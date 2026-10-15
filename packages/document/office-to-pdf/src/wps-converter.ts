/**
 * WPS-backed converter for installations that carry no LibreOffice engine.
 *
 * The kit publishes native engines for darwin and win32 only, so a Linux installation has no
 * renderer at all. This deployment ships `resources/wps/office-cli.mjs`, which drives WPS through
 * its own automation interface while keeping the kit CLI's command surface. When the desktop
 * application points `DSH_WPS_OFFICE_CLI` at that script, conversions run through it instead of
 * through the engine; every other deployment keeps the stock factory.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, extname } from 'node:path'
import {
  ConversionError,
  createConverter,
  type ConversionErrorCode,
  type ConversionRequest,
  type Converter,
  type ConverterOptions,
  type RenderImagesRequest,
  type RenderImagesResult,
  type RenderResult,
} from '@deepseek-ai/libreoffice-kit'

/** Environment variable naming the WPS-backed CLI, set by the desktop application on Linux. */
const CLI_ENVIRONMENT = 'DSH_WPS_OFFICE_CLI'

/** Output bytes retained from either stream before the reader stops appending. */
const DIAGNOSTIC_LIMIT = 16384

/** Failure codes the CLI publishes, mapped onto the kit's categories. */
const FAILURE_CODES: Record<string, ConversionErrorCode> = {
  'conversion-failed': 'failed',
  'input-unreadable': 'failed',
  'invalid-arguments': 'unsupported-format',
  unsupported: 'unsupported-format',
}

/**
 * Resolve the WPS CLI this process should convert through.
 * @param environment - Process environment carrying the desktop application's selection.
 * @returns The absolute CLI path when it is configured and present, otherwise undefined.
 */
export function wpsOfficeCli(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = environment[CLI_ENVIRONMENT]
  if (configured === undefined || configured === '') return undefined
  if (!isAbsolute(configured)) return undefined
  return existsSync(configured) ? configured : undefined
}

/**
 * Create the converter this installation can actually run.
 * @param options - Host limits shared with the engine-backed factory.
 * @returns A WPS-backed converter when one is configured, otherwise the kit's own converter.
 */
export function createOfficeConverter(options?: ConverterOptions): Promise<Converter> {
  const cli = wpsOfficeCli()
  if (cli === undefined) return createConverter(options)
  return Promise.resolve(new WpsConverter(cli, options?.timeoutMs ?? 120_000))
}

