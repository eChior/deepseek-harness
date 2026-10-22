// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../src/client/contract/slots.ts'
import type { AssistantBlock } from '../src/client/contract/snapshot.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const t = ((_key: string) => 'label') as ChatViewSlotProps['t']
const renderMessageImages = (() => null) as ChatNodeOwnerProps['renderMessageImages']
const COLOR = '#123456'
const PLACEHOLDERS = new Map([
  ['[产品-1]', '红霉素肠溶胶囊'],
  ['[工艺-1]', '热封温度'],
])

interface ViewHooks {
  useUserPlaceholders: SnapshotSelectorHook<ReadonlyMap<string, string> | null>
  useRedactionHighlight: SnapshotSelectorHook<string>
}

/** Stand-in for one slot-injected hook: a store that never changes. */
function fixedHook<T>(value: T): SnapshotSelectorHook<T> {
  return <S,>(select: (snapshot: T) => S): S => select(value)
}

/** Stand-in for the slot-injected hooks: a fixed table and the chosen colour. */
function hooksOf(map: ReadonlyMap<string, string> | null): ViewHooks {
  return {
    useUserPlaceholders: fixedHook(map),
    useRedactionHighlight: fixedHook(COLOR),
  }
}

function prose(text: string, streaming = false, hooks?: ViewHooks) {
  const blocks: AssistantBlock[] = [{ kind: 'text', text }]
  return render(
    <AssistantMarkdown
      useDisclosure={useDisclosure}
      usePresentation={useDetailedPresentation}
      blocks={blocks}
      streaming={streaming}
      renderMessageImages={renderMessageImages}
      t={t}
      {...hooks}
    />,
  )
}

function painted(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('span[style]')]
    .filter(node => (node as HTMLElement).style.color !== '')
    .map(node => node.textContent)
}

describe('AssistantMarkdown redaction view', () => {
  it('restores every placeholder in the answer for a reader who shows originals', () => {
    const { container } = prose('处方：[产品-1]，工艺：[工艺-1]。', false, hooksOf(PLACEHOLDERS))
    expect(container.textContent).toBe('处方：红霉素肠溶胶囊，工艺：热封温度。')
    expect(painted(container)).toEqual(['红霉素肠溶胶囊', '热封温度'])
  })

  it('paints the restored value in the colour the reader picked', () => {
    const { container } = prose('[产品-1]', false, hooksOf(PLACEHOLDERS))
    const hit = [...container.querySelectorAll('span[style]')]
      .find(node => (node as HTMLElement).style.color !== '') as HTMLElement
    expect(hit.style.color).toBe('rgb(18, 52, 86)')
  })

  it('keeps the placeholder when the reader chose to read placeholders', () => {
    const { container } = prose('[产品-1] 与 [工艺-1]', false, hooksOf(new Map()))
    expect(container.textContent).toBe('[产品-1] 与 [工艺-1]')
    expect(painted(container)).toEqual([])
  })

  it('keeps the placeholder until a provider answers', () => {
    const { container } = prose('[产品-1]', false, hooksOf(null))
    expect(container.textContent).toBe('[产品-1]')
    expect(painted(container)).toEqual([])
  })

  it('restores a placeholder inside a still-streaming answer', () => {
    const { container } = prose('正在写入 [工艺-1]', true, hooksOf(PLACEHOLDERS))
    expect(container.textContent).toContain('正在写入 热封温度')
    expect(painted(container)).toEqual(['热封温度'])
  })

  it('leaves the answers of a deployment without a provider untouched', () => {
    const { container } = prose('[产品-1]', false)
    expect(container.textContent).toBe('[产品-1]')
    expect(painted(container)).toEqual([])
  })

  it('restores a placeholder in an opened reasoning block', () => {
    const blocks: AssistantBlock[] = [{ kind: 'reasoning', text: '先确认 [产品-1] 的处方。' }]
    const { container } = render(
      <AssistantMarkdown
        useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        blocks={blocks}
        streaming={false}
        renderMessageImages={renderMessageImages}
        t={t}
        {...hooksOf(PLACEHOLDERS)}
      />,
    )
    const toggle = container.querySelector('[role="button"]')
    expect(toggle).not.toBeNull()
    fireEvent.click(toggle!)
    expect(container.textContent).toContain('先确认 红霉素肠溶胶囊 的处方。')
  })
})
