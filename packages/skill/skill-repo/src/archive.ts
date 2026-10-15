/**
 * Fetch and unpack the branch archive of the skills repository.
 *
 * The mirror only ever needs the working tree at one branch tip, and the desktop
 * application may run on a machine with no git binary at all. Reading the archive
 * the host publishes beside the git remote therefore replaces `git clone`
 * entirely, which keeps the sync working on a bare Windows install.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** Archive larger than this is refused instead of buffered in memory. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
/** Every tar entry is described by this many bytes. */
const TAR_BLOCK_BYTES = 512
const TAR_NAME_OFFSET = 0
const TAR_NAME_BYTES = 100
const TAR_SIZE_OFFSET = 124
const TAR_SIZE_BYTES = 12
const TAR_TYPE_OFFSET = 156
const TAR_PREFIX_OFFSET = 345
const TAR_PREFIX_BYTES = 155

/** One entry read out of a tar stream. */
export interface ArchiveEntry {
  /** Path relative to the archive root, with the leading directory stripped. */
  readonly path: string
  readonly content: Buffer
  /** Directories carry no payload but must still be created before their children. */
  readonly directory: boolean
}

/**
 * URL of the branch archive published beside a git remote that ends in `.git`.
 * @param remote Remote URL of the repository.
 * @param branch Branch whose tip the archive holds.
 * @returns The archive URL for that branch.
 */
export function archiveUrl(remote: string, branch: string): string {
  const base = remote.endsWith('.git') ? remote.slice(0, -'.git'.length) : remote
  return `${base.replace(/\/+$/u, '')}/archive/${branch}.tar.gz`
}

/**
 * Owner and repository of a gitea remote, or undefined when the remote is not one.
 * @param remote Remote URL of the repository.
 * @returns The API origin and `owner/name`, or undefined when the remote is not a gitea one.
 */
export function archiveCoordinates(remote: string): { api: string; repository: string } | undefined {
  const base = remote.endsWith('.git') ? remote.slice(0, -'.git'.length) : remote
  const trimmed = base.replace(/\/+$/u, '')
  const match = /^(?<api>https?:\/\/[^/]+)\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/u.exec(trimmed)
  const groups = match?.groups
  if (groups === undefined) return undefined
  const { api, owner, repo } = groups
  if (api === undefined || owner === undefined || repo === undefined) return undefined
  return { api, repository: `${owner}/${repo}` }
}

function readAscii(source: Buffer, offset: number, length: number): string {
  const field = source.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.byteLength : end).toString('utf8')
}

function readOctal(source: Buffer, offset: number, length: number): number {
  const text = readAscii(source, offset, length).trim()
  if (text === '') return 0
  const parsed = Number.parseInt(text, 8)
  return Number.isNaN(parsed) ? 0 : parsed
}

function isBlankBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false
  return true
}

function joinEntryPath(name: string, prefix: string): string {
  return prefix === '' ? name : `${prefix}/${name}`
}

/**
 * Read one tar stream into memory.
 *
 * Only the kinds this archive contains are honoured: directories, regular files
 * and the long-name and pax records git's archiver emits for deep paths. Anything
 * else (links, devices, sparse files) is skipped rather than materialised.
 * @param tar Uncompressed tar bytes.
 * @param stripComponents Leading path segments to drop from every entry.
 * @returns Every honoured entry, in archive order.
 */
export function readArchive(tar: Buffer, stripComponents: number): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  let offset = 0
  let pendingName: string | undefined
  while (offset + TAR_BLOCK_BYTES <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES)
    offset += TAR_BLOCK_BYTES
    if (isBlankBlock(header)) {
      const next = tar.subarray(offset, offset + TAR_BLOCK_BYTES)
      if (next.byteLength < TAR_BLOCK_BYTES || isBlankBlock(next)) break
      continue
    }
    const size = readOctal(header, TAR_SIZE_OFFSET, TAR_SIZE_BYTES)
    const kind = String.fromCharCode(header[TAR_TYPE_OFFSET] ?? 0)
    const body = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
    if (kind === 'L' || kind === 'x') {
      /* Both records carry the real path of the next entry as their whole payload. */
      pendingName = body.toString('utf8').replace(/\0+$/u, '').replace(/\n$/u, '')
      continue
    }
    const declared = pendingName ?? joinEntryPath(
      readAscii(header, TAR_NAME_OFFSET, TAR_NAME_BYTES),
      readAscii(header, TAR_PREFIX_OFFSET, TAR_PREFIX_BYTES),
    )
    pendingName = undefined
    const segments = declared.split('/').filter(segment => segment !== '')
    if (segments.length <= stripComponents) continue
    const path = segments.slice(stripComponents).join('/')
    const file = kind === '0' || kind === '\0' || kind === ''
    entries.push({ path, content: file ? Buffer.from(body) : Buffer.alloc(0), directory: kind === '5' })
  }
  return entries.filter(entry => entry.path !== '')
}

/**
 * Download the branch archive and return its uncompressed tar bytes.
 * @param url Archive URL to fetch.
 * @param timeoutMs Per-request timeout.
 * @returns The uncompressed tar bytes.
 * @throws If the host refuses the request, the body is empty, or the archive is over the size limit.
 */
export async function downloadArchive(url: string, timeoutMs: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    throw new Error(`archive request for ${url} failed with ${String(response.status)}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive at ${url} is ${String(bytes.byteLength)} bytes, over the ${String(MAX_ARCHIVE_BYTES)} byte limit`)
  }
  return gunzipSync(bytes)
}

/**
 * Write every entry under `destination`, skipping paths that would escape it.
 * @param entries Entries to materialise.
 * @param destination Directory the archive root becomes.
 */
export async function writeArchive(entries: readonly ArchiveEntry[], destination: string): Promise<void> {
  const root = resolve(destination)
  await mkdir(root, { recursive: true })
  for (const entry of entries) {
    const target = resolve(root, entry.path)
    if (target !== root && !target.startsWith(`${root}${sep}`)) continue
    if (entry.directory) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, entry.content)
  }
}

/** Commit id inside the branch payload of the gitea API, when it carries one. */
function revisionId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('commit' in body)) return null
  const commit = body.commit
  if (typeof commit !== 'object' || commit === null || !('id' in commit)) return null
  return typeof commit.id === 'string' ? commit.id : null
}

/**
 * Commit the branch currently points at, or null when the host does not answer.
 * @param remote Remote URL of the repository.
 * @param branch Branch to read.
 * @param timeoutMs Per-request timeout.
 * @returns The commit id, or null when the remote is not a gitea one or does not answer.
 */
export async function branchRevision(remote: string, branch: string, timeoutMs: number): Promise<string | null> {
  const coordinates = archiveCoordinates(remote)
  if (coordinates === undefined) return null
  const url = `${coordinates.api}/api/v1/repos/${coordinates.repository}/branches/${encodeURIComponent(branch)}`
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    return revisionId(await response.json())
  } catch {
    return null
  }
}
