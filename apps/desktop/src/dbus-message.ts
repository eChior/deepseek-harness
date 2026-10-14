/**
 * D-Bus message framing: the fixed header, its `a(yv)` field array, and the body that follows.
 *
 * Separate from the value codec because the header carries its own alignment contract: the field
 * array starts at byte 16 and the body starts at the first 8-byte boundary after it.
 */

import { alignmentOf, decodeValue, encodeValue, splitSignature } from './dbus-codec.ts'
import type { ValueReader, ValueWriter } from './dbus-codec.ts'

/** Wire message kinds this shell reads or writes. */
export const MESSAGE_CALL = 1
/** Reply carrying a return value. */
export const MESSAGE_RETURN = 2
/** Reply carrying an error name and message. */
export const MESSAGE_ERROR = 3
/** Unsolicited signal broadcast. */
export const MESSAGE_SIGNAL = 4

/** Header field codes, named after the spec constants. */
export const FIELD = {
  path: 1,
  interface: 2,
  member: 3,
  errorName: 4,
  replySerial: 5,
  destination: 6,
  sender: 7,
  signature: 8,
} as const

const HEADER_LENGTH = 16

/** Fixed header plus decoded fields of one incoming message. */
export interface DbusMessage {
  readonly type: number
  readonly flags: number
  readonly serial: number
  readonly fields: Readonly<Record<number, unknown>>
  /** Body signature; empty string when the message carries no body. */
  readonly signature: string
  readonly body: Buffer
}

/** Growable little-endian writer implementing the value writer contract. */
export class BufferWriter implements ValueWriter {
  private buffer = Buffer.alloc(256)
  private length = 0

  get offset(): number {
    return this.length
  }

  align(alignment: number): void {
    const remainder = this.length % alignment
    if (remainder === 0) return
    const padding = alignment - remainder
    this.reserve(padding)
    this.buffer.fill(0, this.length, this.length + padding)
    this.length += padding
  }

  byte(value: number): void {
    this.reserve(1)
    this.buffer.writeUInt8(value & 0xff, this.length)
    this.length += 1
  }

  uint16(value: number): void {
    this.align(2)
    this.reserve(2)
    this.buffer.writeUInt16LE(value & 0xffff, this.length)
    this.length += 2
  }

  uint32(value: number): void {
    this.align(4)
    this.reserve(4)
    this.buffer.writeUInt32LE(value >>> 0, this.length)
    this.length += 4
  }

  int32(value: number): void {
    this.align(4)
    this.reserve(4)
    this.buffer.writeInt32LE(value, this.length)
    this.length += 4
  }

  uint64(value: bigint): void {
    this.align(8)
    this.reserve(8)
    this.buffer.writeBigUInt64LE(value, this.length)
    this.length += 8
  }

  double(value: number): void {
    this.align(8)
    this.reserve(8)
    this.buffer.writeDoubleLE(value, this.length)
    this.length += 8
  }

  string(value: string): void {
    const bytes = Buffer.from(value, 'utf8')
    this.uint32(bytes.length)
    this.reserve(bytes.length)
    bytes.copy(this.buffer, this.length)
    this.length += bytes.length
    this.byte(0)
  }

  signature(value: string): void {
    const bytes = Buffer.from(value, 'ascii')
    this.byte(bytes.length)
    this.reserve(bytes.length)
    bytes.copy(this.buffer, this.length)
    this.length += bytes.length
    this.byte(0)
  }

  patchUint32(offset: number, value: number): void {
    this.buffer.writeUInt32LE(value >>> 0, offset)
  }

  /** Copy of the written bytes, trimmed to length. */
  finish(): Buffer {
    return Buffer.from(this.buffer.subarray(0, this.length))
  }

  private reserve(count: number): void {
    if (this.length + count <= this.buffer.length) return
    const next = Buffer.alloc(Math.max(this.buffer.length * 2, this.length + count))
    this.buffer.copy(next, 0, 0, this.length)
    this.buffer = next
  }
}

/** Little-endian reader over one message body. */
export class BufferReader implements ValueReader {
  constructor(private readonly buffer: Buffer, private position = 0) {}

  get offset(): number {
    return this.position
  }

  align(alignment: number): void {
    const remainder = this.position % alignment
    if (remainder !== 0) this.position += alignment - remainder
  }

  byte(): number {
    const value = this.buffer.readUInt8(this.position)
    this.position += 1
    return value
  }

  uint16(): number {
    this.align(2)
    const value = this.buffer.readUInt16LE(this.position)
    this.position += 2
    return value
  }

  uint32(): number {
    this.align(4)
    const value = this.buffer.readUInt32LE(this.position)
    this.position += 4
    return value
  }

  int32(): number {
    this.align(4)
    const value = this.buffer.readInt32LE(this.position)
    this.position += 4
    return value
  }

