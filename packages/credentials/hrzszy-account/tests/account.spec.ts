import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import Account, { Config } from '../src/index.ts'
import { RworkProtocolError } from '../src/protocol.ts'
import type { AccountBonusOrderId, AccountClientMetadata, AccountUserId, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account'

const KEY = credentialKey('hrzszy-account', 'default')
const CLIENT: AccountClientMetadata = { version: '1.0.0', locale: 'zh', timezoneOffsetSeconds: 28_800 }

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** The identity body the fake gateway returns; tests mutate it between calls. */
interface GatewayState {
  status: number
  body: unknown
  requests: Array<{ url: string | undefined; headers: IncomingMessage['headers'] }>
}

/**
 * Start a fake RWork deployment and mount the provider against it.
 * @param options - per-test overrides for the provider and the gateway answers.
 * @returns the context, the provider, and the gateway state.
 */
async function fixture(options: {
  config?: Record<string, unknown>
  body?: unknown
  status?: number
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-hrzszy-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const state: GatewayState = {
    status: options.status ?? 200,
    body: options.body ?? { code: 0, message: 'ok', data: { user: { id: 'u-1', name: 'Signed In', display_name: 'Signed In', tenant: { name: 'Tenant' } } } },
    requests: [],
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    state.requests.push({ url: req.url, headers: req.headers })
    res.writeHead(state.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(state.body))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(() => new Promise((resolve) => { server.close(() => { resolve(undefined) }) }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  const apiOrigin = `http://127.0.0.1:${String(address.port)}`

  const ctx = new Context()
  const credentials = await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  cleanups.push(() => credentials.dispose())
  const fiber = await ctx.plugin(Account, { apiOrigin, loginOrigin: 'https://login.example.com', appId: '2', ...options.config })
  cleanups.push(() => fiber.dispose())
  return { ctx, state, apiOrigin, account: ctx.deepseekAccount as Account }
}

/** Store one arbitrary grant payload so the read path can be exercised in isolation. */
async function storeGrant(ctx: Context, payload: unknown): Promise<void> {
  await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload }))
}

describe('Config', () => {
  it('defaults to the deployment endpoints and deadlines', () => {
    const config = new Config({})
    expect(config.apiOrigin).toBe('https://app.rwork.crc.com.cn')
    expect(config.loginOrigin).toBe('https://accounts.rwork.crc.com.cn')
    expect(config.appId).toBe('2')
    expect(config.requestTimeoutMs).toBe(15_000)
    expect(config.attemptTimeoutMs).toBe(600_000)
  })
})

describe('RworkAccount', () => {
  it('reports signed-out until a grant is stored', async () => {
    const { ctx, account } = await fixture()
    expect((await account.getState()).status).toBe('signed-out')
    await storeGrant(ctx, { cookie: 'dsh-auth=x', user: { id: 'u-1', name: 'Signed In', tenant: 'Tenant' } })
    expect((await account.getState()).status).toBe('credential-stored')
  })

  it('normalises configured origins and keeps its own app id', async () => {
    const gateway = await fixture()
    const { account } = await fixture({ config: { apiOrigin: `${gateway.apiOrigin}/prefix`, appId: '9' } })
    await account.acceptExternalSession({ provider: 'rwork', cookie: 'x=1' })
    expect(gateway.state.requests[0]?.url).toBe('/accounts/web/user?app_id=9')
  })

  it('returns no profile or balance before a grant exists', async () => {
    const { account } = await fixture()
    expect(await account.getProfile(CLIENT)).toBeNull()
    expect(await account.getBalance(CLIENT)).toBeNull()
    expect(await account.getUnnotifiedBonuses(CLIENT)).toBeNull()
    expect(await account.ackBonusNotified('u-1' as AccountUserId, 'o-1' as AccountBonusOrderId, CLIENT)).toBe(false)
  })

  it('reports the stored identity, with and without an avatar', async () => {
    const { ctx, account } = await fixture()
    await storeGrant(ctx, { cookie: 'dsh-auth=x', user: { id: 'u-1', name: 'Signed In', avatarUrl: 'https://files.example.com/a.png', tenant: 'Tenant' } })
    expect(await account.getProfile(CLIENT)).toEqual({
      status: 'ready',
      value: { id: 'u-1', name: 'Signed In', contact: null, avatarUrl: 'https://files.example.com/a.png' },
    })
    await storeGrant(ctx, { cookie: 'dsh-auth=x', user: { id: 'u-2', name: 'Plain', tenant: 'Tenant' } })
    expect(await account.getProfile(CLIENT)).toEqual({ status: 'ready', value: { id: 'u-2', name: 'Plain', contact: null } })
    expect(await account.getBalance(CLIENT)).toEqual({ status: 'ready', value: [], bonusWallets: [] })
    expect(await account.getUnnotifiedBonuses(CLIENT)).toBeNull()
  })

  it('falls back to the built-in deployment defaults', async () => {
    const ctx = new Context()
    const credentials = await ctx.plugin(LocalCredentialProvider, { path: join(await mkdtemp(join(tmpdir(), 'dsh-hrzszy-')), 'credentials.yaml'), watch: false })
    cleanups.push(() => credentials.dispose())
    const fiber = await ctx.plugin(Account, {})
    cleanups.push(() => fiber.dispose())
    const account = ctx.deepseekAccount as Account
    expect((await account.getState()).status).toBe('signed-out')
    expect(await account.getProfile(CLIENT)).toBeNull()
  })

  it('rejects a stored record that is not a grant, and a grant without an identity', async () => {
    const { ctx, account } = await fixture()
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', key: 'sk-x' }))
    await expect(account.getProfile(CLIENT)).rejects.toThrow(RworkProtocolError)
    await storeGrant(ctx, { cookie: '', user: { id: 'u-1', name: 'x' } })
    expect(await account.getProfile(CLIENT)).toBeNull()
    await storeGrant(ctx, 'not-an-object')
    expect(await account.getProfile(CLIENT)).toBeNull()
  })

  it('opens one sign-in attempt and reuses it until it expires', async () => {
    const { account } = await fixture()
    const first = await account.startSignIn(CLIENT, 'https://app.local/', 'desktop')
    expect(first.attempt?.phase).toBe('waiting-browser')
    expect(new URL(first.attempt?.authorizeUrl ?? '').host).toBe('login.example.com')
    const second = await account.startSignIn(CLIENT, 'https://app.local/', 'desktop')
    expect(second.attempt?.id).toBe(first.attempt?.id)
  })

  it('opens a fresh attempt once the previous one expired', async () => {
    const { account } = await fixture({ config: { attemptTimeoutMs: 0 } })
    const first = await account.startSignIn(CLIENT, 'https://app.local/', 'web')
    const second = await account.startSignIn(CLIENT, 'https://app.local/', 'web')
    expect(second.attempt?.id).not.toBe(first.attempt?.id)
  })

  it('cancels only the attempt whose id matches', async () => {
    const { account } = await fixture()
    const opened = await account.startSignIn(CLIENT, 'https://app.local/', 'web')
    await account.cancelSignIn('someone-else' as SignInAttemptId)
    expect((await account.getState()).attempt?.phase).toBe('waiting-browser')
    await account.cancelSignIn(opened.attempt?.id as SignInAttemptId)
    expect((await account.getState()).attempt?.phase).toBe('cancelled')
  })

  it('accepts a captured session, reads the identity, and stores it', async () => {
    const { ctx, account, state } = await fixture()
    await account.startSignIn(CLIENT, 'https://app.local/', 'desktop')
    const next = await account.acceptExternalSession({ provider: 'rwork', cookie: 'dsh-auth=captured' })
    expect(next.status).toBe('credential-stored')
    expect(next.attempt?.phase).toBe('succeeded')
    expect(await account.getProfile(CLIENT)).toMatchObject({ value: { id: 'u-1', name: 'Signed In' } })
    expect(state.requests[0]?.headers['x-app-id']).toBe('2')
    expect(state.requests[0]?.headers['x-api-version']).toBe('1')
    expect(state.requests[0]?.headers.cookie).toBe('dsh-auth=captured')
    expect(await ctx.credentials.readRecord(KEY)).toMatchObject({ kind: 'grant' })
  })

  it('rejects a session that carries no cookie or an unknown provider', async () => {
    const { account } = await fixture()
    for (const session of [undefined, null, 'text', {}, { provider: 'rwork', cookie: '' }]) {
      await expect(account.acceptExternalSession(session)).rejects.toThrow(/carried no cookie/u)
    }
    await expect(account.acceptExternalSession({ provider: 'other', cookie: 'x=1' })).rejects.toThrow(/not supported/u)
  })

  it('surfaces gateway failures instead of storing a broken grant', async () => {
    const { account, state } = await fixture()
    state.status = 500
    await expect(account.acceptExternalSession({ provider: 'rwork', cookie: 'x=1' })).rejects.toThrow(/status 500/u)
    expect(await account.getState()).toMatchObject({ status: 'signed-out' })
    state.status = 200
    state.body = { code: 4401, message: 'expired' }
    await expect(account.acceptExternalSession({ provider: 'rwork', cookie: 'x=1' })).rejects.toThrow(/code 4401/u)
  })

  it('signs out by dropping the grant and the attempt', async () => {
    const { ctx, account } = await fixture()
    await account.startSignIn(CLIENT, 'https://app.local/', 'web')
    await account.acceptExternalSession({ provider: 'rwork', cookie: 'x=1' })
    const state = await account.signOut(CLIENT)
    expect(state.status).toBe('signed-out')
    expect(state.attempt).toBeNull()
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
  })

  it('answers the non-identity surfaces without touching the network', async () => {
    const { account, state } = await fixture()
    expect(await account.resolveToken('https://api.deepseek.com')).toBeUndefined()
    await account.rejectToken('token')
    expect(await account.getPlatformSession()).toBeNull()
    expect(await account.getDeviceIdentity()).toEqual({ osVersion: '' })
    expect(state.requests).toHaveLength(0)
  })

  it('streams the current state and every later change', async () => {
    const { account } = await fixture()
    const controller = new AbortController()
    const stream = account.watch(controller.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ status: 'signed-out' })
    await account.acceptExternalSession({ provider: 'rwork', cookie: 'x=1' })
    expect((await stream.next()).value).toMatchObject({ status: 'credential-stored' })
    const idle = stream.next()
    controller.abort()
    expect(await idle).toMatchObject({ done: true })
  })
})
