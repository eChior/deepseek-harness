/**
 * Minimal D-Bus value codec: just the type subset this shell needs to publish a
 * legacy StatusNotifierItem on a Linux session bus.
 *
 * A full D-Bus binding would be a new runtime dependency, and the maintained ones pull in long
 * dependency chains (dbus-next reaches packages as old and as compromised as event-stream), which
 * is not something to ship inside a desktop application for a customer. The wire format is stable
 * and the needed subset is small, so the few hundred lines live here instead.
 *
 * Everything is little-endian, matching the `l` byte the header declares.
 */

/** Byte alignment each type requires inside a message body. */
const ALIGNMENT: Readonly<Record<string, number>> = {
  y: 1,
  b: 4,
  n: 2,
  q: 2,
  i: 4,
  u: 4,
  x: 8,
  t: 8,
  d: 8,
  s: 4,
  o: 4,
  g: 1,
  a: 4,
  v: 1,
  '(': 8,
  '{': 8,
}

/** Marshal a value into the body using this signature. */
export interface ValueWriter {
  align(alignment: number): void
  byte(value: number): void
  uint16(value: number): void
  uint32(value: number): void
  int32(value: number): void
  uint64(value: bigint): void
  double(value: number): void
  string(value: string): void
  signature(value: string): void
  /** Byte offset the next write lands on; structs and arrays address themselves through it. */
  readonly offset: number
  /** Overwrite a previously reserved 32-bit slot, used for array lengths. */
  patchUint32(offset: number, value: number): void
}

/** Unmarshal a value from the body using this signature. */
export interface ValueReader {
  align(alignment: number): void
  byte(): number
  uint16(): number
  uint32(): number
  int32(): number
  uint64(): bigint
  double(): number
  string(): string
  signature(): string
  /** Byte offset the next read lands on. */
  readonly offset: number
}

/** A variant travels as its own signature next to its value. */
export interface DbusVariant {
  readonly signature: string
  readonly value: unknown
}

/**
 * Narrow a decoded value to a string. Decoding is untyped, so every reader that wants text has to
 * prove it first; a value of another type reads as the fallback instead of `[object Object]`.
 * @param value - Value decoded from the wire.
 * @param fallback - Text used when the value is not a string.
 */
export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Type alignment for one complete type, defaulting to byte alignment for scalars we never pad. */
export function alignmentOf(signature: string): number {
  return ALIGNMENT[signature[0] ?? 'y'] ?? 1
}

/**
 * Split a signature into its complete types: `a{sv}as` becomes `['a{sv}', 'as']`.
 * @param signature - Concatenated D-Bus type signatures.
 */
export function splitSignature(signature: string): string[] {
  const types: string[] = []
  let index = 0
  const readOne = (): void => {
    let start = index
    while (signature[index] === 'a') index += 1
    const head = signature[index]
    if (head === '(') {
      let depth = 1
      index += 1
      while (index < signature.length && depth > 0) {
        if (signature[index] === '(') depth += 1
        else if (signature[index] === ')') depth -= 1
        index += 1
      }
      if (depth > 0) throw new Error(`dbus: incomplete type signature ${JSON.stringify(signature)}`)
    } else if (head === '{') {
      let depth = 1
      index += 1
      while (index < signature.length && depth > 0) {
        if (signature[index] === '{') depth += 1
        else if (signature[index] === '}') depth -= 1
        index += 1
      }
      if (depth > 0) throw new Error(`dbus: incomplete type signature ${JSON.stringify(signature)}`)
    } else {
      index += 1
    }
    if (index === start) throw new Error(`dbus: incomplete type signature ${JSON.stringify(signature)}`)
    types.push(signature.slice(start, index))
    start = index
  }
  while (index < signature.length) readOne()
  return types
}

