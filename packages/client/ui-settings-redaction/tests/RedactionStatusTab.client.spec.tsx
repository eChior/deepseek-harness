// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RedactionRosterView,
  RedactionStatusView,
  RedactionUploadView,
} from '@deepseek-ai/dsh-api-redaction-controller/types'
import { RedactionStatusTab } from '../src/client/RedactionStatusTab.tsx'
import type { RedactionStatusTabInjected, RedactionStatusTabProps } from '../src/client/RedactionStatusTab.tsx'
import { zh, type RedactionLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const READY: RedactionStatusView = {
  enabled: true,
  revision: '2026-10-16',
  terms: 56,
  patterns: 38,
  replacements: 7,
  source: 'bundled',
  lastChecked: '2026-10-16T04:00:00.000Z',
  lastError: null,
  detail: null,
  pending: 0,
  localFiles: 0,
  roster: 0,
}

const ROSTER: RedactionRosterView = {
  enabled: true,
  revision: '2026-10-17',
  people: 227,
  departments: 16,
  account: '毛子艺',
  department: '智能与信息化部',
  employeeId: '21614226',
}

const UPLOAD: RedactionUploadView = {
  name: 'qc.yaml',
  bytes: 420,
  revision: '2026-10-17-qc',
  department: '质量管理部',
  author: '毛子艺',
  enabled: true,
  terms: 3,
  patterns: 1,
  problems: [],
}

/** Translate a key the way the Settings slot renderer's locale binding does. */
const t = ((key: RedactionLocaleKey, params?: Record<string, string | number>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    zh[key],
  )) as RedactionStatusTabProps['t']

/** Build the injected face, overriding only the methods a case exercises. */
function face(overrides: Partial<RedactionStatusTabInjected> = {}): RedactionStatusTabInjected {
  return {
    status: async () => READY,
    roster: async () => ROSTER,
    uploads: async () => [],
    upload: async () => UPLOAD,
    drop: async () => true,
    setEnabled: async () => UPLOAD,
    example: async () => ({ name: 'terms-local.example.yaml', text: 'version: 1\n' }),
    ...overrides,
  }
}

/** Build the props the Settings slot renderer would assemble. */
function props(read: () => Promise<RedactionStatusView>, rest: Partial<RedactionStatusTabInjected> = {}): RedactionStatusTabProps {
  return { t, ...face({ ...rest, status: read }) } as RedactionStatusTabProps
}

describe('RedactionStatusTab', () => {
  it('renders every reported row once the status arrives', async () => {
    const read = vi.fn(async () => READY)
    render(<RedactionStatusTab {...props(read)} />)
    expect(screen.getByText('正在读取脱敏状态…')).toBeTruthy()

    await waitFor(() => { expect(screen.getByText('2026-10-16')).toBeTruthy() })
    expect(read).toHaveBeenCalledOnce()
    expect(screen.getByText('随客户端分发')).toBeTruthy()
    expect(screen.getByText('56 个词条 · 38 条正则')).toBeTruthy()
    expect(screen.getByText('7')).toBeTruthy()
    expect(screen.getByText('脱敏常开')).toBeTruthy()
    expect(screen.queryByText('这些词条在本机排队，等待交付通道。')).toBeNull()
    expect(screen.queryByText(/词表未加载/)).toBeNull()
  })

  it('falls back to the never label for an unchecked publisher and reads the local cache source', async () => {
    const read = vi.fn(async (): Promise<RedactionStatusView> => ({ ...READY, source: 'cache', lastChecked: null, pending: 3 }))
    render(<RedactionStatusTab {...props(read)} />)

    await waitFor(() => { expect(screen.getByText('本机缓存')).toBeTruthy() })
    expect(screen.getAllByText('从未')).toHaveLength(1)
    expect(screen.getByText('这些词条在本机排队，等待交付通道。')).toBeTruthy()
  })

  it('names a blocked term list and a refresh that kept the loaded rules', async () => {
    const read = vi.fn(async () => ({
      ...READY,
      terms: 0,
      patterns: 0,
      detail: 'the term list did not parse',
      lastError: 'connect ETIMEDOUT',
    }))
    render(<RedactionStatusTab {...props(read)} />)

    await waitFor(() => {
      expect(screen.getByText('词表未加载，暂时不会替换任何内容：the term list did not parse')).toBeTruthy()
    })
    expect(screen.getByText(/上次刷新未采用: connect ETIMEDOUT/)).toBeTruthy()
  })

  it('reports a refused read and recovers on retry', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('redaction.status failed: REMOTE_SHUTDOWN: unavailable'))
      .mockResolvedValueOnce(READY)
    render(<RedactionStatusTab {...props(read)} />)

    await waitFor(() => { expect(screen.getByText('暂时无法读取脱敏状态。')).toBeTruthy() })
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => { expect(screen.getByText('2026-10-16')).toBeTruthy() })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('discards a response that arrives after unmount', async () => {
    let settle: ((view: RedactionStatusView) => void) | undefined
    const read = vi.fn(() => new Promise<RedactionStatusView>((resolve) => { settle = resolve }))
    const view = render(<RedactionStatusTab {...props(read)} />)
    view.unmount()

    settle!(READY)
    await Promise.resolve()
    expect(read).toHaveBeenCalledOnce()
  })

  it('lists an uploaded list with its attribution and counts', async () => {
    render(<RedactionStatusTab {...props(async () => READY, { uploads: async () => [UPLOAD] })} />)

    await waitFor(() => { expect(screen.getByText('qc.yaml')).toBeTruthy() })
    expect(screen.getByText('质量管理部 · 毛子艺 · 3 个词条 · 1 条正则')).toBeTruthy()
    expect(screen.getByText('已把公司人员与部门名称加入脱敏（227 人 · 16 个部门）')).toBeTruthy()
  })

  it('refuses a file over the ceiling without calling the Host', async () => {
    const upload = vi.fn(async () => UPLOAD)
    render(<RedactionStatusTab {...props(async () => READY, { upload })} />)

    await waitFor(() => { expect(screen.getByText('还没有上传过词表。')).toBeTruthy() })
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement
    const big = new File(['x'.repeat(300 * 1024)], 'big.yaml', { type: 'text/yaml' })
    fireEvent.change(picker, { target: { files: [big] } })

    expect(upload).not.toHaveBeenCalled()
    await waitFor(() => { expect(screen.getByText(/上传失败：文件超过 256 KB/)).toBeTruthy() })
  })

  it('drops a list and reloads what remains', async () => {
    const drop = vi.fn(async () => true)
    const uploads = vi.fn()
      .mockResolvedValueOnce([UPLOAD])
      .mockResolvedValue([])
    render(<RedactionStatusTab {...props(async () => READY, { uploads, drop })} />)

    await waitFor(() => { expect(screen.getByText('qc.yaml')).toBeTruthy() })
    fireEvent.click(screen.getByText('删除'))

    await waitFor(() => { expect(drop).toHaveBeenCalledWith({ name: 'qc.yaml' }) })
    await waitFor(() => { expect(screen.queryByText('qc.yaml')).toBeNull() })
  })

  it('surfaces a refusal from an upload as a banner', async () => {
    const upload = vi.fn(async () => { throw new Error('redaction.upload failed: BAD_REQUEST: nope') })
    render(<RedactionStatusTab {...props(async () => READY, { upload })} />)

    await waitFor(() => { expect(screen.getByText('还没有上传过词表。')).toBeTruthy() })
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['version: 1'], 'qc.yaml', { type: 'text/yaml' })
    fireEvent.change(picker, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByText(/上传失败：redaction\.upload failed: BAD_REQUEST: nope/)).toBeTruthy()
    })
  })
})
