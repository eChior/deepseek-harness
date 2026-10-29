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
}): Promise<void> {
  const { target, token, branch, path, bytes, message } = options
  const url = `${target.api}/repos/${target.owner}/${target.repo}/contents/${encodePath(path)}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      content: Buffer.from(bytes).toString('base64'),
      message,
      branch,
    }),
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
    conflicts.push(path)
  }
  return { written, unchanged, conflicts, skipped: contents.skipped }
}
