/**
 * A model can only ever write placeholders into a document: the map that would
 * turn them back never reaches it. The file therefore has to be finished off
 * after the call that wrote it — and inside Python, because document encryption
 * whitelists that interpreter and refuses a read or write from this process.
 */
import { Context } from '@deepseek-ai/cordis'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it, onTestFinished } from 'vitest'
import { RedactionService } from '../src/index.ts'

const TERMS = `version: 1
revision: 'documents-1'
categories:
  - id: product
    label: 产品
    terms:
      - 红霉素肠溶胶囊
    patterns: []
`

/** The interpreter the plugin spawns, named the same way here. */
const python = process.env.DSH_REDACTION_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')

/** Whether this machine can run the restore script at all. */
const interpreter = spawnSync(python, ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0

async function scratch(): Promise<{ directory: string; cache: string; termsPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-documents-'))
  const termsPath = join(directory, 'terms.yaml')
  await writeFile(termsPath, TERMS, 'utf8')
  return { directory, cache: join(directory, 'cache'), termsPath }
}

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

/** Run one tool call through the waterfall with `arguments` as its payload. */
async function call(ctx: Context, arguments_: unknown): Promise<void> {
  const exec = { name: 'bash', arguments: arguments_, callId: 'call-1', signal: new AbortController().signal }
  await ctx.waterfall(
    ctx as never,
    'tools/post-execute',
    exec as never,
    { content: [] } as never,
    () => Promise.resolve({ kind: 'accept' as const }),
  )
}

describe.skipIf(!interpreter)('documents a tool call wrote', () => {
  it('puts the original back into a markdown file the call named', async () => {
    const { directory, cache, termsPath } = await scratch()
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const ctx = await mount(cache, termsPath)

    const placeholder = ctx.redaction.redactText('红霉素肠溶胶囊')
    expect(placeholder).toBe('[产品-1]')
    const path = join(directory, 'notes.md')
    await writeFile(path, `# 记录\n\n产品是 ${placeholder}\n`, 'utf8')

    await call(ctx, { command: `cat "${path}"` })

    expect(await readFile(path, 'utf8')).toContain('红霉素肠溶胶囊')
  })

  it('puts the original back into the XML part of a docx', async () => {
    const { directory, cache, termsPath } = await scratch()
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const ctx = await mount(cache, termsPath)

    const placeholder = ctx.redaction.redactText('红霉素肠溶胶囊')
    const path = join(directory, '报告.docx')
    const archive = zipSync({
      '[Content_Types].xml': new TextEncoder().encode('<Types/>'),
      'word/document.xml': new TextEncoder().encode(`<w:t>${placeholder}</w:t>`),
    })
    await writeFile(path, archive)

    await call(ctx, { path })

    const bytes = await readFile(path)
    expect(Buffer.from(bytes).includes(Buffer.from('[产品-1]', 'utf8'))).toBe(false)
  })

  it('leaves the file alone when the write-back switch is off', async () => {
    const { directory, cache, termsPath } = await scratch()
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const ctx = await mount(cache, termsPath)

    const placeholder = ctx.redaction.redactText('红霉素肠溶胶囊')
    const path = join(directory, 'notes.md')
    await writeFile(path, `产品是 ${placeholder}\n`, 'utf8')
    ctx.redaction.setMappings(false)

    await call(ctx, { path })

    expect(await readFile(path, 'utf8')).toContain(placeholder)
  })

  it('does not fail the call when the file is not there', async () => {
    const { directory, cache, termsPath } = await scratch()
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const ctx = await mount(cache, termsPath)
    ctx.redaction.redactText('红霉素肠溶胶囊')

    await expect(call(ctx, { path: join(directory, 'absent.docx') })).resolves.toBeUndefined()
  })
})
