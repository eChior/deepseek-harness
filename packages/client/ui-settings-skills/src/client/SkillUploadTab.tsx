/**
 * The skill publishing page: every skill this machine could send, what the
 * repository already holds for it, and the department skills already published.
 *
 * A row answers one question — is this still mine to send? The badge names the
 * relationship (never published, already published, local is newer, repository
 * is newer) and the buttons follow from it: upload when the repository does not
 * hold the skill, update when it does, delete only for the copy this colleague
 * published. The page never shows a repository path: a colleague needs to know
 * whether their skill arrived, not where it landed.
 */

import { useCallback, useEffect, useState } from 'react'
import type {
  SkillRepoDepartmentView,
  SkillRepoEntryView,
  SkillRepoUploadView,
} from '@deepseek-ai/dsh-api-skill-repo-controller/types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SkillUploadTab.module.css'

/** Publishing mode, matching the Remote request. */
export type SkillPublishMode = 'new' | 'update'

/** Registration-side Remote face used by the page. */
export interface SkillUploadTabInjected {
  /** List the skills this machine can publish, with their repository state. */
  entries: () => Promise<readonly SkillRepoEntryView[]>
  /** List the skills already published by any department. */
  departments: () => Promise<readonly SkillRepoDepartmentView[]>
  /** Publish one skill, by directory name. */
  upload: (name: string, mode: SkillPublishMode) => Promise<SkillRepoUploadView>
  /** Delete this colleague's own copy of one skill. */
  drop: (name: string) => Promise<number>
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
  | {
    readonly status: 'ready'
    readonly skills: readonly SkillRepoEntryView[]
    readonly departments: readonly SkillRepoDepartmentView[]
  }

/** One row's action, kept per skill so each row answers for itself. */
type ActionState =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly action: 'upload' | 'update' | 'remove' }
  | { readonly status: 'done'; readonly message: string }
  | { readonly status: 'failed'; readonly reason: string }

/** Render one size in the largest unit that keeps it short. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The version as this page writes it. */
function versionOf(version: string | null, t: Translate): string {
  return version === null || version === '' ? t('noVersion') : t('version', { version })
}

/** The badge text for one row's relationship with the repository. */
function stateLabelOf(skill: SkillRepoEntryView, t: Translate): string {
  const published = skill.publishedVersion ?? ''
  switch (skill.state) {
    case 'new':
      return t('stateNew')
    case 'published':
      return t('statePublished')
    case 'ahead':
      return t('stateAhead', { version: published })
    case 'behind':
      return t('stateBehind', { version: published })
  }
}

/** The badge class for one row's relationship with the repository. */
function stateClassOf(skill: SkillRepoEntryView): string {
  switch (skill.state) {
    case 'new':
      return css.badgeNew ?? ''
    case 'published':
      return css.badgePublished ?? ''
    case 'ahead':
      return css.badgeAhead ?? ''
    case 'behind':
      return css.badgeBehind ?? ''
  }
}

/** One row's report, translated. */
function reportOf(state: ActionState, t: Translate): string | null {
  switch (state.status) {
    case 'idle':
    case 'running':
      return null
    case 'failed':
      return t('failed', { reason: state.reason })
    case 'done':
      return state.message
  }
}

/** Describe an upload outcome as one line. */
function uploadReport(outcome: SkillRepoUploadView, t: Translate): string {
  const parts = [t('written', { count: outcome.written })]
  if (outcome.unchanged > 0) parts.push(t('unchanged', { count: outcome.unchanged }))
  if (outcome.conflicts.length > 0) parts.push(t('conflicts', { count: outcome.conflicts.length }))
  if (outcome.skipped.length > 0) parts.push(t('skipped', { count: outcome.skipped.length }))
  return parts.join(' · ')
}

