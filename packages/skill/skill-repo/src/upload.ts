/**
 * Publishing one local skill into the git-hosted skill repository through the
 * host's contents API. Every file arrives as its own commit, and a path that
 * already exists with different bytes is reported instead of overwritten, so a
 * skill another colleague published stays that colleague's: this seam only
 * adds.
 * @module @deepseek-ai/dsh-skill-repo/upload
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Where the repository lives and how to reach its contents API. */
export interface GiteaTarget {
  /** API root, without a trailing slash, e.g. `http://host:3000/api/v1`. */
  readonly api: string
  /** Repository owner. */
  readonly owner: string
  /** Repository name, without the `.git` suffix. */
  readonly repo: string
}

/** One file of a local skill, keyed by its path inside the skill directory. */
export interface SkillFile {
  /** Path relative to the skill directory, always with `/` separators. */
  readonly path: string
  /** Raw bytes. */
  readonly bytes: Uint8Array
}

/** What a skill directory holds, and what publishing would leave behind. */
export interface SkillContents {
  /** Files small enough for one contents-API request. */
  readonly files: readonly SkillFile[]
  /** Paths left out because one request cannot carry them. */
  readonly skipped: readonly string[]
}

/** What an upload did, and what it refused to do. */
export interface UploadOutcome {
  /** Files written as new paths. */
  readonly written: number
  /** Files whose published bytes already matched. */
  readonly unchanged: number
  /** Paths that exist with different bytes; nothing was written over them. */
  readonly conflicts: readonly string[]
  /** Paths skipped before any request was made. */
  readonly skipped: readonly string[]
}

/** Largest file the contents API accepts in one request. */
const MAX_FILE_BYTES = 1024 * 1024

/** Entries that belong to a tool rather than to the skill. */
const IGNORED = new Set(['.git', 'node_modules', 'Thumbs.db', 'desktop.ini'])

/** File name that records who published a skill and from where. */
export const UPLOADER_FILE = '.uploader.json'

/**
 * Read the owner and repository out of an HTTP(S) git remote URL.
 * @param remote - Remote URL, with or without the `.git` suffix.
 * @returns The API root and the two path segments, or undefined when the URL is not HTTP(S).
 */
export function giteaTarget(remote: string): GiteaTarget | undefined {
  const match = /^(?<scheme>https?):\/\/(?<host>[^/]+)\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/u
    .exec(remote.trim())
  const groups = match?.groups
  if (groups === undefined) return undefined
  const scheme = groups['scheme']
  const host = groups['host']
  const owner = groups['owner']
  const repo = groups['repo']
  if (scheme === undefined || host === undefined || owner === undefined || repo === undefined) return undefined
  return { api: `${scheme}://${host}/api/v1`, owner, repo }
}

/**
 * Read one skill directory into the file list an upload carries.
 * @param directory - Absolute path of the skill directory.
 * @returns The readable files plus the paths that were left out.
 */
export async function readSkillDirectory(directory: string): Promise<SkillContents> {
  const files: SkillFile[] = []
  const skipped: string[] = []
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const repositoryPath = relative(directory, absolute).split(sep).join('/')
      const details = await stat(absolute)
      if (details.size > MAX_FILE_BYTES) {
        skipped.push(repositoryPath)
        continue
      }
      files.push({ path: repositoryPath, bytes: await readFile(absolute) })
    }
  }
  await walk(directory)
  // Byte order, so the same directory always yields the same request order.
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return { files, skipped }
}

/**
 * Percent-encode one repository path segment by segment.
 * @param path - Repository-relative path with `/` separators.
 * @returns The path safe to place in a URL.
 */
export function encodePath(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

/** One entry the contents API reports for a path. */
interface ContentsEntry {
  readonly sha?: unknown
  readonly content?: unknown
}

/**
 * Read what the repository currently stores at one path.
 * @param options - Target, token, branch and repository-relative path.
 * @returns The stored bytes, or undefined when the path does not exist.
 */
async function readPublishedFile(options: {
  readonly target: GiteaTarget
  readonly token: string
  readonly branch: string
  readonly path: string
}): Promise<Uint8Array | undefined> {
  const { target, token, branch, path } = options
  const url = `${target.api}/repos/${target.owner}/${target.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`
  const response = await fetch(url, { headers: { authorization: `token ${token}` } })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`gitea: reading ${path} failed with ${String(response.status)}`)
  const entry = await response.json() as ContentsEntry
  const content = entry.content
  if (typeof content !== 'string') return new Uint8Array()
  return new Uint8Array(Buffer.from(content, 'base64'))
}

/**
 * Write one file as its own commit.
 * @param options - Target, token, branch, repository-relative path and bytes.
 * @returns Nothing; a refused write throws.
 */
