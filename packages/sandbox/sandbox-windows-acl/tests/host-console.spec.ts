/**
 * Host-console allocation: the console the runner acquires at import so a
 * restricted child inherits one instead of building one under its restricted
 * token. Stub binding tables only — no real Win32 calls in the seam tests — so
 * they run on every platform; the last case observes the real import-time
 * allocation (`hostConsole.owned`), which is the real-FFI evidence for this
 * module on Windows and the platform-gate evidence everywhere else.
 */

import { describe, expect, it, vi } from 'vitest'

import type { NativePtr } from '@deepseek-ai/dsh-win32-process'
import { ensureHostConsole, hostConsole } from '../src/host-console.ts'
import type { HostConsoleBindings } from '../src/host-console.ts'

/** A non-null console window handle; cases that need NULL override it. */
const WINDOW = 0x1234n as NativePtr

/** Stub console bindings plus their mocks, for order and call-count checks. */
function stubBindings(overrides: Partial<HostConsoleBindings> = {}): { api: HostConsoleBindings; showWindow: ReturnType<typeof vi.fn> } {
  const showWindow = vi.fn(() => 1)
  const api: HostConsoleBindings = {
    freeConsole: vi.fn(() => 1),
    allocConsole: vi.fn(() => 1),
    getConsoleWindow: vi.fn(() => WINDOW),
    showWindow,
    ...overrides,
  }
  return { api, showWindow }
}

describe('ensureHostConsole', () => {
  it('does nothing off Windows and loads no bindings', () => {
    const load = vi.fn(() => stubBindings().api)
    expect(ensureHostConsole({ platform: 'linux', load })).toBe(false)
    expect(load).not.toHaveBeenCalled()
  })

  it('defaults to the current platform', () => {
    expect(ensureHostConsole()).toBe(process.platform === 'win32')
  })

  it('frees any inherited console, allocates, then hides the window', () => {
    const calls: string[] = []
    const showWindow = vi.fn(() => {
      calls.push('ShowWindow')
      return 1
    })
    const { api } = stubBindings({
      freeConsole: vi.fn(() => {
        calls.push('FreeConsole')
        return 1
      }),
      allocConsole: vi.fn(() => {
        calls.push('AllocConsole')
        return 1
      }),
      getConsoleWindow: vi.fn(() => {
        calls.push('GetConsoleWindow')
        return WINDOW
      }),
      showWindow,
    })
    expect(ensureHostConsole({ platform: 'win32', load: () => api })).toBe(true)
    expect(calls).toEqual(['FreeConsole', 'AllocConsole', 'GetConsoleWindow', 'ShowWindow'])
    expect(showWindow).toHaveBeenCalledWith(WINDOW, 0)
  })

  it('skips hiding when the allocated console has no window', () => {
    const { api, showWindow } = stubBindings({ getConsoleWindow: vi.fn(() => null) })
    expect(ensureHostConsole({ platform: 'win32', load: () => api })).toBe(true)
    expect(showWindow).not.toHaveBeenCalled()
  })

  it('returns false without throwing when AllocConsole fails', () => {
    const { api, showWindow } = stubBindings({ allocConsole: vi.fn(() => 0) })
    const allocate = () => ensureHostConsole({ platform: 'win32', load: () => api })
    expect(allocate).not.toThrow()
    expect(allocate()).toBe(false)
    expect(showWindow).not.toHaveBeenCalled()
  })

  it('returns false without throwing when the bindings cannot be loaded', () => {
    const load = vi.fn(() => {
      throw new Error('koffi unavailable')
    })
    const allocate = () => ensureHostConsole({ platform: 'win32', load })
    expect(allocate).not.toThrow()
    expect(allocate()).toBe(false)
  })

  it('returns false without throwing when a console call itself throws', () => {
    const { api } = stubBindings({
      freeConsole: vi.fn(() => {
        throw new Error('FreeConsole raised')
      }),
    })
    const allocate = () => ensureHostConsole({ platform: 'win32', load: () => api })
    expect(allocate).not.toThrow()
    expect(allocate()).toBe(false)
  })
})

describe('hostConsole', () => {
  it('records the import-time allocation for the runner', () => {
    expect(hostConsole.platform).toBe(process.platform)
    // The import above really ran the allocation: a Windows process owns a
    // console afterwards (a fresh, hidden one), and off Windows the platform
    // gate must leave the process untouched.
    expect(hostConsole.owned).toBe(process.platform === 'win32')
  })
})
