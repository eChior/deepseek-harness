/**
 * The composer's redaction badge: a small control beside the model selector
 * that lists the placeholders this machine has issued and what each stands
 * for, and owns the user-side choice of which form the transcript reads.
 *
 * Everything is defensive on purpose: the badge renders nothing when the
 * redaction namespace is absent, the entries call fails, or the map is empty,
 * so a deployment without the guard leaves the composer untouched.
 */

import { useEffect, useRef, useState } from 'react'
import type {
  RedactionEntryView,
} from '@deepseek-ai/dsh-api-redaction-controller/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './RedactionBadge.module.css'

/** What the badge needs from the Host: the entries read and the view choice. */
export interface RedactionBadgeInjected {
  /** Read the placeholders this machine has issued, freshest at call time. */
  entries: () => Promise<readonly RedactionEntryView[]>
  /** Publish the user's transcript view choice. */
  setUserView: (view: 'original' | 'placeholder') => void
}

/** Full component props assembled by the composer slot renderer. */
export type RedactionBadgeProps =
  PropsRuntime<'conversation.input.right'>
  & PropsLocale<'settings.redaction'>
  & InjectFace<RedactionBadgeInjected>

/** The composer redaction badge. */
export function RedactionBadge({ entries, setUserView, t }: RedactionBadgeProps) {
  const [items, setItems] = useState<readonly RedactionEntryView[]>([])
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => {
    let inFlight = false
    const read = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const fresh = await entries()
        if (aliveRef.current) setItems(fresh)
      } catch (_error) {
        // An absent or failing provider keeps the last known list; an
        // empty one renders nothing.
      } finally {
        inFlight = false
      }
    }
    void read()
    const timer = window.setInterval(read, 4000)
    return () => {
      aliveRef.current = false
      window.clearInterval(timer)
    }
  }, [entries])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const element = popRef.current
    if (element !== null && window.getComputedStyle(element).position !== 'absolute') {
      console.warn('[redaction-badge] panel is not absolutely positioned; it would stretch the composer row')
    }
  }, [open])

  if (items.length === 0) return null

  return (
    <span className={css.wrap} ref={rootRef}>
      <button
        type="button"
        className={css.badge}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t('badgeAria')}
        title={t('badgeTitle', { total: items.length })}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className={css.dot} aria-hidden />
        {items.length}
      </button>
      {open && (
        <div className={css.panel} ref={popRef} role="dialog" aria-label={t('badgeAria')}>
          <div className={css.head}>
            <span className={css.title}>{t('badgeTitle', { total: items.length })}</span>
          </div>
          <ul className={css.list}>
            {items.map(item => (
              <li key={item.placeholder} className={css.row}>
                <code className={css.placeholder}>{item.placeholder}</code>
                <span className={css.arrow} aria-hidden>→</span>
                <span className={css.original}>{item.original}</span>
              </li>
            ))}
          </ul>
          <div className={css.footer}>
            <button
              type="button"
              className={css.viewToggle}
              onClick={() => { setUserView('placeholder') }}
            >
              {t('badgeShowPlaceholders')}
            </button>
            <button
              type="button"
              className={css.viewToggle}
              onClick={() => { setUserView('original') }}
            >
              {t('badgeShowOriginals')}
            </button>
          </div>
        </div>
      )}
    </span>
  )
}
