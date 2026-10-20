// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RedactionEntryView } from '@deepseek-ai/dsh-api-redaction-controller/types'
import { RedactionBadge } from '../src/client/RedactionBadge.tsx'
import type { RedactionBadgeInjected, RedactionBadgeProps } from '../src/client/RedactionBadge.tsx'
import { zh, type RedactionLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const ENTRIES: readonly RedactionEntryView[] = [
  { placeholder: 'ZY', category: 'holder', original: '浙江华润三九众益制药有限公司' },
  { placeholder: '[工艺-1]', category: 'craft', original: '热封温度: 165℃' },
]

/** Translate a key the way the composer slot renderer's locale binding does. */
const t = ((key: RedactionLocaleKey, params?: Record<string, string | number>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    zh[key],
  )) as RedactionBadgeProps['t']

/** Build the props the composer slot renderer would assemble. */
function props(entries: RedactionBadgeInjected['entries'], setUserView: RedactionBadgeInjected['setUserView'] = () => {}): RedactionBadgeProps {
  return { entries, setUserView, t } as RedactionBadgeProps
}

describe('RedactionBadge', () => {
  it('renders nothing while no placeholder has been issued', () => {
    const { container } = render(<RedactionBadge {...props(async () => [])} />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('lists each placeholder and its value once the entries call answers', async () => {
    render(<RedactionBadge {...props(async () => ENTRIES)} />)
    await waitFor(() => { expect(screen.getByText('2')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '脱敏占位符' }))
    expect(screen.getByText('浙江华润三九众益制药有限公司')).toBeTruthy()
    expect(screen.getByText('[工艺-1]')).toBeTruthy()
    expect(screen.getByText('热封温度: 165℃')).toBeTruthy()
  })

  it('publishes the user view choice from the panel buttons', async () => {
    const setUserView = vi.fn()
    render(<RedactionBadge {...props(async () => ENTRIES, setUserView)} />)
    await waitFor(() => { expect(screen.getByText('2')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '脱敏占位符' }))
    fireEvent.click(screen.getByRole('button', { name: '会话里显示占位符' }))
    fireEvent.click(screen.getByRole('button', { name: '会话里显示原文' }))
    expect(setUserView.mock.calls).toEqual([['placeholder'], ['original']])
  })

  it('survives a failing entries call without rendering the badge', async () => {
    const entries = vi.fn(async (): Promise<readonly RedactionEntryView[]> => {
      throw new Error('namespace absent')
    })
    const { container } = render(<RedactionBadge {...props(entries)} />)
    await waitFor(() => { expect(entries).toHaveBeenCalledOnce() })
    expect(container.querySelector('button')).toBeNull()
  })
})
