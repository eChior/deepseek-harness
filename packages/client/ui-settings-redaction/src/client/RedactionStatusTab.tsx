/**
 * The redaction status page: which term list the provider loaded, how many
 * rules it compiled, how many replacements this process has made, and how many
 * term requests are still queued locally. Read-only — the guard has no off
 * switch, so the page reports rather than configures.
 */

import { useCallback, useEffect, useState } from 'react'
import type { RedactionStatusView } from '@deepseek-ai/dsh-api-redaction-controller/types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './RedactionStatusTab.module.css'

/** Registration-side Remote face used by the page. */
export interface RedactionStatusTabInjected {
  /** Read the current provider status. */
  status: () => Promise<RedactionStatusView>
}

/** Full component props assembled by the Settings slot renderer. */
export type RedactionStatusTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.redaction'>
  & InjectFace<RedactionStatusTabInjected>

type Translate = RedactionStatusTabProps['t']

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly view: RedactionStatusView }

/** Display name of the copy of the term list the loaded rules came from. */
function sourceLabel(view: RedactionStatusView, t: Translate): string {
  switch (view.source) {
    case 'bundled': return t('sourceBundled')
    case 'cache': return t('sourceCache')
    case 'remote': return t('sourceRemote')
  }
}

/** Render the redaction status page, as the Plugins settings section asks. */
export function RedactionStatusTab(props: RedactionStatusTabProps) {
  const { t } = props
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const read = props.status

  const refresh = useCallback((): void => {
    setState({ status: 'loading' })
    void read().then(
      (view) => { setState({ status: 'ready', view }) },
      () => { setState({ status: 'error' }) },
    )
  }, [read])

  useEffect(() => {
    let live = true
    void read().then(
      (view) => { if (live) setState({ status: 'ready', view }) },
      () => { if (live) setState({ status: 'error' }) },
    )
    return () => { live = false }
  }, [read])

  if (state.status === 'loading') return <p className={css.status}>{t('loading')}</p>
  if (state.status === 'error') {
    return (
      <div className={css.failure}>
        <p>{t('error')}</p>
        <Button onClick={refresh}>{t('retry')}</Button>
      </div>
    )
  }

  const { view } = state
  return (
    <section className={css.section}>
      <div className={css.panel}>
        <h3 className={css.heading}>{t('guardTitle')}</h3>
        <p className={css.hint}>{t('guardHint')}</p>
      </div>
      <dl className={css.rows}>
        <dt className={css.term}>{t('revisionLabel')}</dt>
        <dd className={css.value}>{view.revision ?? t('never')}</dd>
        <dt className={css.term}>{t('sourceLabel')}</dt>
        <dd className={css.value}>{sourceLabel(view, t)}</dd>
        <dt className={css.term}>{t('rulesLabel')}</dt>
        <dd className={css.value}>{t('rulesValue', { terms: view.terms, patterns: view.patterns })}</dd>
        <dt className={css.term}>{t('replacementsLabel')}</dt>
        <dd className={css.value}>{view.replacements}</dd>
        <dt className={css.term}>{t('pendingLabel')}</dt>
        <dd className={css.value}>{view.pending}</dd>
        <dt className={css.term}>{t('checkedLabel')}</dt>
        <dd className={css.value}>{view.lastChecked ?? t('never')}</dd>
      </dl>
      <p className={css.hint}>{t('rulesHint')}</p>
      {view.detail !== null && <p className={css.note}>{t('detailBlocked', { detail: view.detail })}</p>}
      {view.lastError !== null && <p className={css.note}>{t('staleLabel')}: {view.lastError}</p>}
      {view.pending > 0 && <p className={css.hint}>{t('pendingHint')}</p>}
      <div className={css.actions}>
        <Button onClick={refresh}>{t('refresh')}</Button>
      </div>
    </section>
  )
}