async function writePublishedFile(options: {
  readonly target: GiteaTarget
  readonly token: string
  readonly branch: string
  readonly path: string
  readonly bytes: Uint8Array
  readonly message: string
  readonly sha?: string | undefined
}): Promise<void> {
  const { target, token, branch, path, bytes, message, sha } = options
  const url = `${target.api}/repos/${target.owner}/${target.repo}/contents/${encodePath(path)}`
  // The contents API distinguishes creation (no sha) from replacement (the sha
  // it handed back for the existing blob): a replacement without it is refused.
  const payload: Record<string, string> = {
    content: Buffer.from(bytes).toString('base64'),
    message,
    branch,
  }
  if (sha !== undefined) payload['sha'] = sha
  const response = await fetch(url, {
    method: sha === undefined ? 'POST' : 'PUT',
    headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`gitea: writing ${path} failed with ${String(response.status)}: ${detail.slice(0, 200)}`)
  }
}

/** Two byte arrays of different length are different files. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Publish every file of one skill under a directory of the repository.
 *
 * A path that already exists with different bytes is reported as a conflict and
 * left untouched: uploading never rewrites another colleague's skill.
 * @param options - Everything the upload needs.
 * @returns How many files were written, how many matched, and what was refused.
 */
export async function uploadSkillFiles(options: {
  readonly target: GiteaTarget
  readonly token: string
  readonly branch: string
  readonly directory: string
  readonly contents: SkillContents
  readonly message: string
  readonly overwrite?: boolean | undefined
}): Promise<UploadOutcome> {
  const { target, token, branch, directory, contents, message } = options
  let written = 0
  let unchanged = 0
  const conflicts: string[] = []
  for (const file of contents.files) {
    const path = `${directory}/${file.path}`
    const published = await readPublishedFile({ target, token, branch, path })
    if (published === undefined) {
      await writePublishedFile({ target, token, branch, path, bytes: file.bytes, message })
      written += 1
      continue
    }
    if (sameBytes(published, file.bytes)) {
      unchanged += 1
      continue
    }
    if (options.overwrite === true) {
      // A replacement needs the sha of the blob it replaces, which the tree
      // listing already handed out; one extra read keeps the call self-contained.
      const sha = await readPublishedSha({ target, token, branch, path })
      if (sha === undefined) {
        await writePublishedFile({ target, token, branch, path, bytes: file.bytes, message })
      } else {
        await writePublishedFile({ target, token, branch, path, bytes: file.bytes, message, sha })
      }
      written += 1
      continue
    }
    conflicts.push(path)
  }
  return { written, unchanged, conflicts, skipped: contents.skipped }
}

/** One blob the repository tree reports, with the sha an overwrite needs. */
export interface RemoteFile {
  readonly path: string
  readonly sha: string
}

/**
 * Read one blob's sha, which the contents API requires to replace it.
 * @param options - Target, token, branch and repository-relative path.
 * @returns The sha, or undefined when the path does not exist.
 */
async function readPublishedSha(options: {
  readonly target: GiteaTarget
  readonly token: string
  readonly branch: string
  readonly path: string
}): Promise<string | undefined> {
  const { target, token, branch, path } = options
  const url = `${target.api}/repos/${target.owner}/${target.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`
  const response = await fetch(url, { headers: { authorization: `token ${token}` } })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`gitea: reading ${path} failed with ${String(response.status)}`)
  const entry = await response.json() as ContentsEntry
  return typeof entry.sha === 'string' && entry.sha.length > 0 ? entry.sha : undefined
}

/**
 * Read every blob in the branch, so a page can answer "is this skill already
 * there, and is my copy newer" without one request per file.
 * @param options - Target, token and branch.
 * @returns One entry per blob, keyed by repository-relative path order.
 */
export async function readRepositoryTree(options: {
  readonly target: GiteaTarget
  readonly token: string
  readonly branch: string
}): Promise<readonly RemoteFile[]> {
  const { target, token, branch } = options
  const url = `${target.api}/repos/${target.owner}/${target.repo}/git/trees/${encodeURIComponent(branch)}?recursive=true&per_page=1000`
  const response = await fetch(url, { headers: { authorization: `token ${token}` } })
  if (response.status === 404) return []
  if (!response.ok) throw new Error(`gitea: reading the tree failed with ${String(response.status)}`)
  const payload = await response.json() as { tree?: readonly { path?: unknown; sha?: unknown; type?: unknown }[] }
  const blobs: RemoteFile[] = []
  for (const entry of payload.tree ?? []) {
    if (entry.type !== 'blob') continue
    if (typeof entry.path !== 'string' || typeof entry.sha !== 'string') continue
    blobs.push({ path: entry.path, sha: entry.sha })
  }
  return blobs
}

/** What a `SKILL.md` frontmatter says about one skill. */
export interface SkillManifest {
  readonly version: string | null
  readonly description: string | null
}

