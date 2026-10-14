/**
 * Session-bus client for the one thing this shell needs: publishing a legacy StatusNotifierItem.
 *
 * Connects over the session bus socket, performs the EXTERNAL handshake, then speaks the message
 * protocol from `dbus-message.ts`. Method calls, exported objects, and signal emission are all
 * supported; file-descriptor passing and the introspection interface are deliberately absent.
 */

import { connect } from 'node:net'
import type { Socket } from 'node:net'

import { asString, splitSignature, decodeValue } from './dbus-codec.ts'
import { BufferReader, FIELD, MESSAGE_CALL, MESSAGE_ERROR, MESSAGE_RETURN, MESSAGE_SIGNAL, decodeMessage, encodeMessage } from './dbus-message.ts'
import type { DbusMessage } from './dbus-message.ts'

/** One method call arriving from the bus, already decoded. */
export interface DbusCall {
  readonly sender: string
  readonly path: string
  readonly iface: string
  readonly member: string
  readonly signature: string
  readonly body: readonly unknown[]
}

/** Return value of an exported method. */
export interface DbusReply {
  readonly signature: string
  readonly body: readonly unknown[]
}

/** Exported method implementation. */
export type DbusHandler = (call: DbusCall) => DbusReply | Promise<DbusReply>

/** Signal this client wants to hear. */
export interface DbusSignalPattern {
  readonly iface: string
  readonly member: string
  readonly handler: (body: readonly unknown[]) => void
}

/** Bus name flags from the specification. */
export const NAME_FLAG_REPLACE_EXISTING = 0x2
/** Fail instead of queueing when another owner holds the name. */
export const NAME_FLAG_DO_NOT_QUEUE = 0x4

/** Error thrown when the bus answers a call with an error message. */
export class DbusError extends Error {
  readonly errorName: string

  constructor(errorName: string, message: string) {
    super(message)
    this.name = 'DbusError'
    this.errorName = errorName
  }
}

interface PendingCall {
  readonly resolve: (reply: DbusReply) => void
  readonly reject: (error: Error) => void
}

interface ExportedMethod {
  readonly path: string
  readonly iface: string
  readonly member: string
  readonly handler: DbusHandler
}

/** Turn `DBUS_SESSION_BUS_ADDRESS` into a socket path, falling back to the runtime directory. */
export function sessionBusPath(
  address: string | undefined = process.env.DBUS_SESSION_BUS_ADDRESS,
  runtimeDirectory: string | undefined = process.env.XDG_RUNTIME_DIR,
): string {
  if (address !== undefined && address !== '') {
    for (const part of address.split(';')) {
      if (!part.startsWith('unix:')) continue
      for (const entry of part.slice('unix:'.length).split(',')) {
        if (entry.startsWith('path=')) return entry.slice('path='.length)
      }
    }
  }
  if (runtimeDirectory !== undefined && runtimeDirectory !== '') return `${runtimeDirectory}/bus`
  throw new Error('dbus: no session bus address (set DBUS_SESSION_BUS_ADDRESS or XDG_RUNTIME_DIR)')
}

/** Connected, authenticated session-bus client. */
export class DbusSession {
  private serial = 0
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<number, PendingCall>()
  private readonly exported: ExportedMethod[] = []
  private readonly signalPatterns: DbusSignalPattern[] = []
  private readonly failures: ((error: Error) => void)[] = []
  private closed = false

  private constructor(
    private readonly socket: Socket,
    private name: string,
  ) {}

