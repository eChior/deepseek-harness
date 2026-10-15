/**
 * Sidebar shortcut for the Models settings, browser half.
 *
 * The settings panel owns its own navigation: its sections are rendered by
 * the shell that declares `sidebar.settings`, and that section seat is not
 * this package's to render. The shortcut therefore drives the panel through
 * the `settingsShell` service ui-settings-general provides, opening the panel
 * directly on this feature's section.
 */
import { IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the sidebar shell's SlotMap merge (the
// 'sidebar.footer.action' entry this component is registered against).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './SidebarModelsShortcut.module.css'

/** Injected share of the sidebar shortcut (this plugin's register factory). */
export interface ModelsShortcutInjected {
  /** Open the Settings panel on this feature's registered section. */
  openModelsSection: () => void
}

/** Full props composed by the sidebar foot action seat. */
export type ModelsShortcutProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<ModelsShortcutInjected> & PropsLocale<'settings.models'>

/**
 * Render the Models shortcut: the sidebar foot keeps the account row last, and
 * this seat sits directly above the Settings row so the models that drive every
 * session stay reachable without opening Settings first.
 * @param props - sidebar geometry, the panel driver, and the translator.
 * @returns the sidebar foot action.
 */
export function ModelsShortcut({ wide, t, openModelsSection }: ModelsShortcutProps) {
  const label = t('shortcut')
  return (
    <button type="button" className={css.action} aria-label={label} title={label} onClick={openModelsSection}>
      <IconSparkleRegular size={wide ? 16 : 18} />
      {wide && <span className={css.label}>{label}</span>}
    </button>
  )
}
