import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  it('replaces an unpatched profile copy with the packaged one', () => {
    const home = homeWithProfile('if (code === "error.repo.noGit") throw error;')
    const dshRoot = installWithPatch('if (code === "error.repo.noGit") return;')
    const log = vi.fn()

    const written = syncPatchedPlugins({ dshRoot, home, log })

    expect(written).toEqual(['@michengai/dsh-skills-manager'])
    expect(readFileSync(join(home, 'profiles', 'desktop', 'node_modules', MARKER), 'utf8'))
      .toBe('if (code === "error.repo.noGit") return;')
    expect(log).toHaveBeenCalledOnce()
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
