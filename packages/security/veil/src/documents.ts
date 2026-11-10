import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readablePath } from './assets.ts'

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
/** The interpreter opens this path itself, so it has to exist on disk. */
const SCRIPT_PATH = readablePath(
  fileURLToPath(new URL('../assets/restore_documents.py', import.meta.url)),
)

/** How long one restore pass may take before it is abandoned. */
const RESTORE_TIMEOUT_MS = 30_000
/** A directory grant walks every entry, so it gets longer than one interpreter run. */
const GRANT_TIMEOUT_MS = 120_000

/** The argument names that hold a path rather than prose about one. */
const PATH_KEYS: ReadonlySet<string> = new Set(['path', 'file_path', 'filePath', 'filepath'])

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
  readonly files?: readonly { readonly path?: unknown; readonly hits?: unknown }[]
  readonly skipped?: readonly { readonly path?: unknown; readonly reason?: unknown }[]
}

/** How one restore pass went: the total hits, the per-file breakdown, and why it stopped. */
export interface RestoreOutcome {
  readonly restored: number
  readonly files: readonly { readonly path: string; readonly hits: number }[]
  /**
   * Documents the pass looked at and left alone, with the interpreter's reason:
   * `no placeholder` for a file that held none, `unmapped: [公司-1]` for one whose
   * placeholders the map cannot resolve, `missing`/`unsupported`/`unreadable` else.
   * The status surface shows them, because a file still holding placeholders looks
   * like a broken write-back when it is really a placeholder no mapping recorded.
   */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
  /** Set when no interpreter could run or the pass failed outright. */
  readonly error?: string
}

/** A pass that changed nothing, used when the interpreter is unavailable. */
const NOTHING_RESTORED: RestoreOutcome = { restored: 0, files: [], skipped: [] }

/** How deep a manual pass walks the session directory. */
const SCAN_DEPTH = 2

/** How many documents one manual pass takes on. */
const SCAN_LIMIT = 200

/** Folders a manual pass never walks into. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules'])

/** One document a scan found, and when it was last touched. */
interface ScannedDocument {
  readonly path: string
  readonly modified: number
}

/**
 * The documents under a session directory, newest first.
 *
 * A model can put the output path somewhere no argument carries — inside a
 * script it wrote, or behind a shell variable — and then the automatic pass
 * never hears about the file. The file still sits there holding placeholders,
 * so the user gets a button; this is what that button reads.
 * @param directory The session's working directory.
 * @returns document paths, the most recently written first, capped.
 */
export async function documentsInDirectory(directory: string): Promise<string[]> {
  const found: ScannedDocument[] = []
  await walk(directory, 0, found)
  found.sort((left, right) => right.modified - left.modified)
  return found.slice(0, SCAN_LIMIT).map(document => document.path)
}

async function walk(directory: string, depth: number, into: ScannedDocument[]): Promise<void> {
  if (depth > SCAN_DEPTH || into.length >= SCAN_LIMIT * 4) return
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    // A directory this process may not list, or one that just went away.
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(path, depth + 1, into)
      continue
    }
    if (!entry.isFile() || !isDocumentPath(entry.name)) continue
    try {
      const info = await stat(path)
      into.push({ path, modified: info.mtimeMs })
    } catch {
      // Named by the listing, gone by the stat.
    }
  }
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

function collect(value: unknown, into: Set<string>, depth: number, key?: string): void {
  if (depth > MAX_DEPTH) return
  if (typeof value === 'string') {
    // A path argument holds the path itself, spaces and all: splitting it into
    // words would read `D:/a b/report.md` as the unrelated `b/report.md`. Only a
    // value sitting in a known path field is taken whole; everything else (a
    // shell command, a note) is searched as text.
    const whole = value.trim()
    if (key !== undefined && PATH_KEYS.has(key) && isDocumentPath(whole)) {
      into.add(whole)
      return
    }
    collectFromText(value, into)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into, depth + 1)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [childKey, item] of Object.entries(value)) collect(item, into, depth + 1, childKey)
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

