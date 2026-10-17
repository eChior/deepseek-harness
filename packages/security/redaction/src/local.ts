/**
 * Term lists uploaded on this machine.
 *
 * The published list covers what the whole company must not leak; it cannot cover
 * what one department knows and the publisher does not. This module is that gap —
 * a directory beside the cache where a department drops its own list in the same
 * format, which the provider then compiles together with the published one.
 *
 * An upload is constrained twice. Its name is normalized into the directory, so a
 * name cannot address anything else on disk. Its contents are parsed, and every
 * pattern is measured against a sample prompt before the file is accepted: a
 * pattern that matches the whole sample would turn every request into a single
 * placeholder, so refusing it here is what stops a well-meaning edit from
 * disabling the guard by accident.
 */
import { Buffer } from 'node:buffer'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseTermList, type ParsedTermList, type TermListProblem } from './terms.ts'

/** Subdirectory of the cache directory holding uploaded lists. */
export const LOCAL_DIRECTORY = 'local'

/** Accepted name stem: no separators, and never a bare dot file. */
const LOCAL_FILE_STEM = /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9._\u4e00-\u9fa5-]{0,63}$/u

/** Extension every upload is stored under, whatever the upload was called. */
const LOCAL_FILE_EXTENSION = '.yaml'

/** Extensions an upload may arrive with; the contents are what decide its format. */
const UPLOAD_EXTENSION = /\.(?:ya?ml|txt)$/iu

/** Largest upload this machine accepts, in bytes. */
export const MAX_LOCAL_BYTES = 256 * 1024

/** How many uploaded lists one machine keeps. */
export const MAX_LOCAL_FILES = 32

/** Longest span one uploaded pattern may cover in {@link PATTERN_SAMPLE}. */
export const MAX_PATTERN_SPAN = 100

/**
 * Text a candidate pattern is measured against.
 *
 * It is one line of the kind a prompt about this work actually carries, longer
 * than {@link MAX_PATTERN_SPAN}, so a pattern written to match everything —
 * `.*`, `[\s\S]+`, `.{0,200}` — covers the whole thing and is refused, while a
 * pattern for an identifier covers a handful of characters and passes.
 */
const PATTERN_SAMPLE = '批号 231208 的中间体在 2026-03-11 完成干燥并取样，收率 87.3%，水分 2.1%，检验编号 CAM-SW-001，由二车间提交偏差 DEV-2026-014，涉及客户 A 公司的委托生产与工艺验证批次，按照 SOP-ST-AD-001-R6-01 处理并经 QA 复核签署。'

/** One uploaded list, as the settings page needs to describe it. */
export interface LocalTermFile {
  /** Name inside the upload directory, always ending in `.yaml`. */
  readonly name: string
  /** Size of the stored file, in bytes. */
  readonly bytes: number
  /** Revision the file declares, or null when it declares none. */
  readonly revision: string | null
  /** Department the upload credits, or null when it credits none. */
  readonly department: string | null
  /** Person the upload credits, or null when it credits none. */
  readonly author: string | null
  /** Whether the file takes part. An upload that says nothing here takes part. */
  readonly enabled: boolean
  /** Term entries the file declares. */
  readonly terms: number
  /** Regular expressions the file declares. */
  readonly patterns: number
  /** Everything wrong with the file; a file with problems is stored but not compiled. */
  readonly problems: readonly TermListProblem[]
}

/** One upload with its parsed contents. */
export interface LocalTermList {
  /** What the settings page shows for this file. */
  readonly file: LocalTermFile
  /** Parsed contents, whether or not {@link isUsable} accepts them. */
  readonly list: ParsedTermList
}

/** Raised when an upload is refused, carrying every reason it was refused. */
export class LocalTermError extends Error {
  /** Reasons the upload was refused, in the shape {@link parseTermList} reports. */
  readonly problems: readonly TermListProblem[]

  /**
   * @param message - what went wrong, for the operator log.
   * @param problems - the individual reasons, for the settings page.
   */
  constructor(message: string, problems: readonly TermListProblem[] = []) {
    super(message)
    this.name = 'LocalTermError'
    this.problems = problems
  }
}

/**
 * Directory holding the uploaded lists.
 * @param directory Cache directory the provider was configured with.
 * @returns Path of the upload directory, which need not exist yet.
 */
