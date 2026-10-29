import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NO_KEYS, pickDepartmentKey, readDepartmentKeys } from '../src/keys.ts'

const rooms: string[] = []

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-qwen-keys-'))
  rooms.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(rooms.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('readDepartmentKeys', () => {
  it('answers an empty table when the build shipped no file', async () => {
    const directory = await scratch()
    expect(await readDepartmentKeys(join(directory, 'absent.json'))).toEqual(NO_KEYS)
  })

  it('answers an empty table rather than throwing on damaged JSON', async () => {
    const directory = await scratch()
    const path = join(directory, 'broken.json')
    await writeFile(path, '{ not json', 'utf8')
    expect(await readDepartmentKeys(path)).toEqual(NO_KEYS)
  })

  it('answers an empty table when the document is a list', async () => {
    const directory = await scratch()
    const path = join(directory, 'list.json')
    await writeFile(path, '["sk-one"]', 'utf8')
    expect(await readDepartmentKeys(path)).toEqual(NO_KEYS)
  })

  it('keeps the string entries and drops the rest', async () => {
    const directory = await scratch()
    const path = join(directory, 'mixed.json')
    await writeFile(path, JSON.stringify({ 研发部: 'sk-a', 财务部: '   ', 生产部: 42, '*': ' sk-fallback ' }), 'utf8')
    expect(await readDepartmentKeys(path)).toEqual({ 研发部: 'sk-a', '*': 'sk-fallback' })
  })
})

describe('pickDepartmentKey', () => {
  const keys = { 研发部: 'sk-lab', '*': 'sk-fallback' }

  it('prefers the department of the signed-in colleague', () => {
    expect(pickDepartmentKey(keys, '研发部')).toBe('sk-lab')
  })

  it('falls back to the catch-all entry for any other department', () => {
    expect(pickDepartmentKey(keys, '财务部')).toBe('sk-fallback')
  })

  it('falls back when the roster could not name a department', () => {
    expect(pickDepartmentKey(keys, null)).toBe('sk-fallback')
    expect(pickDepartmentKey(keys, undefined)).toBe('sk-fallback')
  })

  it('answers undefined when the table covers neither case', () => {
    expect(pickDepartmentKey({ 研发部: 'sk-lab' }, '财务部')).toBeUndefined()
    expect(pickDepartmentKey(NO_KEYS, '研发部')).toBeUndefined()
  })
})
