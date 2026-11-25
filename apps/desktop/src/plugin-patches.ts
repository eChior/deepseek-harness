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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Packages this distribution patches, and the marker file that proves it. */
const PATCHED_PACKAGES: readonly { readonly name: string; readonly marker: string }[] = [
  { name: '@michengai/dsh-skills-manager', marker: join('lib', 'repository-git.js') },
  { name: 'dsh-weknora-panel', marker: join('lib', 'index.js') },
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
 * Copy a directory tree by reading and writing every file.
 *
 * `cpSync` cannot read from inside an asar archive: Electron patches the file
 * calls but not the directory walker it uses. Reading each file through `fs`
 * works on both a real directory and an archive.
 * @param source - file or directory to copy.
 * @param target - destination path for the same entry.
 */
function copyTree(source: string, target: string): void {
  if (statSync(source).isDirectory()) {
    // pnpm links a profile package to the store; a directory here is either
    // that link resolved or a plain copy, and both take the same walk.
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source)) copyTree(join(source, entry), join(target, entry))
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  // A file pnpm installed may be a hard link into the store and read-only:
  // writing through it either fails or edits the store. Replace the name
  // instead of the contents.
  if (existsSync(target)) unlinkSync(target)
  writeFileSync(target, readFileSync(source))
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
    if (sourceDigest === undefined) {
      // The installation carries no copy, so the profile keeps whatever it has.
      // Saying so is the only way to tell this apart from "already up to date".
      options.log?.(`patched plugin: ${name} is absent from ${source}`)
      continue
    }
    if (digest(join(target, marker)) === sourceDigest) continue
    copyTree(source, target)
    options.log?.(`patched plugin: refreshed ${name} at ${target}`)
    written.push(name)
  }
  return written
}
