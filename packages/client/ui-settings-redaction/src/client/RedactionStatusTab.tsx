/**
 * The redaction page: which term list the provider loaded, how many rules it
 * compiled, how many replacements this process has made, and — the part a
 * department acts on — the term lists uploaded to this machine.
 *
 * The status half is read-only because the guard has no off switch. The upload
 * half is writable because the published list is the floor, not the ceiling: a
 * department knows terms the company list cannot, and the page is where it
 * says so. Every upload stays on this machine.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  RedactionRosterView,
  RedactionStatusView,
  RedactionUploadView,
} from '@deepseek-ai/dsh-api-redaction-controller/types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './RedactionStatusTab.module.css'

/** Registration-side Remote face used by the page. */
export interface RedactionStatusTabInjected {
  /** Read the current provider status. */
  status: () => Promise<RedactionStatusView>
  /** Read the staff directory summary and what it says about the caller. */
  roster: () => Promise<RedactionRosterView>
  /** List the term lists uploaded to this machine. */
  uploads: () => Promise<RedactionUploadView[]>
  /** Store one uploaded list and put it in force. */
  upload: (request: { readonly name: string; readonly text: string }) => Promise<RedactionUploadView>
  /** Drop one uploaded list. */
  remove: (request: { readonly name: string }) => Promise<boolean>
  /** Turn one uploaded list on or off. */
  setEnabled: (request: { readonly name: string; readonly enabled: boolean }) => Promise<RedactionUploadView>
  /** Read the example a department starts from. */
  example: () => Promise<{ readonly name: string; readonly text: string }>
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

/** Largest upload the page will read from disk, matching the provider's own ceiling. */
const MAX_UPLOAD_BYTES = 256 * 1024

/** Display name of the copy of the term list the loaded rules came from. */
function sourceLabel(view: RedactionStatusView, t: Translate): string {
  switch (view.source) {
    case 'bundled': return t('sourceBundled')
    case 'cache': return t('sourceCache')
    case 'remote': return t('sourceRemote')
  }
}

/** Render the redaction page, as the Plugins settings section asks. */
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
      <UploadsPanel {...props} onChanged={refresh} />
    </section>
  )
}

/** Props the upload half adds to the ones the page already carries. */
type UploadsPanelProps = RedactionStatusTabProps & { readonly onChanged: () => void }

/**
 * The upload half: what this machine holds, and what it takes to add another.
 *
 * A file is read in the browser and its text handed over, so the upload is the
 * YAML the department can already read — there is no server-side path that
 * accepts an opaque blob, and nothing is stored before the provider accepts it.
 */
function UploadsPanel(props: UploadsPanelProps) {
  const { t } = props
  const [uploads, setUploads] = useState<readonly RedactionUploadView[] | null>(null)
  const [roster, setRoster] = useState<RedactionRosterView | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement | null>(null)
  const readUploads = props.uploads
  const readRoster = props.roster

  const reload = useCallback((): void => {
    void readUploads().then(setUploads, () => { setUploads([]) })
    void readRoster().then(setRoster, () => { setRoster(null) })
  }, [readUploads, readRoster])

  useEffect(reload, [reload])

  const submit = useCallback((file: File): void => {
    setBusy(true)
    setFailure(null)
    void file.text().then(
      async (text) => {
        await props.upload({ name: file.name, text })
        setUploads(await props.uploads())
        props.onChanged()
      },
      (error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) },
    ).catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      setBusy(false)
      if (picker.current !== null) picker.current.value = ''
    })
  }, [props])

  const choose = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    if (file === undefined) return
    if (file.size > MAX_UPLOAD_BYTES) {
      setFailure(t('uploadsFileTooBig'))
      event.target.value = ''
      return
    }
    submit(file)
  }, [submit, t])

  const download = useCallback((): void => {
    void props.example().then((sample) => {
      const blob = new Blob([sample.text], { type: 'text/yaml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = sample.name
      anchor.click()
      URL.revokeObjectURL(url)
    }, () => { setFailure(t('error')) })
  }, [props, t])

  const toggle = useCallback((entry: RedactionUploadView): void => {
    void props.setEnabled({ name: entry.name, enabled: !entry.enabled }).then(
      async () => { setUploads(await props.uploads()); props.onChanged() },
      (error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) },
    )
  }, [props])

  const drop = useCallback((entry: RedactionUploadView): void => {
    void props.remove({ name: entry.name }).then(
      async () => { setUploads(await props.uploads()); props.onChanged() },
      (error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) },
    )
  }, [props])

  return (
    <div className={css.panel}>
      <h3 className={css.heading}>{t('uploadsTitle')}</h3>
      <p className={css.hint}>{t('uploadsHint')}</p>
      {roster !== null && (
        <p className={css.hint}>
          {roster.enabled
            ? t('uploadsRosterOn', { people: roster.people, departments: roster.departments })
            : t('uploadsRosterOff')}
        </p>
      )}
      {roster !== null && roster.enabled && roster.account === null && (
        <p className={css.hint}>{t('uploadsRosterUnknown')}</p>
      )}
      {uploads === null && <p className={css.status}>{t('loading')}</p>}
      {uploads !== null && uploads.length === 0 && <p className={css.hint}>{t('uploadsEmpty')}</p>}
      {uploads !== null && uploads.length > 0 && (
        <ul className={css.uploads}>
          {uploads.map(entry => (
            <li key={entry.name} className={css.upload}>
              <div className={css.uploadHead}>
                <span className={css.uploadName}>{entry.name}</span>
                <span className={css.uploadState}>{entry.enabled ? t('uploadsEnable') : t('uploadsDisabled')}</span>
              </div>
              <p className={css.hint}>
                {entry.department === null && entry.author === null
                  ? t('uploadsNoAttribution')
                  : t('uploadsAttribution', { department: entry.department ?? '', author: entry.author ?? '' })}
                {' · '}
                {t('uploadsCounts', { terms: entry.terms, patterns: entry.patterns })}
              </p>
              {entry.problems.length > 0 && (
                <div className={css.note}>
                  <p>{t('uploadsProblems')}</p>
                  <ul>
                    {entry.problems.map((problem, index) => <li key={String(index)}>{problem}</li>)}
                  </ul>
                </div>
              )}
              <div className={css.actions}>
                <Button onClick={() => { toggle(entry) }}>{t('uploadsEnable')}</Button>
                <Button onClick={() => { drop(entry) }}>{t('uploadsRemove')}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {failure !== null && <p className={css.note}>{t('uploadsFailed', { detail: failure })}</p>}
      <div className={css.actions}>
        <input
          ref={picker}
          className={css.file}
          type="file"
          accept=".yaml,.yml,.txt"
          onChange={choose}
        />
        <Button onClick={download}>{t('uploadsExample')}</Button>
        {busy && <span className={css.hint}>{t('uploadsUploading')}</span>}
      </div>
    </div>
  )
}
