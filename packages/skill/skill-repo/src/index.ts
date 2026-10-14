/**
 * Mirror a git-hosted skill repository into the DSH home on startup.
 *
 * This distribution ships its skills from a gitea repository instead of baking
 * them into the installer, so adding a skill does not require a new build. The
 * provider only maintains the mirror on disk — `skill-filesystem` picks the
 * directory up through `customSkillDirs`, so a failed or offline sync costs
 * nothing more than a stale skill set.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cloneRepository, describeRevision, isRepository, updateRepository } from './git.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillRepo: SkillRepository
  }
}

export const name = '@deepseek-ai/dsh-skill-repo'

export interface Config {
  /** Set to false to keep the provider from touching the network at all. */
  enabled?: boolean
  /** Remote to mirror. */
  url?: string
  branch?: string
  /** Where the mirror lives. Defaults to `$DSH_HOME/skills-repo`. */
  directory?: string
  /** Subdirectory of the mirror that holds the skills themselves. */
  skillsDirectory?: string
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  url: z.string().default('http://10.151.5.175:3000/ITPublic/dsh-skills.git'),
  branch: z.string().default('main'),
  directory: z.string().default(dshHomePath('skills-repo')),
  skillsDirectory: z.string().default('skills'),
  timeoutMs: z.number().default(120_000),
})

export interface SkillRepositoryStatus {
  readonly directory: string
  /** Directory to hand to the skill provider, whether or not the sync worked. */
  readonly skillsDirectory: string
  readonly revision: string | null
  readonly state: 'idle' | 'syncing' | 'ready' | 'failed'
  readonly detail: string | null
}

/** Path form of the mirror's skill directory, usable from a Loader `!!js` expression. */
export function skillsDirectoryPath(config: Pick<Config, 'directory' | 'skillsDirectory'> = {}): string {
  return join(config.directory ?? dshHomePath('skills-repo'), config.skillsDirectory ?? 'skills')
}

export class SkillRepository extends Service {
  static inject: string[] = []

  private readonly config: Required<Config>
  private current: SkillRepositoryStatus
  /** In-flight sync, shared by every caller that arrives while it runs. */
  private pending: Promise<SkillRepositoryStatus> | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'skillRepo')
    this.config = {
      enabled: config.enabled ?? true,
      url: config.url ?? 'http://10.151.5.175:3000/ITPublic/dsh-skills.git',
      branch: config.branch ?? 'main',
      directory: config.directory ?? dshHomePath('skills-repo'),
      skillsDirectory: config.skillsDirectory ?? 'skills',
      timeoutMs: config.timeoutMs ?? 120_000,
    }
    const directory = this.config.directory
    const skillsDirectory = this.config.skillsDirectory
    this.current = {
      directory,
      skillsDirectory: join(directory, skillsDirectory),
      revision: null,
      state: 'idle',
      detail: null,
    }
    if (this.config.enabled) {
      ctx.effect(() => {
        void this.sync()
        return () => {}
      }, 'skill-repo: mirror the skills repository on startup')
    }
  }

  get status(): SkillRepositoryStatus {
    return this.current
  }

  /**
   * Bring the mirror up to date. Never throws: an unreachable remote, a missing
   * git binary or a timeout all land in `status.detail` and leave whatever copy
   * is already on disk in place.
   *
   * The constructor already starts one sync, so a caller that arrives while that
   * sync runs joins it rather than cloning into the same directory twice.
   */
  async sync(): Promise<SkillRepositoryStatus> {
    this.pending ??= this.mirror()
    const running = this.pending
    try {
      return await running
    } finally {
      if (this.pending === running) this.pending = undefined
    }
  }

  private async mirror(): Promise<SkillRepositoryStatus> {
    const { directory, skillsDirectory } = this.current
    this.current = { ...this.current, state: 'syncing', detail: null }
    try {
      if (isRepository(directory)) {
        await updateRepository(directory, this.config.branch, this.config.timeoutMs)
      } else {
        await mkdir(dirname(directory), { recursive: true })
        await cloneRepository(this.config.url, directory, this.config.branch, this.config.timeoutMs)
      }
      const revision = await describeRevision(directory, this.config.timeoutMs)
      this.current = { ...this.current, state: 'ready', revision, detail: null }
      this.ctx.logger.info(`skill-repo: ${this.config.url} at ${revision}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.current = { ...this.current, state: 'failed', detail }
      this.ctx.logger.warn(`skill-repo: keeping the existing mirror at ${skillsDirectory}: ${detail}`)
    }
    return this.current
  }
}

export default SkillRepository
