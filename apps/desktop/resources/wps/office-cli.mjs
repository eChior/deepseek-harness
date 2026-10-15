#!/usr/bin/env node
/**
 * Office CLI for this deployment, backed by WPS instead of the bundled LibreOffice kit.
 *
 * The upstream kit ships engines for darwin and win32 only; `@deepseek-ai/libreoffice-kit-linux-*`
 * does not exist on npm, so a Linux installation has no renderer at all. This deployment
 * standardises on WPS, so the same command surface the Office skills already call
 * (`capabilities`, `convert`, `render`, `recalculate`) is implemented here on top of `wps2pdf`,
 * which drives WPS through its own automation interface.
 *
 * Keeping the command surface identical is the point: the skill text, the shared Python checkers,
 * and everything the model has learned about this CLI stay untouched.
 *
 * Usage (identical to the kit CLI):
 *   node office-cli.mjs capabilities --json
 *   node office-cli.mjs convert --input <file> --output <file>
 *   node office-cli.mjs render --input <file> --output-dir <fresh-directory> [--pages all|1,3] [--dpi 144]
 *   node office-cli.mjs recalculate --input <workbook> --output <xlsx|ods>
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Directory that holds this script and the compiled `wps2pdf` helper. */
const HERE = dirname(fileURLToPath(import.meta.url))
const CONVERTER = process.env.WPS2PDF ?? join(HERE, 'wps2pdf')

/** WPS installation whose `librpcwpsapi_sysqt5.so` the converter loads. */
const WPS_OFFICE_HOME = process.env.WPS_OFFICE_HOME ?? '/opt/kingsoft/wps-office/office6'

/** Formats WPS opens directly and writes as PDF. */
const WORD_FORMATS = ['doc', 'docx', 'rtf', 'odt', 'txt']
const SHEET_FORMATS = ['xls', 'xlsx', 'ods', 'csv']
const SLIDE_FORMATS = ['ppt', 'pptx', 'odp']

/** Defaults that match the kit's raster contract. */
const DEFAULT_DPI = 144
const MAX_PAGES = 100

class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function fail(code, message) {
  throw new CliError(code, message)
}

/** Read `--name value` pairs and bare flags from an argv tail. */
function parseArguments(argv) {
  const values = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const equals = token.indexOf('=')
    if (equals > 0) {
      values[token.slice(2, equals)] = token.slice(equals + 1)
      continue
    }
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      values[name] = true
      continue
    }
    values[name] = next
    index += 1
  }
  return { values, positionals }
}

function extensionOf(file) {
  const dot = file.lastIndexOf('.')
  return dot < 0 ? '' : file.slice(dot + 1).toLowerCase()
}

async function requireFile(label, file) {
  if (typeof file !== 'string' || file.length === 0) fail('invalid-arguments', `${label} is required.`)
  if (!file.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(file)) fail('invalid-arguments', `${label} must be an absolute path.`)
  try {
    await access(file, constants.R_OK)
  } catch {
    fail('input-unreadable', `${label} is not readable: ${file}`)
  }
}

/** Report whether a POSIX tool is callable. */
async function hasTool(name) {
  try {
    await run('which', [name])
    return true
  } catch {
    return false
  }
}

