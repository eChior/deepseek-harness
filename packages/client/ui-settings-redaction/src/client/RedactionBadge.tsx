/**
 * The composer's redaction badge: a small control beside the model selector
 * that carries the whole redaction surface — the guard state, the switches the
 * user owns, and the table of placeholders this machine has issued.
 *
 * The badge is always present. It used to disappear while the map was empty,
 * which is the normal state of a fresh session — the control that switches the
 * transcript between placeholders and originals was therefore unreachable
 * exactly when a reader first looks for it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  RedactionEntryView,
  RedactionStatusView,
} from '@deepseek-ai/dsh-api-redaction-controller/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './RedactionBadge.module.css'

/** Which form the transcript is currently reading. */
export type RedactionUserView = 'original' | 'placeholder'

/** What the badge needs from the Host: the entries read and the choices it owns. */
export interface RedactionBadgeInjected {
  /** Read the placeholders this machine has issued, freshest at call time. */
  entries: () => Promise<readonly RedactionEntryView[]>
  /** Read the guard state, the rule counts, and the running replacement counter. */
  status: () => Promise<RedactionStatusView>
  /** Publish the user's transcript view choice. */
  setUserView: (view: RedactionUserView) => void
  /** The view the transcript is reading now. */
  userView: RedactionUserView
  /**
   * Read the stored view choice again, for a subscriber that has just been
   * told it changed.
   */
  readUserView: () => RedactionUserView
  /**
   * Follow the stored view choice. Without it the highlight would stay on the
   * button the user clicked even after the write was rejected or normalized.
   */
  subscribeUserView: (listener: () => void) => () => void
  /** Publish whether an ended session writes its placeholder table to disk. */
  setMappings: (enabled: boolean) => void
  /** Colour a restored original is painted in. */
  highlightColor: string
  /** Publish the colour choice. */
  setHighlightColor: (color: string) => void
}

/** Full component props assembled by the composer slot renderer. */
export type RedactionBadgeProps =
  PropsRuntime<'conversation.input.right'>
  & PropsLocale<'settings.redaction'>
  & InjectFace<RedactionBadgeInjected>

/** Re-read interval for the placeholder table and the status, in milliseconds. */
const POLL_MS = 2000

/** Fallback the colour input accepts when the stored preference is unset. */
const DEFAULT_COLOR = '#d92d20'