export function localDirectory(directory: string): string {
  return join(directory, LOCAL_DIRECTORY)
}

/**
 * Turn whatever a browser sent into a name inside the upload directory.
 * @param name Name the caller proposed, possibly with a path or another extension.
 * @returns The stored name, or undefined when nothing safe can be made of it.
 */
export function normalizeLocalName(name: string): string | undefined {
  const base = name.split(/[/\\]/u).pop() ?? ''
  const stem = base.replace(UPLOAD_EXTENSION, '')
  if (!LOCAL_FILE_STEM.test(stem)) return undefined
  return `${stem}${LOCAL_FILE_EXTENSION}`
}

/**
 * Longest span a pattern covers in {@link PATTERN_SAMPLE}.
 * @param pattern The expression as written in the upload.
 * @returns The longest match length, or 0 when the pattern does not compile.
 */
function coveredSpan(pattern: string): number {
  let regex: RegExp
  try {
    regex = new RegExp(pattern, 'g')
  } catch {
    return 0
  }
  let longest = 0
  for (const match of PATTERN_SAMPLE.matchAll(regex)) {
    if (match[0].length > longest) longest = match[0].length
  }
  return longest
}

/**
 * Everything wrong with a candidate upload.
 * @param text Contents the caller wants to store.
 * @returns Problems in the shape {@link parseTermList} reports; empty means acceptable.
 */
export function checkLocalText(text: string): TermListProblem[] {
  const problems: TermListProblem[] = []
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_LOCAL_BYTES) {
    problems.push({ line: 0, message: `the file is ${String(bytes)} bytes and the limit is ${String(MAX_LOCAL_BYTES)}` })
    return problems
  }
  const parsed = parseTermList(text)
  problems.push(...parsed.problems)
  if (parsed.categories.length === 0) problems.push({ line: 0, message: 'the file declares no category' })
  for (const category of parsed.categories) {
    for (const pattern of category.patterns) {
      const span = coveredSpan(pattern)
      if (span > MAX_PATTERN_SPAN) {
        problems.push({
          line: 0,
          message: `pattern ${pattern} covers ${String(span)} characters of a sample request, over the limit of ${String(MAX_PATTERN_SPAN)}; narrow it so it cannot replace a whole request`,
        })
      }
    }
  }
  return problems
}

/**
 * Describe one list for the settings page.
 * @param name Name it is stored under.
 * @param text Its contents.
 * @returns The description, including any problem the file carries.
 */
function describe(name: string, text: string): LocalTermFile {
  const parsed = parseTermList(text)
  let terms = 0
  let patterns = 0
  for (const category of parsed.categories) {
    terms += category.terms.length
    patterns += category.patterns.length
  }
  return {
    name,
    bytes: Buffer.byteLength(text, 'utf8'),
    revision: parsed.revision === '' ? null : parsed.revision,
    department: parsed.department ?? null,
    author: parsed.author ?? null,
    enabled: parsed.enabled ?? true,
    terms,
    patterns,
    problems: parsed.problems,
  }
}

/**
 * Read every uploaded list, parsed.
 *
 * A file that cannot be read is left out rather than reported: it is not a list the
 * provider can compile, and the settings page shows what is there.
 * @param directory Cache directory the provider was configured with.
 * @returns One entry per stored file, ordered by name; empty when nothing was uploaded.
 */
export async function readLocalTermLists(directory: string): Promise<LocalTermList[]> {
  const home = localDirectory(directory)
  let names: string[]
  try {
    names = (await readdir(home)).filter(name => name.endsWith(LOCAL_FILE_EXTENSION))
  } catch {
    /* Nothing uploaded yet: the directory is created by the first upload. */
    return []
  }
  const entries: LocalTermList[] = []
  for (const name of names.toSorted()) {
    try {
      const text = await readFile(join(home, name), 'utf8')
      entries.push({ file: describe(name, text), list: parseTermList(text) })
    } catch {
      /* Unreadable between the listing and the read: same as absent. */
    }
  }
  return entries
}

/**
 * Describe every uploaded list, without their parsed contents.
 * @param directory Cache directory the provider was configured with.
 * @returns One description per stored file, ordered by name.
 */
export async function listLocalTermFiles(directory: string): Promise<LocalTermFile[]> {
  return (await readLocalTermLists(directory)).map(entry => entry.file)
}

