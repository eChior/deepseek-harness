/** Prepare the target Electron distribution and pinned pnpm CLI. */

import { packagingStep } from './packaging-step.mjs'
import { execFileSync } from 'node:child_process'

import { createHash } from 'node:crypto'

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { downloadArtifact } from '@electron/get'
import extractZip from 'extract-zip'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { preparePrimaryRuntime } from './prepare-primary-runtime.ts'
import { prepareDesktopCli } from './prepare-cli.ts'
import { prepareCommandLink } from './prepare-command-link.ts'

const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const RUNTIME_ROOT = BUILD_PATHS.runtime

function preparePnpm(): string {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('pnpm')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('desktop runtime: pnpm manifest has no version')
  const packageDir = dirname(manifestPath)
  const destination = join(RUNTIME_ROOT, 'pnpm')
  rmSync(destination, { recursive: true, force: true })
  cpSync(packageDir, destination, { recursive: true })
  return manifest.version
}

/**

 * Copy the npm CLI beside the pnpm CLI.
 *
 * pnpm falls back to `npm install` when it prepares a git-hosted package without a pnpm
 * lockfile (`@pnpm/prepare-package` picks the package manager from the lockfiles it finds and
 * defaults to npm), so a plugin without a lockfile would otherwise fail with `'npm' is not
 * recognized`. npm ships with full Node.js installations but not inside the packaged runtime,
 * so the workspace copy — resolved through the pnpm virtual store — is staged here.
 */
function prepareNpm(): string {
  const require = createRequire(import.meta.url)
  // The npm manifest does not export ./bin, so the entry is joined from the resolved package root.
  const packageDir = dirname(require.resolve('npm/package.json'))
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('desktop runtime: npm manifest has no version')
  if (!existsSync(join(packageDir, 'bin', 'npm-cli.js'))) throw new Error('desktop runtime: npm package has no bin/npm-cli.js')
  const destination = join(RUNTIME_ROOT, 'npm')
  rmSync(destination, { recursive: true, force: true })
  cpSync(packageDir, destination, { recursive: true })
  return manifest.version
}

/**
 * Download the pinned Electron distribution, retrying transport failures.
 *
 * The download is one ~110 MB GET from GitHub's release CDN, and it fails often enough to cost
 * a build: the failure arrives as a bare `TypeError: fetch failed` from undici, with no status
 * code to tell a dropped connection from a missing asset. Retrying is therefore the only
 * available response, and the last attempt is the one whose error is reported.
 * @param version - Electron version from the workspace manifest.
 * @param platform - Target platform.
 * @param arch - Target architecture.
 * @returns Path to the downloaded archive.
 */
async function downloadElectron(
  version: string,
  platform: 'darwin' | 'linux' | 'win32',
  arch: 'arm64' | 'x64',
): Promise<string> {
  const attempts = 4
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await downloadArtifact({ version, platform, arch, artifactName: 'electron', cacheRoot: BUILD_PATHS.downloads })
    } catch (error) {
      last = error
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`desktop runtime: electron download attempt ${attempt}/${attempts} failed: ${detail}\n`)
      if (attempt < attempts) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 5_000 * attempt) })
      }
    }
  }
  throw last instanceof Error ? last : new Error(`desktop runtime: electron download failed: ${String(last)}`)
}

/**
 * Windows 7 build: unpack the bundled PowerShell 7.2 into runtime/pwsh when
 * DSH_WIN7_PWSH_ARCHIVE names its zip; DSH_WIN7_PWSH_SHA256 must match the archive.
 */
