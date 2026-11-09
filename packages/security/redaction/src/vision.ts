/**
 * Read the text out of an image on this machine.
 *
 * A picture of a screen or a printed page carries the same values a typed
 * document does, and a model that receives the pixels has them whatever the
 * caller intended. Recognition therefore happens locally, the image never
 * becomes an attachment and never enters a model request, and the caller feeds
 * the text through {@link RedactionService.redactText} before anything keeps it.
 *
 * The recognizer is whatever the platform already installs: the Windows
 * composition engine, or `tesseract` on a Linux host that has it. A machine with
 * neither reports a failure and the caller decides what the session sees instead
 * — it never falls back to sending the image.
 *
 * An optional `dsh-ocr` binary adds a third reader. It is built from
 * PaddleOCR and published on the intranet rather than bundled, because it
 * carries a model and a runtime of its own; a machine that has downloaded it
 * points {@link VisionOptions.paddlePath} at the file and reads images with it
 * instead. Nothing else changes: same stdin, same stdout, same normalization.
 */
import { Buffer } from 'node:buffer'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readablePath } from './assets.ts'

/** Script a Windows client runs; it reads base64 on stdin and writes text on stdout. */
/** PowerShell opens this path itself, so it has to exist on disk. */
const WINDOWS_SCRIPT = readablePath(
  fileURLToPath(new URL('../assets/vision.ps1', import.meta.url)),
)

/** How long one recognition may take before it is abandoned. */
export const DEFAULT_VISION_TIMEOUT_MS = 20_000

/** Which local reader produces the text. */
export type VisionEngine = 'paddle' | 'windows' | 'tesseract'

/** File names the optional reader carries, in the order they are looked for. */
const PADDLE_BINARIES: readonly string[] = ['dsh-ocr.exe', 'dsh-ocr']

/** What the caller can choose about local recognition. */
export interface VisionOptions {
  /**
   * Path to the optional `dsh-ocr` binary. When the file exists it reads the
   * image; when it is empty or missing the platform engine does.
   */
  paddlePath?: string
  /**
   * Directory a downloaded reader was unpacked into. It is looked in only
   * when no path was configured, so downloading the file and unpacking it
   * there is enough to switch the reader on — nobody types a path.
   */
  paddleDirectory?: string
  /** How long one recognition may take before it is abandoned. */
  timeoutMs?: number
  /**
   * Which device the optional reader should use.
   *
   * `auto` lets the reader measure itself the first time and remember what it
   * found; `cpu` and `gpu` skip that measurement and are for a machine whose
   * answer is known or whose measurement picked the slower one.
   */
  backend?: 'auto' | 'cpu' | 'gpu'
  /**
   * Keep one reader process alive between images and feed it one line per
   * image, instead of starting a process for every call.
   *
   * A fresh process loads the model and runs the first inference cold, which
   * dominates a one-image call; a reader that stays up pays that once. Set to
   * `false` to avoid a process that outlives the request.
   *
   * A download that predates this protocol is detected and read one image at a
   * time, so both kinds of download keep working.
   */
  serve?: boolean
  /**
   * Ask the reader for per-character boxes as well as per-line ones.
   *
   * Character boxes come from an extra alignment pass, so this is off unless
   * the caller needs them.
   */
  characters?: boolean
}

/**
 * Find the optional reader, if this machine has one.
 *
 * A configured path wins, because a deployment that typed one means it. A
 * machine that downloaded the reader instead leaves the path empty and
 * unpacks the file into `directory`; finding it there is what makes the
 * download take effect on its own.
 * @param configured The path a deployment typed, if any.
 * @param directory The directory a download is unpacked into, if any.
 * @returns The path of a file that exists, or an empty string.
 */
export function resolvePaddle(configured: string | undefined, directory: string | undefined): string {
  const explicit = configured?.trim() ?? ''
  if (explicit !== '') return existsSync(explicit) ? explicit : ''
  const base = directory?.trim() ?? ''
  if (base === '') return ''
  for (const name of PADDLE_BINARIES) {
    const candidate = join(base, name)
    if (existsSync(candidate)) return candidate
  }
  return ''
}

/**
 * Say which reader an image would go through, without running one.
 *
 * The status panel shows this, so a machine that downloaded the optional
 * reader can see it is being used and a machine that did not sees what it has.
 * @param options The caller's choices.
 * @returns The engine that would run.
 */
