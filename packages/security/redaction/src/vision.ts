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
 */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Script a Windows client runs; it reads base64 on stdin and writes text on stdout. */
const WINDOWS_SCRIPT = fileURLToPath(new URL('../assets/vision.ps1', import.meta.url))

/** How long one recognition may take before it is abandoned. */
export const DEFAULT_VISION_TIMEOUT_MS = 20_000

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
function run(command: string, args: readonly string[], input: string | Uint8Array, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const { stdout, stderr } = child
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
    child.stdin.end(input)
  })
}

/** The command and arguments this platform reads images with. */
function recognizerCommand(timeoutMs: number): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_SCRIPT],
    }
  }
  void timeoutMs
  return { command: 'tesseract', args: ['stdin', 'stdout', '-l', 'chi_sim+eng'] }
}

/**
 * Read the text out of one encoded image.
 *
 * Takes the bytes, not a path: a caller that has only a path has already put the
 * image on disk, which is the state this function exists to avoid.
 * @param bytes The image as decoded bytes.
 * @param timeoutMs How long to wait before abandoning the attempt.
 * @returns The recognized text, normalized, empty when the image held no text.
 * @throws When no recognizer is available, or when it fails or times out.
 */
export async function recognizeImageText(bytes: Uint8Array, timeoutMs = DEFAULT_VISION_TIMEOUT_MS): Promise<string> {
  const { command, args } = recognizerCommand(timeoutMs)
  // The Windows script reads base64 because a text stream is what it decodes;
  // tesseract reads the container itself, so it gets the bytes unchanged.
  const input = command === 'powershell.exe' ? Buffer.from(bytes).toString('base64') : bytes
  const raw = await run(command, args, input, timeoutMs)
  return normalizeRecognized(raw.trim())
}
