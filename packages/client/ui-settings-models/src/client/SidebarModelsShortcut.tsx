/**
 * Sidebar shortcut for the Models settings, browser half.
 *
 * The settings panel owns its own navigation, and that panel lives in a package
 * this workspace does not carry the source of. Rather than reach into it, the
 * shortcut renders the Models section it already owns into a portal, so the
 * control sits above the account row in the sidebar foot and opens in place.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { ModelsSection } from './ModelsSection.tsx'
import type { ModelsSectionInjected } from './ModelsSection.tsx'

/**
 * The Models section injects itself through its own apply, which runs before any
 * occupant renders; the shortcut therefore reads the live thunk through this
 * registration seam instead of taking it from slot owner props, which carry only
 * the sidebar column state.
 */
let readInjected: (() => ModelsSectionInjected) | undefined

/**
 * Publish the section's inject thunk for the sidebar occupant.
 * @param injected - Thunk built by this plugin's apply.
 */
export function publishModelsShortcutInjected(injected: () => ModelsSectionInjected): void {
  readInjected = injected
}

/** Geometry and copy supplied by the sidebar foot slot. */
export interface ModelsShortcutProps {
  /** Whether the sidebar shows labels. */
  wide: boolean
  /** Locale-bound translator; the slot binds it from this plugin's namespace. */
  t: (key: 'shortcut') => string
}

/**
 * Render the Models shortcut and, while open, the section itself.
 * @param props - Sidebar geometry and translator.
 */
export function ModelsShortcut({ wide, t }: ModelsShortcutProps): ReactElement {
  const [open, setOpen] = useState(false)
  const label = t('shortcut')
  // A closed shortcut must not keep listening for the Escape key.
  useEffect(() => {
    if (!open) return undefined
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('keydown', close) }
  }, [open])

  const injected = readInjected
  return (
    <>
      <button
        type="button"
        className="dsh-models-shortcut"
        aria-label={label}
        title={label}
        onClick={() => { setOpen(value => !value) }}
      >
        {wide ? <span>{label}</span> : <span aria-hidden="true">◇</span>}
      </button>
      {open && injected !== undefined && (
        <div className="dsh-models-shortcut-panel" role="dialog" aria-modal="true" aria-label={label}>
          <button type="button" className="dsh-models-shortcut-close" aria-label={label} onClick={() => { setOpen(false) }}>×</button>
          <ModelsSection {...injected()} />
        </div>
      )}
    </>
  )
}