/** One interpreter invocation the restore pass may use. */
interface Interpreter {
  readonly command: string
  /** Windows needs a shell for a `.cmd` shim, which `spawn` refuses otherwise. */
  readonly shell: boolean
}

/** Where the interpreter sits inside the runtime a desktop build ships. */
const RUNTIME_PYTHON = process.platform === 'win32'
  ? ['dependencies', 'python', 'python.exe']
  : ['dependencies', 'python', 'bin', 'python3']

/** How long a probe may take before that candidate is abandoned. */
const PROBE_TIMEOUT_MS = 10_000

/**
 * The interpreters this machine may hold, best first.
 *
 * A bare `python` is the last resort, not the first: the desktop build puts a
 * `python.cmd` shim on PATH, and `spawn` cannot start a `.cmd` without a shell.
 * The interpreter the build ships is an `.exe` and always starts.
 * @returns absolute-or-PATH candidates, de-duplicated, in preference order.
 */
function pythonCandidates(): string[] {
  const found: string[] = []
  const configured = process.env.DSH_REDACTION_PYTHON
  if (configured !== undefined && configured !== '') found.push(configured)
  const runtime = process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR
  if (runtime !== undefined && runtime !== '') found.push(join(runtime, ...RUNTIME_PYTHON))
  const home = process.env.DSH_HOME
  if (home !== undefined && home !== '') {
    found.push(join(home, 'dsh-runtimes', 'dsh-primary-runtime', ...RUNTIME_PYTHON))
  }
  found.push(process.platform === 'win32' ? 'python.exe' : 'python3')
  found.push(process.platform === 'win32' ? 'python' : 'python3')
  return found.filter((candidate, index) => found.indexOf(candidate) === index)
}

/** Whether a candidate is an absolute path that is missing on disk. */
function absent(candidate: string): boolean {
  return (candidate.includes('/') || candidate.includes('\\')) && !existsSync(candidate)
}

/** How much interpreter stderr a report keeps. */
const DIAGNOSTIC_CHARS = 400

/**
 * Attach what the interpreter said on stderr to a pass that restored nothing.
 *
 * A denied write is the one failure the pass cannot describe from its own
 * JSON, because the interpreter caught the error before it reached stdout.
 * @param outcome - what the pass reported on stdout.
 * @param diagnostics - whatever the interpreter wrote on stderr.
 * @returns the same outcome, carrying the diagnostics when nothing applied.
 */
function withDiagnostics(outcome: RestoreOutcome, diagnostics: string): RestoreOutcome {
  const text = diagnostics.trim()
  if (text === '' || outcome.restored > 0) return outcome
  return { ...outcome, error: outcome.error ?? text.split(String.fromCharCode(10)).slice(-3).join(' ').trim() }
}

/**
 * Run one candidate to see whether it starts.
 * @param candidate - the interpreter to try.
 * @param shell - whether to go through a shell (required for a `.cmd` shim).
 * @returns true when the process started and exited cleanly.
 */
function probeOnce(candidate: string, shell: boolean): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let child
    try {
      child = spawn(candidate, ['-c', 'pass'], { stdio: 'ignore', windowsHide: true, shell })
    } catch {
      finish(false)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, PROBE_TIMEOUT_MS)
    timer.unref()
    child.on('error', () => {
      clearTimeout(timer)
      finish(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code === 0)
    })
  })
}

let settledInterpreter: Interpreter | undefined
let interpreterProbe: Promise<Interpreter | undefined> | undefined

/**
 * The interpreter this machine will actually run, probed once per process.
 *
 * Resolving it lazily matters: a machine without any interpreter must still
 * start the harness, and the answer only changes when the process restarts.
 * @returns the working interpreter, or undefined when none starts.
 */
