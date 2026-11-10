/**
 * Department lists: the per-department YAML files, the tick that decides which
 * of them apply, and the round trip from a published file to the summary the
 * settings page renders. The rule itself is small — the reader's own
 * department is on without a tick — but it decides whose wording reaches a
 * conversation, so each branch is pinned here.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  departmentApplies,
  departmentNameOf,
  departmentNamesOf,
  departmentsDirectory,
  describeDepartments,
  readDepartmentLists,
  readDepartmentSelection,
  writeDepartmentList,
  writeDepartmentSelection,
  type DepartmentSelection,
} from '../src/departments.ts'
import type { LocalTermFile, LocalTermList } from '../src/local.ts'

const directories: string[] = []

const NOTHING: DepartmentSelection = { enabled: [], disabled: [] }

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-departments-'))
  directories.push(home)
  return home
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const LIST = [
  'version: 1',
  "revision: '2026-10-28'",
  'categories:',
  '  - id: craft',
  '    label: 工艺',
  '    terms:',
  '      - 结晶温度',
  '',
].join('\n')

function file(name: string, department: string | null = null): LocalTermFile {
  return { name, bytes: 0, revision: '', department, author: null, enabled: true, terms: 0, patterns: 0, problems: [] }
}

function list(name: string, categories: unknown[], department: string | null = null): LocalTermList {
  return {
    file: file(name, department),
    list: { revision: '2026-10-28', problems: [], categories } as unknown as LocalTermList['list'],
  }
}

describe('the department directory', () => {
  it('sits beside the uploaded lists', async () => {
    const home = await makeHome()
    expect(departmentsDirectory(home)).toBe(join(home, 'departments'))
  })
})

describe('readDepartmentSelection and writeDepartmentSelection', () => {
  it('starts empty when the machine never made a choice', async () => {
    const home = await makeHome()
    await expect(readDepartmentSelection(home)).resolves.toEqual(NOTHING)
  })

  it('reads back what it wrote', async () => {
    const home = await makeHome()
    await writeDepartmentSelection(home, { enabled: ['研发部'], disabled: ['财务部'] })
    await expect(readDepartmentSelection(home)).resolves.toEqual({ enabled: ['研发部'], disabled: ['财务部'] })
  })

  it('falls back to the default when the file is not readable JSON', async () => {
    const home = await makeHome()
    await writeFile(join(home, 'departments.json'), '{not json', 'utf8')
    await expect(readDepartmentSelection(home)).resolves.toEqual(NOTHING)
  })
})

describe('departmentApplies', () => {
  it('switches the reader own department on without a tick', () => {
    expect(departmentApplies(NOTHING, '研发部', '研发部')).toBe(true)
  })

  it('leaves another department off until it is ticked', () => {
    expect(departmentApplies(NOTHING, '财务部', '研发部')).toBe(false)
    expect(departmentApplies({ enabled: ['财务部'], disabled: [] }, '财务部', '研发部')).toBe(true)
  })

  it('lets an explicit off win over both the tick and the own department', () => {
    expect(departmentApplies({ enabled: ['财务部'], disabled: ['财务部'] }, '财务部', '研发部')).toBe(false)
    expect(departmentApplies({ enabled: [], disabled: ['研发部'] }, '研发部', '研发部')).toBe(false)
  })

  it('leaves every list off when the caller has no department', () => {
    expect(departmentApplies(NOTHING, '研发部', null)).toBe(false)
  })
})

describe('writeDepartmentList and readDepartmentLists', () => {
  it('writes the file under the department name and reads it back', async () => {
    const home = await makeHome()
    const written = await writeDepartmentList(home, '研发部', LIST)
    expect(written.name).toBe('研发部.yaml')
    expect(written.terms).toBe(1)
    const lists = await readDepartmentLists(home)
    expect(lists.map(entry => entry.file.name)).toEqual(['研发部.yaml'])
    expect(lists[0]?.file.department).toBe('研发部')
    expect(lists[0]?.list.categories[0]?.terms).toEqual(['结晶温度'])
  })

  it('reads an empty directory as no lists at all', async () => {
    const home = await makeHome()
    await expect(readDepartmentLists(home)).resolves.toEqual([])
  })

  it('prefers the department named inside the file', () => {
    expect(departmentNameOf(file('yf.yaml'))).toBe('yf')
    expect(departmentNameOf(file('yf.yaml', '研发部'))).toBe('研发部')
  })

  it('sorts and de-duplicates the names it is given', () => {
    expect(departmentNamesOf(['b.yaml', 'a.yml', 'b.yaml', 'c.txt'])).toEqual(['a', 'b'])
  })
})

describe('describeDepartments', () => {
  it('reports the counts and whether each list applies', () => {
    const lists = [
      list('研发部.yaml', [{ id: 'craft', label: '工艺', terms: ['结晶温度', '混合时间'], patterns: [/a/gu] }]),
      list('财务部.yaml', [{ id: 'finance', label: '财务指标', terms: ['单价'], patterns: [] }]),
    ]

    expect(describeDepartments(lists, NOTHING, '研发部')).toEqual([
      { name: '研发部', enabled: true, own: true, terms: 2, patterns: 1, revision: '2026-10-28' },
      { name: '财务部', enabled: false, own: false, terms: 1, patterns: 0, revision: '2026-10-28' },
    ])
  })
})
