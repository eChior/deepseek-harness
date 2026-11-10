/**
 * The mapping file is what keeps a conversation readable after the process that
 * wrote it is gone. A placeholder outlives its process — the session file keeps it
 * forever — so the table has to survive too, in one file for the machine, and a
 * fresh process has to read it back before it hands out a number that file already
 * used.
 */
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mappingKey, openLine } from '../src/mapping-file.ts'
import type { RedactionEntry } from '../src/index.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { RedactionService } from '../src/index.ts'

/**
 * The write-back is asynchronous and the suite runs files in parallel, so a
 * loaded machine can take far longer than the default budget to land one line.
 */
vi.setConfig({ testTimeout: 20_000 })

/** One term, so every replacement is predictable. */
const TERMS = `version: 1
revision: 'mappings-1'
categories:
  - id: craft
    label: 工艺
    terms:
      - 结晶温度
      - 热封温度
    patterns: []
`

/** A cache directory with the term list written next to it. */
async function scratch(): Promise<{ cache: string; termsPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-mappings-'))
  const termsPath = join(directory, 'terms.yaml')
  await writeFile(termsPath, TERMS, 'utf8')
  return { cache: join(directory, 'cache'), termsPath }
}

/** Mount the service over one cache directory and load its rules. */
async function mount(cache: string, termsPath: string): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(RedactionService, {
    termsPath,
    cacheDirectory: cache,
    remote: '',
    refreshMinutes: 0,
    vision: false,
    includeRoster: false,
  })
  await ctx.veil.load()
  return ctx
}

/**
 * End one session and wait for the mapping file to carry `original`.
 * @param ctx Mounted context.
 * @param cache Cache directory the service writes under.
 * @param id Session identity; only the fact that a task ended matters now.
 * @param original A value the session replaced, so the wait has something to find.
 * @returns The file that was written.
 */
async function endSession(ctx: Context, cache: string, id: string, original: string): Promise<string> {
  const session = Session.create(SessionId(id))
  ctx.emit('session/disposed', session)
  const file = join(cache, 'mappings', 'mappings.jsonl')
  await vi.waitFor(async () => {
    await expect(entriesOf(file)).resolves.toContainEqual(expect.objectContaining({ original }))
  }, { timeout: 15_000, interval: 50 })
  return file
}

/**
 * The pairings one mapping file records, opened with the machine key.
 * @param file - the mapping file.
 * @returns every entry it holds, in file order.
 */
async function entriesOf(file: string): Promise<RedactionEntry[]> {
  const body = await readFile(file, 'utf8')
  const key = mappingKey(dirname(file))
  return body
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => openLine(line, key))
    .filter((entry): entry is RedactionEntry => entry !== undefined)
}

describe('redaction mapping files', () => {
  it('writes one file for the whole machine', async () => {
    const { cache, termsPath } = await scratch()
    const ctx = await mount(cache, termsPath)
    ctx.veil.redactText('结晶温度偏高')
    const file = await endSession(ctx, cache, 'task-a', '结晶温度')
    expect(file.endsWith(join('mappings', 'mappings.jsonl'))).toBe(true)
    // The originals never sit on disk in the clear: a tool result, a hex view or
    // a copied file must not be enough to read them back.
    expect(await readFile(file, 'utf8')).not.toContain('结晶温度')
    await expect(entriesOf(file)).resolves.toEqual([{ placeholder: '[工艺-1]', category: 'craft', original: '结晶温度' }])
  })

  it('writes while the process is alive, without waiting for the session to end', async () => {
    const { cache, termsPath } = await scratch()
    const ctx = await mount(cache, termsPath)
    ctx.veil.redactText('结晶温度偏高')
    // The desktop app quits by exiting its process, so `session/disposed` never
    // runs there. A pairing has to reach the disk on its own or the next launch
    // shows placeholders it can no longer read.
    const file = join(cache, 'mappings', 'mappings.jsonl')
    await vi.waitFor(async () => {
      await expect(entriesOf(file)).resolves.toContainEqual(expect.objectContaining({ original: '结晶温度' }))
    }, { timeout: 15_000, interval: 50 })
    expect(await readFile(file, 'utf8')).not.toContain('结晶温度')
  })

  it('appends every task to the same file', async () => {
    const { cache, termsPath } = await scratch()
    const ctx = await mount(cache, termsPath)
    ctx.veil.redactText('结晶温度偏高')
    await endSession(ctx, cache, 'task-a', '结晶温度')
    ctx.veil.redactText('热封温度偏低')
    await endSession(ctx, cache, 'task-b', '热封温度')
    // Not one file per task: a placeholder means the same value wherever it is
    // read, so every task appends to the machine's table instead.
    // The key that opens the file lives elsewhere, under a name that gives
    // nothing away, so a listing of the mappings is all a reader gets.
    const names = (await readdir(join(cache, 'mappings'))).sort()
    expect(names).toEqual(['mappings.jsonl'])
    expect(await readdir(join(cache, 'state'))).toEqual(['index.dat'])
    await expect(entriesOf(join(cache, 'mappings', 'mappings.jsonl'))).resolves.toEqual([
      { placeholder: '[工艺-1]', category: 'craft', original: '结晶温度' },
      { placeholder: '[工艺-2]', category: 'craft', original: '热封温度' },
    ])
  })

  it('leaves nothing behind when the write-back is off', async () => {
    const { cache, termsPath } = await scratch()
    const ctx = await mount(cache, termsPath)
    ctx.veil.setMappings(false)
    ctx.veil.redactText('结晶温度偏高')
    const session = Session.create(SessionId('task-off'))
    ctx.emit('session/disposed', session)
    await new Promise(resolve => setTimeout(resolve, 50))
    // Nothing that opens a file is written either: the directory may hold the
    // key from an earlier run, but no pairing ever reaches the disk.
    await expect(readdir(join(cache, 'mappings'))).resolves.not.toContain('mappings.jsonl')
    // The map is still in memory, so the reader of this process keeps restoring.
    expect(ctx.veil.restore('[工艺-1] 偏高')).toBe('结晶温度 偏高')
  })

  it('restores in a fresh process what an earlier one wrote', async () => {
    const { cache, termsPath } = await scratch()
    const first = await mount(cache, termsPath)
    first.veil.redactText('结晶温度偏高')
    await endSession(first, cache, 'task-a', '结晶温度')

    const second = await mount(cache, termsPath)
    await vi.waitFor(() => {
      expect(second.veil.restore('[工艺-1] 偏高')).toBe('结晶温度 偏高')
    })
    // A reader rendering an old conversation sees the original, and the table the
    // browser asks for carries it — whichever task wrote it.
    expect(await second.veil.mappingsFor()).toEqual([
      { placeholder: '[工艺-1]', category: 'craft', original: '结晶温度' },
    ])
    expect(second.veil.entries()).toEqual([
      { placeholder: '[工艺-1]', category: 'craft', original: '结晶温度' },
    ])
    // The value the file already pinned keeps its number in this process too.
    expect(second.veil.redactText('结晶温度偏高')).toBe('[工艺-1]偏高')
    // A value the file never saw takes the next free number, not `[工艺-1]` again.
    expect(second.veil.redactText('热封温度偏低')).toBe('[工艺-2]偏低')
    expect(second.veil.restore('[工艺-1] 与 [工艺-2]')).toBe('结晶温度 与 热封温度')
    // Every replacement is counted, including the one that reused the pinned
    // number; a new entry is recorded only for the value the file never saw.
    expect(second.veil.status.replacements).toBe(2)
  })
})
