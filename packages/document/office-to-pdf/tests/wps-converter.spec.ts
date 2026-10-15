/** The WPS-backed converter resolves its CLI from the environment and reports CLI failures. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createOfficeConverter, wpsOfficeCli } from '../src/wps-converter.ts'

afterEach(() => { vi.unstubAllEnvs() })

/**
 * Write one stub CLI that answers a single conversion.
 * @param script - JavaScript body executed by the stub.
 * @returns Absolute path of the stub, registered for cleanup.
 */
async function stubCli(script: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wps-converter-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const path = join(directory, 'office-cli.mjs')
  await writeFile(path, script)
  return path
}

/**
 * Write a stub that reports the output path it was given and exits with one status.
 * @param lines - Extra module-level lines placed before the report.
 * @param status - Exit status to report.
 * @returns The CLI output the stub writes.
 */
function reportingCli(lines: string, status: number): string {
  return `import { writeFileSync } from 'node:fs'
${lines}
const args = process.argv.slice(2)
const output = args[args.indexOf('--output') + 1]
if (${String(status)} === 0) writeFileSync(output, '%PDF-1.7\\n%%EOF\\n')
process.stdout.write(${JSON.stringify(JSON.stringify({ schemaVersion: 1 }))} + '\\n')
process.exitCode = ${String(status)}
`
}

/** Create one temporary conversion request. */
async function request(): Promise<{ inputPath: string; outputPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wps-request-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const inputPath = join(directory, 'source.docx')
  await writeFile(inputPath, 'document')
  return { inputPath, outputPath: join(directory, 'converted.pdf') }
}

it('ignores an unset, relative, or missing WPS CLI', async () => {
  expect(wpsOfficeCli({})).toBeUndefined()
  expect(wpsOfficeCli({ DSH_WPS_OFFICE_CLI: '' })).toBeUndefined()
  expect(wpsOfficeCli({ DSH_WPS_OFFICE_CLI: 'office-cli.mjs' })).toBeUndefined()
  expect(wpsOfficeCli({ DSH_WPS_OFFICE_CLI: join(tmpdir(), 'absent', 'office-cli.mjs') })).toBeUndefined()
})

it('accepts an absolute CLI that exists', async () => {
  const cli = await stubCli(reportingCli('', 0))
  expect(wpsOfficeCli({ DSH_WPS_OFFICE_CLI: cli })).toBe(cli)
})

it('converts through the CLI and reports the native backend', async () => {
  vi.stubEnv('DSH_WPS_OFFICE_CLI', await stubCli(reportingCli('', 0)))
  const converter = await createOfficeConverter()
  const options = await request()
  await expect(converter.render(options, new AbortController().signal))
    .resolves.toEqual({ backend: 'native', missingFonts: [] })
})

it('refuses an input extension the CLI cannot open', async () => {
  vi.stubEnv('DSH_WPS_OFFICE_CLI', await stubCli(reportingCli('', 0)))
  const converter = await createOfficeConverter()
  const options = await request()
  await expect(converter.render({ ...options, inputPath: `${options.inputPath}.zip` }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'unsupported-format' })
})

it('refuses an output that is not a PDF', async () => {
  vi.stubEnv('DSH_WPS_OFFICE_CLI', await stubCli(reportingCli('', 0)))
  const converter = await createOfficeConverter()
  const options = await request()
  await expect(converter.convert({ ...options, outputPath: join(options.outputPath, '..', 'converted.docx') }))
    .rejects.toMatchObject({ code: 'unsupported-format' })
})

it('maps a reported CLI failure onto the published category', async () => {
  const report = `process.stdout.write(${JSON.stringify(JSON.stringify({ error: { code: 'conversion-failed', message: 'wps said no' } }))} + '\\n')`
  vi.stubEnv('DSH_WPS_OFFICE_CLI', await stubCli(`${report}\nprocess.exitCode = 1\n`))
  const converter = await createOfficeConverter()
  const options = await request()
  await expect(converter.render(options, new AbortController().signal))
    .rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('wps said no') })
})

it('reports a CLI that dies without a report as a generic failure', async () => {
  vi.stubEnv('DSH_WPS_OFFICE_CLI', await stubCli('process.exitCode = 3\n'))
  const converter = await createOfficeConverter()
  const options = await request()
  await expect(converter.render(options, new AbortController().signal)).rejects.toMatchObject({ code: 'failed' })
})

it('refuses image rendering and workbook recalculation', async () => {
  vi.stubEnv('DSH_WPS_OFFICE_CLI', await stubCli(reportingCli('', 0)))
  const converter = await createOfficeConverter()
  const options = await request()
  await expect(converter.renderImages({ inputPath: options.inputPath, outputDir: join(options.outputPath, '..', 'images') }))
    .rejects.toMatchObject({ code: 'unsupported-format' })
  await expect(converter.recalculate(options)).rejects.toMatchObject({ code: 'unsupported-format' })
})

it('refuses further conversions after disposal', async () => {
  vi.stubEnv('DSH_WPS_OFFICE_CLI', await stubCli(reportingCli('', 0)))
  const converter = await createOfficeConverter()
  const options = await request()
  await converter.dispose()
  await expect(converter.render(options, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' })
})

it('stops the running CLI when the caller cancels', async () => {
  const slow = `setTimeout(() => {}, 30_000)
`
  vi.stubEnv('DSH_WPS_OFFICE_CLI', await stubCli(slow))
  const converter = await createOfficeConverter()
  const options = await request()
  const controller = new AbortController()
  const pending = converter.render(options, controller.signal)
  controller.abort(new Error('caller cancelled'))
  await expect(pending).rejects.toBeDefined()
})
