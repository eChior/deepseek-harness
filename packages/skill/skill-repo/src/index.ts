/**
 * Mirror a git-hosted skill repository into the DSH home on startup.
 *
 * This distribution ships its skills from a gitea repository instead of baking
 * them into the installer, so adding a skill does not require a new build. The
 * provider keeps a mirror on disk and publishes every skill it carries into the
 * user skill root, which `skill-filesystem` already scans, so a failed or
 * offline sync costs nothing more than a stale skill set.
 *
 * The mirror is read from the branch archive over HTTP rather than from a `git
 * clone`: the desktop application has to work on machines that never installed a
 * git binary, and the whole working tree is all this provider ever needs.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  UPLOADER_FILE,
  deleteSkillFiles,
  giteaTarget,
  parseSkillManifest,
  readDepartmentSkills,
  readRepositoryTree,
  readSkillDirectory,
  uploadSkillFiles,
  type RemoteSkill,
} from './upload.ts'
import { archiveUrl, branchRevision, downloadArchive, readArchive, writeArchive } from './archive.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillRepo: SkillRepository
  }
}

export const name = '@deepseek-ai/dsh-skill-repo'

/** Directory the staging copy lives in while a sync replaces the mirror. */
const STAGING_SUFFIX = '.staging'

/** The archive wraps everything in one `<repository>-<branch>` directory. */
const ARCHIVE_ROOT_COMPONENTS = 1

/** File beside the mirror that names the skills this provider published. */
const PUBLISH_MANIFEST = '.dsh-skill-repo-published.json'

/**
 * Skills this distribution carries inside the installer. A machine that never
 * reached the remote still receives a working skill set from them, so an
 * offline install is not an install without skills.
 */
const BUNDLED_SKILLS = fileURLToPath(new URL('../assets/skills', import.meta.url))

/** Fields a deployment can set for the skill mirror. */
export interface Config {
  /** Set to false to keep the provider from touching the network at all. */
  enabled?: boolean
  /** Remote to mirror. */
  url?: string
  /** Branch to mirror. Defaults to `main`. */
  branch?: string
  /** Where the mirror lives. Defaults to `$DSH_HOME/skills-repo`. */
  directory?: string
  /** Subdirectory of the mirror that holds the skills themselves. */
  skillsDirectory?: string
  /** Skill root the synced skills are published into. Defaults to `$DSH_HOME/skills`. */
  publishDirectory?: string
  /**
   * Skills this build carries, used while no mirror exists yet and the remote is
   * unreachable. Defaults to the copy inside this package.
   */
  bundledDirectory?: string
  /** Per-request timeout for the archive download and the branch lookup. */
  timeoutMs?: number
  /**
   * Token the publishing seam presents to the repository host. Empty falls back
   * to `DSH_SKILLS_TOKEN`, so a deployment can keep it out of the config file.
   */
  token?: string
}

/** One skill on this machine that a colleague can publish. */
export interface LocalSkillView {
  readonly name: string
  /** First sentence of the skill's own description, or its title. */
  readonly description: string | null
  /** The publisher's own version label, read from the skill's `SKILL.md`. */
  readonly version: string | null
  readonly files: number
  readonly bytes: number
}

/** Where a local skill stands against the repository its department publishes to. */
export type SkillPublishState = 'new' | 'published' | 'ahead' | 'behind'

/** One row of the publishing page: this machine's copy beside the repository's. */
export interface SkillEntryView {
  readonly name: string
  readonly description: string | null
  readonly version: string | null
  readonly files: number
  readonly bytes: number
  readonly state: SkillPublishState
  /** Version the repository holds for this skill, when it holds one. */
  readonly publishedVersion: string | null
  /** Department whose directory holds it, or null while it is unpublished. */
  readonly department: string | null
  readonly uploader: string | null
  readonly uploadedAt: string | null
  /** Whether the signed-in colleague published the copy in the repository. */
  readonly owned: boolean
}

/** Every department skill the repository holds, as the page lists them. */
export interface DepartmentSkillView {
  readonly name: string
  readonly department: string
  readonly version: string | null
  readonly description: string | null
  readonly uploader: string | null
  readonly uploadedAt: string | null
  readonly files: number
}

/**
 * What publishing one skill did. `conflicts` lists repository paths that
 * already hold different bytes: publishing never rewrites them.
 */
