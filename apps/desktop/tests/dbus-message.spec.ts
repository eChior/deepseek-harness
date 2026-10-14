import { expect, it } from 'vitest'

import { FIELD, MESSAGE_CALL, MESSAGE_ERROR, MESSAGE_RETURN, MESSAGE_SIGNAL, decodeMessage, encodeMessage } from '../src/dbus-message.ts'

/** Decode a buffer that must contain exactly one whole message. */
function decodeOne(buffer: Buffer): NonNullable<ReturnType<typeof decodeMessage>>['message'] {
  const decoded = decodeMessage(buffer)
  if (decoded === undefined) throw new Error('message did not decode')
  expect(decoded.consumed).toBe(buffer.length)
  return decoded.message
}

it('round-trips a method call with its routing fields and body', () => {
  const message = decodeOne(encodeMessage({
    type: MESSAGE_CALL,
    serial: 7,
    path: '/StatusNotifierItem',
    interface: 'org.kde.StatusNotifierItem',
    member: 'Activate',
    destination: 'org.kde.StatusNotifierItem-1-1',
    signature: 'ii',
    body: [10, 20],
  }))
  expect(message.type).toBe(MESSAGE_CALL)
  expect(message.serial).toBe(7)
  expect(message.fields[FIELD.path]).toBe('/StatusNotifierItem')
  expect(message.fields[FIELD.interface]).toBe('org.kde.StatusNotifierItem')
  expect(message.fields[FIELD.member]).toBe('Activate')
  expect(message.fields[FIELD.destination]).toBe('org.kde.StatusNotifierItem-1-1')
  expect(message.signature).toBe('ii')
  expect(message.body.length).toBe(8)
})

it('round-trips a body-less message and a reply', () => {
  const empty = decodeOne(encodeMessage({ type: MESSAGE_SIGNAL, serial: 1, path: '/x', interface: 'a.b', member: 'Ping' }))
  expect(empty.signature).toBe('')
  expect(empty.body.length).toBe(0)

  const reply = decodeOne(encodeMessage({ type: MESSAGE_RETURN, serial: 2, replySerial: 9, signature: 's', body: ['ok'] }))
  expect(reply.type).toBe(MESSAGE_RETURN)
  expect(reply.fields[FIELD.replySerial]).toBe(9)
  expect(reply.signature).toBe('s')
})

it('round-trips an error message', () => {
  const message = decodeOne(encodeMessage({
    type: MESSAGE_ERROR,
    serial: 3,
    replySerial: 9,
    errorName: 'org.freedesktop.DBus.Error.UnknownMethod',
    signature: 's',
    body: ['no such method'],
  }))
  expect(message.type).toBe(MESSAGE_ERROR)
  expect(message.fields[FIELD.errorName]).toBe('org.freedesktop.DBus.Error.UnknownMethod')
})

it('aligns the body to eight bytes after the field array', () => {
  const buffer = encodeMessage({ type: MESSAGE_SIGNAL, serial: 4, path: '/x', interface: 'a.b', member: 'C', signature: 'u', body: [5] })
  const message = decodeOne(buffer)
  expect(message.body.readUInt32LE(0)).toBe(5)
  expect(message.signature).toBe('u')
})

it('waits for more bytes instead of throwing on a short buffer', () => {
  const buffer = encodeMessage({ type: MESSAGE_CALL, serial: 5, path: '/p', interface: 'a.b', member: 'C', signature: 's', body: ['x'] })
  expect(decodeMessage(buffer.subarray(0, 8))).toBeUndefined()
  expect(decodeMessage(buffer.subarray(0, buffer.length - 1))).toBeUndefined()
  expect(decodeMessage(buffer)).toBeDefined()
})

it('refuses a header it cannot trust', () => {
  const buffer = encodeMessage({ type: MESSAGE_SIGNAL, serial: 6, path: '/x', interface: 'a.b', member: 'C' })
  const bigEndian = Buffer.from(buffer)
  bigEndian.writeUInt8(0x42, 0)
  expect(() => decodeMessage(bigEndian)).toThrow('only little-endian messages are supported')
})

it('decodes two messages concatenated in one buffer', () => {
  const first = encodeMessage({ type: MESSAGE_SIGNAL, serial: 7, path: '/a', interface: 'x.y', member: 'One' })
  const second = encodeMessage({ type: MESSAGE_SIGNAL, serial: 8, path: '/b', interface: 'x.y', member: 'Two' })
  const combined = Buffer.concat([first, second])
  const decoded = decodeMessage(combined)
  expect(decoded?.message.fields[FIELD.member]).toBe('One')
  const rest = combined.subarray(decoded?.consumed ?? 0)
  expect(decodeMessage(rest)?.message.fields[FIELD.member]).toBe('Two')
})
