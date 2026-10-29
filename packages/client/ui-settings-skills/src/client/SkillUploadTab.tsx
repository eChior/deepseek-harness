/**
 * The skill publishing page: every skill this machine could send, and one button
 * that sends the chosen one into the department skill repository.
 *
 * The page deliberately shows no repository paths: a colleague needs to know
 * whether their skill arrived, not where it landed. Conflicts are surfaced
 * because they are the one outcome that needs a human decision — the file
 * already exists with different contents and publishing will not overwrite it.
 */

import { useCallback, useEffect, useState } from 'react'
import type {
  SkillRepoLocalView,
  SkillRepoUploadView,
} from '@deepseek-ai/dsh-api-skill-repo-controller/types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SkillUploadTab.module.css'

/** Registration-side Remote face used by the page. */
export interface SkillUploadTabInjected {
  /** List the skills this machine can publish. */
  skills: () => Promise<readonly SkillRepoLocalView[]>
  /** Publish one skill, by directory name. */
  upload: (name: string) => Promise<SkillRepoUploadView>
}

/** Full component props assembled by the Settings slot renderer. */
export type SkillUploadTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.skills'>
  & InjectFace<SkillUploadTabInjected>

type Translate = SkillUploadTabProps['t']

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly reason: string }
  | { readonly status: 'ready'; readonly skills: readonly SkillRepoLocalView[] }

/** What one upload reported, kept per skill so each row can answer for itself. */
type UploadState =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'done'; readonly outcome: SkillRepoUploadView }
  | { readonly status: 'failed'; readonly reason: string }

/** Render one size in the largest unit that keeps it short. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** One row's report, translated. */
function reportOf(state: UploadState, t: Translate): string | null {
  switch (state.status) {
    case 'idle':
    case 'running':
      return null
    case 'failed':
      return t('failed', { reason: state.reason })
    case 'done': {
      const { outcome } = state
      const parts = [t('written', { count: outcome.written })]
      if (outcome.unchanged > 0) parts.push(t('unchanged', { count: outcome.unchanged }))
      if (outcome.conflicts.length > 0) parts.push(t('conflicts', { count: outcome.conflicts.length }))
      if (outcome.skipped.length > 0) parts.push(t('skipped', { count: outcome.skipped.length }))
      return parts.join(' · ')
    }
  }
}

/** Render the skill publishing page, as the Plugins settings section asks. */
export function SkillUploadTab(props: SkillUploadTabProps) {
  const { t } = props
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [uploads, setUploads] = useState<Readonly<Record<string, UploadState>>>({})
  const read = props.skills

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' })
    try {
      setState({ status: 'ready', skills: await read() })
    } catch (error) {
      setState({ status: 'error', reason: error instanceof Error ? error.message : String(error) })
    }
  }, [read])

  useEffect(() => {
    void load()
  }, [load])

  const publish = useCallback(async (name: string): Promise<void> => {
    setUploads(current => ({ ...current, [name]: { status: 'running' } }))
    try {
      const outcome = await props.upload(name)
      setUploads(current => ({ ...current, [name]: { status: 'done', outcome } }))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      setUploads(current => ({ ...current, [name]: { status: 'failed', reason } }))
    }
  }, [props])

  return (
    <section className={css.section}>
      <h2 className={css.title}>{t('tab')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      <p className={css.hint}>{t('departmentHint')}</p>
      <div className={css.toolbar}>
        <Button variant="outline" onClick={() => void load()}>{t('refresh')}</Button>
      </div>
      {state.status === 'loading' ? <p className={css.muted}>{t('loading')}</p> : null}
      {state.status === 'error' ? <p className={css.error}>{t('loadFailed', { reason: state.reason })}</p> : null}
      {state.status === 'ready' && state.skills.length === 0 ? <p className={css.muted}>{t('empty')}</p> : null}
      {state.status === 'ready' && state.skills.length > 0 ? (
        <ul className={css.list}>
          {state.skills.map((skill) => {
            const upload = uploads[skill.name] ?? { status: 'idle' }
            const report = reportOf(upload, t)
            return (
              <li key={skill.name} className={css.row}>
                <div className={css.identity}>
                  <span className={css.name}>{skill.name}</span>
                  {skill.description === null ? null : <span className={css.detail}>{skill.description}</span>}
                  <span className={css.detail}>
                    {t('files', { count: skill.files })}
                    {' · '}
                    {formatBytes(skill.bytes)}
                  </span>
                  {report === null ? null : (
                    <span className={upload.status === 'failed' ? css.error : css.report}>{report}</span>
                  )}
                </div>
                <Button
                  variant="primary"
                  disabled={upload.status === 'running'}
                  onClick={() => void publish(skill.name)}
                >
                  {upload.status === 'running' ? t('uploading') : t('upload')}
                </Button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