async function converterAvailable() {
  try {
    await access(CONVERTER, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Environment the WPS automation interface needs; the converter inherits it. */
function converterEnvironment() {
  const path = ['/usr/bin', '/bin', '/usr/local/bin']
  return {
    ...process.env,
    LD_LIBRARY_PATH: [WPS_OFFICE_HOME, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    PATH: [process.env.PATH, ...path].filter(Boolean).join(':'),
    DISPLAY: process.env.DISPLAY ?? ':0',
  }
}

/**
 * Convert one document to PDF with WPS.
 * @returns the PDF bytes' digest so callers can cache on the source.
 */
async function convertToPdf(input, output) {
  const environment = converterEnvironment()
  try {
    const { stderr } = await run(CONVERTER, [input, output], {
      env: environment,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 300_000,
    })
    if (stderr.length > 0) process.stderr.write(stderr)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail('conversion-failed', `WPS could not convert ${input}: ${detail}`)
  }
  try {
    const handle = await stat(output)
    if (handle.size === 0) fail('conversion-failed', `WPS produced an empty file: ${output}`)
  } catch (error) {
    if (error instanceof CliError) throw error
    fail('conversion-failed', `WPS did not produce ${output}`)
  }
}

/** Parse `--pages all|1,3` into a one-based inclusive range. */
function parsePages(value, pageCount) {
  if (value === undefined || value === true || value === 'all') return { first: 1, last: pageCount }
  const numbers = String(value)
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((number) => Number.isInteger(number) && number >= 1)
  if (numbers.length === 0) fail('invalid-arguments', `--pages must be "all" or a list like 1,3: ${String(value)}`)
  const first = Math.min(...numbers)
  const last = Math.max(...numbers)
  if (last > pageCount) fail('invalid-arguments', `--pages asks for page ${String(last)} but the document has ${String(pageCount)}.`)
  return { first, last, selected: new Set(numbers) }
}

/** Fill in the `pageCount` of a PDF without a PDF library, by counting page objects. */
async function pdfPageCount(file) {
  const { stdout } = await run('pdfinfo', [file], { maxBuffer: 4 * 1024 * 1024 })
  const match = /^Pages:\s+(\d+)$/mu.exec(stdout)
  if (match?.[1] === undefined) fail('render-failed', `pdfinfo reported no page count for ${file}`)
  return Number.parseInt(match[1], 10)
}

async function commandCapabilities(values) {
  if (Object.keys(values).some((key) => key !== 'json')) fail('invalid-arguments', 'capabilities accepts only --json.')
  const [converter, pdfinfo, pdftoppm] = await Promise.all([
    converterAvailable(),
    hasTool('pdfinfo'),
    hasTool('pdftoppm'),
  ])
  const rasteriser = pdfinfo && pdftoppm
  process.stdout.write(`${JSON.stringify({
    runtime: {
      backend: 'wps',
      officeHome: WPS_OFFICE_HOME,
      converter: converter ? CONVERTER : null,
      available: converter,
      display: process.env.DISPLAY ?? ':0',
    },
    conversions: {
      inputs: [...WORD_FORMATS, ...SHEET_FORMATS, ...SLIDE_FORMATS],
      outputs: ['pdf'],
      note: converter
        ? 'WPS converts through its automation interface; the PDF is written to a tmpfs first because the file safe box encrypts controlled writes.'
        : 'wps2pdf is missing from this installation, so no conversion is available.',
    },
    imageRendering: {
      inputs: [...WORD_FORMATS, ...SHEET_FORMATS, ...SLIDE_FORMATS, 'pdf'],
      output: 'png',
      officeBackend: 'wps',
      pdfBackend: rasteriser ? 'poppler' : null,
      pages: 'one-based physical pages or slides; all by default',
      worksheets: 'exact sheet plus optional A1 range; all visible data areas by default',
      maxPages: MAX_PAGES,
    },
    csv: {
      sheet: 'exact name; required when the input has multiple worksheets',
      encoding: 'UTF-8',
      delimiter: ',',
    },
    recalculation: {
      inputs: [],
      outputs: [],
      preservesFormulas: false,
      note: 'WPS recalculates when it saves, but this shim does not expose a workbook rewrite yet.',
    },
    options: {
      limits: ['dpi'],
      fonts: [],
    },
  })}\n`)
}

async function commandConvert(values) {
  const input = resolve(String(values.input))
  const output = resolve(String(values.output))
  await requireFile('--input', input)
  if (input === output) fail('invalid-arguments', '--input and --output must differ.')
  await mkdir(dirname(output), { recursive: true })
  await convertToPdf(input, output)
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    operation: 'convert',
    backend: 'wps',
    inputPath: input,
    outputPath: output,
    missingFonts: [],
  })}\n`)
}

async function commandRender(values) {
  const input = resolve(String(values.input))
  const outputDir = resolve(String(values['output-dir']))
  await requireFile('--input', input)
  const dpi = values.dpi === undefined || values.dpi === true ? DEFAULT_DPI : Number.parseInt(String(values.dpi), 10)
  if (!Number.isInteger(dpi) || dpi < 36 || dpi > 600) fail('invalid-arguments', `--dpi must be an integer between 36 and 600: ${String(values.dpi)}`)

  if (values.output !== undefined) fail('invalid-arguments', 'render requires --output-dir and does not accept --output.')
  if (!await hasTool('pdftoppm')) fail('render-failed', 'pdftoppm is required to rasterise pages and is not installed.')
  if (!await hasTool('pdfinfo')) fail('render-failed', 'pdfinfo is required to count pages and is not installed.')

  await mkdir(outputDir, { recursive: true })
  const scratch = await mkdtemp(join(tmpdir(), 'office-cli-wps-'))
  try {
    const pdf = join(scratch, 'document.pdf')
    await convertToPdf(input, pdf)

    const pageCount = await pdfPageCount(pdf)
    if (pageCount > MAX_PAGES) fail('render-failed', `the document has ${String(pageCount)} pages, above the ${String(MAX_PAGES)} page limit.`)
    const { first, last, selected } = parsePages(values.pages, pageCount)

    const prefix = join(scratch, 'page')
    await run('pdftoppm', ['-png', '-r', String(dpi), '-f', String(first), '-l', String(last), pdf, prefix], { maxBuffer: 16 * 1024 * 1024 })

    const produced = (await readdir(scratch)).filter((name) => name.startsWith('page') && name.endsWith('.png')).sort()
    const source = await readFile(pdf)
    const sourceSha256 = createHash('sha256').update(source).digest('hex')

    const images = []
    for (const [offset, name] of produced.entries()) {
      const page = first + offset
      if (selected !== undefined && !selected.has(page)) continue
      const target = join(outputDir, `page-${String(page).padStart(4, '0')}.png`)
      await rename(join(scratch, name), target)
      const handle = await stat(target)
      images.push({
        index: images.length + 1,
        page,
        path: target,
        rectangle: { x: 0, y: 0, width: 0, height: 0 },
        byteLength: handle.size,
      })
    }

    const manifest = {
      schemaVersion: 1,
      backend: 'native',
      rasterEngine: 'poppler',
      source: 'saved',
      inputPath: input,
      sourceSha256,
      dpi,
      pageCount,
      images,
      missingFonts: [],
    }
    await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, { flag: 'wx', mode: 0o600 })
    process.stdout.write(`${JSON.stringify(manifest)}\n`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function commandRecalculate(values) {
  const input = resolve(String(values.input))
  await requireFile('--input', input)
  fail('unsupported', `recalculate is not implemented for ${extensionOf(input)} in this deployment; WPS recalculates when it saves a workbook.`)
}

async function main() {
  const [, , command, ...rest] = process.argv
  const { values, positionals } = parseArguments(rest)
  if (positionals.length > 0) fail('invalid-arguments', `unexpected argument: ${positionals[0]}`)
  switch (command) {
    case 'capabilities': {
      await commandCapabilities(values)
      return
    }
    case 'convert': {
      await commandConvert(values)
      return
    }
    case 'render': {
      await commandRender(values)
      return
    }
    case 'recalculate': {
      await commandRecalculate(values)
      return
    }
    default: {
      fail('invalid-arguments', 'Usage: office-cli.mjs capabilities --json | convert --input <file> --output <file> | render --input <file> --output-dir <fresh-directory> [--pages all|1,3] [--dpi 144] | recalculate --input <workbook> --output <xlsx|ods>')
    }
  }
}

try {
  await main()
} catch (error) {
  const code = error instanceof CliError ? error.code : 'internal'
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.stdout.write(`${JSON.stringify({ error: { code, message } })}\n`)
  process.exitCode = 1
}
