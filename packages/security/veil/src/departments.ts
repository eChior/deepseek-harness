/**
 * One term list per department, and which of them are in force.
 *
 * The published list covers the company; a department's own list covers the
 * wording only that department uses. Two things decide whether a list applies:
 * the department the signed-in colleague belongs to, which is on by default, and
 * the boxes the reader ticked, which is how a list another department maintains
 * joins a conversation.
 *
 * The lists themselves arrive from the same repository as the published list, so
 * a department edits its own file and every client picks the change up within one
 * refresh interval.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseTermList } from './terms.ts'
import { describe, readTermListsIn, stampAttribution, type LocalTermFile, type LocalTermList } from './local.ts'

/** Directory under the cache that holds the department lists. */
export const DEPARTMENT_DIRECTORY = 'departments'

/** File that records the reader's choice. */
export const DEPARTMENT_STATE = 'departments.json'

/** A department list is one YAML file named after its department. */
const DEPARTMENT_FILE = /\.ya?ml$/iu

/** Which department lists the reader switched on, and which they switched off. */
export interface DepartmentSelection {
  /** Lists the reader ticked. */
  readonly enabled: readonly string[]
  /** Lists the reader unticked, which overrides the automatic one. */
  readonly disabled: readonly string[]
}

/** Nothing ticked and nothing refused: only the reader's own department applies. */
const DEFAULT_SELECTION: DepartmentSelection = { enabled: [], disabled: [] }

/**
 * Directory holding the department lists.
 * @param directory The provider's cache directory.
 * @returns Absolute path of the department directory.
 */
export function departmentsDirectory(directory: string): string {
  return join(directory, DEPARTMENT_DIRECTORY)
}

function departmentName(name: string): string {
  return name.replace(DEPARTMENT_FILE, '')
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/**
 * Read which department lists the reader switched on or off.
 *
 * A record that cannot be read — never written, half-written, edited by hand into
 * something else — counts as nothing chosen, so the reader's own department still
 * applies instead of the feature going silent.
 * @param directory The provider's cache directory.
 * @returns The selection in force.
 */
export async function readDepartmentSelection(directory: string): Promise<DepartmentSelection> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, DEPARTMENT_STATE), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SELECTION
    const record = parsed as { enabled?: unknown; disabled?: unknown }
    return { enabled: names(record.enabled), disabled: names(record.disabled) }
  } catch {
    return DEFAULT_SELECTION
  }
}

/**
 * Record the reader's choice.
 * @param directory The provider's cache directory.
 * @param selection The selection to keep.
 */
export async function writeDepartmentSelection(directory: string, selection: DepartmentSelection): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, DEPARTMENT_STATE), `${JSON.stringify(selection, null, 2)}\n`, 'utf8')
}

/**
 * Read every department list on this machine.
 * @param directory The provider's cache directory.
 * @returns One entry per readable list, ordered by department name.
 */
export async function readDepartmentLists(directory: string): Promise<LocalTermList[]> {
  return readTermListsIn(departmentsDirectory(directory))
}

/**
 * Store one department list, stamped with the department it belongs to.
 * @param directory The provider's cache directory.
 * @param name Department the list belongs to.
 * @param text The list as published.
 * @returns The stored file's description.
 */
export async function writeDepartmentList(directory: string, name: string, text: string): Promise<LocalTermFile> {
  const home = departmentsDirectory(directory)
  await mkdir(home, { recursive: true })
  const stamped = stampAttribution(text, { department: name })
  await writeFile(join(home, `${name}.yaml`), stamped, 'utf8')
  return describe(`${name}.yaml`, stamped)
}

/**
 * Whether a department list applies to this reader.
 *
 * The reader's own department counts as ticked unless they unticked it, so a new
 * colleague is protected by their department without visiting a settings page.
 * @param selection What the reader ticked and unticked.
 * @param name Department the list belongs to.
 * @param own Department the signed-in colleague belongs to, or null when unknown.
 * @returns True when the list takes part in redaction.
 */
export function departmentApplies(selection: DepartmentSelection, name: string, own: string | null): boolean {
  if (selection.disabled.includes(name)) return false
  return selection.enabled.includes(name) || (own !== null && name === own)
}

/**
 * Department a stored list belongs to.
 *
 * The stamp inside the file wins over its name, so an operator may rename a file
 * without changing which department it protects.
 * @param file The stored list's description.
 * @returns Department name.
 */
export function departmentNameOf(file: LocalTermFile): string {
  return file.department ?? departmentName(file.name)
}

/**
 * The lists a reader can choose from, with the state that explains each one.
 * @param lists Every department list on this machine.
 * @param selection What the reader ticked and unticked.
 * @param own Department the signed-in colleague belongs to, or null when unknown.
 * @returns One entry per list, ordered by department name.
 */
export function describeDepartments(
  lists: readonly LocalTermList[],
  selection: DepartmentSelection,
  own: string | null,
): { name: string; enabled: boolean; own: boolean; terms: number; patterns: number; revision: string }[] {
  return lists.map((entry) => {
    const name = departmentNameOf(entry.file)
    return {
      name,
      enabled: departmentApplies(selection, name, own),
      own: own !== null && name === own,
      terms: entry.list.categories.reduce((count, category) => count + category.terms.length, 0),
      patterns: entry.list.categories.reduce((count, category) => count + category.patterns.length, 0),
      revision: entry.list.revision,
    }
  })
}

/**
 * Department names a repository publishes, so a client knows what to download.
 * @param names Every file name found in the department directory.
 * @returns Department names, one per YAML file, ordered.
 */
export function departmentNamesOf(names: readonly string[]): string[] {
  return [...new Set(names.filter(name => DEPARTMENT_FILE.test(name)).map(name => departmentName(name)))].toSorted()
}

/** Re-exported so the provider can parse a downloaded list without importing terms.ts twice. */
export { parseTermList }
