import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { syncPatchedPlugins } from '../src/plugin-patches.ts'

const PACKAGE = join('@michengai', 'dsh-skills-manager')
const MARKER = join(PACKAGE, 'lib', 'repository-git.js')

/** Build a home with a profile that already installed the plugin. */
function homeWithProfile(body: string): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-'))
  const profile = join(home, 'profiles', 'desktop')
  mkdirSync(join(profile, 'node_modules', PACKAGE, 'lib'), { recursive: true })
  writeFileSync(join(profile, 'node_modules', MARKER), body)
  return home
}

/** Build an installation whose packaged copy carries the patch. */
function installWithPatch(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-install-'))
  mkdirSync(join(root, 'node_modules', PACKAGE, 'lib'), { recursive: true })
  writeFileSync(join(root, 'node_modules', MARKER), body)
  return root
}

describe('syncPatchedPlugins', () => {
  it('rewrites the installed file when the installation carries no copy', () => {
    const home = homeWithProfile('if (err?.code === "error.repo.noGit") throw err;')
    const written = syncPatchedPlugins({
      dshRoot: mkdtempSync(join(tmpdir(), 'dsh-empty-install-')),
      home,
      log: () => {},
    })
    expect(readFileSync(join(home, 'profiles', 'desktop', 'node_modules', MARKER), 'utf8'))
      .toContain('if (err?.code === "error.repo.noGit") return;')
    expect(written).toContain('@michengai/dsh-skills-manager')
  })

  it('replaces a symlinked profile package without editing its store target', () => {
    // pnpm installs a profile package as a link into its store. Writing through
    // that link edits the store, and every package sharing the file breaks with
    // it — an update then loses the knowledge base and the session service.
    const home = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-'))
    const profile = join(home, 'profiles', 'desktop')
    const store = join(home, '.store', PACKAGE)
    mkdirSync(join(store, 'lib'), { recursive: true })
    writeFileSync(join(store, 'lib', 'repository-git.js'), 'if (code === "error.repo.noGit") throw error;')
    mkdirSync(join(profile, 'node_modules', '@michengai'), { recursive: true })
    symlinkSync(store, join(profile, 'node_modules', PACKAGE), 'junction')
    const dshRoot = installWithPatch('if (code === "error.repo.noGit") return;')

    syncPatchedPlugins({ dshRoot, home, log: () => {} })

    // The store keeps the published bytes...
    expect(readFileSync(join(store, 'lib', 'repository-git.js'), 'utf8'))
      .toContain('if (code === "error.repo.noGit") throw error;')
    // ...and the profile now holds a real directory with the patched copy.
    expect(readFileSync(join(profile, 'node_modules', MARKER), 'utf8'))
      .toContain('if (code === "error.repo.noGit") return;')
  })

  it('replaces an unpatched profile copy with the packaged one', () => {
    const home = homeWithProfile('if (code === "error.repo.noGit") throw error;')
    const dshRoot = installWithPatch('if (code === "error.repo.noGit") return;')
    const log = vi.fn<(message: string) => void>()

    const written = syncPatchedPlugins({ dshRoot, home, log })

    expect(written).toEqual(['@michengai/dsh-skills-manager'])
    expect(readFileSync(join(home, 'profiles', 'desktop', 'node_modules', MARKER), 'utf8'))
      .toBe('if (code === "error.repo.noGit") return;')
    // The second entry in the list is absent here, and it says so; what this
    // case is about is the replacement message for the plugin that is present.
    expect(log.mock.calls.some(([message]) => message.includes('@michengai/dsh-skills-manager')))
      .toBe(true)
  })

  it('leaves the profile alone when the bytes already agree', () => {
    const home = homeWithProfile('patched')
    const dshRoot = installWithPatch('patched')

    expect(syncPatchedPlugins({ dshRoot, home })).toEqual([])
  })

  it('does nothing when the profile has not been created yet', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-no-profile-'))
    const dshRoot = installWithPatch('patched')

    expect(syncPatchedPlugins({ dshRoot, home })).toEqual([])
  })

  it('does nothing when the installation carries no such package', () => {
    const home = homeWithProfile('old')
    const dshRoot = mkdtempSync(join(tmpdir(), 'dsh-bare-'))

    expect(syncPatchedPlugins({ dshRoot, home })).toEqual([])
    expect(readFileSync(join(home, 'profiles', 'desktop', 'node_modules', MARKER), 'utf8')).toBe('old')
  })
})
