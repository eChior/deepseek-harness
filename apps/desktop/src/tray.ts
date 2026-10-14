/** System tray (Windows ICO / Linux StatusNotifierItem): the always-present way back to a hidden window and the explicit quit entry. */

import { Menu, nativeImage, Tray } from 'electron'

import { LinuxTrayItem } from './linux-tray-item.ts'
import type { DesktopLocale } from './locale.ts'

/** Icon theme name the Linux item resolves through the installed hicolor assets. */
const LINUX_ICON_NAME = 'deepseek-harness'

/** Main-process actions the tray triggers; both run the same paths as the window and application menu. */
export interface DesktopTrayOptions {
  /** Multi-size ICO rendered by `scripts/render-tray-icon.ts`; Windows picks the bitmap for the display scale. */
  readonly iconPath: string
  readonly locale: () => DesktopLocale
  /** Show and focus the primary window. */
  readonly open: () => void
  /** Request quit through the same confirmation as every other quit entry. */
  readonly quit: () => void
  /**
   * Pop the same entries as a native context menu at the pointer, for panels that report a
   * secondary click instead of letting the toolkit drive the menu.
   */
  readonly showContextMenu?: () => void
}

/** Tray icon present for the whole run, not only while the window is hidden. */
export class DesktopTray {
  private tray: Tray | undefined
  private item: LinuxTrayItem | undefined
  private disposed = false

  /** @param options - Icon path, locale reader, and the open and quit actions. */
  constructor(private readonly options: DesktopTrayOptions) {
    if (process.platform === 'linux') {
      void this.publishLinuxItem()
      return
    }
    const tray = new Tray(nativeImage.createFromPath(options.iconPath))
    this.tray = tray
    tray.on('click', () => { options.open() })
    this.relabel()
  }

  /** Rebuild the tooltip and context menu in the current locale. */
  relabel(): void {
    const { messages } = this.options.locale()
    if (this.item !== undefined) {
      this.item.relabel({ title: messages.aboutProduct })
      return
    }
    const tray = this.tray
    if (tray === undefined) return
    tray.setToolTip(messages.aboutProduct)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: messages.openApplication, click: () => { this.options.open() } },
      { type: 'separator' },
      { label: messages.quitApplication, click: () => { this.options.quit() } },
    ]))
  }

  /** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */
  dispose(): void {
    this.disposed = true
    const tray = this.tray
    this.tray = undefined
    tray?.destroy()
    const item = this.item
    this.item = undefined
    item?.dispose()
  }

  /**
   * Publish the item panels built on the older KDE naming can see. Electron's tray keeps the
   * freedesktop naming, which the ukui-panel in Kylin V10 does not resolve, so on Linux the panel
   * is driven from here instead.
   */
  private async publishLinuxItem(): Promise<void> {
    try {
      const messages = this.options.locale().messages
      const item = await LinuxTrayItem.publish({
        iconName: LINUX_ICON_NAME,
        id: LINUX_ICON_NAME,
        title: messages.aboutProduct,
        onActivate: () => { this.options.open() },
        onContextMenu: () => { this.options.showContextMenu?.() },
      })
      if (this.disposed) {
        item.dispose()
        return
      }
      this.item = item
    } catch (error) {
      console.warn('desktop tray: unavailable', error)
    }
  }
}