/** Render the skill publishing page, as the Plugins settings section asks. */
export function SkillUploadTab(props: SkillUploadTabProps) {
  const { t } = props
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [actions, setActions] = useState<Readonly<Record<string, ActionState>>>({})
  const readEntries = props.entries
  const readDepartments = props.departments

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' })
    try {
      const [skills, departments] = await Promise.all([readEntries(), readDepartments()])
      setState({ status: 'ready', skills, departments })
    } catch (error) {
      setState({ status: 'error', reason: error instanceof Error ? error.message : String(error) })
    }
  }, [readEntries, readDepartments])

  useEffect(() => {
    void load()
  }, [load])

  const publish = useCallback(async (name: string, mode: SkillPublishMode): Promise<void> => {
    setActions(current => ({ ...current, [name]: { status: 'running', action: mode === 'new' ? 'upload' : 'update' } }))
    try {
      const outcome = await props.upload(name, mode)
      setActions(current => ({ ...current, [name]: { status: 'done', message: uploadReport(outcome, t) } }))
      await load()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      setActions(current => ({ ...current, [name]: { status: 'failed', reason } }))
    }
  }, [props, t, load])

  const remove = useCallback(async (name: string): Promise<void> => {
    setActions(current => ({ ...current, [name]: { status: 'running', action: 'remove' } }))
    try {
      const count = await props.drop(name)
      setActions(current => ({ ...current, [name]: { status: 'done', message: t('removed', { count }) } }))
      await load()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      setActions(current => ({ ...current, [name]: { status: 'failed', reason } }))
    }
  }, [props, t, load])

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
            const action = actions[skill.name] ?? { status: 'idle' }
            const report = reportOf(action, t)
            const running = action.status === 'running'
            return (
              <li key={skill.name} className={css.row}>
                <div className={css.identity}>
                  <span className={css.name}>
                    {skill.name}
                    <span className={css.version}>{versionOf(skill.version, t)}</span>
                    <span className={`${css.badge} ${stateClassOf(skill)}`}>{stateLabelOf(skill, t)}</span>
                  </span>
                  {skill.description === null ? null : <span className={css.detail}>{skill.description}</span>}
                  <span className={css.detail}>
                    {t('files', { count: skill.files })}
                    {' · '}
                    {formatBytes(skill.bytes)}
                    {skill.uploader === null ? null : ` · ${t('uploader', { name: skill.uploader })}`}
                  </span>
                  {report === null ? null : (
                    <span className={action.status === 'failed' ? css.error : css.report}>{report}</span>
                  )}
                </div>
                <div className={css.actions}>
                  {skill.state === 'new' ? (
                    <Button
                      variant="primary"
                      disabled={running}
                      onClick={() => void publish(skill.name, 'new')}
                    >
                      {action.status === 'running' && action.action === 'upload' ? t('uploading') : t('upload')}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={running}
                      onClick={() => void publish(skill.name, 'update')}
                    >
                      {action.status === 'running' && action.action === 'update' ? t('updating') : t('update')}
                    </Button>
                  )}
                  {skill.owned ? (
                    <Button
                      variant="ghost"
                      disabled={running}
                      onClick={() => void remove(skill.name)}
                    >
                      {action.status === 'running' && action.action === 'remove' ? t('removing') : t('remove')}
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
      {state.status === 'ready' ? (
        <>
          <h3 className={css.sectionTitle}>{t('departmentSection')}</h3>
          <p className={css.hint}>{t('departmentSectionHint')}</p>
          {state.departments.length === 0 ? <p className={css.muted}>{t('departmentEmpty')}</p> : (
            <ul className={css.list}>
              {state.departments.map(skill => (
                <li key={`${skill.department}/${skill.name}`} className={css.departmentRow}>
                  <div className={css.identity}>
                    <span className={css.name}>
                      {skill.name}
                      <span className={css.version}>{versionOf(skill.version, t)}</span>
                    </span>
                    <span className={css.detail}>
                      {skill.department}
                      {' · '}
                      {t('files', { count: skill.files })}
                      {' · '}
                      {skill.uploader === null ? t('uploaderUnknown') : t('uploader', { name: skill.uploader })}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  )
}
