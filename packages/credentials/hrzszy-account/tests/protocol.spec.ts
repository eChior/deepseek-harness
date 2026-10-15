import { describe, expect, it } from 'vitest'
import {
  parseRworkUser,
  rworkIdentityHeaders,
  rworkIdentityUrl,
  rworkLoginUrl,
  RworkProtocolError,
} from '../src/protocol.ts'

describe('rworkLoginUrl', () => {
  it('carries the parameters the deployment expects on its sign-in page', () => {
    const url = new URL(rworkLoginUrl('https://accounts.example.com', '7', 'https://app.example.com'))
    expect(url.pathname).toBe('/accounts/page/login')
    expect(url.searchParams.get('app_id')).toBe('7')
    expect(url.searchParams.get('no_trap')).toBe('1')
    expect(url.searchParams.get('query_scope')).toBe('all')
    // The workspace origin, not the sign-in origin: the latter answers 404 for this path.
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/drive/home/')
  })
})

describe('rworkIdentityUrl', () => {
  it('targets the identity endpoint with the application id', () => {
    const url = new URL(rworkIdentityUrl('https://app.example.com', '7'))
    expect(url.pathname).toBe('/accounts/web/user')
    expect(url.searchParams.get('app_id')).toBe('7')
  })
})

describe('rworkIdentityHeaders', () => {
  it('sends the three headers the deployment demands', () => {
    const headers = rworkIdentityHeaders('7')
    expect(headers['x-app-id']).toBe('7')
    expect(headers['x-api-version']).toBe('1')
    expect(headers['x-device-info']?.length).toBeGreaterThan(0)
  })
})

describe('parseRworkUser', () => {
  const envelope = (user: unknown, extra: Record<string, unknown> = {}): unknown => ({
    code: 0,
    message: 'ok',
    data: { user },
    ...extra,
  })

  it('reads id, display name, avatar and tenant', () => {
    const user = parseRworkUser(envelope({
      id: '7403122327115792512',
      name: 'Mao Ziyi',
      display_name: 'Mao Ziyi',
      avatar_url: 'https://files.example.com/avatar.png',
      tenant: { name: 'Tenant' },
    }))
    expect(user).toEqual({
      id: '7403122327115792512',
      name: 'Mao Ziyi',
      avatarUrl: 'https://files.example.com/avatar.png',
      tenant: 'Tenant',
    })
  })

  it('falls back to name when display_name is absent, and tolerates a missing avatar', () => {
    const user = parseRworkUser(envelope({ id: 'u-1', name: 'Fallback' }))
    expect(user).toEqual({ id: 'u-1', name: 'Fallback', tenant: '' })
  })

  it('treats an empty avatar and a non-object tenant as absent', () => {
    const user = parseRworkUser(envelope({ id: 'u-2', name: 'Quiet', avatar_url: '', tenant: 'Tenant' }))
    expect(user).toEqual({ id: 'u-2', name: 'Quiet', tenant: '' })
  })

  it('treats a tenant without a name as absent', () => {
    const user = parseRworkUser(envelope({ id: 'u-9', name: 'No Tenant Name', tenant: { id: 't-1' } }))
    expect(user).toEqual({ id: 'u-9', name: 'No Tenant Name', tenant: '' })
  })

  it('rejects a body that is not an object', () => {
    expect(() => parseRworkUser('nope')).toThrow(RworkProtocolError)
  })

  it('rejects a business error and reports its message', () => {
    expect(() => parseRworkUser({ code: 4401, message: 'invalid' })).toThrow(/code 4401.*invalid/u)
  })

  it('falls back to msg and then to a generic description', () => {
    expect(() => parseRworkUser({ code: 42, msg: 'from msg' })).toThrow(/from msg/u)
    expect(() => parseRworkUser({ code: 42 })).toThrow(/unknown error/u)
    expect(() => parseRworkUser({ code: 'zero' })).toThrow(/code zero/u)
  })

  it('rejects a response without a user object', () => {
    expect(() => parseRworkUser({ code: 0 })).toThrow(/carried no user/u)
    expect(() => parseRworkUser({ code: 0, data: null })).toThrow(/carried no user/u)
  })

  it('rejects a user without an id or a name', () => {
    expect(() => parseRworkUser(envelope({ name: 'No Id' }))).toThrow(/id or name/u)
    expect(() => parseRworkUser(envelope({ id: 'u-3' }))).toThrow(/id or name/u)
  })
})
