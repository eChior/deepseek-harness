/**
 * Legacy StatusNotifierItem publisher for Linux panels that predate the freedesktop naming.
 *
 * Electron's own tray registers `org.freedesktop.StatusNotifierItem-<pid>-<n>` at
 * `/StatusNotifierItem/<n>`. Panels built on the older KDE specification — the ukui-panel in Kylin
 * V10 is one — look for an `org.kde.StatusNotifierItem-<pid>-<n>` name whose item lives at
 * `/StatusNotifierItem`, so they silently ignore the Electron one and no icon ever appears. This
 * publishes that older shape directly, next to whatever Electron does.
 */

import { DbusError, DbusSession } from './dbus-session.ts'
import type { DbusCall, DbusReply } from './dbus-session.ts'
import { asString } from './dbus-codec.ts'
import type { DbusVariant } from './dbus-codec.ts'

/**
 * The slice of a session this item uses, so a test can stand in for the bus without a socket.
 */
export interface DbusSessionLike {
  readonly uniqueName: string
  requestName(name: string, flags?: number): Promise<number>
  call(request: {
    destination?: string
    path: string
    iface: string
    member: string
    signature?: string
    body?: readonly unknown[]
  }): Promise<DbusReply>
  exportMethod(path: string, iface: string, member: string, handler: (call: DbusCall) => DbusReply | Promise<DbusReply>): void
  emit(path: string, iface: string, member: string, signature?: string, body?: readonly unknown[]): void
  close(): void
}

const ITEM_PATH = '/StatusNotifierItem'
const ITEM_IFACE = 'org.kde.StatusNotifierItem'
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties'
const INTROSPECTABLE_IFACE = 'org.freedesktop.DBus.Introspectable'
const WATCHER_DESTINATION = 'org.kde.StatusNotifierWatcher'
const WATCHER_PATH = '/StatusNotifierWatcher'
const WATCHER_IFACE = 'org.kde.StatusNotifierWatcher'

/** `org.kde.StatusNotifierItem.Status` value: the item is drawn normally. */
const STATUS_ACTIVE = 'Active'
/** `org.freedesktop.DBus.RequestName` replied with this: this connection now owns the name. */
const REQUEST_NAME_PRIMARY_OWNER = 1

/** Introspection XML; some panels call this before reading properties. */
const ITEM_INTROSPECTION = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="${ITEM_IFACE}">
    <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
    <signal name="NewIcon"/>
    <signal name="NewStatus"><arg name="status" type="s"/></signal>
    <signal name="NewTitle"/>
    <signal name="NewToolTip"/>
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconThemePath" type="s" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
  </interface>
  <interface name="${PROPERTIES_IFACE}">
    <method name="Get"><arg name="interface_name" type="s" direction="in"/><arg name="property_name" type="s" direction="in"/><arg name="value" type="v" direction="out"/></method>
    <method name="GetAll"><arg name="interface_name" type="s" direction="in"/><arg name="properties" type="a{sv}" direction="out"/></method>
    <method name="Set"><arg name="interface_name" type="s" direction="in"/><arg name="property_name" type="s" direction="in"/><arg name="value" type="v" direction="in"/></method>
  </interface>
