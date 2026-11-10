/**
 * The cached vocabulary must not be readable on disk.
 *
 * A colleague's machine holds the list that says what the company considers
 * sensitive. Leaving it as plain YAML would hand that list to anyone who can
 * open the file, which is precisely the exposure the redaction exists to
 * prevent. These cases pin both halves: the file on disk reveals nothing, and a
 * plain list an earlier release left behind still loads.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCachedTermList, writeCachedTermList } from '../src/source.ts'

/** Directories every case made, removed once the case ends. */
const created: string[] = []

/**
 * A cache directory nothing else touches.
 * @returns The directory that was created.
 */
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-terms-cache-'))
  created.push(directory)
  return directory
}

/** What a published list looks like, with a word no reader should see on disk. */
const PUBLISHED = `revision: '2026-11-10'
categories:
  - id: craft
    label: 工艺
    terms:
      - 熔封温度
`

afterEach(async () => {
  await Promise.all(created.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('a cached list', () => {
  it('is sealed on disk and opens back to the same text', async () => {
    const directory = await scratch()
    const path = await writeCachedTermList({ directory } as never, PUBLISHED, '2026-11-10')
    const body = await readFile(path, 'utf8')

    expect(body).not.toContain('熔封温度')
    expect(body).not.toContain('revision')
    const cached = await readCachedTermList(directory)
    expect(cached?.text).toBe(PUBLISHED)
  })

  it('keeps only the revision in force', async () => {
    const directory = await scratch()
    await writeCachedTermList({ directory } as never, PUBLISHED, '2026-11-09')
    await writeCachedTermList({ directory } as never, PUBLISHED, '2026-11-10')

    const names = (await readdir(directory)).filter(name => name.startsWith('terms-'))
    expect(names).toEqual(['terms-2026-11-10.yaml'])
  })

  it('still reads a plain list an earlier release wrote', async () => {
    const directory = await scratch()
    await writeFile(join(directory, 'terms-2026-10-01.yaml'), PUBLISHED, 'utf8')
    await writeFile(join(directory, 'current'), 'terms-2026-10-01.yaml\n', 'utf8')

    const cached = await readCachedTermList(directory)
    expect(cached?.text).toBe(PUBLISHED)
  })
})
