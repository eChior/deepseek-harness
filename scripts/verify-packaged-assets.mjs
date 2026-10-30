/**
 * Verify that a packaged build actually carries the secrets and patches it must ship.
 *
 * The packaging lane writes `roster.key`, `qwen-keys.json` and `skills.token` from repository
 * secrets just before packing, and the packaged runtime re-installs its own dependencies, so a
 * missing `files` entry or an unapplied `patchedDependencies` table silently produces an installer
 * that looks fine but cannot resolve a department key, a staff roster, or the intranet skill
 * repository.  This check reads the packed `app.asar` and fails the lane when a source file that
 * exists in the workspace is absent from the archive.
 *
 * Usage: `node scripts/verify-packaged-assets.mjs <unpacked-app-directory>`
 */

import { closeSync, existsSync, globSync, openSync, readFileSync, readSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Source file to the archive entry it must appear as. */
const ASSETS = [
  ['packages/security/redaction/assets/roster.key', 'roster.key'],
  ['packages/security/redaction/assets/roster.bin', 'roster.bin'],
  ['packages/security/redaction/assets/terms.yaml', 'terms.yaml'],
  ['packages/credentials/hrzszy-account/assets/qwen-keys.json', 'qwen-keys.json'],
  ['packages/skill/skill-repo/assets/skills.token', 'skills.token'],
]

/** Patches that leave a marker inside a packed dependency, keyed by the package they patch. */
const PATCH_MARKERS = new Map([['@michengai/dsh-skills-manager', 'DSH_SKILLS_MANAGER_ORIGIN']])

/** Bytes read per pass while scanning the archive. */
const CHUNK = 4 * 1024 * 1024

/**
 * Read the archive header, which lists every packed path.
 * @param archive - absolute path to the packed `app.asar`.
 * @returns the header JSON as text.
 */
function readHeader(archive) {
  const bytes = readFileSync(archive)
  const size = bytes.readUInt32LE(12)
  return bytes.subarray(16, 16 + size).toString('utf8')
}

/**
 * Report whether the header declares a packed file.
 * @param header - header text.
 * @param name - file name to look for.
 * @returns true when the header lists the name as a key.
 */
function lists(header, name) {
  return header.includes(`${JSON.stringify(name)}:`)
}

/**
 * Scan a file for a marker without loading it whole.
 * @param path - file to scan.
 * @param marker - text to find.
 * @returns true when the marker appears anywhere in the file.
 */
function contains(path, marker) {
  const handle = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(CHUNK + marker.length)
  try {
    let carry = 0
    for (;;) {
      const read = readSync(handle, buffer, carry, CHUNK, null)
      if (read === 0) return false
      const available = buffer.subarray(0, carry + read)
      if (available.includes(marker)) return true
      carry = Math.min(marker.length - 1, available.length)
      available.copy(buffer, 0, available.length - carry)
    }
  } finally {
    closeSync(handle)
  }
}

/**
 * Read the packages the repository patches.
 * @param repository - repository root.
 * @returns package names that the workspace patches.
 */
function patchedPackages(repository) {
  const workspace = join(repository, 'pnpm-workspace.yaml')
  if (!existsSync(workspace)) return []
  const names = []
  let inside = false
  for (const line of readFileSync(workspace, 'utf8').split('\n')) {
    if (line.startsWith('patchedDependencies:')) {
      inside = true
      continue
    }
    if (!inside) continue
    if (line.trim() === '') continue
    if (!line.startsWith(' ')) break
    const match = /^\s+'?([^':]+)'?:/.exec(line)
    if (match !== null) names.push(match[1])
  }
  return names
}

const target = process.argv[2]
if (target === undefined) {
  console.error('verify-packaged-assets: pass the build target directory')
  process.exit(2)
}

/**
 * Find the packed archive this build produced.
 * @param directory - build target directory, or the unpacked application itself.
 * @returns the archive path, or undefined when the build produced none.
 */
function archiveUnder(directory) {
  const direct = join(directory, 'resources', 'app.asar')
  if (existsSync(direct)) return direct
  const found = globSync('**/resources/app.asar', { cwd: directory })
  if (found.length === 0) return undefined
  if (found.length > 1) {
    throw new Error(`verify-packaged-assets: ${directory} holds ${String(found.length)} archives`)
  }
  return join(directory, found[0])
}

const archive = archiveUnder(resolve(target))
if (archive === undefined) {
  console.error(`verify-packaged-assets: no app.asar under ${resolve(target)}`)
  process.exit(2)
}

const repository = resolve(import.meta.dirname, '..')
const header = readHeader(archive)
const missing = []
let checked = 0
for (const [source, name] of ASSETS) {
  if (!existsSync(join(repository, source))) continue
  checked += 1
  if (!lists(header, name)) missing.push(`${name} (from ${source})`)
}

/**
 * Find the marker a patched dependency must contain.
 * @param entry - `patchedDependencies` key, which carries the patched version.
 * @returns the marker text, or undefined when this patch leaves none.
 */
function markerOf(entry) {
  for (const [name, marker] of PATCH_MARKERS) {
    if (entry === name || entry.startsWith(`${name}@`)) return marker
  }
  return undefined
}

const patched = patchedPackages(repository)
  .map(entry => ({ entry, marker: markerOf(entry) }))
  .filter(item => item.marker !== undefined)
const unpatched = patched
  .filter(item => !contains(archive, item.marker))
  .map(item => `${item.entry} (${item.marker} absent)`)

if (missing.length > 0 || unpatched.length > 0) {
  for (const item of missing) console.error(`verify-packaged-assets: the package is missing ${item}`)
  for (const item of unpatched) console.error(`verify-packaged-assets: the package ships an unpatched ${item}`)
  process.exit(1)
}

console.log(`verify-packaged-assets: ${checked} asset(s) and ${patched.length} patch marker(s) are inside the package`)
