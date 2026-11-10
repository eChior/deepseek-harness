/**
 * A department list reaches a conversation only while it applies: the reader's
 * own department is automatic, another department needs a tick. The service
 * side of that rule is what this file pins — reading the files, reporting them
 * to the settings page, and turning one on or off at runtime.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { RedactionService } from '../src/index.ts'

/** The published list carries nothing, so every hit comes from a department. */
const TERMS = `version: 1
revision: 'departments-1'
categories: []
`

const DEPARTMENT = `version: 1
revision: '2026-10-28'
categories:
  - id: craft
    label: 工艺
    terms:
      - 结晶温度
    patterns: []
`

/** A cache with one department list already on disk. */
async function scratch(): Promise<{ cache: string; termsPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-redaction-departments-'))
  const termsPath = join(directory, 'terms.yaml')
  await writeFile(termsPath, TERMS, 'utf8')
  const cache = join(directory, 'cache')
  await mkdir(join(cache, 'departments'), { recursive: true })
  await writeFile(join(cache, 'departments', '研发部.yaml'), DEPARTMENT, 'utf8')
  return { cache, termsPath }
}

/** Mount the service and read the lists on disk. */
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
  await ctx.veil.reloadLocal()
  return ctx
}

describe('department lists', () => {
  it('starts switched off when the reader has no known department', async () => {
    const { cache, termsPath } = await scratch()
    const ctx = await mount(cache, termsPath)

    expect(ctx.veil.departmentLists()).toEqual([
      { name: '研发部', enabled: false, own: false, terms: 1, patterns: 0, revision: '2026-10-28' },
    ])
    expect(ctx.veil.redactText('结晶温度偏高')).toBe('结晶温度偏高')
  })

  it('puts the list in force once it is ticked, and takes it out again', async () => {
    const { cache, termsPath } = await scratch()
    const ctx = await mount(cache, termsPath)

    await ctx.veil.setDepartmentEnabled('研发部', true)
    expect(ctx.veil.departmentLists()[0]?.enabled).toBe(true)
    expect(ctx.veil.redactText('结晶温度偏高')).toBe('[工艺-1]偏高')

    await ctx.veil.setDepartmentEnabled('研发部', false)
    expect(ctx.veil.redactText('结晶温度偏高')).toBe('结晶温度偏高')
  })

  it('keeps the tick for the next process', async () => {
    const { cache, termsPath } = await scratch()
    const first = await mount(cache, termsPath)
    await first.veil.setDepartmentEnabled('研发部', true)
    await first.fiber.dispose()

    const second = await mount(cache, termsPath)
    expect(second.veil.departmentLists()[0]?.enabled).toBe(true)
    expect(second.veil.redactText('结晶温度偏高')).toBe('[工艺-1]偏高')
  })

  it('refuses a name it never downloaded', async () => {
    const { cache, termsPath } = await scratch()
    const ctx = await mount(cache, termsPath)

    await expect(ctx.veil.setDepartmentEnabled('财务部', true)).rejects.toThrow('no department list named 财务部')
  })

  it('counts the lists in force in its status', async () => {
    const { cache, termsPath } = await scratch()
    const ctx = await mount(cache, termsPath)
    expect(ctx.veil.status.departments).toBe(0)

    await ctx.veil.setDepartmentEnabled('研发部', true)
    expect(ctx.veil.status.departments).toBe(1)
  })
})
