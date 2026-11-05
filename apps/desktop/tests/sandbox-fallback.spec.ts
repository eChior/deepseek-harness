/**
 * The sandbox fallback keeps a crash count across launches and turns it into one
 * sandbox-free restart; these cases pin the arithmetic that decides it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bumpFallback,
  clearFallback,
  FALLBACK_SWITCH,
  fallbackArguments,
  FALLBACK_THRESHOLD,
  readFallback,
  sandboxDisabled,
  shouldFallBack,
  writeFallback,
} from '../src/sandbox-fallback.ts'

const directories: string[] = []

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), 'dsh-fallback-'))
  directories.push(created)
  return created
}

afterEach(() => {
  for (const created of directories.splice(0)) rmSync(created, { recursive: true, force: true })
})

describe('sandbox fallback', () => {
  it('counts one crash at a time and keeps no record when there is none', () => {
    const first = bumpFallback(undefined, new Date('2026-11-05T00:00:00Z'))
    expect(first.crashes).toBe(1)
    expect(first.lastAt).toBe('2026-11-05T00:00:00.000Z')
    expect(bumpFallback(first, new Date('2026-11-05T00:01:00Z')).crashes).toBe(2)
  })

  it(`falls back only at the threshold of ${String(FALLBACK_THRESHOLD)}`, () => {
    expect(shouldFallBack(undefined)).toBe(false)
    expect(shouldFallBack({ crashes: 1, lastAt: '2026-11-05T00:00:00.000Z' })).toBe(false)
    expect(shouldFallBack({ crashes: FALLBACK_THRESHOLD, lastAt: '2026-11-05T00:00:00.000Z' })).toBe(true)
  })

  it('round-trips through the user-data directory and clears', () => {
    const home = directory()
    expect(readFallback(home)).toBeUndefined()
    writeFallback(home, { crashes: 3, lastAt: '2026-11-05T00:00:00.000Z' })
    expect(readFallback(home)).toEqual({ crashes: 3, lastAt: '2026-11-05T00:00:00.000Z' })
    expect(JSON.parse(readFileSync(join(home, 'sandbox-fallback.json'), 'utf8'))).toMatchObject({ crashes: 3 })
    clearFallback(home)
    expect(readFallback(home)).toBeUndefined()
  })

  it('treats a corrupt record as no crashes rather than failing the launch', () => {
    const home = directory()
    writeFallback(home, { crashes: 1, lastAt: 'x' })
    expect(readFallback(home)?.crashes).toBe(1)
    rmSync(join(home, 'sandbox-fallback.json'))
    expect(readFallback(home)).toBeUndefined()
  })

  it('adds the switch once and keeps every other argument', () => {
    expect(fallbackArguments(['/app/dsh', '--inspect=9229', '--no-sandbox']))
      .toEqual(['--inspect=9229', FALLBACK_SWITCH])
    expect(fallbackArguments(['/app/dsh'])).toEqual([FALLBACK_SWITCH])
  })

  it('sees the switch however the process was started', () => {
    expect(sandboxDisabled(['/app/dsh', '--no-sandbox'])).toBe(true)
    expect(sandboxDisabled(['/app/dsh', '--no-sandbox-for-testing'])).toBe(true)
    expect(sandboxDisabled(['/app/dsh', '--inspect=9229'])).toBe(false)
  })
})