export interface SkillUploadView {
  readonly name: string
  readonly written: number
  readonly unchanged: number
  readonly conflicts: readonly string[]
  readonly skipped: readonly string[]
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  url: z.string().default('http://10.151.5.175:3000/ITPublic/dsh-skills.git'),
  branch: z.string().default('main'),
  directory: z.string().default(dshHomePath('skills-repo')),
  skillsDirectory: z.string().default('skills'),
  publishDirectory: z.string().default(dshHomePath('skills')),
  bundledDirectory: z.string().default(BUNDLED_SKILLS),
  timeoutMs: z.number().default(120_000),
  token: z.string().default(''),
})

/** Where the mirror currently stands and which skills it published. */
export interface SkillRepositoryStatus {
  readonly directory: string
  /** Directory inside the mirror that holds the skills the archive carries. */
  readonly skillsDirectory: string
  /** Skill root the synced skills are published into. */
  readonly publishDirectory: string
  readonly revision: string | null
  /** Where the skills on disk came from: the remote, this build, or nowhere yet. */
  readonly source: 'remote' | 'bundled' | 'none'
  readonly state: 'idle' | 'syncing' | 'ready' | 'failed'
  readonly detail: string | null
}

/**
 * Path form of the mirror's skill directory, usable from a Loader `!!js` expression.
 * @param config The same directory fields the plugin takes; defaults apply when omitted.
 * @returns Absolute path of the directory inside the mirror that holds the skills.
 */
export function skillsDirectoryPath(config: Pick<Config, 'directory' | 'skillsDirectory'> = {}): string {
  return join(config.directory ?? dshHomePath('skills-repo'), config.skillsDirectory ?? 'skills')
}

/**
 * A department-scoped skill lives at `<skillsDirectory>/<department>/<skill>/`, one
 * level below the shared skills. The skills manager subscribes to `skills` and
 * lists any folder that carries a `SKILL.md`, so this layout reaches colleagues
 * without a second subscription, while the mirror publishes only direct
 * children of `skillsDirectory`: a department's skill stays a deliberate
 * install, not something every launch drops in.
 */

/** Department recorded when the roster cannot place the uploader. */
export const UNASSIGNED_DEPARTMENT = '未分配'

/**
 * Pull the one-line description out of a skill manifest.
 *
 * A YAML front matter `description:` wins; otherwise the first Markdown heading
 * names the skill, and the first non-empty prose line after it explains it.
 * @param manifest - Raw `SKILL.md` text.
 * @returns The description, or undefined when the manifest carries none.
 */
