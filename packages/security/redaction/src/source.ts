/**
 * Where the term list comes from, and the copy this machine keeps.
 *
 * A deployment maintains the list in a repository rather than inside the
 * application, so a term added to it protects every client within one refresh
 * interval instead of waiting for a release. The copy on disk is what makes that
 * arrangement safe to depend on: a machine that cannot reach the repository
 * keeps replacing exactly what it replaced last time, and an install that has
 * never reached it falls back to the list inside this package.
 *
 * The fetch reads one file through the raw-file endpoint of the host that serves
 * the repository. That endpoint exists on gitea and on GitHub, so the same
 * configuration names either, and no archive has to be unpacked to read one file.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Pointer file naming the cached revision. Lives beside the revisions it names. */
export const CURRENT_POINTER = 'current'

/** Cached revisions keep this name, so a prune cannot mistake an unrelated file for one. */
const CACHED_TERM_FILE = /^terms-[^/\\]+\.yaml$/u

/** Which copy of the term list the provider is replacing with. */
export type TermSourceKind = 'bundled' | 'cache' | 'remote'

/** Everything a fetch needs: which repository, which branch, and how long to wait. */
export interface TermSourceConfig {
  /** Repository URL, for example `http://10.151.5.175:3000/ITPublic/dsh-redaction-terms`. */
  readonly remote: string
  /** Branch whose tip is the published list. */
  readonly branch: string
  /** Path of the list inside that branch. */
  readonly file: string
  /** Directory holding the cached copies. */
  readonly directory: string
  /** Per-request timeout. */
  readonly timeoutMs: number
}

/** Coordinates of a repository URL, split the way both hosting hosts address it. */
interface RemoteCoordinates {
  readonly origin: string
  readonly owner: string
  readonly repository: string
  readonly github: boolean
}

function coordinates(remote: string): RemoteCoordinates | undefined {
  const base = remote.endsWith('.git') ? remote.slice(0, -'.git'.length) : remote
  const match = /^(?<origin>https?:\/\/[^/]+)\/(?<owner>[^/]+)\/(?<repository>[^/]+)$/u.exec(base.replace(/\/+$/u, ''))
  const groups = match?.groups
  if (groups === undefined) return undefined
  const { origin, owner, repository } = groups
  if (origin === undefined || owner === undefined || repository === undefined) return undefined
  return { origin, owner, repository, github: /^(?:www\.)?github\.com$/u.test(origin.replace(/^https?:\/\//u, '')) }
}

/**
 * URL of the raw term list.
 * @param config Where the list comes from.
 * @returns The URL that serves the file, or an empty string when the remote is not a repository.
 */
export function termListUrl(config: TermSourceConfig): string {
  const found = coordinates(config.remote)
  if (found === undefined) return ''
  const branch = encodeURIComponent(config.branch)
  if (found.github) {
    return `https://raw.githubusercontent.com/${found.owner}/${found.repository}/${branch}/${config.file}`
  }
  const { origin, owner, repository } = found
  return `${origin}/api/v1/repos/${owner}/${repository}/raw/${config.file}?ref=${branch}`
}

/**
 * Download the published list.
 * @param config Where the list comes from.
 * @returns The file's text.
 * @throws If the host refuses the request, does not answer in time, or serves an empty body.
 */
export async function fetchTermList(config: TermSourceConfig): Promise<string> {
  const url = termListUrl(config)
  if (url === '') throw new Error(`redaction: ${config.remote} is not a repository URL`)
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(config.timeoutMs) })
  if (!response.ok) throw new Error(`redaction: term list request failed with ${String(response.status)}`)
  const text = await response.text()
  if (text.trim() === '') throw new Error('redaction: the published term list is empty')
  return text
}

function cachedPath(directory: string, name: string): string | undefined {
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) return undefined
  return join(directory, name)
}

/**
 * Read the revision the pointer names.
 * @param directory Cache directory.
 * @returns The list text and the file it came from, or undefined when no usable copy is cached.
 */
export async function readCachedTermList(directory: string): Promise<{ text: string; path: string } | undefined> {
  try {
    const pointer = (await readFile(join(directory, CURRENT_POINTER), 'utf8')).trim()
    const path = cachedPath(directory, pointer)
    if (path === undefined) return undefined
    return { text: await readFile(path, 'utf8'), path }
  } catch {
    /* No pointer, no file, or an unreadable directory: the caller falls back to the bundled list. */
    return undefined
  }
}

/**
 * Keep the revision just written plus the one before it, and drop anything older.
 *
 * One spare revision is what lets an operator put the list back after a bad edit
 * without waiting for the next fetch, and dropping the rest keeps an installation
 * that runs for years from accumulating one file per revision.
 * @param directory Cache directory.
 * @param current Name of the revision just written.
 */
async function pruneCache(directory: string, current: string): Promise<void> {
  try {
    const names = (await readdir(directory)).filter(name => CACHED_TERM_FILE.test(name))
    const newest = names.toSorted((left, right) => right.localeCompare(left)).slice(0, 2)
    const stale = names.filter(name => name !== current && !newest.includes(name))
    await Promise.all(stale.map(name => rm(join(directory, name), { force: true })))
  } catch {
    /* A cache that cannot be pruned still serves the revision it holds. */
  }
}

/**
 * Write a fetched list under its revision and point `current` at it.
 * @param config Where the list comes from.
 * @param text The list as published.
 * @param revision Revision the list declares, which names the file.
 * @returns The path the list was written to.
 */
export async function writeCachedTermList(config: TermSourceConfig, text: string, revision: string): Promise<string> {
  await mkdir(config.directory, { recursive: true })
  const name = `terms-${revision.replace(/[^A-Za-z0-9._-]/gu, '_')}.yaml`
  const target = join(config.directory, name)
  await writeFile(target, text, 'utf8')
  await writeFile(join(config.directory, CURRENT_POINTER), `${name}\n`, 'utf8')
  await pruneCache(config.directory, name)
  return target
}