/** Marshal a value described by its signature. */
export function encodeValue(writer: ValueWriter, signature: string, value: unknown): void {
  switch (signature) {
    case 'y':
      writer.byte(Number(value))
      return
    case 'b':
      writer.uint32(value === true || value === 1 ? 1 : 0)
      return
    case 'n':
    case 'q':
      writer.uint16(Number(value))
      return
    case 'i':
      writer.int32(Number(value))
      return
    case 'u':
      writer.uint32(Number(value))
      return
    case 'x':
    case 't':
      writer.uint64(BigInt(value as bigint | number))
      return
    case 'd':
      writer.double(Number(value))
      return
    case 's':
    case 'o':
      writer.string(asString(value))
      return
    case 'g':
      writer.signature(asString(value))
      return
    case 'v': {
      const variant = value as DbusVariant
      writer.signature(variant.signature)
      encodeValue(writer, variant.signature, variant.value)
      return
    }
    default:
      break
  }
  if (signature.startsWith('a{')) {
    const entry = signature.slice(2, -1)
    const [keyType, valueType] = splitSignature(entry)
    if (keyType === undefined || valueType === undefined) throw new Error(`dbus: bad dictionary signature ${signature}`)
    const entries = Object.entries((value ?? {}) as Record<string, unknown>)
    writer.align(4)
    const lengthOffset = writer.offset
    writer.uint32(0)
    writer.align(8)
    const dataStart = writer.offset
    for (const [key, item] of entries) {
      writer.align(8)
      encodeValue(writer, keyType, key)
      encodeValue(writer, valueType, item)
    }
    writer.patchUint32(lengthOffset, writer.offset - dataStart)
    return
  }
  if (signature.startsWith('a(')) {
    const elementType = signature.slice(1)
    writer.align(4)
    const lengthOffset = writer.offset
    writer.uint32(0)
    writer.align(alignmentOf(elementType))
    const dataStart = writer.offset
    for (const item of (value ?? []) as readonly unknown[]) encodeValue(writer, elementType, item)
    writer.patchUint32(lengthOffset, writer.offset - dataStart)
    return
  }
  if (signature.startsWith('a')) {
    const elementType = signature.slice(1)
    writer.align(4)
    const lengthOffset = writer.offset
    writer.uint32(0)
    writer.align(alignmentOf(elementType))
    const dataStart = writer.offset
    for (const item of (value ?? []) as readonly unknown[]) encodeValue(writer, elementType, item)
    writer.patchUint32(lengthOffset, writer.offset - dataStart)
    return
  }
  if (signature.startsWith('(')) {
    const members = splitSignature(signature.slice(1, -1))
    const values = (value ?? []) as readonly unknown[]
    writer.align(8)
    for (const [index, member] of members.entries()) encodeValue(writer, member, values[index])
    return
  }
  throw new Error(`dbus: unsupported type signature ${signature}`)
}

/** Unmarshal a value described by its signature. */
export function decodeValue(reader: ValueReader, signature: string): unknown {
  switch (signature) {
    case 'y':
      return reader.byte()
    case 'b':
      return reader.uint32() !== 0
    case 'n':
    case 'q':
      return reader.uint16()
    case 'i':
      return reader.int32()
    case 'u':
      return reader.uint32()
    case 'x':
    case 't':
      return reader.uint64()
    case 'd':
      return reader.double()
    case 's':
    case 'o':
      return reader.string()
    case 'g':
      return reader.signature()
    case 'v': {
      const inner = reader.signature()
      return { signature: inner, value: decodeValue(reader, inner) } satisfies DbusVariant
    }
    default:
      break
  }
  if (signature.startsWith('a{')) {
    const entry = signature.slice(2, -1)
    const [keyType, valueType] = splitSignature(entry)
    if (keyType === undefined || valueType === undefined) throw new Error(`dbus: bad dictionary signature ${signature}`)
    reader.align(4)
    const length = reader.uint32()
    const end = reader.offset + length
    reader.align(8)
    const result: Record<string, unknown> = {}
    while (reader.offset < end) {
      reader.align(8)
      const key = decodeValue(reader, keyType)
      result[String(key)] = decodeValue(reader, valueType)
    }
    return result
  }
  if (signature.startsWith('a')) {
    const elementType = signature.slice(1)
    reader.align(4)
    const length = reader.uint32()
    const end = reader.offset + length
    reader.align(alignmentOf(elementType))
    const items: unknown[] = []
    while (reader.offset < end) items.push(decodeValue(reader, elementType))
    return items
  }
  if (signature.startsWith('(')) {
    const members = splitSignature(signature.slice(1, -1))
    reader.align(8)
    return members.map(member => decodeValue(reader, member))
  }
  throw new Error(`dbus: unsupported type signature ${signature}`)
}
