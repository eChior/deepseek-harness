// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import type { RedactionStatusView } from '@deepseek-ai/dsh-api-redaction-controller/types'
import { RedactionStatusTab } from '../src/client/RedactionStatusTab.tsx'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const VIEW = {
  enabled: true,
  revision: '2026-10-16',
  terms: 56,
  patterns: 38,
  replacements: 7,
  source: 'bundled',
  lastChecked: null,
  lastError: null,
  detail: null,
  pending: 2,
} as const

type StatusResult =
  | { readonly ok: true; readonly value: typeof VIEW }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const status = vi.fn<() => Promise<StatusResult>>().mockResolvedValue({ ok: true, value: VIEW })
  ctx.provide('remote.redaction', { status })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, status }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-redaction browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services the Settings contribution reads', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.redaction'])
  })

  it('registers a localized tab without reading the Remote eagerly', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(RedactionStatusTab)
    expect(entry.options).toMatchObject({ id: 'redaction', order: 20 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('脱敏状态')
    expect(b.status).not.toHaveBeenCalled()

    const injectFace = entry.inject
    expect(typeof injectFace).toBe('function')
    const injected = (injectFace as () => Record<string, unknown>)()
    const status = injected.status as () => Promise<RedactionStatusView>
    await expect(status()).resolves.toEqual(VIEW)
    expect(b.status).toHaveBeenCalledOnce()

    b.status.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_SHUTDOWN', message: 'unavailable' } })
    await expect(status()).rejects.toThrow('redaction.status failed: REMOTE_SHUTDOWN: unavailable')

    b.locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('Redaction status')
    await b.ctx.fiber.dispose()
  })

  it('follows locale and recovers across late declaration and declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]!.options.label)).toBe('Redaction status')

    stop()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('settings.plugins.tab')[0]?.component).toBe(RedactionStatusTab)
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