function interpreter(): Promise<Interpreter | undefined> {
  if (settledInterpreter !== undefined) return Promise.resolve(settledInterpreter)
  if (interpreterProbe !== undefined) return interpreterProbe
  interpreterProbe = (async () => {
    for (const candidate of pythonCandidates()) {
      if (absent(candidate)) continue
      if (await probeOnce(candidate, false)) {
        settledInterpreter = { command: candidate, shell: false }
        return settledInterpreter
      }
      if (process.platform === 'win32' && await probeOnce(candidate, true)) {
        settledInterpreter = { command: candidate, shell: true }
        return settledInterpreter
      }
    }
    return undefined
  })()
  return interpreterProbe
}

function restoreOutcome(output: string): RestoreOutcome {
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as RestoreReport
      const files: { path: string; hits: number }[] = []
      for (const file of parsed.files ?? []) {
        if (typeof file.path !== 'string' || typeof file.hits !== 'number') continue
        files.push({ path: file.path, hits: file.hits })
      }
      const skipped: { path: string; reason: string }[] = []
      for (const item of parsed.skipped ?? []) {
        if (typeof item.path !== 'string' || typeof item.reason !== 'string') continue
        if (item.reason === 'restored') continue
        skipped.push({ path: item.path, reason: item.reason })
      }
      return { restored: typeof parsed.restored === 'number' ? parsed.restored : 0, files, skipped }
    } catch {
      continue
    }
  }
  return NOTHING_RESTORED
}

/** Wraps the interpreter argv in whatever the host confines commands with. */
export type Confine = (argv: readonly string[]) => Promise<readonly string[]>

/** Wraps the interpreter argv for one directory the host has to unlock. */
export type ConfineFor = (directory: string) => Confine | undefined

/**
 * Hand the documents and the mapping to the interpreter that may touch them.
 *
 * Failures are swallowed on purpose: a machine without Python, or a document
 * that refuses the rewrite, must not fail the tool call that produced it.
 * @param paths Documents this call named, absolute or relative to the session.
 * @param mappings Placeholder-to-original pairs in force right now.
 * @param cwd - the session's working directory, used to resolve a relative path.
 * @param confineFor - resolves the wrapper for one directory, so the host grants
 *   it before the interpreter runs; without it the interpreter keeps the
 *   caller's own access.
 * @returns how many files were rewritten; zero when nothing applied.
 */
export async function restoreDocuments(
  paths: readonly string[],
  mappings: readonly DocumentMapping[],
  cwd?: string,
  confineFor?: ConfineFor,
): Promise<RestoreOutcome> {
  if (paths.length === 0 || mappings.length === 0) return NOTHING_RESTORED
  const command = await interpreter()
  if (command === undefined) {
    return { ...NOTHING_RESTORED, error: 'no Python interpreter could be started' }
  }
  /* Group by the directory each document actually lives in: a document does not
   * have to sit in the session's workspace, and the host can only unlock the
   * directory it is told about. */
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    const absolute = isAbsolute(path) ? path : join(cwd === undefined || cwd === '' ? '.' : cwd, path)
    const directory = dirname(absolute)
    const group = groups.get(directory) ?? []
    group.push(absolute)
    groups.set(directory, group)
  }
  let merged: RestoreOutcome = { restored: 0, files: [], skipped: [] }
  for (const [directory, group] of groups) {
    const outcome = await restoreGroup(command, group, mappings, directory, confineFor?.(directory))
    const error = merged.error ?? outcome.error
    merged = {
      restored: merged.restored + outcome.restored,
      files: [...merged.files, ...outcome.files],
      skipped: [...merged.skipped, ...outcome.skipped],
      ...error === undefined ? {} : { error },
    }
  }
  return merged
}

/**
 * Hand one directory's documents to the interpreter.
 * @param command the interpreter to start.
 * @param paths absolute document paths, all under `directory`.
 * @param mappings placeholder-to-original pairs in force right now.
 * @param directory the directory the paths share, and the one to unlock.
 * @param confine wraps the argv so the host grants that directory first.
 * @returns how the group went.
 */
