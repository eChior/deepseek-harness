/**
 * End to end through the real loop. Two paths carry a value into the session log
 * — what the user typed, and what a tool returned — and this suite drives both.
 * The assertion that matters is the last one: the words a value was made of must
 * not appear anywhere in the events the session kept.
 */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RedactionService } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** The term list these tests redact with. */
const TERMS = `version: 1
revision: 'test-1'
categories:
  - id: identifier
    label: 编号
    terms: []
    patterns:
      - 'SOP-[A-Z]{2,4}(?:-[A-Z]{2,4})*-\\d{2,4}'
  - id: craft
    label: 工艺
    terms:
      - 结晶温度
    patterns: []
`

/** The values the loop must never store. */
const RECORD = 'SOP-ST-AD-001'
const MEASURE = '结晶温度'

/** Boot the core spine with a redaction provider and one tool that answers with sensitive text. */
async function harness(): Promise<Context> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-loop-'))
  const termsPath = join(directory, 'terms.yaml')
  await writeFile(termsPath, TERMS, 'utf8')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(RedactionService, { termsPath })
  await ctx.redaction.load()
  ctx.tools.register(defineContentToolFixture({
    name: 'lookup',
    description: 'look up one record',
    parameters: {},
    async execute() {
      return [{ type: 'text', text: `记录 ${RECORD} 的${MEASURE}为 72 摄氏度` }]
    },
  }))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const off = ctx.on('agent/status', ({ agent: statusAgent, status }) => {
      if (statusAgent === agent && status === 'idle') {
        off()
        resolve()
      }
    })
  })
}

describe('redaction through the loop', () => {
  it('keeps a user term and a tool result out of the session log', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'lookup', {}),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('redaction-loop'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `查一下 ${RECORD} 的${MEASURE}` }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    const events = agent.session.snapshotEvents()
    const log = JSON.stringify(events)
    expect(log).not.toContain(RECORD)
    expect(log).not.toContain(MEASURE)

    const prompt = events.find(event => event.type === 'user/message')
    expect(prompt?.type === 'user/message' ? JSON.stringify(prompt.data.content) : '').toContain('[编号-1]')

    const result = events.find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' ? JSON.stringify(result.data.message.content) : '').toContain('[工艺-1]')
  })
})
