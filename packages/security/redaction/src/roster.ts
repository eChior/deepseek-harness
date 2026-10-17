/**
 * The staff directory, read from the ciphertext this build ships.
 *
 * The roster exists for two jobs: naming the department of whoever uploads a
 * department term list, and turning every colleague and department into a term
 * the redaction can substitute. Both need the names, and neither may put them
 * in the repository, in a build log, or in the session — so the only copy that
 * travels is `assets/roster.bin`, sealed with AES-256-GCM by
 * `scripts/build-roster.py`, and everything here works on the plaintext that
 * comes out of it in memory.
 *
 * The key is shared with that script. It keeps a colleague list out of a casual
 * read of the source tree or the installed bundle; it does not stop someone who
 * has both the file and the repository from extracting it.
 */
import { createDecipheriv } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const MAGIC = Buffer.from('RSTR', 'utf8')
const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
/** Ciphertext this build ships, next to the code that opens it. */
export const ROSTER_PATH = fileURLToPath(new URL('../assets/roster.bin', import.meta.url))
const ROSTER_KEY_PATH = fileURLToPath(new URL('../assets/roster.key', import.meta.url))

/** One colleague, as the QMS export describes them. */
export interface RosterPerson {
  /** Display name, the key every lookup uses. */
  readonly name: string
  /** Department the person belongs to. */
  readonly department: string
  /** Employee number, an identifier worth redacting. */
  readonly employeeId: string
  /** Job title. */
  readonly position: string
  /** LDAP account, another identifier worth redacting. */
  readonly account: string
  /** QMS person id, the identifier the quality system uses. */
  readonly qmsId: string
  /** False for anyone the export no longer lists as employed. */
  readonly active: boolean
}

/** The whole directory. */
export interface Roster {
  /** Revision stamp recorded when the file was built. */
  readonly revision: string
  /** Every colleague in the directory. */
  readonly people: readonly RosterPerson[]
  /** Every department name, deduplicated. */
  readonly departments: readonly string[]
}

/** Raised when the roster file cannot be trusted or cannot be read. */
export class RosterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RosterError'
  }
}

/**
 * The key to open the roster with, as the environment supplies it.
 *
 * No key is written into source. A build reads it from the CI secret, writes
 * `assets/roster.key` next to the ciphertext, and that file stays out of the
 * repository; `DSH_ROSTER_KEY` wins when it is set, which is how tests and a
 * deployment that would rather hold its own key both get their way.
 * @returns The hex key, or an empty string when the environment has none.
 */
export function rosterKey(): string {
  const supplied = process.env['DSH_ROSTER_KEY']
  return supplied === undefined ? '' : supplied
}

/**
 * Resolve the key: the environment first, then the file a build wrote.
 * @returns The hex key, or an empty string when the build shipped none.
 */
async function shippedKey(): Promise<string> {
  const fromEnvironment = rosterKey()
  if (fromEnvironment !== '') return fromEnvironment
  try {
    return (await readFile(ROSTER_KEY_PATH, 'utf8')).trim()
  } catch {
    return ''
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readPerson(value: unknown): RosterPerson | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const name = text(record['name'])
  if (name === '') return undefined
  return {
    name,
    department: text(record['department']),
    employeeId: text(record['employeeId']),
    position: text(record['position']),
    account: text(record['account']),
    qmsId: text(record['qmsId']),
    active: record['active'] !== false,
  }
}

/**
 * Open the roster payload.
 * @param bytes File contents as `assets/roster.bin` holds them.
 * @param keyHex Hex key to decrypt with; defaults to {@link rosterKey}.
 * @returns The directory.
 * @throws RosterError when the header, the version, the key, or the tag is wrong.
 */
export function parseRoster(bytes: Buffer, keyHex: string = rosterKey()): Roster {
  const start = MAGIC.length + 1
  if (bytes.length < start + IV_BYTES + TAG_BYTES) {
    throw new RosterError('the roster file is truncated')
  }
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new RosterError('the roster file does not start with RSTR')
  }
  const version = bytes[MAGIC.length] ?? 0
  if (version !== VERSION) {
    throw new RosterError(`the roster file is version ${String(version)}, this build reads ${String(VERSION)}`)
  }
  const key = Buffer.from(keyHex, 'hex')
  if (key.length !== 32) {
    throw new RosterError('the roster key is not a 32-byte hex string')
  }

  const iv = bytes.subarray(start, start + IV_BYTES)
  const tag = bytes.subarray(start + IV_BYTES, start + IV_BYTES + TAG_BYTES)
  const body = bytes.subarray(start + IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(bytes.subarray(0, start))
  decipher.setAuthTag(tag)
  let payload: string
  try {
    payload = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    throw new RosterError('the roster file did not decrypt; the key and the file come from different builds')
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(payload)
  } catch {
    throw new RosterError('the roster payload is not JSON')
  }
  if (typeof decoded !== 'object' || decoded === null) {
    throw new RosterError('the roster payload is not an object')
  }
  const record = decoded as Record<string, unknown>
  const rawPeople = record['people']
  const rawDepartments = record['departments']
  const people: RosterPerson[] = []
  if (Array.isArray(rawPeople)) {
    for (const entry of rawPeople) {
      const person = readPerson(entry)
      if (person !== undefined) people.push(person)
    }
  }
  const departments: string[] = []
  if (Array.isArray(rawDepartments)) {
    for (const entry of rawDepartments) {
      const name = text(entry)
      if (name !== '' && !departments.includes(name)) departments.push(name)
    }
  }
  for (const person of people) {
    if (person.department !== '' && !departments.includes(person.department)) {
      departments.push(person.department)
    }
  }
  return { revision: text(record['revision']), people, departments }
}

/**
 * Read and open the roster that ships with this build.
 * @param path File to read; defaults to the bundled asset.
 * @returns The directory.
 * @throws RosterError when the file is missing or cannot be opened.
 */
export async function readRoster(path: string = ROSTER_PATH): Promise<Roster> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    throw new RosterError(`no roster ships at ${path}`)
  }
  return parseRoster(bytes, await shippedKey())
}

/**
 * Find one colleague by the name the account reports.
 * @param roster Directory to search.
 * @param name Display name, matched exactly after trimming.
 * @returns The colleague, or undefined when the name is not on the list.
 */
export function findPerson(roster: Roster, name: string): RosterPerson | undefined {
  const wanted = name.trim()
  if (wanted === '') return undefined
  return roster.people.find(person => person.name === wanted)
}

/**
 * Every colleague and department name, ready to become term-list entries.
 * @param roster Directory to mine.
 * @param options `activeOnly` keeps departed colleagues out of the vocabulary.
 * @returns Names and departments, longest first so overlapping ones resolve well.
 */
export function rosterVocabulary(roster: Roster, options: { activeOnly?: boolean } = {}): string[] {
  const activeOnly = options.activeOnly !== false
  const words = new Set<string>(roster.departments)
  for (const person of roster.people) {
    if (activeOnly && !person.active) continue
    words.add(person.name)
  }
  words.delete('')
  return [...words].sort((left, right) => right.length - left.length || left.localeCompare(right))
}
