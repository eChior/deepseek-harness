/**
 * The mapping file holds the pairings the redactor issued, and the originals
 * are the values it protects. A plain `.jsonl` on disk hands every one of them
 * to anything that can read the file — a `read` call, a hex view, a shell
 * pipeline — which defeats the point of the redaction layer entirely. Each
 * line is therefore sealed on its own: one AES-256-GCM block per entry, so an
 * append stays an append and a line that fails to open is simply skipped.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RedactionEntry } from './map.ts'

/**
 * The directory the key lives in, one level above the mapping files it opens.
 *
 * A tool that walks the mapping directory finds sealed lines and nothing to
 * open them with. The name says nothing about what the file is for: the pair
 * reads as one more piece of plugin state, so a reader that goes looking for a
 * key finds nothing to recognise.
 */
const KEY_DIRECTORY = 'state'

/** The key file itself, named for the place rather than the purpose. */
const KEY_FILE = 'index.dat'

/** Bytes of the per-entry initialisation vector. */
const IV_BYTES = 12

/** Bytes of the GCM authentication tag. */
const TAG_BYTES = 16

/** Bytes of the key. */
const KEY_BYTES = 32

/** Encoding the key is stored in. */
const KEY_RADIX: BufferEncoding = 'hex'

/**
 * The machine's mapping key, created on first use.
 *
 * The key file sits in its own directory one level above `directory`, created
 * on first use with owner-only access. It never sits beside the lines it
 * opens, so a plain directory listing of the mappings is not enough to read
 * them.
 * @param directory - the directory holding the mapping files.
 * @returns the key, or undefined when the file cannot be created or read.
 */
export function mappingKey(directory: string): Buffer | undefined {
  const path = join(dirname(directory), KEY_DIRECTORY, KEY_FILE)
  try {
    if (!existsSync(path)) {
      mkdirSync(join(dirname(directory), KEY_DIRECTORY), { recursive: true, mode: 0o700 })
      writeFileSync(path, randomBytes(KEY_BYTES).toString(KEY_RADIX), { mode: 0o600 })
      chmodSync(path, 0o600)
    }
    const text = readFileSync(path, 'utf8').trim()
    if (text.length !== KEY_BYTES * 2) return undefined
    return Buffer.from(text, KEY_RADIX)
  } catch {
    return undefined
  }
}

/**
 * Seal one entry into a line that reveals nothing without the key.
 * @param entry - the pairing to record.
 * @param key - the machine key.
 * @returns the line to append, newline included.
 */
export function sealEntry(entry: RedactionEntry, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([
    cipher.update(JSON.stringify({ placeholder: entry.placeholder, category: entry.category, original: entry.original }), 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return `${JSON.stringify({ e: Buffer.concat([iv, tag, body]).toString('base64') })}\n`
}

/**
 * Seal a whole document with the machine key.
 * @param text - the text a file should hold.
 * @param key - the machine key.
 * @returns One base64 line, iv and tag prefixed like a sealed entry.
 */
export function sealText(text: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

/**
 * Open a document sealed by {@link sealText}.
 * @param body - the file contents.
 * @param key - the machine key.
 * @returns The text, or undefined when this key does not open it.
 */
export function openText(body: string, key: Buffer | undefined): string | undefined {
  if (key === undefined) return undefined
  try {
    const packed = Buffer.from(body.trim(), 'base64')
    if (packed.length <= IV_BYTES + TAG_BYTES) return undefined
    const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, IV_BYTES))
    decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    return Buffer.concat([decipher.update(packed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * One entry recorded in a line, from a sealed line or a plaintext one an
 * earlier release wrote.
 * @param line - the line to open.
 * @param key - the machine key; without it only plaintext lines open.
 * @returns the entry, when the line records a complete one.
 */
export function openLine(line: string, key: Buffer | undefined): RedactionEntry | undefined {
  const text = line.trim()
  if (text === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.e === 'string') {
    if (key === undefined) return undefined
    return openSealed(record.e, key)
  }
  return plainEntry(record)
}

/**
 * Open one sealed block.
 * @param encoded - the base64 block.
 * @param key - the machine key.
 * @returns the entry, or undefined when the block does not authenticate.
 */
function openSealed(encoded: string, key: Buffer): RedactionEntry | undefined {
  let raw: Buffer
  try {
    raw = Buffer.from(encoded, 'base64')
  } catch {
    return undefined
  }
  if (raw.length <= IV_BYTES + TAG_BYTES) return undefined
  const iv = raw.subarray(0, IV_BYTES)
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = raw.subarray(IV_BYTES + TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const text = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return plainEntry(parsed as Record<string, unknown>)
  } catch {
    return undefined
  }
}

/**
 * Read one unsealed record, the shape every release writes inside the block.
 * @param record - the parsed object.
 * @returns the entry, when it carries all three fields as strings.
 */
function plainEntry(record: Record<string, unknown>): RedactionEntry | undefined {
  const { placeholder, category, original } = record
  if (typeof placeholder !== 'string' || typeof category !== 'string' || typeof original !== 'string') return undefined
  if (placeholder === '' || original === '') return undefined
  return { placeholder, category, original }
}