export function describeManifest(manifest: string): string | undefined {
  const front = /^---\r?\n(?<body>[\s\S]*?)\r?\n---/u.exec(manifest)
  const described = front?.groups?.['body'] === undefined
    ? undefined
    : /^description:\s*(?<text>.+)$/mu.exec(front.groups['body'])?.groups?.['text']
  if (described !== undefined) return described.trim().replace(/^["']|["']$/gu, '')
  const lines = manifest.split(/\r?\n/u)
  const heading = lines.findIndex(line => line.startsWith('# '))
  if (heading < 0) return undefined
  const prose = lines.slice(heading + 1).find(line => line.trim() !== '' && !line.startsWith('#'))
  return prose?.trim()
}

/** Mirror a git-hosted skill repository into the DSH home and publish its skills. */
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
      publishDirectory: config.publishDirectory ?? dshHomePath('skills'),
      bundledDirectory: config.bundledDirectory ?? BUNDLED_SKILLS,
      timeoutMs: config.timeoutMs ?? 120_000,
      token: config.token ?? '',
    }
    const directory = this.config.directory
    const skillsDirectory = this.config.skillsDirectory
    this.current = {
      directory,
      skillsDirectory: join(directory, skillsDirectory),
      publishDirectory: this.config.publishDirectory,
      revision: null,
      source: 'none',
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

  /** Where the mirror stands, which skills it published, and why the last sync failed. */
  get status(): SkillRepositoryStatus {
    return this.current
  }

  /**
   * List the skills this machine can publish, read from the directory the mirror
   * publishes into. A directory without `SKILL.md` is not a skill and is left out.
   * @returns One entry per skill, sorted by name.
   */
  async localSkills(): Promise<readonly LocalSkillView[]> {
    const entries = await readdir(this.config.publishDirectory, { withFileTypes: true }).catch(() => [])
    const views: LocalSkillView[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const view = await this.describeSkill(entry.name)
      if (view !== undefined) views.push(view)
    }
    views.sort((left, right) => left.name.localeCompare(right.name))
    return views
  }

  /**
   * Publish one local skill into the repository, recording who sent it and which
   * department they belong to beside the files.
   *
   * Only new paths are written: a file that already exists with different bytes
   * is reported as a conflict, so one colleague never overwrites another's work.
   * @param name - Directory name of the skill under the publish directory.
   * @param mode - The word "new" refuses to replace an existing copy, "update" replaces it.
   * @returns How many files were written, how many matched, and what was refused.
   */
  async uploadSkill(name: string, mode: 'new' | 'update' = 'new'): Promise<SkillUploadView> {
    if (!/^[\p{L}\p{N}._-]{1,64}$/u.test(name)) throw new Error(`skill-repo: ${name} is not a usable skill name`)
    const target = giteaTarget(this.config.url)
    if (target === undefined) {
      throw new Error(`skill-repo: ${this.config.url} is not an HTTP(S) repository URL`)
    }
    const token = this.publishingToken()
    if (token === '') {
      throw new Error('skill-repo: no publishing token; set the skill-repo token or DSH_SKILLS_TOKEN')
    }
    const directory = join(this.config.publishDirectory, name)
    const contents = await readSkillDirectory(directory)
    if (contents.files.length === 0) throw new Error(`skill-repo: ${name} holds no publishable file`)
    const uploader = await this.uploader()
    const stamp = new Date().toISOString()
    const record = JSON.stringify({ name, uploader: uploader.name, department: uploader.department, uploadedAt: stamp }, null, 2)
    const files = contents.files.filter(file => file.path !== UPLOADER_FILE)
    files.push({ path: UPLOADER_FILE, bytes: new TextEncoder().encode(`${record}\n`) })
    const department = uploader.department ?? UNASSIGNED_DEPARTMENT
    const outcome = await uploadSkillFiles({
      target,
      token,
      branch: this.config.branch,
      directory: `${this.config.skillsDirectory}/${department}/${name}`,
      contents: { files, skipped: contents.skipped },
      message: `skill: ${name}${uploader.name === null ? '' : ` by ${uploader.name}`}${uploader.department === null ? '' : ` (${uploader.department})`}${mode === 'update' ? ' (replace)' : ''}`,
      overwrite: mode === 'update',
    })
    return { name, ...outcome }
  }

  /**
   * Delete this colleague's published copy of one skill.
   *
   * Only the publisher can do it: the `.uploader.json` beside the files is the
   * record of who sent them, and a copy without one is left alone rather than
   * guessed at.
   * @param name - Skill directory name under the caller's department.
   * @returns How many files were removed.
   */
  async removeSkill(name: string): Promise<number> {
    const target = giteaTarget(this.config.url)
    if (target === undefined) throw new Error(`skill-repo: ${this.config.url} is not an HTTP(S) repository URL`)
    const token = this.publishingToken()
    if (token === '') throw new Error('skill-repo: no publishing token; set the skill-repo token or DSH_SKILLS_TOKEN')
    const uploader = await this.uploader()
    const department = uploader.department ?? UNASSIGNED_DEPARTMENT
    const tree = await readRepositoryTree({ target, token, branch: this.config.branch })
    const published = await readDepartmentSkills({ target, token, branch: this.config.branch, tree, sharedRoot: this.sharedRoot })
    const mine = published.find(skill => skill.department === department && skill.name === name)
    if (mine === undefined) throw new Error(`skill-repo: ${name} is not published under ${department}`)
    if (mine.uploader === null || mine.uploader !== uploader.name) {
      throw new Error(`skill-repo: ${name} was published by ${mine.uploader ?? 'someone else'}, so it stays`)
    }
    return deleteSkillFiles({
      target,
      token,
      branch: this.config.branch,
      directory: mine.directory,
      files: mine.files,
      // The ownership check above already proved the stamp names this colleague.
      message: `skill: remove ${name} by ${uploader.name}`,
    })
  }

  /** Read one skill directory into the summary the settings page shows. */
  private async describeSkill(name: string): Promise<LocalSkillView | undefined> {
    const contents = await readSkillDirectory(join(this.config.publishDirectory, name)).catch(() => undefined)
    if (contents === undefined) return undefined
    const manifest = contents.files.find(file => file.path === 'SKILL.md')
    if (manifest === undefined) return undefined
    const bytes = contents.files.reduce((total, file) => total + file.bytes.length, 0)
    const text = new TextDecoder().decode(manifest.bytes)
    return {
      name,
      description: describeManifest(text) ?? null,
      version: parseSkillManifest(text).version,
      files: contents.files.length,
      bytes,
    }
  }

  /**
   * Compare two version labels, so the page can say which side is newer.
   *
   * Labels are written by people, so only the numeric runs are compared and a
   * label without any is treated as equal to everything: reporting "newer" on
   * two unnumbered copies would be a guess.
   * @param left - The local version.
   * @param right - The published version.
   * @returns Negative when left is older, positive when newer, zero when equal.
   */
  private static compareVersions(left: string | null, right: string | null): number {
    if (left === null || right === null) return 0
    const split = (value: string): number[] => value.split(/[^0-9]+/u).filter(part => part !== '').map(part => Number(part))
    const a = split(left)
    const b = split(right)
    if (a.length === 0 || b.length === 0) return 0
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const one = a[index] ?? 0
      const other = b[index] ?? 0
      if (one !== other) return one - other
    }
    return 0
  }

  /** Root the mirror publishes; every other top-level folder is a department. */
  private get sharedRoot(): string {
    return this.config.skillsDirectory
  }

  /**
   * Every department skill the repository holds, read once from its tree.
   * @returns One entry per published department skill; empty when the token or
   * the repository is unreachable, because the page still has to render.
   */
  async departmentSkills(): Promise<readonly DepartmentSkillView[]> {
    const target = giteaTarget(this.config.url)
    const token = this.publishingToken()
    if (target === undefined || token === '') return []
    try {
      const tree = await readRepositoryTree({ target, token, branch: this.config.branch })
      const skills = await readDepartmentSkills({ target, token, branch: this.config.branch, tree, sharedRoot: this.sharedRoot })
      return skills.map(skill => ({
        name: skill.name,
        department: skill.department,
        version: skill.version,
        description: skill.description,
        uploader: skill.uploader,
        uploadedAt: skill.uploadedAt,
        files: skill.files.length,
      }))
    } catch {
      return []
    }
  }

  /**
   * This machine's skills beside what the repository already holds, which is
   * what the page needs to decide between publishing, replacing and deleting.
   * @returns One row per local skill, sorted by name.
   */
  async skillEntries(): Promise<readonly SkillEntryView[]> {
    const locals = await this.localSkills()
    const uploader = await this.uploader()
    const department = uploader.department ?? UNASSIGNED_DEPARTMENT
    const target = giteaTarget(this.config.url)
    const token = this.publishingToken()
    let published: readonly RemoteSkill[] = []
    if (target !== undefined && token !== '') {
      published = await readRepositoryTree({ target, token, branch: this.config.branch })
        .then(tree => readDepartmentSkills({ target, token, branch: this.config.branch, tree, sharedRoot: this.sharedRoot }))
        .catch(() => [])
    }
    return locals.map((local) => {
      const mine = published.find(skill => skill.department === department && skill.name === local.name)
      const state: SkillPublishState = mine === undefined
        ? 'new'
        : mine.version === local.version
          ? 'published'
          : SkillRepository.compareVersions(local.version, mine.version) > 0 ? 'ahead' : 'behind'
      return {
        name: local.name,
        description: local.description,
        version: local.version,
        files: local.files,
        bytes: local.bytes,
        state,
        publishedVersion: mine?.version ?? null,
        department: mine?.department ?? null,
        uploader: mine?.uploader ?? null,
        uploadedAt: mine?.uploadedAt ?? null,
        owned: mine !== undefined && uploader.name !== null && mine.uploader === uploader.name,
      }
    })
  }

  /** The token to publish with: the configured one, else the environment. */
  private publishingToken(): string {
    const configured = this.config.token.trim()
    return configured === '' ? (process.env['DSH_SKILLS_TOKEN'] ?? '').trim() : configured
  }

  /** Who is publishing, read from the account the desktop signed in with. */
  private async uploader(): Promise<{ name: string | null; department: string | null }> {
    const account = this.ctx.get('deepseekAccount') as
      { getProfile?: (client: unknown) => Promise<{ value?: { name?: unknown } }> } | undefined
    if (account?.getProfile === undefined) return { name: null, department: null }
    const client = {
      id: 'local',
      version: '0.0.0',
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
    const profile = await account.getProfile(client).catch(() => undefined)
    const raw = profile?.value?.name
    if (typeof raw !== 'string' || raw === '') return { name: null, department: null }
    const directory = this.ctx.get('redaction') as
      { identify?: (account: string) => { department?: unknown } | undefined } | undefined
    const person = directory?.identify?.(raw)
    const department = person?.department
    return { name: raw, department: typeof department === 'string' ? department : null }
  }

  /**
   * Bring the mirror up to date. Never throws: an unreachable remote, a refused
   * archive or a timeout all land in `status.detail` and leave whatever copy is
   * already on disk in place.
   *
   * The constructor already starts one sync, so a caller that arrives while that
   * sync runs joins it rather than unpacking into the same directory twice.
   * @returns The status after the attempt; `detail` carries any failure reason.
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
    const { directory } = this.current
    this.current = { ...this.current, state: 'syncing', detail: null }
    const staging = `${directory}${STAGING_SUFFIX}`
    try {
      const tar = await downloadArchive(archiveUrl(this.config.url, this.config.branch), this.config.timeoutMs)
      const entries = readArchive(tar, ARCHIVE_ROOT_COMPONENTS)
      await rm(staging, { recursive: true, force: true })
      await writeArchive(entries, staging)
      await mkdir(dirname(directory), { recursive: true })
      /* The staging copy is complete before the previous mirror is dropped, so a
       * failed download never leaves the skill directory empty. */
      await rm(directory, { recursive: true, force: true })
      await rename(staging, directory)
      const published = await this.publish(this.current.skillsDirectory)
      const revision = await branchRevision(this.config.url, this.config.branch, this.config.timeoutMs)
      this.current = { ...this.current, state: 'ready', revision, source: 'remote', detail: null }
      this.ctx.logger.info(`skill-repo: ${this.config.url} at ${revision ?? 'an unreported revision'}; published ${String(published.length)} skill(s) to ${this.current.publishDirectory}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await rm(staging, { recursive: true, force: true })
      if (await this.seed(staging, detail)) return this.current
      this.current = { ...this.current, state: 'failed', detail }
      this.ctx.logger.warn(`skill-repo: keeping the skills already on disk: ${detail}`)
    }
    return this.current
  }

  /**
   * Fall back to the skills this build carries when the remote never answers and
   * the machine has no mirror at all. A machine that synced before keeps what it
   * already holds, because that copy came from the remote and is newer than the
   * one this build shipped.
   *
   * The bundled copy goes through the same staging-then-rename step as a
   * download, so a half-finished seed cannot leave an empty skill directory for
   * the next sync to mistake for a mirror.
   */
  private async seed(staging: string, detail: string): Promise<boolean> {
    const bundled = this.config.bundledDirectory
    /* A mirror counts only when it still holds a readable skill: an empty or
     * half-written directory (a rename that was cut off, a wiped skills folder)
     * would otherwise block the bundled floor and leave the machine with no
     * skills at all. */
    if ((await listSkillDirectories(this.current.skillsDirectory)).length > 0) return false
    try {
      await rm(staging, { recursive: true, force: true })
      await mkdir(join(staging, this.config.skillsDirectory), { recursive: true })
      await cp(bundled, join(staging, this.config.skillsDirectory), { recursive: true })
      await mkdir(dirname(this.current.directory), { recursive: true })
      await rm(this.current.directory, { recursive: true, force: true })
      await rename(staging, this.current.directory)
      const published = await this.publish(this.current.skillsDirectory)
      this.current = { ...this.current, state: 'ready', revision: null, source: 'bundled', detail }
      this.ctx.logger.info(`skill-repo: ${detail}; publishing the ${String(published.length)} skill(s) this build ships`)
      return true
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      const failure = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`skill-repo: the skills this build ships could not be published: ${failure}`)
      return false
    }
  }

  /**
   * Copy every skill the archive carries into the user skill root. A directory
   * this provider published before is replaced; one it never published is left
   * alone, so a hand-written skill that shares a name survives the sync.
   */
  private async publish(source: string): Promise<string[]> {
    const target = this.current.publishDirectory
    const manifest = join(dirname(this.current.directory), PUBLISH_MANIFEST)
    const owned = await readPublished(manifest)
    const names = await listSkillDirectories(source)
    await mkdir(target, { recursive: true })
    const published: string[] = []
    for (const name of names) {
      const destination = join(target, name)
      if (!owned.includes(name) && await exists(destination)) {
        this.ctx.logger.warn(`skill-repo: keeping ${destination}, which this provider never published`)
        continue
      }
      await rm(destination, { recursive: true, force: true })
      await cp(join(source, name), destination, { recursive: true })
      published.push(name)
    }
    for (const name of owned) {
      if (!published.includes(name)) await rm(join(target, name), { recursive: true, force: true })
    }
    await writeFile(manifest, `${JSON.stringify(published, null, 2)}\n`, 'utf8')
    return published
  }
}

/** Directory names under `source` that look like skills. */
async function listSkillDirectories(source: string): Promise<string[]> {
  let items
  try {
    items = await readdir(source, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const item of items) {
    if (!item.isDirectory() || item.name.startsWith('.')) continue
    try {
      if (!(await stat(join(source, item.name, 'SKILL.md'))).isFile()) continue
    } catch {
      continue
    }
    names.push(item.name)
  }
  return names.sort()
}

/** Names recorded by the previous sync, or an empty list when there is none. */
async function readPublished(manifest: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(manifest, 'utf8'))
    return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []
  } catch {
    return []
  }
}

/** Whether `path` exists at all. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export default SkillRepository
