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
import { spawn } from 'node:child_process'
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS
  const paddle = resolvePaddle(options.paddlePath, options.paddleDirectory)
  if (paddle !== '') {
    // Both readers take base64 on stdin, so the optional one is a drop-in
    // replacement rather than a second code path the caller has to know about.
    // The device choice rides an environment variable rather than an argument,
    // because the reader was published before it had one and a machine with an
    // older download must keep working.
    const backend = options.backend ?? 'auto'
    const raw = await run(
      paddle,
      [],
      Buffer.from(bytes).toString('base64'),
      timeoutMs,
      backend === 'auto' ? undefined : { ...process.env, DSH_OCR_BACKEND: backend },
    )
    return normalizeRecognized(raw.trim())
  }
  const { command, args } = recognizerCommand()
  // The Windows script reads base64 because a text stream is what it decodes;
  // tesseract reads the container itself, so it gets the bytes unchanged.
  const input = command === 'powershell.exe' ? Buffer.from(bytes).toString('base64') : bytes
  const raw = await run(command, args, input, timeoutMs)
  return normalizeRecognized(raw.trim())
}
