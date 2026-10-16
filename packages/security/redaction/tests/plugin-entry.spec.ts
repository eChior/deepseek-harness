/**
 * Cordis accepts a plugin only as a function or as an object carrying `apply`.
 * A module that exports the service class and forgets `apply` is rejected before
 * it registers anything — and because every consumer looks `ctx.redaction` up and
 * steps aside when it is undefined, that rejection is silent: no log line, no
 * failed gate, and a session log that keeps every value verbatim. The entry point
 * is asserted here rather than assumed.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as entry from '../src/index.ts'

/** A term list with one term, so a replacement proves the rules were loaded. */
const TERMS = `version: 1
revision: 'entry-1'
categories:
  - id: craft
    label: 工艺
    terms:
      - 结晶温度
    patterns: []
`

/**
 * The admission test cordis applies before it resolves a plugin.
 * @param plugin - The module as the loader received it.
 * @returns True when cordis would accept it.
 */
function isApplicable(plugin: unknown): boolean {
  return typeof plugin === 'object' && plugin !== null
    && typeof (plugin as { apply?: unknown }).apply === 'function'
}

describe('plugin entry point', () => {
  it('presents itself as a module cordis can load', () => {
    expect(isApplicable(entry)).toBe(true)
    expect(typeof entry.apply).toBe('function')
  })

  it('registers the service when it is loaded the way cordis loads it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-entry-'))
    const termsPath = join(directory, 'terms.yaml')
    await writeFile(termsPath, TERMS, 'utf8')
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(entry, {
      termsPath,
      cacheDirectory: join(directory, 'cache'),
      remote: '',
      refreshMinutes: 0,
      vision: false,
    })
    await ctx.redaction.load()
    expect(ctx.get('redaction')).toBeDefined()
    expect(ctx.redaction.redactText('结晶温度偏高')).toBe('[工艺-1]偏高')
  })
})
