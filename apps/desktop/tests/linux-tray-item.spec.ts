import { expect, it } from 'vitest'

import { LinuxTrayItem } from '../src/linux-tray-item.ts'
import type { DbusSessionLike } from '../src/linux-tray-item.ts'
import type { DbusCall, DbusReply } from '../src/dbus-session.ts'

interface RecordedCall {
  readonly destination?: string
  readonly path: string
  readonly iface: string
  readonly member: string
  readonly signature?: string
  readonly body?: readonly unknown[]
}

/** Stands in for the session bus so the registration shape can be asserted without a socket. */
class FakeSession implements DbusSessionLike {
  readonly uniqueName = ':1.42'
  readonly calls: RecordedCall[] = []
  readonly emitted: string[] = []
  readonly methods = new Map<string, (call: DbusCall) => DbusReply | Promise<DbusReply>>()
  requestedName = ''
  closed = false
  nameResult = 1
  registerError: Error | undefined

  requestName(name: string): Promise<number> {
    this.requestedName = name
    return Promise.resolve(this.nameResult)
  }

  call(request: RecordedCall): Promise<DbusReply> {
    this.calls.push(request)
    if (this.registerError !== undefined && request.member === 'RegisterStatusNotifierItem') {
      return Promise.reject(this.registerError)
    }
    return Promise.resolve({ signature: '', body: [] })
  }

  exportMethod(path: string, iface: string, member: string, handler: (call: DbusCall) => DbusReply | Promise<DbusReply>): void {
    this.methods.set(`${path}|${iface}|${member}`, handler)
  }

  emit(path: string, iface: string, member: string): void {
    this.emitted.push(`${path}|${iface}|${member}`)
  }

  close(): void {
    this.closed = true
  }

  invoke(key: string, body: readonly unknown[] = []): DbusReply | Promise<DbusReply> {
    const handler = this.methods.get(key)
    if (handler === undefined) throw new Error(`no handler for ${key}`)
    return handler({ sender: ':1.9', path: '/StatusNotifierItem', iface: 'x', member: 'y', signature: '', body })
  }
}

async function publish(
  session: FakeSession,
  actions: { activate?: () => void; contextMenu?: (x: number, y: number) => void } = {},
): Promise<LinuxTrayItem> {
  return await LinuxTrayItem.publish({
    iconName: 'deepseek-harness',
    id: 'deepseek-harness',
    title: 'DeepSeek Harness',
    onActivate: actions.activate ?? ((): void => {}),
    ...(actions.contextMenu === undefined ? {} : { onContextMenu: actions.contextMenu }),
  }, () => Promise.resolve(session))
}

it('claims an org.kde name and registers it with the watcher', async () => {
  const session = new FakeSession()
  const item = await publish(session)
  expect(session.requestedName).toMatch(/^org\.kde\.StatusNotifierItem-\d+-\d+$/u)
  expect(item.name).toBe(session.requestedName)
  const registration = session.calls.find(call => call.member === 'RegisterStatusNotifierItem')
  expect(registration?.destination).toBe('org.kde.StatusNotifierWatcher')
  expect(registration?.signature).toBe('s')
  expect(registration?.body).toEqual([session.requestedName])
  item.dispose()
})

it('exposes the item interface at the legacy object path', async () => {
  const session = new FakeSession()
  const item = await publish(session)
  expect([...session.methods.keys()].every(key => key.startsWith('/StatusNotifierItem|'))).toBe(true)
  expect(session.methods.has('/StatusNotifierItem|org.kde.StatusNotifierItem|Activate')).toBe(true)
  expect(session.methods.has('/StatusNotifierItem|org.freedesktop.DBus.Properties|GetAll')).toBe(true)
  item.dispose()
})

it('backs off when the bus name is already taken', async () => {
  const session = new FakeSession()
  session.nameResult = 2
  await expect(publish(session)).rejects.toThrow('could not own')
  expect(session.closed).toBe(true)
  expect(session.calls.length).toBe(0)
})

it('drops the connection when the watcher refuses the registration', async () => {
  const session = new FakeSession()
  session.registerError = new Error('no watcher')
  await expect(publish(session)).rejects.toThrow('no watcher')
  expect(session.closed).toBe(true)
})

it('routes a primary click and a secondary click to their actions', async () => {
  const activated: number[] = []
  const menus: string[] = []
  const session = new FakeSession()
  const item = await publish(session, {
    activate: () => { activated.push(1) },
    contextMenu: (x, y) => { menus.push(`${String(x)}x${String(y)}`) },
  })
  await session.invoke('/StatusNotifierItem|org.kde.StatusNotifierItem|Activate', [10, 20])
  await session.invoke('/StatusNotifierItem|org.kde.StatusNotifierItem|SecondaryActivate', [10, 20])
  await session.invoke('/StatusNotifierItem|org.kde.StatusNotifierItem|ContextMenu', [30, 40])
  await session.invoke('/StatusNotifierItem|org.kde.StatusNotifierItem|Scroll', [1, 'vertical'])
  expect(activated.length).toBe(2)
  expect(menus).toEqual(['30x40'])
  item.dispose()
})

it('answers property reads and rejects unknown ones', async () => {
  const session = new FakeSession()
  const item = await publish(session)
  const all = await session.invoke('/StatusNotifierItem|org.freedesktop.DBus.Properties|GetAll', ['org.kde.StatusNotifierItem'])
  expect(all.signature).toBe('a{sv}')
  const properties = all.body[0] as Record<string, { value: unknown }>
  expect(properties.Category?.value).toBe('ApplicationStatus')
  expect(properties.IconName?.value).toBe('deepseek-harness')
  expect(properties.ItemIsMenu?.value).toBe(false)
  expect(properties.Menu?.value).toBe('/NO_DBUSMENU')

  const one = await session.invoke('/StatusNotifierItem|org.freedesktop.DBus.Properties|Get', ['org.kde.StatusNotifierItem', 'Status'])
  expect(one.signature).toBe('v')
  expect((one.body[0] as { value: unknown }).value).toBe('Active')

  expect(() => session.invoke('/StatusNotifierItem|org.freedesktop.DBus.Properties|Get', ['org.kde.StatusNotifierItem', 'Nope'])).toThrow('no property Nope')
  await session.invoke('/StatusNotifierItem|org.freedesktop.DBus.Properties|Set', [])
  const xml = await session.invoke('/StatusNotifierItem|org.freedesktop.DBus.Introspectable|Introspect')
  expect(String(xml.body[0])).toContain('org.kde.StatusNotifierItem')
  item.dispose()
})

it('announces a relabel and a removal', async () => {
  const session = new FakeSession()
  const item = await publish(session)
  item.relabel({ title: 'Renamed', iconName: 'other-icon' })
  expect(session.emitted).toContain('/StatusNotifierItem|org.freedesktop.DBus.Properties|PropertiesChanged')
  expect(session.emitted).toContain('/StatusNotifierItem|org.kde.StatusNotifierItem|NewIcon')
  expect(session.emitted).toContain('/StatusNotifierItem|org.kde.StatusNotifierItem|NewTitle')

  const before = session.emitted.length
  item.relabel({})
  expect(session.emitted.length).toBe(before)

  item.dispose()
  expect(session.emitted).toContain('/StatusNotifierItem|org.kde.StatusNotifierItem|NewStatus')
  expect(session.closed).toBe(true)
  item.relabel({ title: 'ignored' })
  item.dispose()
})
