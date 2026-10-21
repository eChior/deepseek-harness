// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RedactionEntryView, RedactionStatusView } from '@deepseek-ai/dsh-api-redaction-controller/types'
import { RedactionBadge } from '../src/client/RedactionBadge.tsx'
import type { RedactionBadgeInjected, RedactionBadgeProps } from '../src/client/RedactionBadge.tsx'
import { zh, type RedactionLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const ENTRIES: readonly RedactionEntryView[] = [
  { placeholder: 'ZY', category: 'holder', original: '浙江华润三九众益制药有限公司' },
  { placeholder: '[工艺-1]', category: 'craft', original: '热封温度: 165℃' },
]

const STATUS: RedactionStatusView = {
  enabled: true,
  revision: '2026-10-22',
  terms: 190,
  patterns: 32,
  replacements: 7,
  source: 'bundled',
  lastChecked: null,
  lastError: null,
  detail: null,
  pending: 0,
  localFiles: 0,
  roster: 0,
  imageTool: false,
  mappings: true,
}

/** Translate a key the way the composer slot renderer's locale binding does. */
const t = ((key: RedactionLocaleKey, params?: Record<string, string | number>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    zh[key],
  )) as RedactionBadgeProps['t']

/** Overrides a test needs to vary. */
interface Variants {
  entries?: RedactionBadgeInjected['entries']
  status?: RedactionBadgeInjected['status']
  setUserView?: RedactionBadgeInjected['setUserView']
  userView?: RedactionBadgeInjected['userView']
  setMappings?: RedactionBadgeInjected['setMappings']
  setHighlightColor?: RedactionBadgeInjected['setHighlightColor']
  highlightColor?: string
}

/** Build the props the composer slot renderer would assemble. */
function props(overrides: Variants = {}): RedactionBadgeProps {
  const userView = overrides.userView ?? 'original'
  const highlightColor = overrides.highlightColor ?? '#d92d20'
  return {
    entries: overrides.entries ?? (async () => ENTRIES),
    status: overrides.status ?? (async () => STATUS),
    setUserView: overrides.setUserView ?? (() => {}),
    userView,
    readUserView: () => userView,
    subscribeUserView: () => () => {},
    setMappings: overrides.setMappings ?? (() => {}),
    highlightColor,
    setHighlightColor: overrides.setHighlightColor ?? (() => {}),
    t,
  } as RedactionBadgeProps
}

describe('RedactionBadge', () => {
  it('stays reachable with an empty table, so the view switch is never hidden', async () => {
    const entries = vi.fn(async (): Promise<readonly RedactionEntryView[]> => [])
    render(<RedactionBadge {...props({ entries })} />)
    await waitFor(() => { expect(entries).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: '脱敏状态' }))
    expect(screen.getByText('这段会话还没有需要脱敏的内容。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '占位符' })).toBeTruthy()
  })

  it('carries the running replacement count on the badge itself', async () => {
    render(<RedactionBadge {...props()} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '脱敏状态' }).textContent).toContain('7') })
  })

  it('reports the guard state and the read-image denial in the panel', async () => {
    render(<RedactionBadge {...props()} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '脱敏状态' }).textContent).toContain('7') })
    fireEvent.click(screen.getByRole('button', { name: '脱敏状态' }))
    expect(screen.getByText('脱敏状态')).toBeTruthy()
    expect(screen.getAllByText('脱敏常开').length).toBeGreaterThan(0)
    expect(screen.getAllByText('已开启').length).toBeGreaterThan(0)
    expect(screen.getAllByText('已关闭').length).toBeGreaterThan(0)
    expect(screen.getByText('2026-10-22')).toBeTruthy()
    expect(screen.getByText('190 个词条 · 32 条正则')).toBeTruthy()
  })

  it('lists each placeholder and paints the original in the stored colour', async () => {
    render(<RedactionBadge {...props()} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '脱敏状态' }).textContent).toContain('7') })
    fireEvent.click(screen.getByRole('button', { name: '脱敏状态' }))
    expect(screen.getByText('[工艺-1]')).toBeTruthy()
    const original = screen.getByText('热封温度: 165℃')
    expect(original.style.color).toBe('rgb(217, 45, 32)')
  })

  it('publishes the transcript view choice from the segmented control', async () => {
    const setUserView = vi.fn()
    render(<RedactionBadge {...props({ setUserView })} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '脱敏状态' }).textContent).toContain('7') })
    fireEvent.click(screen.getByRole('button', { name: '脱敏状态' }))
    fireEvent.click(screen.getByRole('button', { name: '占位符' }))
    fireEvent.click(screen.getByRole('button', { name: '原文' }))
    expect(setUserView.mock.calls).toEqual([['placeholder'], ['original']])
  })

  it('publishes the mapping switch', async () => {
    const setMappings = vi.fn()
    render(<RedactionBadge {...props({ setMappings })} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '脱敏状态' }).textContent).toContain('7') })
    fireEvent.click(screen.getByRole('button', { name: '脱敏状态' }))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(setMappings.mock.calls).toEqual([[false]])
  })

  it('publishes a picked colour only once the change is confirmed', async () => {
    const setHighlightColor = vi.fn()
    render(<RedactionBadge {...props({ setHighlightColor })} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '脱敏状态' }).textContent).toContain('7') })
    fireEvent.click(screen.getByRole('button', { name: '脱敏状态' }))
    // The picker fires on every drag frame; nothing reaches the Host until the
    // reader confirms the colour they settled on.
    fireEvent.change(screen.getByLabelText('原文标色'), { target: { value: '#0088ff' } })
    fireEvent.change(screen.getByLabelText('原文标色'), { target: { value: '#00ff88' } })
    expect(setHighlightColor.mock.calls).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    expect(setHighlightColor.mock.calls).toEqual([['#00ff88']])
  })

  it('survives a failing entries call and still shows the switches', async () => {
    const entries = vi.fn(async (): Promise<readonly RedactionEntryView[]> => {
      throw new Error('namespace absent')
    })
    render(<RedactionBadge {...props({ entries })} />)
    await waitFor(() => { expect(entries).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: '脱敏状态' }))
    expect(screen.getByRole('button', { name: '原文' })).toBeTruthy()
    expect(screen.getByRole('checkbox')).toBeTruthy()
  })
})
