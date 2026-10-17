/**
 * The staff directory is the only place a colleague's department is written
 * down, and the only list that can tell an ordinary word from a person's name.
 * Both jobs are asserted here: naming the department an upload belongs to, and
 * contributing colleagues and departments to the rules.
 *
 * Every case seals its own directory and hands the key over through the
 * environment, because the alternative is reading the list this build ships —
 * which would make these tests depend on who happens to work here.
 */
import { Context } from '@deepseek-ai/cordis'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as entry from '../src/index.ts'

/** A term list of its own, so a directory replacement cannot be confused with one. */
const TERMS = `version: 1
revision: 'roster-1'
categories:
  - id: craft
    label: 工艺
    terms:
      - 结晶温度
    patterns: []
`

/** A directory of two colleagues, one of whom the export no longer employs. */
const PAYLOAD = {
  revision: '2026-10-17',
  people: [
    {
      name: '张三',
      department: '质量管理部',
      employeeId: '20792036',
      position: 'QA',
      account: 'zhangsan',
      qmsId: 'Q1001',
      active: true,
    },
    {
      name: '李四',
      department: '生产部',
      employeeId: '20792037',
      position: 'OP',
      account: 'lisi',
      qmsId: 'Q1002',
      active: false,
    },
  ],
  departments: ['质量管理部', '生产部'],
}

/**
 * Seal a payload the way `scripts/build-roster.py` does.
 * @param payload - Directory contents to encrypt.
 * @returns The hex key and the bytes a build would ship.
 */
function seal(payload: unknown): { readonly key: string; readonly bytes: Buffer } {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const header = Buffer.concat([Buffer.from('RSTR', 'utf8'), Buffer.from([1])])
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(header)
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return { key: key.toString('hex'), bytes: Buffer.concat([header, iv, cipher.getAuthTag(), body]) }
}

/**
 * Load the provider against a directory sealed for this test alone.
 * @param includeRoster - Whether the deployment would use the directory.
 * @returns The context holding the loaded provider.
 */
async function loaded(includeRoster: boolean): Promise<Context> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-roster-'))
  const sealed = seal(PAYLOAD)
  const termsPath = join(directory, 'terms.yaml')
  await writeFile(termsPath, TERMS, 'utf8')
  await writeFile(join(directory, 'roster.bin'), sealed.bytes)
  const previous = process.env['DSH_ROSTER_KEY']
  process.env['DSH_ROSTER_KEY'] = sealed.key
  onTestFinished(() => {
    if (previous === undefined) delete process.env['DSH_ROSTER_KEY']
    else process.env['DSH_ROSTER_KEY'] = previous
  })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(entry, {
    termsPath,
    rosterPath: join(directory, 'roster.bin'),
    cacheDirectory: join(directory, 'cache'),
    remote: '',
    refreshMinutes: 0,
    vision: false,
    includeRoster,
  })
  await ctx.redaction.load()
  return ctx
}

describe('staff directory', () => {
  it('turns colleagues and departments into rules', async () => {
    const ctx = await loaded(true)
    expect(ctx.redaction.status.roster).toBe(3)
    expect(ctx.redaction.redactText('张三')).not.toBe('张三')
    expect(ctx.redaction.redactText('质量管理部')).not.toBe('质量管理部')
    // The published half is still in force; the directory only adds to it.
    expect(ctx.redaction.redactText('结晶温度')).not.toBe('结晶温度')
  })

  it('leaves the departed colleague out of the rules', async () => {
    const ctx = await loaded(true)
    expect(ctx.redaction.redactText('张三')).not.toBe('张三')
    expect(ctx.redaction.redactText('李四')).toBe('李四')
    expect(ctx.redaction.redactText('生产部')).not.toBe('生产部')
  })

  it('names the department of the colleague asking', async () => {
    const ctx = await loaded(true)
    expect(ctx.redaction.identify('张三')?.department).toBe('质量管理部')
    expect(ctx.redaction.identify(' 张三 ')?.employeeId).toBe('20792036')
    expect(ctx.redaction.identify('王五')).toBeUndefined()
    expect(ctx.redaction.attributionFor('张三')).toEqual({ author: '张三', department: '质量管理部' })
  })

  it('carries a name the directory does not list without inventing a department', async () => {
    const ctx = await loaded(true)
    expect(ctx.redaction.attributionFor('外来人员')).toEqual({ author: '外来人员' })
    expect(ctx.redaction.attributionFor('   ')).toEqual({})
  })

  it('describes what the directory contributes', async () => {
    const ctx = await loaded(true)
    expect(ctx.redaction.rosterSummary()).toEqual({
      enabled: true,
      revision: '2026-10-17',
      people: 2,
      departments: 2,
    })
  })

  it('contributes nothing when the deployment turns it off', async () => {
    const ctx = await loaded(false)
    expect(ctx.redaction.status.roster).toBe(0)
    expect(ctx.redaction.identify('张三')).toBeUndefined()
    expect(ctx.redaction.rosterSummary().enabled).toBe(false)
    expect(ctx.redaction.redactText('张三')).toBe('张三')
    // The published half does not depend on the directory being readable.
    expect(ctx.redaction.redactText('结晶温度')).not.toBe('结晶温度')
  })

  it('keeps replacing from the published list when the directory cannot be opened', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-roster-bad-'))
    const termsPath = join(directory, 'terms.yaml')
    await writeFile(termsPath, TERMS, 'utf8')
    await writeFile(join(directory, 'roster.bin'), Buffer.from('RSTR\u0001 truncated', 'utf8'))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(entry, {
      termsPath,
      rosterPath: join(directory, 'roster.bin'),
      cacheDirectory: join(directory, 'cache'),
      remote: '',
      refreshMinutes: 0,
      vision: false,
      includeRoster: true,
    })
    await ctx.redaction.load()
    expect(ctx.redaction.status.roster).toBe(0)
    expect(ctx.redaction.status.detail).toBeNull()
    expect(ctx.redaction.redactText('结晶温度')).not.toBe('结晶温度')
  })
})