</node>
`

/** What the item shows and where its clicks go. */
export interface LinuxTrayItemOptions {
  /** Icon theme name, resolved by the panel from the installed icon directory. */
  readonly iconName: string
  /** Icon directory the panel should also search, used when the theme has no match. */
  readonly iconThemePath?: string
  /** Stable identifier of the application behind the item. */
  readonly id: string
  /** Text a panel shows next to or instead of the icon. */
  readonly title: string
  /** Primary click: typically show and focus the window. */
  readonly onActivate: () => void
  /** Secondary click; the panel reports the pointer position in screen coordinates. */
  readonly onContextMenu?: (x: number, y: number) => void
}

/** A published item; `dispose()` removes it from the panel. */
export class LinuxTrayItem {
  private disposed = false

  private constructor(
    private readonly session: DbusSessionLike,
    private readonly busName: string,
    private options: LinuxTrayItemOptions,
  ) {}

  /**
   * Connect to the session bus, claim an `org.kde.StatusNotifierItem-*` name, export the item, and
   * register it with the running watcher.
   * @param options - Icon, identity, and the click actions.
   * @param connect - Session factory, overridden by tests that run without a bus.
   * @throws When there is no session bus or the watcher refuses the registration.
   */
  static async publish(
    options: LinuxTrayItemOptions,
    connect: () => Promise<DbusSessionLike> = () => DbusSession.open(),
  ): Promise<LinuxTrayItem> {
    const session = await connect()
    const busName = `org.kde.StatusNotifierItem-${String(process.pid)}-${String(Date.now() % 1000)}`
    const result = await session.requestName(busName)
    if (result !== REQUEST_NAME_PRIMARY_OWNER) {
      session.close()
      throw new DbusError('org.freedesktop.DBus.Error.NameExists', `dbus: could not own ${busName} (result ${String(result)})`)
    }
    const item = new LinuxTrayItem(session, busName, options)
    item.wire()
    try {
      await session.call({
        destination: WATCHER_DESTINATION,
        path: WATCHER_PATH,
        iface: WATCHER_IFACE,
        member: 'RegisterStatusNotifierItem',
        signature: 's',
        body: [busName],
      })
    } catch (error) {
      session.close()
      throw error
    }
    return item
  }

  /** Well-known bus name the item is published under. */
  get name(): string {
    return this.busName
  }

  /** Replace the visible strings and tell the panel they changed. */
  relabel(options: Partial<Pick<LinuxTrayItemOptions, 'title' | 'iconName'>>): void {
    if (this.disposed) return
    this.options = { ...this.options, ...options }
    const changed: Record<string, DbusVariant> = {}
    if (options.title !== undefined) changed.Title = { signature: 's', value: options.title }
    if (options.iconName !== undefined) changed.IconName = { signature: 's', value: options.iconName }
    if (Object.keys(changed).length === 0) return
    this.session.emit(ITEM_PATH, PROPERTIES_IFACE, 'PropertiesChanged', 'sa{sv}as', [ITEM_IFACE, changed, []])
    if (options.iconName !== undefined) this.session.emit(ITEM_PATH, ITEM_IFACE, 'NewIcon')
    if (options.title !== undefined) this.session.emit(ITEM_PATH, ITEM_IFACE, 'NewTitle')
  }

  /** Remove the item; the bus name goes away with the connection. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.session.emit(ITEM_PATH, ITEM_IFACE, 'NewStatus', 's', ['Passive'])
    this.session.close()
  }

  private wire(): void {
    const session = this.session
    const properties = (): Record<string, DbusVariant> => ({
      Category: { signature: 's', value: 'ApplicationStatus' },
      Id: { signature: 's', value: this.options.id },
      Title: { signature: 's', value: this.options.title },
      Status: { signature: 's', value: STATUS_ACTIVE },
      IconName: { signature: 's', value: this.options.iconName },
      IconThemePath: { signature: 's', value: this.options.iconThemePath ?? '' },
      Menu: { signature: 'o', value: '/NO_DBUSMENU' },
      ItemIsMenu: { signature: 'b', value: false },
    })

    session.exportMethod(ITEM_PATH, PROPERTIES_IFACE, 'Get', (call: DbusCall): DbusReply => {
      const name = asString(call.body[1])
      const value = properties()[name]
      if (value === undefined) {
        throw new DbusError('org.freedesktop.DBus.Error.UnknownProperty', `dbus: no property ${name}`)
      }
      return { signature: 'v', body: [value] }
    })
    session.exportMethod(ITEM_PATH, PROPERTIES_IFACE, 'GetAll', (): DbusReply => ({
      signature: 'a{sv}',
      body: [properties()],
    }))
    session.exportMethod(ITEM_PATH, PROPERTIES_IFACE, 'Set', (): DbusReply => ({ signature: '', body: [] }))
    session.exportMethod(ITEM_PATH, INTROSPECTABLE_IFACE, 'Introspect', (): DbusReply => ({
      signature: 's',
      body: [ITEM_INTROSPECTION],
    }))
    session.exportMethod(ITEM_PATH, ITEM_IFACE, 'Activate', (): DbusReply => {
      this.options.onActivate()
      return { signature: '', body: [] }
    })
    session.exportMethod(ITEM_PATH, ITEM_IFACE, 'SecondaryActivate', (): DbusReply => {
      this.options.onActivate()
      return { signature: '', body: [] }
    })
    session.exportMethod(ITEM_PATH, ITEM_IFACE, 'ContextMenu', (call: DbusCall): DbusReply => {
      this.options.onContextMenu?.(Number(call.body[0] ?? 0), Number(call.body[1] ?? 0))
      return { signature: '', body: [] }
    })
    session.exportMethod(ITEM_PATH, ITEM_IFACE, 'Scroll', (): DbusReply => ({ signature: '', body: [] }))
  }
}
