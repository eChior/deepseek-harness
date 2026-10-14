/**
 * Wire shape of the RWork identity gateway.
 *
 * Only the two endpoints this provider needs are modelled: the browser page a
 * human signs in on, and the JSON endpoint that reports who that session
 * belongs to. Every other RWork surface stays out of the harness.
 *
 * @module @deepseek-ai/dsh-hrzszy-account/protocol
 */

import type { RworkUser } from './types.ts'

/** Origin serving the identity JSON endpoints. */
export const RWORK_DEFAULT_API_ORIGIN = 'https://app.rwork.crc.com.cn'
/** Origin serving the browser sign-in page; a different host from {@link RWORK_DEFAULT_API_ORIGIN}. */
export const RWORK_DEFAULT_LOGIN_ORIGIN = 'https://accounts.rwork.crc.com.cn'
/** Deployment application id required by every identity request. */
export const RWORK_DEFAULT_APP_ID = '2'

/** Identity read failed, or the deployment answered with an unfamiliar shape. */
export class RworkProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RworkProtocolError'
  }
}

/**
 * Build the page a human signs in on. The desktop shell loads exactly this URL
 * in its own window, so the deployment sees an ordinary browser login.
 * @param loginOrigin - origin serving the sign-in page.
 * @param appId - deployment application id.
 * @returns the sign-in page URL.
 */
export function rworkLoginUrl(loginOrigin: string, appId: string): string {
  const url = new URL('/accounts/page/login', loginOrigin)
  url.searchParams.set('app_id', appId)
  url.searchParams.set('no_trap', '1')
  url.searchParams.set('query_scope', 'all')
  url.searchParams.set('redirect_uri', `${loginOrigin}/drive/home/`)
  return url.href
}

/**
 * Build the endpoint reporting the employee behind a session cookie.
 * @param apiOrigin - origin serving identity JSON.
 * @param appId - deployment application id.
 * @returns the identity endpoint URL.
 */
export function rworkIdentityUrl(apiOrigin: string, appId: string): string {
  const url = new URL('/accounts/web/user', apiOrigin)
  url.searchParams.set('app_id', appId)
  return url.href
}

/**
 * Request headers every identity call carries. `x-device-info` is required but
 * its content is not inspected by the deployment, so a stable literal keeps
 * requests reproducible.
 * @param appId - deployment application id.
 * @returns headers for one identity request.
 */
export function rworkIdentityHeaders(appId: string): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    'x-app-id': appId,
    'x-api-version': '1',
    'x-device-info': '{"device_id":"dsh-desktop"}',
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function readText(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read the employee identity out of one `/accounts/web/user` response.
 * @param payload - decoded JSON body.
 * @returns the reported employee.
 * @throws RworkProtocolError when the deployment reports a business error or an unfamiliar shape.
 */
export function parseRworkUser(payload: unknown): RworkUser {
  const body = asRecord(payload)
  if (body === undefined) throw new RworkProtocolError('rwork: identity response was not an object')
  const code = body.code
  if (typeof code !== 'number' || code !== 0) {
    const message = readText(body, 'message') ?? readText(body, 'msg') ?? 'unknown error'
    throw new RworkProtocolError(`rwork: identity request rejected (code ${String(code)}): ${message}`)
  }
  const data = asRecord(body.data)
  const user = data === undefined ? undefined : asRecord(data.user)
  if (user === undefined) throw new RworkProtocolError('rwork: identity response carried no user')
  const id = readText(user, 'id')
  const name = readText(user, 'display_name') ?? readText(user, 'name')
  if (id === undefined || name === undefined) throw new RworkProtocolError('rwork: identity response omitted the employee id or name')
  const tenant = asRecord(user.tenant)
  const avatarUrl = readText(user, 'avatar_url')
  return {
    id,
    name,
    ...avatarUrl === undefined ? {} : { avatarUrl },
    tenant: tenant === undefined ? '' : readText(tenant, 'name') ?? '',
  }
}
