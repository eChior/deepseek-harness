/**
 * An upgrade must not be silently cancelled by a stale cache.
 *
 * The cached list exists so a machine that cannot reach the publisher keeps
 * replacing what it replaced yesterday. That cache has a trap in it: a package
 * shipping a newer list would load the older cached one instead, and the client
 * would replace less than the release it was built from — no error, no warning,
 * just fewer terms in force than the operator configured. These cases pin the
 * ordering down in both directions, plus the case where nothing can be ordered.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as entry from '../src/index.ts'
import type { RedactionService } from '../src/index.ts'

/** Directories every case made, removed once the case ends. */
const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** A one-term list. The term is the only thing that tells the two copies apart. */
function list(revision: string, term: string): string {
  return `version: 1
revision: '${revision}'
categories:
  - id: craft
    label: 工艺
    terms:
      - ${term}
    patterns: []
`
}

/** Write a cache that points at one revision, the way a fetch would leave it. */
async function cache(directory: string, revision: string, term: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  const name = `terms-${revision}.yaml`
  await writeFile(join(directory, name), list(revision, term), 'utf8')
  await writeFile(join(directory, 'current'), `${name}\n`, 'utf8')
}

/** Load a provider over one shipped list and one cached list. */
async function load(shipped: string, cached: { revision: string; term: string } | undefined): Promise<RedactionService> {
  const root = await mkdtemp(join(tmpdir(), 'redaction-revision-'))
  created.push(root)
  const termsPath = join(root, 'shipped.yaml')
  await writeFile(termsPath, shipped, 'utf8')
  const cacheDirectory = join(root, 'cache')
  if (cached !== undefined) await cache(cacheDirectory, cached.revision, cached.term)
  const ctx = new Context()
  await ctx.plugin(entry, { termsPath, cacheDirectory, remote: '', refreshMinutes: 0, vision: false })
  await ctx.redaction.load()
  return ctx.redaction
}

describe('term list revision ordering', () => {
  it('adopts the shipped list when the cache is older', async () => {
    const service = await load(list('2026-10-16', '结晶温度'), { revision: '2026-10-15', term: '工艺规程' })
    expect(service.status.revision).toBe('2026-10-16')
    expect(service.redactText('结晶温度 是 78.5')).not.toContain('结晶温度')
    expect(service.redactText('工艺规程 已更新')).toContain('工艺规程')
  })

  it('keeps the cache when it is newer than the shipped list', async () => {
    const service = await load(list('2026-10-15', '结晶温度'), { revision: '2026-10-16', term: '工艺规程' })
    expect(service.status.revision).toBe('2026-10-16')
    expect(service.redactText('工艺规程 已更新')).not.toContain('工艺规程')
    expect(service.redactText('结晶温度 是 78.5')).toContain('结晶温度')
  })

  it('leaves a revision that does not read as a date to the cache', async () => {
    const service = await load(list('test-2', '结晶温度'), { revision: 'test-1', term: '工艺规程' })
    expect(service.status.revision).toBe('test-1')
    expect(service.redactText('工艺规程 已更新')).not.toContain('工艺规程')
  })

  it('uses the shipped list when no cache exists', async () => {
    const service = await load(list('2026-10-16', '结晶温度'), undefined)
    expect(service.status.revision).toBe('2026-10-16')
    expect(service.redactText('结晶温度 是 78.5')).not.toContain('结晶温度')
  })
})