export function describeVision(options: VisionOptions = {}): VisionEngine {
  if (resolvePaddle(options.paddlePath, options.paddleDirectory) !== '') return 'paddle'
  return process.platform === 'win32' ? 'windows' : 'tesseract'
}

/**
 * Join what a recognizer reported into the text a person would have typed.
 *
 * Recognition returns one token per visual run, so Chinese arrives with a space
 * between characters and a long number arrives split across tokens. Either one
 * hides a value from a rule that would otherwise match it, which defeats the
 * reason for reading the image at all, so the spaces that separate scripts
 * rather than words are removed here.
 * @param text Text as the recognizer reported it.
 * @returns The same text with those separator spaces removed.
 */
export function normalizeRecognized(text: string): string {
  return text
    .replace(/(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5A-Za-z0-9])/gu, '')
    .replace(/(?<=[A-Za-z0-9])\s+(?=[\u4e00-\u9fa5])/gu, '')
    .replace(/(?<=\d)\s+(?=\d)/gu, '')
    // A hyphen between two runs is frequently read as the character that looks
    // like one; a document number split that way stops matching its own pattern.
    .replace(/(?<=[A-Za-z0-9])\s*一\s*(?=\d)/gu, '-')
}

/** Run one recognizer to completion, bounded by the caller's timeout. */
function run(
  command: string,
  args: readonly string[],
  input: string | Uint8Array,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...env === undefined ? {} : { env },
    })
    const { stdin, stdout, stderr } = child
    stdout.setEncoding('utf8')
    stderr.setEncoding('utf8')
    let output = ''
    let diagnostics = ''
    stdout.on('data', (chunk: string) => {
      output += chunk
    })
    stderr.on('data', (chunk: string) => {
      diagnostics += chunk
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${command} did not finish within ${String(timeoutMs)} ms`))
    }, timeoutMs)
    timer.unref()
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error(`${command} exited with ${String(code)}: ${diagnostics.trim().slice(0, 400)}`))
    })
    // A recognizer that refuses its input exits before reading it, and the write
    // then fails on a pipe nobody owns. That failure arrives as an `error` event
    // on the stream, not as a rejected promise, so leaving it unhandled turns one
    // unreadable image into a dead Host process; the `close` handler above
    // already reports the failure the caller acts on.
    stdin.on('error', () => {
      // Reported through `close`, never through the stream.
    })
    stdout.on('error', () => {
      // Same: a broken pipe says nothing the exit status does not.
    })
    stderr.on('error', () => {
      // Same.
    })
    stdin.end(input)
  })
}

/** One request waiting for the reader's next output line. */
interface ServeWait {
  readonly resolve: (raw: string) => void
  readonly reject: (error: Error) => void
  readonly cancel: () => void
}

/** One reader process kept between images. */
interface ReaderServer {
  readonly child: ChildProcessWithoutNullStreams
  readonly pending: ServeWait[]
  buffer: string
  diagnostics: string
  exited: boolean
}

/** Live readers, by the configuration that would make a different process. */
const servers = new Map<string, ReaderServer>()

/** Readers already found not to understand `--serve`, by path. */
const oneShotOnly = new Set<string>()

/** Whether a reader understands `--serve`, remembered per path. */
const capable = new Map<string, Promise<boolean>>()

/** The reader process could not start or died; a one-shot read may still work. */
class ReaderProcessError extends Error {}

/** Stop a server and settle everything waiting on it. */
function stopServer(server: ReaderServer, error: Error): void {
  server.exited = true
  server.child.kill()
  for (const wait of server.pending.splice(0)) {
    wait.cancel()
    wait.reject(error)
  }
}

// A reader left running would outlive the Host on Windows, where a child does
// not die with its parent. Kill the ones still alive when this process ends.
process.once('exit', () => {
  for (const server of servers.values()) server.child.kill()
})

/** Take one report line per request, in the order the requests were written. */
function drain(server: ReaderServer): void {
  for (;;) {
    const end = server.buffer.indexOf('\n')
    if (end < 0) return
    const line = server.buffer.slice(0, end)
    server.buffer = server.buffer.slice(end + 1)
    if (line.trim() === '') continue
    const wait = server.pending.shift()
    if (wait === undefined) continue
    wait.cancel()
    wait.resolve(line)
  }
}

/** Start (or reuse) the reader that stays up for this configuration. */
function serverFor(
  key: string,
  command: string,
  env: NodeJS.ProcessEnv,
  characters: boolean,
): ReaderServer {
  const existing = servers.get(key)
  if (existing !== undefined && !existing.exited) return existing
  const child = spawn(command, characters ? ['--serve', '--chars'] : ['--serve'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  const server: ReaderServer = { child, pending: [], buffer: '', diagnostics: '', exited: false }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    server.buffer += chunk
    drain(server)
  })
  child.stderr.on('data', (chunk: string) => {
    server.diagnostics = (server.diagnostics + chunk).slice(-4_000)
  })
  const fail = (error: Error): void => {
    if (servers.get(key) === server) servers.delete(key)
    stopServer(server, error)
  }
  child.on('error', (error: Error) => {
    fail(new ReaderProcessError(error.message))
  })
  child.on('close', (code: number | null) => {
    fail(new ReaderProcessError(
      `${command} exited with ${String(code)}: ${server.diagnostics.trim().slice(0, 400)}`,
    ))
  })
  // A reader that refuses one image closes the pipe; the close handler above
  // already reports it, and an unhandled stream error would end the Host.
  child.stdin.on('error', () => {
    // Reported through `close`.
  })
  child.stdout.on('error', () => {
    // Same.
  })
  child.stderr.on('error', () => {
    // Same.
  })
  servers.set(key, server)
  return server
}

/** Does this download understand the serve protocol? Asked once per path. */
function supportsServe(command: string): Promise<boolean> {
  const known = capable.get(command)
  if (known !== undefined) return known
  const answer = new Promise<boolean>((resolve) => {
    const child = spawn(command, ['--version'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {
      // The answer is on stdout; diagnostics are not needed here.
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, 5_000)
    timer.unref()
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve(code === 0 && output.includes('dsh-ocr'))
    })
  })
  capable.set(command, answer)
  return answer
}

/** Send one image to a live reader and wait for its report line. */
function serveOnce(server: ReaderServer, payload: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const wait: ServeWait = {
      resolve: (raw: string) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve(raw)
      },
      reject: (error: Error) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        reject(error)
      },
      cancel: () => {
        if (timer !== undefined) clearTimeout(timer)
      },
    }
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      const index = server.pending.indexOf(wait)
      if (index >= 0) server.pending.splice(index, 1)
      // A reader that stopped answering cannot be trusted with the next
      // image either, so the process goes and the next call starts a new one.
      server.child.kill()
      reject(new ReaderProcessError(`reader did not answer within ${String(timeoutMs)} ms`))
    }, timeoutMs)
    timer.unref()
    server.pending.push(wait)
    try {
      server.child.stdin.write(`${payload}\n`)
    } catch (error) {
      const index = server.pending.indexOf(wait)
      if (index >= 0) server.pending.splice(index, 1)
      wait.cancel()
      reject(new ReaderProcessError(error instanceof Error ? error.message : String(error)))
    }
  })
}

/** The error object a reader writes when it could not read one request. */
function readerFailure(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    if (isRecord(value) && typeof value.error === 'string') return value.error
  } catch {
    // Not the report; the parser below treats it as plain text.
  }
  return undefined
}

/** Shape a reader's answer the same way for every engine and protocol. */
function complete(engine: VisionEngine, raw: string): VisionResult {
  const failure = readerFailure(raw)
  if (failure !== undefined) throw new Error(`reader could not read the image: ${failure}`)
  const parsed = parseReaderOutput(raw)
  return { engine, ...parsed, text: normalizeRecognized(parsed.text.trim()) }
}

/** The command and arguments this platform reads images with. */
function recognizerCommand(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_SCRIPT],
    }
  }
  return { command: 'tesseract', args: ['stdin', 'stdout', '-l', 'chi_sim+eng'] }
}

/** One corner of a line or character box, in input-image pixels. */
export interface VisionBox {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly x3: number
  readonly y3: number
  readonly x4: number
  readonly y4: number
}

/** One character box the reader reported for a line. */
export interface VisionCharacter {
  readonly text: string
  readonly score: number
  readonly box: VisionBox
}

/** One recognized line with the geometry the optional reader reported. */
export interface VisionLine {
  readonly text: string
  /** Four corners, clockwise from the top-left of the detected line. */
  readonly box: VisionBox
  /** Detector confidence for the box, 0..1. */
  readonly detectionScore: number
  /** Recognizer score, raw and not normalized to 0..1. */
  readonly recognitionScore: number
  /** Direction-classifier confidence, 0..1. */
  readonly classificationScore: number
  /** Degrees the line was rotated before recognition. */
  readonly rotationDegrees: number
  /** Character boxes; empty unless the reader aligned characters. */
  readonly characters: readonly VisionCharacter[]
}

/** What one reader report carries beyond the text. */
export interface ReaderOutput {
  /** The text as the reader wrote it; callers normalize before keeping it. */
  readonly text: string
  /** One entry per detected line; empty when the reader reports only text. */
  readonly lines: readonly VisionLine[]
  /** The device the optional reader used, when it reports one. */
  readonly backend?: 'cpu' | 'vulkan' | 'metal'
  /** How long the reader spent, when it reports one. */
  readonly elapsedMs?: number
  /** Pixel size of the input image, when the reader reports it. */
  readonly image?: { readonly width: number; readonly height: number }
}

/** What one local recognition returned. */
export interface VisionResult extends ReaderOutput {
  /** Which local reader produced the text. */
  readonly engine: VisionEngine
}

/** A JSON object, checked field by field at the process boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** One finite number, or undefined when the field is absent or not one. */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A four-corner box, or undefined when any corner is missing. */
function readBox(value: unknown): VisionBox | undefined {
  if (!isRecord(value)) return undefined
  const x1 = readNumber(value.x1)
  const y1 = readNumber(value.y1)
  const x2 = readNumber(value.x2)
  const y2 = readNumber(value.y2)
  const x3 = readNumber(value.x3)
  const y3 = readNumber(value.y3)
  const x4 = readNumber(value.x4)
  const y4 = readNumber(value.y4)
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return undefined
  if (x3 === undefined || y3 === undefined || x4 === undefined || y4 === undefined) return undefined
  return { x1, y1, x2, y2, x3, y3, x4, y4 }
}

/** Character boxes; an absent or malformed list reads as none. */
function readCharacters(value: unknown): VisionCharacter[] {
  if (!Array.isArray(value)) return []
  const characters: VisionCharacter[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.text !== 'string') continue
    const box = readBox(entry.box)
    if (box === undefined) continue
    characters.push({ text: entry.text, score: readNumber(entry.score) ?? 0, box })
  }
  return characters
}

/**
 * Parse one reader report.
 *
 * The optional reader answers with a JSON object when the host asks for one.
 * An older download ignores the request and writes the text itself, so
 * anything that is not a valid report reads as plain text and every caller
 * keeps working with either reader.
 * @param raw The bytes the reader wrote to stdout, decoded as UTF-8.
 * @returns The text, the lines the report carries, and its metadata.
 */
export function parseReaderOutput(raw: string): ReaderOutput {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return { text: raw, lines: [] }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    // Not JSON: an older reader answered the request with plain text.
    return { text: raw, lines: [] }
  }
  if (!isRecord(value) || typeof value.text !== 'string' || !Array.isArray(value.lines)) {
    return { text: raw, lines: [] }
  }
  const lines: VisionLine[] = []
  for (const entry of value.lines) {
    if (!isRecord(entry) || typeof entry.text !== 'string') continue
    const box = readBox(entry.box)
    if (box === undefined) continue
    lines.push({
      text: entry.text,
      box,
      detectionScore: readNumber(entry.detectionScore) ?? 0,
      recognitionScore: readNumber(entry.recognitionScore) ?? 0,
      classificationScore: readNumber(entry.classificationScore) ?? 0,
      rotationDegrees: readNumber(entry.rotationDegrees) ?? 0,
      characters: readCharacters(entry.characters),
    })
  }
  const output: {
    text: string
    lines: VisionLine[]
    backend?: 'cpu' | 'vulkan' | 'metal'
    elapsedMs?: number
    image?: { width: number; height: number }
  } = { text: value.text, lines }
  if (value.backend === 'cpu' || value.backend === 'vulkan' || value.backend === 'metal') {
    output.backend = value.backend
  }
  const elapsedMs = readNumber(value.elapsedMs)
  if (elapsedMs !== undefined) output.elapsedMs = elapsedMs
  const width = isRecord(value.image) ? readNumber(value.image.width) : undefined
  const height = isRecord(value.image) ? readNumber(value.image.height) : undefined
  if (width !== undefined && height !== undefined) output.image = { width, height }
  return output
}

/**
 * Translate the caller's device choice into the value the optional reader
 * understands. A `gpu` request names the platform's Vulkan or Metal device;
 * an older download that only knows `gpu` is reached by the host resolving it
 * here rather than passing an unknown word through.
 * @param backend The caller's choice, already defaulted to `auto`.
 * @returns The device name the reader accepts.
 */
function deviceFor(backend: 'auto' | 'cpu' | 'gpu'): 'auto' | 'cpu' | 'vulkan' | 'metal' {
  if (backend !== 'gpu') return backend
  return process.platform === 'darwin' ? 'metal' : 'vulkan'
}

/**
 * Read one encoded image, keeping the geometry the optional reader reports.
 *
 * Takes the bytes, not a path: a caller that has only a path has already put the
 * image on disk, which is the state this function exists to avoid.
 * @param bytes The image as decoded bytes.
 * @param options The caller's choices; the timeout defaults, the optional reader
 * is used only when the file is there.
 * @returns The recognized text, normalized, with per-line geometry when the
 * optional reader reports it.
 * @throws When no recognizer is available, or when it fails or times out.
 */
export async function recognizeImage(bytes: Uint8Array, options: VisionOptions = {}): Promise<VisionResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS
  const paddle = resolvePaddle(options.paddlePath, options.paddleDirectory)
  if (paddle !== '') {
    // Both readers take base64 on stdin, so the optional one is a drop-in
    // replacement rather than a second code path the caller has to know about.
    // The format request rides an environment variable rather than an argument,
    // because a machine with an older download ignores the variable and keeps
    // writing plain text; the report parser then reads it as text.
    const device = deviceFor(options.backend ?? 'auto')
    const environment: NodeJS.ProcessEnv = device === 'auto'
      ? { ...process.env, DSH_OCR_JSON: '1' }
      : { ...process.env, DSH_OCR_JSON: '1', DSH_OCR_BACKEND: device }
    const characters = options.characters === true
    const payload = Buffer.from(bytes).toString('base64')

    if (options.serve !== false && !oneShotOnly.has(paddle) && await supportsServe(paddle)) {
      // Tiered JIT keeps re-compiling the kernels for the first several images,
      // and a reader that stays up pays that on images 2..N; a one-shot process
      // is too short-lived to benefit from it, so only the server turns it off.
      const serveEnvironment = {
        ...environment,
        DOTNET_TieredCompilation: environment.DOTNET_TieredCompilation ?? '0',
      }
      const key = `${paddle}\u0000${device}\u0000${String(characters)}`
      try {
        const raw = await serveOnce(serverFor(key, paddle, serveEnvironment, characters), payload, timeoutMs)
        return complete('paddle', raw)
      } catch (error) {
        if (!(error instanceof ReaderProcessError)) throw error
        // A reader that cannot stay alive is still usable one image at a time;
        // remembering that keeps every later call from restarting it first.
        oneShotOnly.add(paddle)
      }
    }

    const raw = await run(paddle, characters ? ['--chars'] : [], payload, timeoutMs, environment)
    return complete('paddle', raw)
  }
  const { command, args } = recognizerCommand()
  // The Windows script reads base64 because a text stream is what it decodes;
  // tesseract reads the container itself, so it gets the bytes unchanged.
  const input = command === 'powershell.exe' ? Buffer.from(bytes).toString('base64') : bytes
  const raw = await run(command, args, input, timeoutMs)
  return complete(process.platform === 'win32' ? 'windows' : 'tesseract', raw)
}

/**
 * Read the text out of one encoded image.
 *
 * Takes the bytes, not a path: a caller that has only a path has already put the
 * image on disk, which is the state this function exists to avoid.
 * @param bytes The image as decoded bytes.
 * @param options The caller's choices; the timeout defaults, the optional reader
 * is used only when the file is there.
 * @returns The recognized text, normalized, empty when the image held no text.
 * @throws When no recognizer is available, or when it fails or times out.
 */
export async function recognizeImageText(bytes: Uint8Array, options: VisionOptions = {}): Promise<string> {
  return (await recognizeImage(bytes, options)).text
}