/**
 * Read the version and description out of a `SKILL.md` body.
 *
 * The file starts with a `---` block of `key: value` lines; the version is the
 * publisher's own label and is compared as text, because skill versions are
 * written by people rather than derived from a build.
 * @param text - The whole `SKILL.md`.
 * @returns The two fields the settings page needs, each null when absent.
 */
export function parseSkillManifest(text: string): SkillManifest {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === '---')
  if (start === -1) return { version: null, description: null }
  let version: string | null = null
  let description: string | null = null
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '---') break
    const match = /^(version|description)\s*:\s*(?<value>.+)$/u.exec(line)
    if (match === null) continue
    const value = (match.groups?.['value'] ?? '').trim().replace(/^["']|["']$/gu, '')
    if (value === '') continue
    if (match[1] === 'version') version = value
    else description = value
  }
  return { version, description }
}

/** One skill as the repository holds it. */
export interface RemoteSkill {
  readonly name: string
  readonly department: string
  readonly directory: string
  readonly uploader: string | null
  readonly uploadedAt: string | null
  readonly version: string | null
  readonly description: string | null
  readonly files: readonly RemoteFile[]
}

/**
 * Group the department tree into skills, reading each `SKILL.md` for its
 * version and its `.uploader.json` for who published it.
 *
 * Only `<department>/<skill>/` paths count: the shared catalogue under
 * `sharedRoot` is what the mirror already publishes, so showing it here would
 * duplicate every row.
 * @param options - Target, token, branch and the whole tree.
 * @returns One entry per department skill, sorted by department then name.
 */
export async function readDepartmentSkills(options: {
  readonly target: GiteaTarget
  readonly token: string
  readonly branch: string
  readonly tree: readonly RemoteFile[]
  readonly sharedRoot: string
}): Promise<readonly RemoteSkill[]> {
  const { target, token, branch, tree, sharedRoot } = options
  const grouped = new Map<string, RemoteFile[]>()
  for (const file of tree) {
    const parts = file.path.split('/')
    if (parts.length < 3) continue
    if (parts[0] === sharedRoot) continue
    const key = `${parts[0]}/${parts[1]}`
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [file])
    else bucket.push(file)
  }
  const skills: RemoteSkill[] = []
  for (const [key, files] of grouped) {
    const [department, name] = key.split('/') as [string, string]
    const directory = key
    const manifestPath = `${directory}/SKILL.md`
    const manifest = files.find(file => file.path === manifestPath)
    if (manifest === undefined) continue
    const manifestText = await readPublishedFile({ target, token, branch, path: manifestPath })
    const uploaderPath = `${directory}/${UPLOADER_FILE}`
    const uploaderText = files.some(file => file.path === uploaderPath)
      ? await readPublishedFile({ target, token, branch, path: uploaderPath })
      : undefined
    const parsed = manifestText === undefined
      ? { version: null, description: null }
      : parseSkillManifest(new TextDecoder().decode(manifestText))
    const record = uploaderText === undefined ? {} : readUploaderRecord(new TextDecoder().decode(uploaderText))
    skills.push({
      name,
      department,
      directory,
      uploader: record.uploader ?? null,
      uploadedAt: record.uploadedAt ?? null,
      version: parsed.version,
      description: parsed.description,
      files: files.map(file => ({ path: file.path.slice(directory.length + 1), sha: file.sha })),
    })
  }
  skills.sort((left, right) => left.department === right.department
    ? left.name.localeCompare(right.name)
    : left.department.localeCompare(right.department))
  return skills
}

/** The uploader stamp a published skill carries beside its files. */
function readUploaderRecord(text: string): { uploader?: string; uploadedAt?: string } {
  try {
    const parsed = JSON.parse(text) as { uploader?: unknown; uploadedAt?: unknown }
    return {
      ...typeof parsed.uploader === 'string' ? { uploader: parsed.uploader } : {},
      ...typeof parsed.uploadedAt === 'string' ? { uploadedAt: parsed.uploadedAt } : {},
    }
  } catch {
    return {}
  }
}

/**
 * Delete every file of one published skill.
 *
 * The contents API deletes one blob per call and wants its sha, which the tree
 * listing already carries; the directory disappears with its last file.
 * @param options - Target, token, branch, directory and the skill's files.
 * @returns How many files were removed.
 */
export async function deleteSkillFiles(options: {
  readonly target: GiteaTarget
  readonly token: string
  readonly branch: string
  readonly directory: string
  readonly files: readonly RemoteFile[]
  readonly message: string
}): Promise<number> {
  const { target, token, branch, directory, files, message } = options
  let removed = 0
  for (const file of files) {
    const path = `${directory}/${file.path}`
    const url = `${target.api}/repos/${target.owner}/${target.repo}/contents/${encodePath(path)}`
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sha: file.sha, message, branch }),
    })
    if (response.status === 404) continue
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`gitea: deleting ${path} failed with ${String(response.status)}: ${detail.slice(0, 200)}`)
    }
    removed += 1
  }
  return removed
}
