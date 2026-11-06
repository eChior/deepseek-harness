import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { grantRuntimeRead } from '../src/runtime-access.ts'

const created: string[] = []

/**
 * A scratch directory that the test may write into.
 * @returns the absolute path.
 */
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-runtime-access-'))
  created.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('grantRuntimeRead', () => {
  it('skips a directory that is not there', () => {
    const outcome = grantRuntimeRead(join(scratch(), 'absent'), { apply: () => { throw new Error('must not run') } })
    expect(outcome).toBe('missing')
  })

  it('runs the walk once and records it', () => {
    const directory = scratch()
    const calls: string[] = []
    expect(grantRuntimeRead(directory, { apply: (target) => { calls.push(target) }, now: () => 1_000 })).toBe('done')
    expect(calls).toEqual([directory])
    expect(readFileSync(join(directory, '.dsh-read-granted'), 'utf8')).toBe('1000')
  })

  it('skips a grant younger than the marker lifetime', () => {
    const directory = scratch()
    const day = 24 * 60 * 60 * 1000
    grantRuntimeRead(directory, { apply: () => {}, now: () => 0 })
    expect(grantRuntimeRead(directory, { apply: () => { throw new Error('must not run') }, now: () => day })).toBe('skipped')
  })

  it('walks again once the marker is old', () => {
    const directory = scratch()
    const month = 31 * 24 * 60 * 60 * 1000
    grantRuntimeRead(directory, { apply: () => {}, now: () => 0 })
    const calls: string[] = []
    expect(grantRuntimeRead(directory, { apply: (target) => { calls.push(target) }, now: () => month })).toBe('done')
    expect(calls).toEqual([directory])
  })

  it('reports a refusal without recording one', () => {
    const directory = scratch()
    const notes: string[] = []
    const outcome = grantRuntimeRead(directory, {
      apply: () => { throw new Error('icacls refused') },
      log: (message) => { notes.push(message) },
      now: () => 5,
    })
    expect(outcome).toBe('failed')
    expect(notes.join('\n')).toContain('icacls refused')
    expect(() => readFileSync(join(directory, '.dsh-read-granted'), 'utf8')).toThrow()
  })
})
