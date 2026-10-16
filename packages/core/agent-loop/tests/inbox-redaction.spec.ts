/**
 * The inbox is where a queued message becomes durable, so a redaction provider
 * that is not wired in front of it protects nothing. These tests use the real
 * provider and the real inbox: the value a user typed has to be gone from the
 * message the session keeps, and the placeholder it became has to come back.
 */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RedactionService } from '@deepseek-ai/dsh-redaction'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { rewriteMessage } from '../src/agent.ts'
import { inboxProjectionDefinition, ReactLoopInbox } from '../src/inbox.ts'

/** The term list these tests redact with. Two categories, one term each. */
const TERMS = `version: 1
revision: 'test-1'
categories:
  - id: craft
    label: 工艺
    terms:
      - 结晶温度
    patterns: []
  - id: identifier
    label: 编号
    terms: []
    patterns:
      - 'DEV-\\d{4}'
`

/** An Agent stub whose only real member is the session the inbox writes to. */
function stubAgent(id: SessionId, ctx: Context, session: Session): Agent {
  const reject = (): never => {
    throw new Error('this test Agent does not support Inbox mutations')
  }
  return {
    id,
    options: {},
    session,
    inbox: {
      nextTurn: [], nextStep: [], clear: reject, append: reject,
      prepend: reject, replace: reject, remove: reject, splice: reject,
    },
    status: 'idle',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** An inbox wired to a real redaction provider, backed by a term list on disk. */
async function wiredInbox(rawId: string): Promise<{ ctx: Context; inbox: ReactLoopInbox }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-'))
  const termsPath = join(directory, 'terms.yaml')
  await writeFile(termsPath, TERMS, 'utf8')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(inboxProjectionDefinition)
  await ctx.plugin(RedactionService, { termsPath })
  await ctx.redaction.load()
  const id = SessionId(rawId)
  const session = ctx.sessions.create(id)
  const agent = stubAgent(id, ctx, session)
  const inbox = new ReactLoopInbox(
    ctx.sessionProjections,
    session,
    agentEvents(ctx, agent),
    message => rewriteMessage(ctx.get('redaction'), message),
  )
  return { ctx, inbox }
}

function userMessage(text: string): Parameters<ReactLoopInbox['splice']>[3][number] {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('inbox redaction', () => {
  it('stores a placeholder where the user typed a term', async () => {
    const { inbox } = await wiredInbox('redaction-term')
    inbox.splice('next-turn', Infinity, 0, [userMessage('结晶温度为什么偏低')])
    const stored = inbox.nextTurn[0]
    expect(stored?.content).toEqual([{ type: 'text', text: '[工艺-1]为什么偏低' }])
    expect(JSON.stringify(stored)).not.toContain('结晶温度')
  })

  it('replaces a pattern match and keeps the same placeholder for the same value', async () => {
    const { inbox } = await wiredInbox('redaction-pattern')
    inbox.splice('next-turn', Infinity, 0, [userMessage('DEV-2026 与 DEV-2026 是同一单')])
    const stored = inbox.nextTurn[0]
    expect(stored?.content).toEqual([{ type: 'text', text: '[编号-1] 与 [编号-1] 是同一单' }])
  })

  it('leaves the message untouched when no provider is loaded', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(inboxProjectionDefinition)
    const id = SessionId('redaction-absent')
    const session = ctx.sessions.create(id)
    const agent = stubAgent(id, ctx, session)
    const inbox = new ReactLoopInbox(ctx.sessionProjections, session, agentEvents(ctx, agent))
    const message = userMessage('结晶温度为什么偏低')
    inbox.splice('next-turn', Infinity, 0, [message])
    expect(message.content).toEqual([{ type: 'text', text: '结晶温度为什么偏低' }])
    expect(inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: '结晶温度为什么偏低' }])
  })

  it('restores a placeholder to the value this process saw', async () => {
    const { ctx, inbox } = await wiredInbox('redaction-restore')
    inbox.splice('next-turn', Infinity, 0, [userMessage('结晶温度 70 度')])
    expect(ctx.redaction.restore('复查 [工艺-1] 的记录')).toBe('复查 结晶温度 的记录')
  })
})
