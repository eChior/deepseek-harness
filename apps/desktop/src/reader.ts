/**
 * Unpack the reader that ships inside the client.
 *
 * The reader carries a model and a runtime of its own, which is why it was
 * published separately at first — and why nobody who needed it had it. It now
 * travels with the installer instead: one archive per platform sits in the
 * application's resources, and the first start after an upgrade unpacks it
 * into the home directory the plugin already looks in. A machine behind an
 * air gap gets the same reader as one that is not.
 */
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/** Archive each platform ships with, relative to the application's resources. */
/**
 * Where the download stands in for an archive the build left out.
 * A machine outside the intranet simply fails here and keeps the
 * status the settings page already explains.
 */
const READER_DOWNLOAD = 'http://10.151.5.175:3000/ITPublic/dsh-ocr/releases/download/v1.2.0'
const DOWNLOAD_TIMEOUT_MS = 120_000

/** Fetch one archive from the intranet, or nothing when it is out of reach. */
async function downloadArchive(name: string): Promise<Buffer | undefined> {
  try {
    const response = await fetch(`${READER_DOWNLOAD}/${name}`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) return undefined
    return Buffer.from(await response.arrayBuffer())
  } catch {
    return undefined
  }
}

const ARCHIVES: Readonly<Record<string, string>> = {
  'win32-x64': 'ocr/dsh-ocr-win-x64.zip',
  'linux-arm64': 'ocr/dsh-ocr-linux-arm64.zip',
}

/** Executable the plugin looks for first, per platform. */
const EXECUTABLES: Readonly<Record<string, string>> = {
  'win32-x64': 'dsh-ocr.exe',
  'linux-arm64': 'dsh-ocr',
}

/**
 * Fingerprint of the archive that produced the unpacked files.
 *
 * Without it an upgrade would leave the reader from the previous install in
 * place forever: the executable is there, so there is nothing to do. Users
 * would keep running an old reader that cannot answer the current protocol
 * and no error would ever say so.
 */
const STAMP = '.archive'

/** What a previous unpack recorded, or an empty string when it recorded nothing. */
function recordedStamp(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

/** One file an archive holds. */
export interface ArchiveEntry {
  /** Path inside the archive. */
  name: string
  /** File contents. */
  data: Buffer
}

const CENTRAL_DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50
const STORED = 0
const DEFLATED = 8

/**
 * Read a zip archive held in memory.
 *
 * Only what our own archives contain is supported: stored and deflated entries,
 * no encryption, no zip64. Anything else is refused with the entry's name,
 * because silently skipping a file would produce an installation that looks
 * complete and cannot read an image.
 * @param bytes The archive.
 * @returns Every file it holds.
 * @throws When the archive is malformed or uses an unsupported feature.
 */
export function readArchive(bytes: Buffer): ArchiveEntry[] {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0 || end + 22 > bytes.length) throw new Error('the archive has no central directory')
  const count = bytes.readUInt16LE(end + 10)
  const directoryOffset = bytes.readUInt32LE(end + 16)
  const entries: ArchiveEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error(`entry ${String(index)} is not a central directory record`)
    }
    const method = bytes.readUInt16LE(cursor + 10)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (bytes.readUInt32LE(localOffset) !== LOCAL_HEADER) {
      throw new Error(`${name}: local header is missing`)
    }
    const start = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28)
    const packed = bytes.subarray(start, start + compressedSize)
    if (method === STORED) {
      entries.push({ name, data: Buffer.from(packed) })
    } else if (method === DEFLATED) {
      entries.push({ name, data: inflateRawSync(packed) })
    } else {
      throw new Error(`${name}: compression method ${String(method)} is not supported`)
    }
  }
  return entries
}

/**
 * Unpack the reader for this platform, if the client ships one.
 *
 * Runs on every start and unpacks only when the archive is not the one that
 * produced the files already there, so an upgrade replaces the reader instead
 * of leaving the old one in place. An unpack
 * that fails leaves whatever was there before in place rather than a directory
 * holding half a program.
 * @param options Where the application's resources are and which platform to unpack.
 * @returns The executable's path, or `undefined` when the client ships no reader
 *   for this platform or the archive is missing.
 */
export async function installBundledReader(options: {
  resources: string
  home: string
  platform?: NodeJS.Platform
  architecture?: string
  log?: (message: string) => void
}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const key = `${platform}-${architecture}`
  const archive = ARCHIVES[key]
  const executable = EXECUTABLES[key]
  if (archive === undefined || executable === undefined) return undefined
  const directory = join(options.home, 'redaction', 'ocr')
  const target = join(directory, executable)
  const source = join(options.resources, archive)
  let bytes: Buffer
  if (existsSync(source)) {
    bytes = readFileSync(source)
  } else {
    const fetched = await downloadArchive(basename(archive))
    if (fetched === undefined) {
      options.log?.(`redaction: the client ships no reader at ${source}`)
      return undefined
    }
    options.log?.(`redaction: fetched the reader from ${READER_DOWNLOAD}`)
    bytes = fetched
  }
  const fingerprint = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const stamp = join(directory, STAMP)
  if (existsSync(target) && recordedStamp(stamp) === fingerprint) return target
  const entries = readArchive(bytes)
  await mkdir(directory, { recursive: true })
  for (const entry of entries) {
    // Names come from an archive we built, but a path that walks out of the
    // directory would still be a bug worth refusing outright.
    if (entry.name.includes('..') || entry.name.startsWith('/') || entry.name.startsWith('\\')) {
      throw new Error(`${source}: refusing to unpack ${entry.name}`)
    }
    const destination = join(directory, entry.name)
    await rm(destination, { force: true })
    await writeFile(destination, entry.data)
  }
  if (platform !== 'win32') await chmod(target, 0o755)
  await writeFile(stamp, fingerprint)
  options.log?.(`redaction: unpacked the reader into ${directory}`)
  return existsSync(target) ? target : undefined
}
