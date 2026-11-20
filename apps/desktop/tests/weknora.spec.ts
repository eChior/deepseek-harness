/**
 * The knowledge-base settings a first start copies out of the package.
 *
 * The plugin resolves its own `config.json` from the published package, which
 * carries none, so the packaged settings are the only way a fresh machine gets
 * a configured panel. These tests pin the three decisions that matter: seed an
 * empty home, never overwrite what the user typed, and do nothing when this
 * build shipped no settings.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installKnowledgeBaseConfig } from '../src/weknora.ts'

/** Create one empty directory to act as the application's resources. */
function directory(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-weknora-'))
}

describe('installKnowledgeBaseConfig', () => {
  it('seeds an empty home from the packaged settings', () => {
    const resources = directory()
    const home = directory()
    writeFileSync(join(resources, 'weknora.json'), '{"baseUrl":"http://kb.invalid"}\n', 'utf8')

    const seeded = installKnowledgeBaseConfig({ resources, home })

    expect(seeded).toBe(true)
    expect(readFileSync(join(home, 'dsh-weknora-panel.json'), 'utf8')).toBe('{"baseUrl":"http://kb.invalid"}\n')
  })

  it('leaves a saved file the user already has untouched', () => {
    const resources = directory()
    const home = directory()
    writeFileSync(join(resources, 'weknora.json'), '{"baseUrl":"http://kb.invalid"}\n', 'utf8')
    writeFileSync(join(home, 'dsh-weknora-panel.json'), '{"baseUrl":"http://mine.invalid"}\n', 'utf8')

    expect(installKnowledgeBaseConfig({ resources, home })).toBe(false)
    expect(readFileSync(join(home, 'dsh-weknora-panel.json'), 'utf8')).toBe('{"baseUrl":"http://mine.invalid"}\n')
  })

  it('does nothing when the build shipped no settings', () => {
    const resources = directory()
    const home = directory()

    expect(installKnowledgeBaseConfig({ resources, home })).toBe(false)
    expect(existsSync(join(home, 'dsh-weknora-panel.json'))).toBe(false)
  })
})
