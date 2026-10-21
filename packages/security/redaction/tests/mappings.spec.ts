/**
 * The mapping files are what keep a conversation readable after the process that
 * wrote it is gone. A placeholder outlives its process — the session file keeps it
 * forever — so the table has to survive too, one file per task, and a fresh
 * process has to read it back before it hands out a number that file already used.
 */
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { RedactionService } from '../src/index.ts'

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
  await ctx.redaction.load()
  return ctx
}

/**
 * End one session and wait for its mapping file to carry `original`.
 * @param ctx Mounted context.
 * @param cache Cache directory the service writes under.
 * @param id Session identity, which becomes the file name.
 * @param original A value the session replaced, so the wait has something to find.
 * @returns The file that was written.
 */
async function endSession(ctx: Context, cache: string, id: string, original: string): Promise<string> {
  const session = Session.create(SessionId(id))
  ctx.emit('session/disposed', session)
  const file = join(cache, 'mappings', `${id}.jsonl`)
  await vi.waitFor(async () => {
    await expect(readFile(file, 'utf8')).resolves.toContain(original)
  })
  return file
}

describe('redaction mapping files', () => {
  it('writes one file per task, named after the session', async () => {
    const { cache, termsPath } = await scratch()
    const ctx = await mount(cache, termsPath)
    ctx.redaction.redactText('结晶温度偏高')
    const file = await endSession(ctx, cache, 'task-a', '结晶温度')
    expect(file.endsWith(join('mappings', 'task-a.jsonl'))).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(
      `${JSON.stringify({ placeholder: '[工艺-1]', category: 'craft', original: '结晶温度' })}\n`,
    )
  })

  it('keeps two tasks apart', async () => {
    const { cache, termsPath } = await scratch()
    const ctx = await mount(cache, termsPath)
    ctx.redaction.redactText('结晶温度偏高')
    await endSession(ctx, cache, 'task-a', '结晶温度')
    ctx.redaction.redactText('热封温度偏低')
    await endSession(ctx, cache, 'task-b', '热封温度')
    const names = (await readdir(join(cache, 'mappings'))).sort()
    expect(names).toEqual(['task-a.jsonl', 'task-b.jsonl'])
    const second = await readFile(join(cache, 'mappings', 'task-b.jsonl'), 'utf8')
    // The second file records only what the second task added: a value already
    // written for task A is not repeated here.
    expect(second).toBe(
      `${JSON.stringify({ placeholder: '[工艺-2]', category: 'craft', original: '热封温度' })}\n`,
    )
  })

  it('leaves nothing behind when the write-back is off', async () => {
    const { cache, termsPath } = await scratch()
    const ctx = await mount(cache, termsPath)
    ctx.redaction.setMappings(false)
    ctx.redaction.redactText('结晶温度偏高')
    const session = Session.create(SessionId('task-off'))
    ctx.emit('session/disposed', session)
    await new Promise(resolve => setTimeout(resolve, 50))
    await expect(readdir(join(cache, 'mappings'))).rejects.toThrow()
    // The map is still in memory, so the reader of this process keeps restoring.
    expect(ctx.redaction.restore('[工艺-1] 偏高')).toBe('结晶温度 偏高')
  })

  it('restores in a fresh process what an earlier one wrote', async () => {
    const { cache, termsPath } = await scratch()
    const first = await mount(cache, termsPath)
    first.redaction.redactText('结晶温度偏高')
    await endSession(first, cache, 'task-a', '结晶温度')

    const second = await mount(cache, termsPath)
    await vi.waitFor(() => {
      expect(second.redaction.restore('[工艺-1] 偏高')).toBe('结晶温度 偏高')
    })
    // A reader rendering an old conversation sees the original, and the table
    // the browser asks for by session carries it.
    expect(await second.redaction.mappingsFor('task-a')).toEqual([
      { placeholder: '[工艺-1]', category: 'craft', original: '结晶温度' },
    ])
    // One task, one mapping: nothing of task A is offered to another session.
    expect(await second.redaction.mappingsFor('task-b')).toEqual([])
    // Nor does the file enter this process's own log, which counts what it
    // replaced itself.
    expect(second.redaction.entries()).toEqual([])
    // The number that file already used is never handed out again.
    expect(second.redaction.redactText('热封温度偏低')).toBe('[工艺-2]偏低')
    expect(second.redaction.restore('[工艺-1] 与 [工艺-2]')).toBe('结晶温度 与 热封温度')
    expect(second.redaction.status.replacements).toBe(1)
  })
})