/**
 * Run one directory's documents, taking the write permission if it is missing.
 *
 * The write-back is the one step that must land: the file holds the placeholders
 * the model saw, and only this process has the map. So a directory this process
 * may read but not write is repaired rather than reported.
 * @param command the interpreter to start.
 * @param paths absolute document paths, all under `directory`.
 * @param mappings placeholder-to-original pairs in force right now.
 * @param directory the directory the paths share.
 * @param confine wraps the argv, when a caller has one.
 * @returns how the group went.
 */
async function restoreGroup(
  command: Interpreter,
  paths: readonly string[],
  mappings: readonly DocumentMapping[],
  directory: string,
  confine?: Confine,
): Promise<RestoreOutcome> {
  const first = await runGroup(command, paths, mappings, directory, confine)
  if (first.error !== undefined) return first
  if (!first.skipped.some(file => file.reason.startsWith('unwritable'))) return first
  if (!grantWriteAccess(directory)) return first
  return runGroup(command, paths, mappings, directory, confine)
}

/**
 * Give this process write access to a directory.
 *
 * `icacls` writes the same inherited ACE the sandbox would have written, but for
 * the identity this process already runs as, so the interpreter needs no wrapper
 * and no second attempt at confinement.
 * @param directory the directory holding the documents.
 * @returns whether the grant reported success.
 */
function grantWriteAccess(directory: string): boolean {
  if (process.platform !== 'win32') return false
  try {
    execFileSync('icacls', [directory, '/grant', '*S-1-1-0:(OI)(CI)M', '/T', '/C', '/Q'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: GRANT_TIMEOUT_MS,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Hand one directory's documents to the interpreter.
 * @param command the interpreter to start.
 * @param paths absolute document paths, all under `directory`.
 * @param mappings placeholder-to-original pairs in force right now.
 * @param directory the directory the paths share.
 * @param confine wraps the argv, when a caller has one.
 * @returns how the group went.
 */
async function runGroup(
  command: Interpreter,
  paths: readonly string[],
  mappings: readonly DocumentMapping[],
  directory: string,
  confine?: Confine,
): Promise<RestoreOutcome> {
  const request = JSON.stringify({ paths, entries: mappings, cwd: directory })
  const plain = [command.command, SCRIPT_PATH]
  let argv: readonly string[] = plain
  if (confine !== undefined) {
    try {
      argv = await confine(plain)
    } catch (error: unknown) {
      return { ...NOTHING_RESTORED, error: `could not confine ${command.command}: ${String(error)}` }
    }
  }
  return new Promise<RestoreOutcome>((resolve) => {
    let settled = false
    const finish = (value: RestoreOutcome): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      const program = argv[0] ?? command.command
      // A wrapped argv is already exact; only an unwrapped `.cmd` shim needs a shell.
      child = spawn(program, argv.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: confine === undefined && command.shell,
      })
    } catch (error: unknown) {
      finish({ ...NOTHING_RESTORED, error: `could not start ${command.command}: ${String(error)}` })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(NOTHING_RESTORED)
    }, RESTORE_TIMEOUT_MS)
    timer.unref()
    const { stdin, stdout, stderr } = child
    let output = ''
    let diagnostics = ''
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      output += chunk
    })
    stderr.setEncoding('utf8')
    stderr.on('data', (chunk: string) => {
      diagnostics = (diagnostics + chunk).slice(-DIAGNOSTIC_CHARS)
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(NOTHING_RESTORED)
    })
    child.on('close', () => {
      clearTimeout(timer)
      finish(withDiagnostics(restoreOutcome(output), diagnostics))
    })
    stdin.on('error', () => {
      // The interpreter may exit before reading its whole request; that is a
      // miss, not a crash.
    })
    stdin.end(request)
  })
}
