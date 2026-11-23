/** Carry this distribution's patched plugins into the desktop profile.
 *
 * The profile installs its preinstalled plugins with pnpm, which fetches the
 * published packages and only applies the patches declared by the workspace
 * file the installer ships. A profile created by an older build keeps the
 * unpatched copy it installed back then: the plugin then asks for a `git`
 * executable this distribution no longer ships and refuses to open.
 *
 * The packaged installation already holds the patched copy, so a start copies
 * it over the profile's copy whenever the bytes differ. Nothing is copied when
 * the profile is missing entirely — the installer creates it with the same
 * patched sources — and nothing is copied when the two files agree.
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Packages this distribution patches, and the marker file that proves it. */
const PATCHED_PACKAGES: readonly { readonly name: string; readonly marker: string }[] = [
  { name: '@michengai/dsh-skills-manager', marker: join('lib', 'repository-git.js') },
]

/** Where the packaged installation and the user's home directory are. */
export interface PatchedPluginSyncOptions {
  /** Directory of the packaged dsh installation, holding `node_modules`. */
  readonly dshRoot: string
  /** Directory the profile lives under, normally `~/.dsh`. */
  readonly home: string
  /** Receives one line per copied package. */
  readonly log?: (message: string) => void
}

/**
 * Digest a file so two copies can be compared without keeping either in memory twice.
 * @param path - file to read.
 * @returns hex sha256, or `undefined` when the file is absent.
 */
function digest(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Copy the packaged copy of every patched plugin over the profile's copy.
 * @param options Packaged installation root and the home directory beside it.
 * @returns the package names that were written.
 */
export function syncPatchedPlugins(options: PatchedPluginSyncOptions): string[] {
  const profileModules = join(options.home, 'profiles', 'desktop', 'node_modules')
  if (!existsSync(join(options.home, 'profiles', 'desktop'))) return []
  const written: string[] = []
  for (const { name, marker } of PATCHED_PACKAGES) {
    const source = join(options.dshRoot, 'node_modules', name)
    const target = join(profileModules, name)
    const sourceDigest = digest(join(source, marker))
    if (sourceDigest === undefined) continue
    if (digest(join(target, marker)) === sourceDigest) continue
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true, dereference: true })
    options.log?.(`patched plugin: refreshed ${target}`)
    written.push(name)
  }
  return written
}