/** Document formats the WPS CLI converts; anything else is refused before a process starts. */
const CONVERTIBLE = new Set(['doc', 'docx', 'rtf', 'odt', 'txt', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp'])

/**
 * One serial converter driving the WPS CLI.
 *
 * The kit's contract is narrower than the CLI's: the provider only converts to PDF and never
 * rasterises through the converter, so the image and recalculation operations stay unsupported
 * instead of pretending to work.
 */
class WpsConverter implements Converter {
  readonly backend: 'native' | 'wasm' = 'native'
  private disposed = false
  private active: AbortController | undefined

  /**
   * @param cli - Absolute path of the WPS CLI script.
   * @param timeoutMs - Deadline for one CLI invocation.
   */
  constructor(private readonly cli: string, private readonly timeoutMs: number) {}

  /**
   * Convert one Office file to PDF.
   * @param request - Absolute input path and a fresh PDF output path.
   * @param signal - Cancellation, which terminates the CLI process.
   * @returns The engine choice and the missing declared families, which WPS does not report.
   */
  async render(request: { inputPath: string; outputPath: string }, signal?: AbortSignal): Promise<RenderResult> {
    await this.run(request.inputPath, request.outputPath, signal)
    return { backend: 'native', missingFonts: [] }
  }

  /**
   * Convert to PDF; the CLI writes PDF only.
   * @param request - Absolute input path and a fresh PDF output path.
   * @param signal - Cancellation, which terminates the CLI process.
   * @returns The engine choice and the missing declared families.
   */
  async convert(request: ConversionRequest, signal?: AbortSignal): Promise<RenderResult> {
    const extension = extname(request.outputPath).slice(1).toLowerCase()
    if (extension !== 'pdf') {
      throw new ConversionError('unsupported-format', `The WPS converter writes PDF only, not .${extension}.`)
    }
    return this.render(request, signal)
  }

  /**
   * Refuse rasterisation.
   * @returns Never; the WPS converter does not rasterise.
   */
  renderImages(request: RenderImagesRequest, signal?: AbortSignal): Promise<RenderImagesResult> {
    void request
    void signal
    return Promise.reject(new ConversionError('unsupported-format', 'The WPS converter does not render images.'))
  }

  /**
   * Refuse workbook recalculation.
   * @returns Never; WPS recalculates on save but the CLI exposes no rewrite.
   */
  recalculate(request: Omit<ConversionRequest, 'sheet'>, signal?: AbortSignal): Promise<RenderResult> {
    void request
    void signal
    return Promise.reject(new ConversionError('unsupported-format', 'The WPS converter does not recalculate workbooks.'))
  }

  /** Stop accepting conversions and terminate one in flight. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.active?.abort()
  }

  /**
   * Run one conversion through the CLI.
   * @param inputPath - Absolute source path.
   * @param outputPath - Absolute PDF path the CLI creates.
   * @param signal - Caller cancellation.
   */
  private async run(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new ConversionError('unavailable', 'The WPS converter is disposed.')
    const extension = extname(inputPath).slice(1).toLowerCase()
    if (!CONVERTIBLE.has(extension)) {
      throw new ConversionError('unsupported-format', `The WPS converter does not open .${extension} files.`)
    }
    signal?.throwIfAborted()
    const controller = new AbortController()
    this.active = controller
    const abort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new ConversionError('timeout', 'The WPS conversion timed out.')), this.timeoutMs)
    try {
      await this.spawnConversion(inputPath, outputPath, controller.signal)
      signal?.throwIfAborted()
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (this.active === controller) this.active = undefined
    }
  }

  /**
   * Spawn the CLI and turn its report into a kit failure when it exits non-zero.
   * @param inputPath - Absolute source path.
   * @param outputPath - Absolute PDF path.
   * @param signal - Cancellation owned by this converter.
   */
  private spawnConversion(inputPath: string, outputPath: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [this.cli, 'convert', '--input', inputPath, '--output', outputPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      })
      let stdout = ''
      let stderr = ''
      const collect = (chunk: Buffer, into: (text: string) => void): void => {
        if (stdout.length + stderr.length >= DIAGNOSTIC_LIMIT) return
        into(String(chunk))
      }
      child.stdout.on('data', (chunk: Buffer) => { collect(chunk, (text) => { stdout += text }) })
      child.stderr.on('data', (chunk: Buffer) => { collect(chunk, (text) => { stderr += text }) })
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) { resolve(); return }
        reject(wpsFailure(stdout, stderr, code))
      })
    })
  }
}

/**
 * Build the failure a non-zero CLI exit describes.
 * @param stdout - Captured standard output, which carries the CLI's JSON report.
 * @param stderr - Captured standard error, which carries the human-readable reason.
 * @param code - Exit status.
 * @returns The published kit failure.
 */
function wpsFailure(stdout: string, stderr: string, code: number | null): ConversionError {
  const reported = parseCliError(stdout)
  const category = reported === undefined ? 'failed' : FAILURE_CODES[reported.code] ?? 'failed'
  const detail = reported?.message ?? stderr.trim()
  const suffix = detail === '' ? '' : `: ${detail}`
  return new ConversionError(category, `The WPS converter exited with ${String(code ?? 'a signal')}${suffix}`)
}

/**
 * Read the CLI's error envelope from standard output.
 * @param stdout - Captured standard output.
 * @returns The published code and message, or undefined when the output is not a report.
 */
function parseCliError(stdout: string): { code: string; message: string } | undefined {
  const line = stdout.trim().split('\n').at(-1)
  if (line === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(line) }
  catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) return undefined
  const error = parsed.error
  if (typeof error !== 'object' || error === null) return undefined
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  const message = 'message' in error && typeof error.message === 'string' ? error.message : undefined
  if (code === undefined) return undefined
  return { code, message: message ?? '' }
}