/** The composer redaction badge. */
export function RedactionBadge({
  entries, status, setUserView, userView, readUserView, subscribeUserView,
  setMappings, highlightColor, setHighlightColor, t,
}: RedactionBadgeProps) {
  const [items, setItems] = useState<readonly RedactionEntryView[]>([])
  const [state, setState] = useState<RedactionStatusView | null>(null)
  const [open, setOpen] = useState(false)
  // The stored preference is the source of truth: the click only asks for the
  // write, and this local copy follows whatever the Host ends up holding.
  const [view, setView] = useState<RedactionUserView>(userView)
  const [color, setColor] = useState<string>(highlightColor)
  // A colour input fires on every drag frame; publishing each frame repaints
  // the transcript in steps and writes the Host once per step. The picker
  // therefore only stages a draft, and the Apply button beside it publishes.
  const [draftColor, setDraftColor] = useState<string>(highlightColor)

  const rootRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    setView(userView)
  }, [userView])

  useEffect(() => {
    setColor(highlightColor)
    setDraftColor(highlightColor)
  }, [highlightColor])

  useEffect(() => subscribeUserView(() => { setView(readUserView()) }), [subscribeUserView, readUserView])

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const read = useCallback(async (): Promise<void> => {
    const [rows, fresh] = await Promise.all([
      entries().catch(() => null),
      status().catch(() => null),
    ])
    if (!aliveRef.current) return
    if (rows !== null) setItems(rows)
    if (fresh !== null) setState(fresh)
  }, [entries, status])

  useEffect(() => {
    let inFlight = false
    const tick = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        await read()
      } finally {
        inFlight = false
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, POLL_MS)
    return () => {
      aliveRef.current = false
      window.clearInterval(timer)
    }
  }, [read])

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

  const replacements = state?.replacements ?? 0
  const mappings = state?.mappings ?? true
  const rules = state === null ? null : t('rulesValue', { terms: state.terms, patterns: state.patterns })

  return (
    <span className={css.wrap} ref={rootRef}>
      <button
        type="button"
        className={`${css.badge}${view === 'original' ? '' : ` ${css.badgePlaceholder}`}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t('badgeAria')}
        title={t('badgeTitle', { total: replacements })}
        onClick={() => { setOpen(value => !value) }}
      >
        {/* Four facts at a glance, before the panel is opened: the guard is on,
            how many replacements this process made, whether an ended session
            still writes its map back, and which form the transcript shows. */}
        <span className={`${css.dot}${mappings ? '' : ` ${css.dotOff}`}`} aria-hidden />
        <span className={css.name}>{t('badgeName')}</span>
        <span className={css.count}>{replacements}</span>
        <span className={`${css.viewChip}${view === 'placeholder' ? ` ${css.viewChipPlaceholder}` : ''}`}>
          {view === 'original' ? t('badgeViewOriginal') : t('badgeViewPlaceholder')}
        </span>
        <span className={`${css.viewChip}${mappings ? '' : ` ${css.viewChipPlaceholder}`}`}>
          {mappings ? t('badgeMappingsShort') : t('badgeMappingsOff')}
        </span>
        <span className={css.swatch} style={{ background: color }} aria-hidden />
      </button>
      {open && (
        <div className={css.panel} ref={popRef} role="dialog" aria-label={t('badgeAria')}>
          <div className={css.head}>
            <span className={css.title}>{t('badgeStatusTitle')}</span>
            <button type="button" className={css.close} onClick={() => { setOpen(false) }}>
              {t('badgeClose')}
            </button>
          </div>

          <dl className={css.facts}>
            <dt>{t('badgeGuard')}</dt>
            <dd><span className={css.on}>{t('badgeOn')}</span></dd>
            <dt>{t('badgeImageTool')}</dt>
            <dd><span className={css.off}>{t('badgeOff')}</span></dd>
            <dt>{t('badgeRevision')}</dt>
            <dd>{state?.revision ?? t('never')}</dd>
            <dt>{t('badgeRules')}</dt>
            <dd>{rules ?? t('loading')}</dd>
            <dt>{t('badgeReplacements')}</dt>
            <dd>{replacements}</dd>
          </dl>

          <div className={css.switches}>
            <label className={css.switchRow}>
              <input
                type="checkbox"
                checked={mappings}
                onChange={(event) => { setMappings(event.currentTarget.checked) }}
              />
              <span className={css.switchLabel}>{t('badgeMappings')}</span>
            </label>
            <p className={css.hint}>{t('badgeMappingsHint')}</p>
            <p className={css.hint}>{t('badgeRestoreFormats')}</p>

            <div className={css.switchRow}>
              <span className={css.switchLabel}>{t('badgeView')}</span>
              <span className={css.segmented}>
                <button
                  type="button"
                  className={`${css.segment}${view === 'original' ? ` ${css.segmentActive}` : ''}`}
                  aria-pressed={view === 'original'}
                  onClick={() => { setUserView('original') }}
                >
                  {t('badgeViewOriginal')}
                </button>
                <button
                  type="button"
                  className={`${css.segment}${view === 'placeholder' ? ` ${css.segmentActive}` : ''}`}
                  aria-pressed={view === 'placeholder'}
                  onClick={() => { setUserView('placeholder') }}
                >
                  {t('badgeViewPlaceholder')}
                </button>
              </span>
            </div>

            <div className={css.switchRow}>
              <label className={css.switchLabel} htmlFor="redaction-highlight">{t('badgeHighlight')}</label>
              <span className={css.colorGroup}>
                <input
                  id="redaction-highlight"
                  type="color"
                  className={css.color}
                  value={/^#[0-9a-fA-F]{6}$/.test(draftColor) ? draftColor : DEFAULT_COLOR}
                  onChange={(event) => { setDraftColor(event.currentTarget.value) }}
                />
                <button
                  type="button"
                  className={css.apply}
                  disabled={draftColor === color}
                  onClick={() => { setHighlightColor(draftColor) }}
                >
                  {t('badgeApply')}
                </button>
              </span>
            </div>
          </div>

          <div className={css.entriesHead}>
            <span>{t('badgeEntriesTitle', { total: items.length })}</span>
            <button type="button" className={css.refresh} onClick={() => { void read() }}>
              {t('badgeRefresh')}
            </button>
          </div>
          {items.length === 0
            ? <p className={css.empty}>{t('badgeEmpty')}</p>
            : (
              <ul className={css.list}>
                {items.map(item => (
                  <li key={item.placeholder} className={css.row}>
                    <code className={css.placeholder}>{item.placeholder}</code>
                    <span className={css.arrow} aria-hidden>→</span>
                    <span className={css.original} style={{ color }}>{item.original}</span>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </span>
  )
}
