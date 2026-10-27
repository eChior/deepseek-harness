import { spawn } from 'node:child_process'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The documents a model can author, and where their text lives.
 *
 * A model only ever sees placeholders, so a document it writes carries
 * placeholders too. This harness cannot read or write those files itself:
 * document encryption whitelists the Python interpreter, so a read from here
 * returns ciphertext and a write would destroy it. What this module owns is
 * therefore only the naming half — which documents a call touched, and which
 * placeholder maps back to which original. `assets/restore_documents.py` does
 * the rewriting inside the interpreter that is allowed to.
 */

/** Containers whose text lives in XML members. */
const ARCHIVE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx'])

/** Plain-text documents: the payload is the file, so it is rewritten as-is. */
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv'])

/** Every extension the restore pass can handle. */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ...ARCHIVE_EXTENSIONS,
  ...TEXT_EXTENSIONS,
])

/** The script that owns every document read and write. */
const SCRIPT_PATH = fileURLToPath(new URL('../assets/restore_documents.py', import.meta.url))

/** How long one restore pass may take before it is abandoned. */
const RESTORE_TIMEOUT_MS = 30_000

/** How deep a nested argument payload is walked before it is ignored. */
const MAX_DEPTH = 6

/** A quoted run keeps a path that holds spaces in one piece. */
const QUOTED = /"([^"\n]+)"|'([^'\n]+)'/gu

/** A bare run is everything a shell would read as one word. */
const BARE = /[^\s"'`|;<>()]+/gu

/** One placeholder and the value it stands for. */
export interface DocumentMapping {
  readonly placeholder: string
  readonly original: string
}

/** What the script reports back on stdout. */
interface RestoreReport {
  readonly restored?: number
}

/**
 * Whether a path names a document the restore pass handles.
 * @param path The candidate path.
 * @returns true when the extension is one of the supported ones.
 */
export function isDocumentPath(path: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase())
}

/**
 * The document paths one tool call mentions.
 *
 * A call names its file either as a structured argument (`path`, `file_path`)
 * or inside a shell command, where it may be quoted because it holds spaces.
 * Both spellings are collected here rather than parsed per tool: a tool this
 * deployment adds later needs no new case.
 * @param value The call's parsed arguments.
 * @returns the candidate paths, de-duplicated, in first-mention order.
 */
export function documentPaths(value: unknown): string[] {
  const found = new Set<string>()
  collect(value, found, 0)
  return [...found]
}

function collect(value: unknown, into: Set<string>, depth: number): void {
  if (depth > MAX_DEPTH) return
  if (typeof value === 'string') {
    collectFromText(value, into)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into, depth + 1)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collect(item, into, depth + 1)
  }
}

function collectFromText(text: string, into: Set<string>): void {
  for (const match of text.matchAll(QUOTED)) {
    addCandidate(match[1] ?? match[2] ?? '', into)
  }
  // A quoted run is already read whole above; masking it keeps the bare-word
  // pass from splitting the same path at its spaces and reading a tail.
  const bare = text.replace(QUOTED, match => ' '.repeat(match.length))
  for (const match of bare.matchAll(BARE)) {
    addCandidate(match[0], into)
  }
}

function addCandidate(candidate: string, into: Set<string>): void {
  const trimmed = candidate.replace(/^[([{]+|[)\]}.,;:!?]+$/gu, '')
  if (trimmed === '' || !isDocumentPath(trimmed)) return
  into.add(trimmed)
}

/** The interpreter a deployment whitelists for document access. */
function pythonCommand(): string {
  const configured = process.env.DSH_REDACTION_PYTHON
  if (configured !== undefined && configured !== '') return configured
  return process.platform === 'win32' ? 'python' : 'python3'
}

function restoredCount(output: string): number {
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as RestoreReport
      return typeof parsed.restored === 'number' ? parsed.restored : 0
    } catch {
      continue
    }
  }
  return 0
}

/**
 * Hand the documents and the mapping to the interpreter that may touch them.
 *
 * Failures are swallowed on purpose: a machine without Python, or a document
 * that refuses the rewrite, must not fail the tool call that produced it.
 * @param paths Documents this call named.
 * @param mappings Placeholder-to-original pairs in force right now.
 * @returns how many files were rewritten; zero when nothing applied.
 */
export async function restoreDocuments(
  paths: readonly string[],
  mappings: readonly DocumentMapping[],
): Promise<number> {
  if (paths.length === 0 || mappings.length === 0) return 0
  const request = JSON.stringify({ paths, entries: mappings })
  return new Promise<number>((resolve) => {
    let settled = false
    const finish = (value: number): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(pythonCommand(), [SCRIPT_PATH], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch {
      finish(0)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(0)
    }, RESTORE_TIMEOUT_MS)
    timer.unref()
    const { stdin, stdout } = child
    let output = ''
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(0)
    })
    child.on('close', () => {
      clearTimeout(timer)
      finish(restoredCount(output))
    })
    stdin.on('error', () => {
      // The interpreter may exit before reading its whole request; that is a
      // miss, not a crash.
    })
    stdin.end(request)
  })
}
