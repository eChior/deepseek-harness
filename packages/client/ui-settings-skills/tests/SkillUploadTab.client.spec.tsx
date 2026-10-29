// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SkillRepoDepartmentView,
  SkillRepoEntryView,
  SkillRepoUploadView,
} from '@deepseek-ai/dsh-api-skill-repo-controller/types'
import { SkillUploadTab } from '../src/client/SkillUploadTab.tsx'
import type { SkillUploadTabInjected, SkillUploadTabProps } from '../src/client/SkillUploadTab.tsx'
import { zh, type SkillUploadLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

/** A skill the repository has never seen. */
const FRESH: SkillRepoEntryView = {
  name: 'improvement-proposal',
  description: '改善提案报告生成',
  version: '0.1.1',
  files: 8,
  bytes: 214_733,
  state: 'new',
  publishedVersion: null,
  department: null,
  uploader: null,
  uploadedAt: null,
  owned: false,
}

/** A skill this colleague already published, still at the same version. */
const PUBLISHED: SkillRepoEntryView = {
  name: 'proposal-scoring',
  description: '改善提案评审打分',
  version: '1.2.0',
  files: 2,
  bytes: 11_980,
  state: 'published',
  publishedVersion: '1.2.0',
  department: '智能与信息化部',
  uploader: '毛子艺',
  uploadedAt: '2026-10-29T02:00:00Z',
  owned: true,
}

/** A skill whose repository copy was published by somebody else. */
const FOREIGN: SkillRepoEntryView = {
  ...PUBLISHED,
  name: 'tsd-reader',
  state: 'behind',
  publishedVersion: '3.1.0',
  uploader: '李四',
  owned: false,
}

/** One department listing row. */
const DEPARTMENT: SkillRepoDepartmentView = {
  name: 'proposal-scoring',
  department: '智能与信息化部',
  version: '1.2.0',
  description: '改善提案评审打分',
  uploader: '毛子艺',
  uploadedAt: '2026-10-29T02:00:00Z',
  files: 3,
}

const UPLOAD: SkillRepoUploadView = {
  name: 'improvement-proposal',
  written: 3,
  unchanged: 5,
  conflicts: [],
  skipped: [],
}

/** Translate a key the way the Settings slot renderer's locale binding does. */
const t = ((key: SkillUploadLocaleKey, params?: Record<string, string | number>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    zh[key],
  )) as SkillUploadTabProps['t']

/** Build the injected face, overriding only the methods a case exercises. */
function face(overrides: Partial<SkillUploadTabInjected> = {}): SkillUploadTabInjected {
  return {
    entries: async () => [],
    departments: async () => [],
    upload: async () => UPLOAD,
    drop: async () => 2,
    ...overrides,
  }
}

/** Build the props the Settings slot renderer would assemble. */
function props(overrides: Partial<SkillUploadTabInjected> = {}): SkillUploadTabProps {
  return { t, ...face(overrides) } as SkillUploadTabProps
}

describe('SkillUploadTab', () => {
  it('shows the version and the repository state beside every local skill', async () => {
    render(<SkillUploadTab {...props({ entries: async () => [FRESH, PUBLISHED, FOREIGN] })} />)
    expect(screen.getByText('读取中…')).toBeTruthy()

    await waitFor(() => { expect(screen.getByText('improvement-proposal')).toBeTruthy() })
    expect(screen.getByText('v0.1.1')).toBeTruthy()
    expect(screen.getByText('未上传')).toBeTruthy()
    expect(screen.getByText('已上传')).toBeTruthy()
    expect(screen.getByText('仓库更新（3.1.0）')).toBeTruthy()
  })

  it('offers upload for a skill the repository does not hold yet', async () => {
    const upload = vi.fn(async () => UPLOAD)
    render(<SkillUploadTab {...props({ entries: async () => [FRESH], upload })} />)
    await waitFor(() => { expect(screen.getByText('上传')).toBeTruthy() })
    fireEvent.click(screen.getByText('上传'))
    await waitFor(() => { expect(upload).toHaveBeenCalledWith('improvement-proposal', 'new') })
    await waitFor(() => { expect(screen.getByText(/已上传 3 个文件/)).toBeTruthy() })
  })

  it('offers update instead of upload once the repository holds the skill', async () => {
    const upload = vi.fn(async () => UPLOAD)
    render(<SkillUploadTab {...props({ entries: async () => [PUBLISHED], upload })} />)
    await waitFor(() => { expect(screen.getByText('更新')).toBeTruthy() })
    expect(screen.queryByText('上传')).toBeNull()
    fireEvent.click(screen.getByText('更新'))
    await waitFor(() => { expect(upload).toHaveBeenCalledWith('proposal-scoring', 'update') })
  })

  it('offers delete only for the copy this colleague published', async () => {
    const drop = vi.fn(async () => 2)
    render(<SkillUploadTab {...props({ entries: async () => [PUBLISHED, FOREIGN], drop })} />)
    await waitFor(() => { expect(screen.getByText('proposal-scoring')).toBeTruthy() })
    // Two rows, one of which belongs to somebody else: exactly one delete button.
    expect(screen.getAllByText('删除')).toHaveLength(1)
    fireEvent.click(screen.getByText('删除'))
    await waitFor(() => { expect(drop).toHaveBeenCalledWith('proposal-scoring') })
    await waitFor(() => { expect(screen.getByText('已删除 2 个文件')).toBeTruthy() })
  })

  it('reports a refused delete without losing the other rows', async () => {
    const drop = vi.fn(async () => { throw new Error('skill-repo: 由李四发布，保留') })
    render(<SkillUploadTab {...props({ entries: async () => [PUBLISHED], drop })} />)
    await waitFor(() => { expect(screen.getByText('删除')).toBeTruthy() })
    fireEvent.click(screen.getByText('删除'))
    await waitFor(() => { expect(screen.getByText(/操作失败：skill-repo: 由李四发布，保留/)).toBeTruthy() })
    expect(screen.getByText('proposal-scoring')).toBeTruthy()
  })

  it('lists what the departments already published, with the uploader', async () => {
    render(<SkillUploadTab {...props({ departments: async () => [DEPARTMENT] })} />)
    await waitFor(() => { expect(screen.getByText('部门里的技能')).toBeTruthy() })
    expect(screen.getByText(/智能与信息化部/)).toBeTruthy()
    expect(screen.getByText(/由 毛子艺 上传/)).toBeTruthy()
  })

  it('says so when no department has published anything', async () => {
    render(<SkillUploadTab {...props({ departments: async () => [] })} />)
    await waitFor(() => { expect(screen.getByText('仓库里还没有部门技能。')).toBeTruthy() })
  })

  it('shows the reading failure when the repository cannot be reached', async () => {
    render(<SkillUploadTab {...props({ entries: async () => { throw new Error('连接失败') } })} />)
    await waitFor(() => { expect(screen.getByText(/读取技能失败：连接失败/)).toBeTruthy() })
  })
})