  uint64(): bigint {
    this.align(8)
    const value = this.buffer.readBigUInt64LE(this.position)
    this.position += 8
    return value
  }

  double(): number {
    this.align(8)
    const value = this.buffer.readDoubleLE(this.position)
    this.position += 8
    return value
  }

  string(): string {
    const length = this.uint32()
    const value = this.buffer.toString('utf8', this.position, this.position + length)
    this.position += length + 1
    return value
  }

  signature(): string {
    const length = this.byte()
    const value = this.buffer.toString('ascii', this.position, this.position + length)
    this.position += length + 1
    return value
  }
}

/** Everything one outgoing message needs. */
export interface OutgoingMessage {
  readonly type: number
  readonly serial: number
  readonly path?: string
  readonly interface?: string
  readonly member?: string
  readonly destination?: string
  readonly errorName?: string
  readonly replySerial?: number
  /** Body signature; omit for a body-less message. */
  readonly signature?: string
  /** Positional arguments matching `signature`. */
  readonly body?: readonly unknown[]
}

/** Marshal one message, header and body. */
export function encodeMessage(message: OutgoingMessage): Buffer {
  const bodySignature = message.signature ?? ''
  const body = new BufferWriter()
  if (bodySignature !== '') {
    const types = splitSignature(bodySignature)
    for (const [index, type] of types.entries()) encodeValue(body, type, message.body?.[index])
  }
  const bodyBytes = body.finish()

  const header = new BufferWriter()
  header.byte(0x6c)
  header.byte(message.type)
  header.byte(0)
  header.byte(1)
  header.uint32(bodyBytes.length)
  header.uint32(message.serial)
  const headerFieldsLengthOffset = header.offset
  header.uint32(0)
  const headerFieldsStart = header.offset
  const fields: readonly (readonly [number, DbusFieldValue])[] = [
    ...(message.path === undefined ? [] : [[FIELD.path, { signature: 'o', value: message.path }] as const]),
    ...(message.interface === undefined ? [] : [[FIELD.interface, { signature: 's', value: message.interface }] as const]),
    ...(message.member === undefined ? [] : [[FIELD.member, { signature: 's', value: message.member }] as const]),
    ...(message.errorName === undefined ? [] : [[FIELD.errorName, { signature: 's', value: message.errorName }] as const]),
    ...(message.replySerial === undefined ? [] : [[FIELD.replySerial, { signature: 'u', value: message.replySerial }] as const]),
    ...(message.destination === undefined ? [] : [[FIELD.destination, { signature: 's', value: message.destination }] as const]),
    ...(bodySignature === '' ? [] : [[FIELD.signature, { signature: 'g', value: bodySignature }] as const]),
  ]
  header.align(8)
  for (const [code, value] of fields) {
    header.align(8)
    header.byte(code)
    encodeValue(header, 'v', value)
  }
  header.patchUint32(headerFieldsLengthOffset, header.offset - headerFieldsStart)
  header.align(8)

  return Buffer.concat([header.finish(), bodyBytes])
}

/** Variant shape used inside header fields. */
interface DbusFieldValue {
  readonly signature: string
  readonly value: unknown
}

/**
 * Decode one message from the front of `buffer`.
 * @returns The message and how many bytes it consumed, or undefined when the buffer is short.
 */
export function decodeMessage(buffer: Buffer): { message: DbusMessage; consumed: number } | undefined {
  if (buffer.length < HEADER_LENGTH) return undefined
  if (buffer.readUInt8(0) !== 0x6c) throw new Error('dbus: only little-endian messages are supported')
  const type = buffer.readUInt8(1)
  const flags = buffer.readUInt8(2)
  const bodyLength = buffer.readUInt32LE(4)
  const serial = buffer.readUInt32LE(8)
  const headerFieldsLength = buffer.readUInt32LE(12)
  const bodyStart = align8(HEADER_LENGTH + headerFieldsLength)
  if (buffer.length < bodyStart + bodyLength) return undefined

  const fieldsReader = new BufferReader(buffer, HEADER_LENGTH)
  const fields: Record<number, unknown> = {}
  while (fieldsReader.offset < HEADER_LENGTH + headerFieldsLength) {
    fieldsReader.align(8)
    const code = fieldsReader.byte()
    const variant = decodeValue(fieldsReader, 'v') as { signature: string; value: unknown }
    fields[code] = variant.value
  }
  const signature = typeof fields[FIELD.signature] === 'string' ? (fields[FIELD.signature] as string) : ''
  return {
    message: { type, flags, serial, fields, signature, body: buffer.subarray(bodyStart, bodyStart + bodyLength) },
    consumed: bodyStart + bodyLength,
  }
}

/** Round an offset up to the next 8-byte boundary; `alignmentOf` covers the body types. */
function align8(offset: number): number {
  return offset + ((8 - (offset % 8)) % 8)
}

/** Convenience re-export so callers do not need the codec module for simple bodies. */
export { alignmentOf }