async function prepareWin7Pwsh(): Promise<void> {
  const archive = process.env.DSH_WIN7_PWSH_ARCHIVE
  if (archive === undefined || archive === '') return
  const expected = process.env.DSH_WIN7_PWSH_SHA256?.toLowerCase()
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (expected !== actual) throw new Error(`desktop runtime: DSH_WIN7_PWSH_ARCHIVE has SHA-256 ${actual}, expected DSH_WIN7_PWSH_SHA256 ${String(expected)}`)
  const destination = join(RUNTIME_ROOT, 'pwsh')
  await extractZip(archive, { dir: destination })
  if (!existsSync(join(destination, 'pwsh.exe'))) throw new Error('desktop runtime: DSH_WIN7_PWSH_ARCHIVE has no top-level pwsh.exe')

}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'defer-primary-runtime-smoke': { type: 'boolean', default: false } } })
  const target = resolveDesktopBuildTarget()
  const platform = target.startsWith('mac-') ? 'darwin' : target.startsWith('linux-') ? 'linux' : 'win32'
  const arch = target.endsWith('arm64') ? 'arm64' : 'x64'
  const require = createRequire(import.meta.url)
  const { version } = require('electron/package.json') as { version: string }

  // Windows 7 build: DSH_WIN7_ELECTRON_ARCHIVE names a patched Electron zip, and
  // DSH_WIN7_ELECTRON_DIST names an already unpacked tree; either one skips the download.
  const localElectron = process.env.DSH_WIN7_ELECTRON_ARCHIVE
  const electronDist = process.env.DSH_WIN7_ELECTRON_DIST
  const reuseElectron = (localElectron !== undefined && localElectron !== '')
  const reuseDist = electronDist !== undefined && electronDist !== ''
  const archive = reuseElectron
    ? String(localElectron)
    : reuseDist
      ? ''
      : await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'download:electron',
        () => downloadElectron(version, platform, arch))

  rmSync(BUILD_PATHS.electron, { recursive: true, force: true })
  if (reuseDist) {
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'copy:electron',
      async () => { cpSync(electronDist, BUILD_PATHS.electron, { recursive: true }) })
  } else {
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'extract:electron', () => extractZip(archive, { dir: BUILD_PATHS.electron }))
  }
  const executable = join(BUILD_PATHS.electron, platform === 'win32' ? 'electron.exe'
    : platform === 'linux' ? 'electron' : 'Electron.app/Contents/MacOS/Electron')
  const nodeVersion = execFileSync(executable, ['-p', 'process.versions.node'], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim()
  const macosMinimumVersion = platform === 'darwin' ? execFileSync('/usr/libexec/PlistBuddy',
    ['-c', 'Print LSMinimumSystemVersion', join(BUILD_PATHS.electron, 'Electron.app', 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim() : undefined
  rmSync(RUNTIME_ROOT, { recursive: true, force: true })
  mkdirSync(RUNTIME_ROOT, { recursive: true })
  const pnpmVersion = preparePnpm()
  const npmVersion = prepareNpm()

  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:win7-pwsh', prepareWin7Pwsh)

  cpSync(join(import.meta.dirname, 'node-bin'), join(RUNTIME_ROOT, 'bin'), { recursive: true })
  chmodSync(join(RUNTIME_ROOT, 'bin', 'node'), 0o755)
  writeFileSync(join(RUNTIME_ROOT, 'versions.json'), `${JSON.stringify({
    schemaVersion: 1,
    node: nodeVersion,
    pnpm: pnpmVersion,
    npm: npmVersion,
  }, undefined, 2)}\n`)
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:cli',
    async () => prepareDesktopCli(join(RUNTIME_ROOT, 'cli'), platform))
  if (macosMinimumVersion !== undefined) prepareCommandLink(join(RUNTIME_ROOT, 'cli'), arch, macosMinimumVersion)
  cpSync(join(import.meta.dirname, '..', 'lib', 'command-manager-entry.js'), join(RUNTIME_ROOT, 'cli', 'command-manager.js'))
  cpSync(join(import.meta.dirname, 'command-path.ps1'), join(RUNTIME_ROOT, 'cli', 'command-path.ps1'))
  // DSH_WIN7_RUNTIME_DIST copies an already prepared runtime tree (primary-runtime + pwsh).
  const runtimeDist = process.env.DSH_WIN7_RUNTIME_DIST
  if (runtimeDist !== undefined && runtimeDist !== '') {
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'copy:primary-runtime',
      async () => { cpSync(runtimeDist, RUNTIME_ROOT, { recursive: true }) })
  } else {
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:primary-runtime',
      () => preparePrimaryRuntime({ deferSmoke: values['defer-primary-runtime-smoke'] }))
  }
}

await main()
