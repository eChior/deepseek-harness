import { expect, it } from 'vitest'

import { BufferReader, BufferWriter } from '../src/dbus-message.ts'
import { alignmentOf, decodeValue, encodeValue, splitSignature } from '../src/dbus-codec.ts'

/** Marshal then unmarshal one value, which is the only property every type must hold. */
function roundTrip(signature: string, value: unknown): unknown {
  const writer = new BufferWriter()
  encodeValue(writer, signature, value)
  return decodeValue(new BufferReader(writer.finish()), signature)
}

it('splits a signature into its complete types', () => {
  expect(splitSignature('sa{sv}as')).toEqual(['s', 'a{sv}', 'as'])
  expect(splitSignature('a(ii)a{sa{sv}}')).toEqual(['a(ii)', 'a{sa{sv}}'])
  expect(splitSignature('')).toEqual([])
  expect(() => splitSignature('(')).toThrow('incomplete type signature')
})

it('reports the alignment each type needs', () => {
  expect(alignmentOf('y')).toBe(1)
  expect(alignmentOf('u')).toBe(4)
  expect(alignmentOf('s')).toBe(4)
  expect(alignmentOf('x')).toBe(8)
  expect(alignmentOf('a{sv}')).toBe(4)
  expect(alignmentOf('(ii)')).toBe(8)
  expect(alignmentOf('')).toBe(1)
})

it('round-trips every scalar the item exchanges', () => {
  expect(roundTrip('y', 200)).toBe(200)
  expect(roundTrip('b', true)).toBe(true)
  expect(roundTrip('b', false)).toBe(false)
  expect(roundTrip('n', 7)).toBe(7)
  expect(roundTrip('q', 7)).toBe(7)
  expect(roundTrip('i', -11)).toBe(-11)
  expect(roundTrip('u', 4000000000)).toBe(4000000000)
  expect(roundTrip('x', 12n)).toBe(12n)
  expect(roundTrip('t', 12n)).toBe(12n)
  expect(roundTrip('d', 1.5)).toBe(1.5)
  expect(roundTrip('s', 'DeepSeek Harness')).toBe('DeepSeek Harness')
  expect(roundTrip('o', '/StatusNotifierItem')).toBe('/StatusNotifierItem')
  expect(roundTrip('g', 'a{sv}')).toBe('a{sv}')
})

it('round-trips a variant and an array of strings', () => {
  expect(roundTrip('v', { signature: 's', value: 'Active' })).toEqual({ signature: 's', value: 'Active' })
  expect(roundTrip('as', ['s', 't'])).toEqual(['s', 't'])
  expect(roundTrip('au', [1, 2, 3])).toEqual([1, 2, 3])
  expect(roundTrip('ay', [1, 2, 3])).toEqual([1, 2, 3])
  expect(roundTrip('a(ii)', [[1, 2], [3, 4]])).toEqual([[1, 2], [3, 4]])
  expect(roundTrip('(ii)', [5, 6])).toEqual([5, 6])
})

it('round-trips the property dictionary the panel reads', () => {
  const properties = {
    Category: { signature: 's', value: 'ApplicationStatus' },
    Title: { signature: 's', value: 'DeepSeek Harness' },
    ItemIsMenu: { signature: 'b', value: false },
    Menu: { signature: 'o', value: '/NO_DBUSMENU' },
  }
  expect(roundTrip('a{sv}', properties)).toEqual(properties)
})

it('keeps a dictionary followed by an array in one body', () => {
  const writer = new BufferWriter()
  encodeValue(writer, 'a{sv}', { Status: { signature: 's', value: 'Active' } })
  encodeValue(writer, 'as', ['s'])
  const reader = new BufferReader(writer.finish())
  expect(decodeValue(reader, 'a{sv}')).toEqual({ Status: { signature: 's', value: 'Active' } })
  expect(decodeValue(reader, 'as')).toEqual(['s'])
})

it('rejects a signature it cannot marshal', () => {
  const writer = new BufferWriter()
  expect(() => { encodeValue(writer, 'z', 1) }).toThrow('unsupported type signature z')
  expect(() => { decodeValue(new BufferReader(Buffer.alloc(8)), 'z') }).toThrow('unsupported type signature z')
  expect(() => { encodeValue(writer, 'a{', 1) }).toThrow('bad dictionary signature')
})
