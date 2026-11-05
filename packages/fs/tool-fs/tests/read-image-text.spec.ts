/**
 * The `read_image_text` tool over the REAL local filesystem: it registers only
 * while a local reader is mounted, hands the reader the exact file bytes, and
 * reports a machine that cannot read the image instead of returning empty text.
 */
import { afterEach, expect, it, describe } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

/** 1x1 red PNG. */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

/** A stand-in for the redaction provider: hands back whatever the test set. */
class FakeReader extends Service {
  /** The instance this mount created, so the test holds it without casting the service. */
  static last: FakeReader | undefined

  readonly seen: { data: string; mediaType: string }[] = []
  answer: string | undefined = '合同编号 AB12345678'

  constructor(ctx: Context) {
    super(ctx, 'redaction')
    FakeReader.last = this
  }

  recognizeImage(data: string, mediaType: string): Promise<string | undefined> {
    this.seen.push({ data, mediaType })
    return Promise.resolve(this.answer)
  }
}

const directories: string[] = []

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'dsh-image-text-'))
  directories.push(created)
  return created
}

afterEach(async () => {
  for (const created of directories.splice(0)) await rm(created, { recursive: true, force: true })
})

interface SetupOptions {
  reader?: boolean
  readImageText?: boolean
}

async function setup(options: SetupOptions = {}) {
  const dir = await directory()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs, { readImageText: options.readImageText ?? true })
  let reader: FakeReader | undefined
  if (options.reader !== false) {
    await ctx.plugin(FakeReader)
    reader = FakeReader.last
  }
  return { ctx, dir, reader }
}

const signal = new AbortController().signal

function run(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`image-text-${String(Math.random()).slice(2)}`),
    name: 'read_image_text',
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** A refused call resolves with `isError`; the message is what the model sees. */
async function refused(ctx: Context, args: unknown): Promise<string> {
  const result = await run(ctx, args)
  expect(result.isError).toBe(true)
  return text(result)
}

describe('read_image_text', () => {
  it('hands the reader the file bytes and returns its text', async () => {
    const { ctx, dir, reader } = await setup()
    await writeFile(join(dir, 'sop.png'), PNG_1X1)
    const result = await run(ctx, { file_path: 'sop.png' })
    expect(text(result)).toContain('合同编号 AB12345678')
    expect(reader?.seen).toHaveLength(1)
    expect(reader?.seen[0]?.mediaType).toBe('image/png')
    expect(Buffer.from(reader?.seen[0]?.data ?? '', 'base64')).toEqual(PNG_1X1)
  })

  it('reports a machine that cannot read the image instead of returning nothing', async () => {
    const { ctx, dir, reader } = await setup()
    if (reader !== undefined) reader.answer = undefined
    await writeFile(join(dir, 'sop.png'), PNG_1X1)
    expect(await refused(ctx, { file_path: 'sop.png' })).toMatch(/no reader for image\/png/u)
  })

  it('refuses a file that is not an image', async () => {
    const { ctx, dir } = await setup()
    await writeFile(join(dir, 'notes.txt'), 'plain text')
    expect(await refused(ctx, { file_path: 'notes.txt' })).toMatch(/not a supported PNG\/JPEG\/WebP\/GIF/u)
  })

  it('refuses an empty path', async () => {
    const { ctx } = await setup()
    expect(await refused(ctx, { file_path: '   ' })).toMatch(/must be a non-empty string/u)
  })

  it('registers nothing when no local reader is mounted', async () => {
    const { ctx, dir } = await setup({ reader: false })
    await writeFile(join(dir, 'sop.png'), PNG_1X1)
    expect(await refused(ctx, { file_path: 'sop.png' })).toMatch(/unknown tool/u)
  })

  it('stays off when the deployment turns it off', async () => {
    const { ctx, dir } = await setup({ readImageText: false })
    await writeFile(join(dir, 'sop.png'), PNG_1X1)
    expect(await refused(ctx, { file_path: 'sop.png' })).toMatch(/unknown tool/u)
  })
})