/** The one line a toggle rewrites. Anchored so a term that reads `enabled:` is not it. */
const LOCAL_ENABLED_LINE = /^enabled:.*$/mu

/**
 * Turn one stored list on or off by rewriting its single `enabled` line.
 *
 * Only that line changes, so the comments a department wrote in its own list —
 * often the only record of why a term is on it — survive being toggled.
 * @param directory Cache directory the provider was configured with.
 * @param name File name as it was uploaded.
 * @param enabled Whether the list should take part.
 * @returns The stored list as the settings page will describe it.
 * @throws {LocalTermError} When no list is stored under that name.
 */
export async function setLocalTermEnabled(directory: string, name: string, enabled: boolean): Promise<LocalTermFile> {
  const stored = normalizeLocalName(name)
  if (stored === undefined) throw new LocalTermError(`redaction: ${name} does not yield a usable file name`)
  let text: string
  try {
    text = await readFile(join(localDirectory(directory), stored), 'utf8')
  } catch {
    throw new LocalTermError(`redaction: no uploaded list is stored as ${stored}`)
  }
  const line = `enabled: ${String(enabled)}`
  const next = LOCAL_ENABLED_LINE.test(text) ? text.replace(LOCAL_ENABLED_LINE, line) : `${line}\n${text}`
  return await writeLocalTermFile(directory, stored, next)
}

/** Fields an upload is expected to carry, so one it wrote itself is left alone. */
const LOCAL_DEPARTMENT_LINE = /^department:/mu
const LOCAL_AUTHOR_LINE = /^author:/mu

/**
 * Name the department and person an upload did not name itself.
 *
 * The browser knows who is signed in, but the stored file is the only copy on
 * this machine: writing the submitter into it means a later reader sees who
 * handed the list in without trusting a side channel, and a department that
 * edits its own file can override what was stamped.
 * @param text Contents of the upload.
 * @param attribution Department and person to add when the text omits them.
 * @returns The text with the missing fields added; unchanged when it already names them.
 */
export function stampAttribution(text: string, attribution: { department?: string; author?: string }): string {
  const clean = (value: string): string => value.replaceAll(/[\r\n\t]/gu, ' ').trim()
  const department = attribution.department === undefined ? '' : clean(attribution.department)
  const author = attribution.author === undefined ? '' : clean(attribution.author)
  const lines: string[] = []
  if (department !== '' && !LOCAL_DEPARTMENT_LINE.test(text)) lines.push(`department: ${department}`)
  if (author !== '' && !LOCAL_AUTHOR_LINE.test(text)) lines.push(`author: ${author}`)
  if (lines.length === 0) return text
  return `${lines.join('\n')}\n${text}`
}

/**
 * Store an upload, refusing anything that would make the guard worse.
 * @param directory Cache directory the provider was configured with.
 * @param name Name the caller proposed, from the browser's file picker.
 * @param text Contents of the upload.
 * @returns The stored list as the settings page will describe it.
 * @throws {LocalTermError} When the name is unusable, the directory is full, or the contents are refused.
 */
export async function writeLocalTermFile(directory: string, name: string, text: string): Promise<LocalTermFile> {
  const stored = normalizeLocalName(name)
  if (stored === undefined) throw new LocalTermError(`redaction: ${name} does not yield a usable file name`)
  const problems = checkLocalText(text)
  if (problems.length > 0) throw new LocalTermError('redaction: the uploaded list was refused', problems)
  const existing = await listLocalTermFiles(directory)
  if (existing.length >= MAX_LOCAL_FILES && !existing.some(file => file.name === stored)) {
    throw new LocalTermError(`redaction: this machine already holds ${String(MAX_LOCAL_FILES)} uploaded lists`)
  }
  const home = localDirectory(directory)
  await mkdir(home, { recursive: true })
  const target = join(home, stored)
  const temporary = `${target}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, target)
  return describe(stored, text)
}

/**
 * Delete one upload.
 * @param directory Cache directory the provider was configured with.
 * @param name Name as {@link readLocalTermLists} reported it.
 * @returns True when a file was removed, false when there was nothing to remove.
 */
export async function removeLocalTermFile(directory: string, name: string): Promise<boolean> {
  const stored = normalizeLocalName(name)
  if (stored === undefined) return false
  try {
    await rm(join(localDirectory(directory), stored))
    return true
  } catch {
    return false
  }
}
