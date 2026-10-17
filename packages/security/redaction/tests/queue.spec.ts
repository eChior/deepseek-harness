/**
 * The term-request queue: what a machine holds when it cannot reach the
 * publisher, and what a delivery does with it.
 *
 * The queue is the only redaction state that leaves a machine, so what these
 * tests pin down is that it holds the missing term and nothing else, that a
 * delivery records what happened to each request, and that a machine with no
 * destination keeps every request instead of dropping it.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RedactionService,
  TERM_REQUEST_FILE,
  assertTermShape,
  queueTermRequest,
  readTermRequests,
  settleTermRequest,
  writeTermRequests,
  type TermRequest,
  type TermRequestSink,
} from '../src/index.ts'

/** Boot a provider with no rules, so only the queue is under test. */
async function harness(): Promise<{ ctx: Context; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-queue-'))
  const ctx = new Context()
  await ctx.plugin(RedactionService, {
    termsPath: join(directory, 'missing.yaml'),
    cacheDirectory: directory,
    remote: '',
    refreshMinutes: 0,
    vision: false,
    includeRoster: false,
  })
  return { ctx, directory }
}

/** Build one settled request, for the retention tests. */
function settled(term: string): TermRequest {
  return {
    id: `id-${term}`,
    term,
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'uploaded',
  }
}

describe('term request shape', () => {
  it('refuses a term a list entry cannot hold', () => {
    expect(() => { assertTermShape('') }).toThrow('needs a term')
    expect(() => { assertTermShape('a'.repeat(65)) }).toThrow('at most 64')
    expect(() => { assertTermShape(' 结晶温度') }).toThrow('whitespace')
    expect(() => { assertTermShape('结晶\n温度') }).toThrow('one line')
  })

  it('accepts an ordinary term', () => {
    expect(() => { assertTermShape('结晶温度') }).not.toThrow()
  })
})

describe('the queue file', () => {
  it('holds a request as pending and reads it back', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-queue-'))
    const queued = await queueTermRequest(directory, '结晶温度', '工序参数漏了')
    expect(queued.state).toBe('pending')
    expect((await readTermRequests(directory))).toEqual([queued])
    const text = await readFile(join(directory, TERM_REQUEST_FILE), 'utf8')
    expect(text).toContain('结晶温度')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('keeps one entry for a term already waiting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-queue-'))
    const first = await queueTermRequest(directory, '结晶温度')
    const second = await queueTermRequest(directory, '结晶温度')
    expect(second.id).toBe(first.id)
    expect((await readTermRequests(directory)).length).toBe(1)
  })

  it('records how a delivery ended', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-queue-'))
    const queued = await queueTermRequest(directory, '结晶温度')
    const settledRequest = await settleTermRequest(directory, queued.id, 'rejected', '不在词表范围')
    expect(settledRequest?.state).toBe('rejected')
    const [stored] = await readTermRequests(directory)
    expect(stored?.state).toBe('rejected')
    expect(stored?.detail).toBe('不在词表范围')
  })

  it('ignores a line this module did not write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-queue-'))
    await writeFile(join(directory, TERM_REQUEST_FILE), 'not json\n{"term":"x"}\n', 'utf8')
    expect(await readTermRequests(directory)).toEqual([])
  })

  it('never drops a pending request when it prunes settled ones', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-queue-'))
    const pending: TermRequest = {
      id: 'kept',
      term: '结晶温度',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'pending',
    }
    const uploaded = Array.from({ length: 600 }, (_item, index) => settled(`t-${String(index)}`))
    await writeTermRequests(directory, [pending, ...uploaded])
    const requests = await readTermRequests(directory)
    expect(requests.map(request => request.id)).toContain('kept')
    expect(requests.length).toBe(501)
  })
})

describe('requests through the provider', () => {
  it('reports how many requests are waiting', async () => {
    const { ctx, directory } = await harness()
    await ctx.redaction.requestTerm('结晶温度')
    expect(ctx.redaction.status.pending).toBe(1)
    expect((await ctx.redaction.pendingRequests()).length).toBe(1)
    expect((await readTermRequests(directory)).length).toBe(1)
  })

  it('keeps every request when no destination is configured', async () => {
    const { ctx } = await harness()
    await ctx.redaction.requestTerm('结晶温度')
    const delivery = await ctx.redaction.deliverRequests()
    expect(delivery).toEqual({ sink: null, sent: 0, failed: 0, pending: 1 })
    expect(ctx.redaction.status.pending).toBe(1)
  })

  it('settles what a sink takes and what it refuses', async () => {
    const { ctx } = await harness()
    await ctx.redaction.requestTerm('结晶温度')
    await ctx.redaction.requestTerm('偏差等级')
    const refused: string[] = []
    const sink: TermRequestSink = {
      name: 'test',
      async send(request) {
        if (request.term === '偏差等级') throw new Error('issue tracker is down')
        refused.push(request.term)
      },
    }
    const delivery = await ctx.redaction.deliverRequests(sink)
    expect(delivery).toEqual({ sink: 'test', sent: 1, failed: 1, pending: 0 })
    expect(refused).toEqual(['结晶温度'])
    const stored = await ctx.redaction.pendingRequests()
    expect(stored.find(request => request.term === '结晶温度')?.state).toBe('uploaded')
    const failed = stored.find(request => request.term === '偏差等级')
    expect(failed?.state).toBe('rejected')
    expect(failed?.detail).toBe('issue tracker is down')
    expect(ctx.redaction.status.pending).toBe(0)
  })
})
