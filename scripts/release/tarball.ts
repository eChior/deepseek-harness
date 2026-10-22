/**
 * Reading packed npm tarballs and the order file that accompanies them.
 *
 * The release steps after pack treat a directory of tarballs as the unit of
 * work, so they read what a tarball declares rather than what the checkout
 * currently says.
 *
 * Members are read from the archive headers instead of through `tar`. The
 * archives `pnpm pack` writes carry a pax record for a name a ustar header
 * cannot hold, and GNU tar rejects that record on a Windows lane ("Archive
 * entry has empty or unreadable filename") while reading the same archive
 * elsewhere. Parsing the headers is the one reader that behaves the same on
 * every lane.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** Name of the file recording the order in which a packed family uploads. */
export const PUBLISH_ORDER_FILE = 'publish-order.txt'

/** What a packed tarball calls itself. */
export interface PackedIdentity {
  /** Package name from the packed manifest. */
  readonly name: string
  /** Package version from the packed manifest. */
  readonly version: string
}

/** One member of a tar archive. */
interface Member {
  /** Path the archive records, with any pax or long-name override applied. */
  readonly path: string
  /** Type flag from the header; `0` is a regular file. */
  readonly type: string
  /** Member bytes. */
  readonly body: Buffer
}

/** Size of a tar header block. */
const BLOCK = 512

/** First byte of a gzip stream. */
const GZIP_MAGIC = 0x1f

/**
 * Read an octal field, tolerating both the NUL- and the space-terminated forms
 * that tar writers emit.
 * @param header - header block.
 * @param start - first byte of the field.
 * @param end - one past the last byte of the field.
 * @returns The number the field holds, or zero when it holds nothing readable.
 */
function octal(header: Buffer, start: number, end: number): number {
  const field = header.subarray(start, end).toString('ascii').replace(/[\0 ]+$/u, '').replace(/^ +/u, '')
  if (field === '') return 0
  const value = Number.parseInt(field, 8)
  return Number.isFinite(value) ? value : 0
}

/**
 * Read the name a header records, joining the ustar prefix when one is present.
 * @param header - header block.
 * @returns The path the header itself declares.
 */
function headerPath(header: Buffer): string {
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '')
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/su, '')
  return prefix === '' ? name : `${prefix}/${name}`
}

/**
 * Whether a block closes the archive.
 * @param block - a header-sized block.
 * @returns True when every byte is zero.
 */
function isTerminator(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false
  return true
}

/**
 * Decode the `key=value` records of a pax extended header.
 * @param body - the extended header's own bytes.
 * @returns The records, keyed by name.
 */
function paxRecords(body: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let offset = 0
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(body.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > body.length) break
    const record = body.subarray(space + 1, offset + length)
    const equals = record.indexOf(0x3d)
    if (equals > 0) {
      const key = record.subarray(0, equals).toString('utf8')
      records.set(key, record.subarray(equals + 1, record.length - 1).toString('utf8'))
    }
    offset += length
  }
  return records
}

/**
 * Walk every member of an uncompressed tar image.
 * @param bytes - the whole image.
 * @returns The members in the order the archive stores them.
 */
function membersOf(bytes: Buffer): Member[] {
  const members: Member[] = []
  let offset = 0
  let pending = new Map<string, string>()
  let longName: string | undefined
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK)
    if (isTerminator(header)) break
    const size = octal(header, 124, 136)
    const type = String.fromCharCode(header[156] ?? 0x30)
    const body = bytes.subarray(offset + BLOCK, offset + BLOCK + size)
    const next = offset + BLOCK + Math.ceil(size / BLOCK) * BLOCK
    if (type === 'x') {
      pending = paxRecords(body)
      offset = next
      continue
    }
    if (type === 'g') {
      offset = next
      continue
    }
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/su, '')
      offset = next
      continue
    }
    // A pax record and a long-name record each rename the member that follows them.
    members.push({ path: pending.get('path') ?? longName ?? headerPath(header), type, body })
    pending = new Map()
    longName = undefined
    offset = next
  }
  return members
}

/**
 * Read an archive, decompressing it when it is gzipped.
 * @param tarball - absolute tarball path.
 * @returns The members the archive stores.
 */
function readMembers(tarball: string): Member[] {
  const bytes = readFileSync(tarball)
  if ((bytes[0] ?? 0) === GZIP_MAGIC) return membersOf(gunzipSync(bytes))
  return membersOf(bytes)
}

/**
 * List a tarball's members.
 * @param tarball - absolute tarball path.
 * @returns Every path inside the archive.
 */
export function tarballFiles(tarball: string): string[] {
  return readMembers(tarball).map(member => member.path)
}

/**
 * Read a packed tarball's own manifest.
 * @param tarball - absolute tarball path.
 * @returns The name and version the tarball declares.
 */
export function packedIdentity(tarball: string): PackedIdentity {
  const member = readMembers(tarball).find(candidate => candidate.path === 'package/package.json')
  if (member === undefined) throw new Error(`${tarball} has no manifest`)
  const manifest: unknown = JSON.parse(member.body.toString('utf8'))
  if (manifest === null || typeof manifest !== 'object') throw new Error(`${tarball} has no manifest`)
  const { name, version } = manifest as Record<string, unknown>
  if (typeof name !== 'string' || typeof version !== 'string') throw new Error(`${tarball} manifest lacks name/version`)
  return { name, version }
}

/**
 * Read a packed directory's upload order.
 * @param directory - absolute path of a pack output directory.
 * @returns Tarball filenames in upload order.
 */
export function readPublishOrder(directory: string): string[] {
  return readFileSync(join(directory, PUBLISH_ORDER_FILE), 'utf8').split('\n').filter(line => line !== '')
}