  /** Connect and greet the bus. */
  static async open(path: string = sessionBusPath()): Promise<DbusSession> {
    const socket = connect(path)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    await authenticate(socket)
    const client = new DbusSession(socket, '')
    socket.on('data', (chunk: Buffer) => { client.ingest(chunk) })
    socket.on('error', (error: Error) => { client.fail(error) })
    socket.on('close', () => { client.fail(new Error('dbus: connection closed')) })
    const hello = await client.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      iface: 'org.freedesktop.DBus',
      member: 'Hello',
    })
    // The listeners are bound to this instance, so the greeting has to be sent through it too; a
    // fresh instance would keep its own pending map and never see the replies.
    client.name = asString(hello.body[0])
    return client
  }

  /** Unique name the bus assigned this connection, for example `:1.42`. */
  get uniqueName(): string {
    return this.name
  }

  /** Ask the bus to hand this connection a well-known name; the reply is a numeric result code. */
  async requestName(name: string, flags = NAME_FLAG_DO_NOT_QUEUE): Promise<number> {
    const reply = await this.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      iface: 'org.freedesktop.DBus',
      member: 'RequestName',
      signature: 'su',
      body: [name, flags],
    })
    return Number(reply.body[0] ?? 0)
  }

  /** Invoke a method and resolve with its reply. */
  async call(request: {
    destination?: string
    path: string
    iface: string
    member: string
    signature?: string
    body?: readonly unknown[]
    timeoutMs?: number
  }): Promise<DbusReply> {
    const serial = ++this.serial
    const response = new Promise<DbusReply>((resolve, reject) => {
      this.pending.set(serial, { resolve, reject })
    })
    this.socket.write(encodeMessage({
      type: MESSAGE_CALL,
      serial,
      path: request.path,
      interface: request.iface,
      member: request.member,
      ...(request.destination === undefined ? {} : { destination: request.destination }),
      ...(request.signature === undefined || request.signature === '' ? {} : { signature: request.signature }),
      body: request.body ?? [],
    }))
    const timeoutMs = request.timeoutMs ?? 10_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(serial)
        reject(new Error(`dbus: ${request.iface}.${request.member} timed out`))
      }, timeoutMs)
      timer.unref()
    })
    try {
      return await Promise.race([response, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.pending.delete(serial)
    }
  }

  /** Answer calls addressed to `path`/`iface`/`member`. */
  exportMethod(path: string, iface: string, member: string, handler: DbusHandler): void {
    this.exported.push({ path, iface, member, handler })
  }

  /** Listen for a signal; the watcher's registration notice is the usual reason. */
  subscribe(pattern: DbusSignalPattern): void {
    this.signalPatterns.push(pattern)
  }

  /** Emit a signal from an exported object. */
  emit(path: string, iface: string, member: string, signature = '', body: readonly unknown[] = []): void {
    if (this.closed) return
    this.socket.write(encodeMessage({
      type: MESSAGE_SIGNAL,
      serial: ++this.serial,
      path,
      interface: iface,
      member,
      ...(signature === '' ? {} : { signature }),
      body,
    }))
  }

  /** Observe connection loss so the caller can decide whether to retry. */
  onFailure(handler: (error: Error) => void): void {
    this.failures.push(handler)
  }

  /** Drop the connection; the bus releases the well-known name with it. */
  close(): void {
    this.closed = true
    this.socket.destroy()
  }

  private ingest(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const decoded = this.readMessage()
      if (decoded === undefined) return
      void this.dispatch(decoded).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      })
    }
  }

  private readMessage(): DbusMessage | undefined {
    try {
      const decoded = decodeMessage(this.buffer)
      if (decoded === undefined) return undefined
      this.buffer = this.buffer.subarray(decoded.consumed)
      return decoded.message
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return undefined
    }
  }

  private async dispatch(message: DbusMessage): Promise<void> {
    const replySerial = message.fields[FIELD.replySerial]
    if (message.type === MESSAGE_RETURN || message.type === MESSAGE_ERROR) {
      const pending = typeof replySerial === 'number' ? this.pending.get(replySerial) : undefined
      if (pending === undefined) return
      this.pending.delete(replySerial as number)
      if (message.type === MESSAGE_ERROR) {
        pending.reject(new DbusError(
          asString(message.fields[FIELD.errorName], 'org.freedesktop.DBus.Error.Failed'),
          describeBody(message),
        ))
        return
      }
      pending.resolve({ signature: message.signature, body: decodeBody(message.signature, message.body) })
      return
    }
    const iface = asString(message.fields[FIELD.interface])
    const member = asString(message.fields[FIELD.member])
    if (message.type === MESSAGE_SIGNAL) {
      for (const pattern of this.signalPatterns) {
        if (pattern.iface !== iface || pattern.member !== member) continue
        pattern.handler(decodeBody(message.signature, message.body))
      }
      return
    }
    if (message.type !== MESSAGE_CALL) return
    const path = asString(message.fields[FIELD.path])
    const sender = asString(message.fields[FIELD.sender])
    const match = this.exported.find(entry => entry.path === path && entry.iface === iface && entry.member === member)
    if (match === undefined) {
      this.replyError(message.serial, sender, 'org.freedesktop.DBus.Error.UnknownMethod', `No such method ${iface}.${member} on ${path}`)
      return
    }
    try {
      const reply = await match.handler({
        sender,
        path,
        iface,
        member,
        signature: message.signature,
        body: decodeBody(message.signature, message.body),
      })
      this.socket.write(encodeMessage({
        type: MESSAGE_RETURN,
        serial: ++this.serial,
        replySerial: message.serial,
        destination: sender,
        ...(reply.signature === '' ? {} : { signature: reply.signature }),
        body: reply.body,
      }))
    } catch (error) {
      this.replyError(message.serial, sender, 'org.freedesktop.DBus.Error.Failed', error instanceof Error ? error.message : 'dbus: export handler failed')
    }
  }

  private replyError(replySerial: number, destination: string, errorName: string, text: string): void {
    this.socket.write(encodeMessage({
      type: MESSAGE_ERROR,
      serial: ++this.serial,
      errorName,
      replySerial,
      destination,
      signature: 's',
      body: [text],
    }))
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (this.closed) return
    this.closed = true
    for (const handler of this.failures) handler(error)
  }
}

/** Decode a message body against its signature. */
export function decodeBody(signature: string, body: Buffer): readonly unknown[] {
  if (signature === '') return []
  const reader = new BufferReader(body)
  return splitSignature(signature).map(type => decodeValue(reader, type))
}

/**
 * Handshake: NUL, then AUTH EXTERNAL with the decimal uid, then BEGIN.
 * Unix-fd passing is not negotiated because nothing here exchanges descriptors.
 */
export async function authenticate(socket: Socket): Promise<void> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const credentials = Buffer.from(String(uid), 'ascii').toString('hex')
  socket.write(`\u0000AUTH EXTERNAL ${credentials}\r\n`)
  const answer = await readLine(socket)
  if (!answer.startsWith('OK')) throw new Error(`dbus: authentication rejected (${answer})`)
  socket.write('BEGIN\r\n')
}

/** Read one CRLF-terminated protocol line, pushing back any bytes that follow it. */
export function readLine(socket: Socket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let text = ''
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('latin1')
      const end = text.indexOf('\r\n')
      if (end === -1) return
      socket.off('data', onData)
      socket.off('error', onError)
      const rest = text.slice(end + 2)
      if (rest !== '') socket.unshift(Buffer.from(rest, 'latin1'))
      resolve(text.slice(0, end))
    }
    const onError = (error: Error): void => {
      socket.off('data', onData)
      reject(error)
    }
    socket.on('data', onData)
    socket.on('error', onError)
  })
}

/** Render an error body for logging. */
function describeBody(message: DbusMessage): string {
  try {
    return decodeBody(message.signature, message.body).map(part => asString(part, '<value>')).join(' ')
  } catch {
    return 'dbus error'
  }
}
