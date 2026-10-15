/**
 * Resolves the release feed for one running Desktop version.
 *
 * This distribution publishes to an internal Gitea repository instead of the
 * public DSH download origin. Gitea serves every release from a directory named
 * after its tag, while electron-updater wants one stable feed URL, so the newest
 * published release is looked up first and its download directory becomes the
 * feed for that check.
 */

/** Gitea exposes the releases of one repository under this API prefix. */
const RELEASES_SEGMENT = '/api/v1/repos'

/** Where this build looks for its own releases unless the environment overrides it. */
export const RELEASE_ORIGIN = process.env.DSH_DESKTOP_RELEASE_ORIGIN ?? 'http://10.151.5.175:3000'

/** Repository that carries the enhanced distribution releases. */
export const RELEASE_REPOSITORY = process.env.DSH_DESKTOP_RELEASE_REPOSITORY ?? 'ITPublic/deepseek-harness'

/** Strip trailing slashes so a configured origin never doubles the separator. */
function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/u, '')
}

/** Release assets live in a directory named after the tag that carries them. */
export function releaseDownloadUrl(origin: string, repository: string, tag: string): string {
  return `${trimOrigin(origin)}/${repository}/releases/download/${tag}`
}

/** Human-facing release page for one tag. */
export function releasePageUrl(origin: string, repository: string, tag: string): string {
  return `${trimOrigin(origin)}/${repository}/releases/tag/${tag}`
}

/** Read one string field from an unknown JSON member. */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

/**
 * Pick the first non-draft release that publishes a download tag.
 *
 * Gitea returns releases newest-first, and the tag is the only part the feed URL
 * needs; grouping a local version comparison here would duplicate what
 * electron-updater already decides from the channel metadata.
 */
export function newestReleaseTag(payload: unknown): string | undefined {
  if (!Array.isArray(payload)) return undefined
  for (const entry of payload) {
    if (typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).draft === true) continue
    const tag = stringField(entry, 'tag_name')
    if (tag !== undefined) return tag
  }
  return undefined
}

/**
 * Ask the release origin which tag currently carries the distribution.
 *
 * @param origin - Release origin; defaults to this build's own Gitea instance.
 * @param repository - `owner/name` of the release repository.
 * @param fetchImpl - Transport seam; tests replace it instead of reaching the network.
 * @returns The newest published tag.
 * @throws {Error} When the origin answers with a non-success status or publishes no release.
 */
async function newestTag(
  origin: string = RELEASE_ORIGIN,
  repository: string = RELEASE_REPOSITORY,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const endpoint = `${trimOrigin(origin)}${RELEASES_SEGMENT}/${repository}/releases?limit=20`
  const response = await fetchImpl(endpoint, { headers: { accept: 'application/json' } })
  if (!response.ok) {
    throw new Error(`desktop update: release lookup failed with ${String(response.status)}`)
  }
  const tag = newestReleaseTag(await response.json())
  if (tag === undefined) throw new Error('desktop update: the release repository publishes no release')
  return tag
}

/**
 * Absolute download directory that electron-updater reads channel metadata from.
 *
 * @param origin - Release origin; defaults to this build's own Gitea instance.
 * @param repository - `owner/name` of the release repository.
 * @param fetchImpl - Transport seam; tests replace it instead of reaching the network.
 * @returns Absolute download directory of the newest published release.
 * @throws {Error} When the origin answers with a non-success status or publishes no release.
 */
export async function resolveReleaseFeed(
  origin: string = RELEASE_ORIGIN,
  repository: string = RELEASE_REPOSITORY,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return releaseDownloadUrl(origin, repository, await newestTag(origin, repository, fetchImpl))
}

/**
 * Absolute page a user opens to install this build by hand.
 *
 * The Linux lane ships a deb, while the channel metadata electron-builder writes names the
 * AppImage that lane never builds, so a packaged download would ask for a file that is not
 * there. The release page is the address that always resolves on that target.
 *
 * @param origin - Release origin; defaults to this build's own Gitea instance.
 * @param repository - `owner/name` of the release repository.
 * @param fetchImpl - Transport seam; tests replace it instead of reaching the network.
 * @returns Absolute release page of the newest published release.
 * @throws {Error} When the origin answers with a non-success status or publishes no release.
 */
export async function resolveReleasePage(
  origin: string = RELEASE_ORIGIN,
  repository: string = RELEASE_REPOSITORY,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return releasePageUrl(origin, repository, await newestTag(origin, repository, fetchImpl))
}
