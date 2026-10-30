/**
 * Account provider for the CRC RWork identity gateway.
 *
 * Unlike the DeepSeek platform provider, no browser callback reaches the Host:
 * the desktop shell opens the deployment's own sign-in page in a window it
 * controls, then hands the resulting session cookie over through
 * {@link DeepSeekAccount.acceptExternalSession}. This provider only turns that
 * cookie into a stored identity and answers profile reads with it.
 *
 * The deployment exposes no wallet, bonus, or inference grant, so the balance,
 * bonus, and token surfaces answer as if the account had none rather than
 * failing.
 *
 * @module @deepseek-ai/dsh-hrzszy-account
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  DeepSeekAccount,
  type AccountBonusBatch,
  type AccountBonusOrderId,
  type AccountClientMetadata,
  type AccountDetails,
  type AccountUserId,
  type AccountView,
  type PlatformSession,
  type SignInAttemptId,
  type SignInAttemptView,
} from '@deepseek-ai/dsh-deepseek-account'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  parseRworkUser,
  rworkIdentityHeaders,
  rworkIdentityUrl,
  rworkLoginUrl,
  RWORK_DEFAULT_API_ORIGIN,
  RWORK_DEFAULT_APP_ID,
  RWORK_DEFAULT_LOGIN_ORIGIN,
  RworkProtocolError,
} from './protocol.ts'
import { RWORK_PROVIDER, type ExternalAccountSession, type RworkUser } from './types.ts'
import { NO_KEYS, pickDepartmentKey, readDepartmentKeys, type DepartmentKeys } from './keys.ts'

const KEY = credentialKey('hrzszy-account', 'default')

/** The reference the Qwen route resolves before it asks any other seam. */
const DEPARTMENT_KEY_REF = 'QWEN_API_KEY'

/** Deployment endpoints and request deadlines. */
export interface Config {
  /** Origin serving identity JSON. */
  apiOrigin?: string
  /** Origin serving the browser sign-in page. */
  loginOrigin?: string
  /** Deployment application id every identity request carries. */
  appId?: string
  /** Deadline for each identity request. */
  requestTimeoutMs?: number
  /** Upper bound for one local attempt, even when its window stays open longer. */
  attemptTimeoutMs?: number
}

/** Validated deployment choices. */
export const Config = Schema.object({
  apiOrigin: Schema.string().default(RWORK_DEFAULT_API_ORIGIN),
  loginOrigin: Schema.string().default(RWORK_DEFAULT_LOGIN_ORIGIN),
  appId: Schema.string().default(RWORK_DEFAULT_APP_ID),
  requestTimeoutMs: Schema.natural().default(15_000),
  attemptTimeoutMs: Schema.natural().default(600_000),
})

/** What this provider stores for one signed-in employee. */
interface Grant {
  /** Session cookie header captured from the finished browser login. */
  readonly cookie: string
  /** Identity the gateway reported when the cookie was accepted. */
  readonly user: RworkUser
}

interface Attempt {
  readonly view: SignInAttemptView
  readonly expiresAt: number
}

function isGrant(value: unknown): value is Grant {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  const user = candidate.user
  return typeof candidate.cookie === 'string' && candidate.cookie.length > 0
    && typeof user === 'object' && user !== null
    && typeof (user as Record<string, unknown>).id === 'string'
    && typeof (user as Record<string, unknown>).name === 'string'
}

/** RWork-backed account state; only Host consumers can obtain the session cookie. */
export default class RworkAccount extends DeepSeekAccount {
  static inject = ['credentials']

  private readonly apiOrigin: string
  private readonly loginOrigin: string
  private readonly appId: string
  private readonly requestTimeout: number
  private readonly attemptTimeout: number
  private attempt: Attempt | undefined
  private readonly listeners = new Set<(state: AccountView) => void>()
  private keys: DepartmentKeys = NO_KEYS

  /**
   * @param ctx - context owning this provider.
   * @param config - deployment endpoints; unset fields fall back to the deployment defaults.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.apiOrigin = new URL(config.apiOrigin ?? RWORK_DEFAULT_API_ORIGIN).origin
    this.loginOrigin = new URL(config.loginOrigin ?? RWORK_DEFAULT_LOGIN_ORIGIN).origin
    this.appId = config.appId ?? RWORK_DEFAULT_APP_ID
    this.requestTimeout = config.requestTimeoutMs ?? 15_000
    this.attemptTimeout = config.attemptTimeoutMs ?? 600_000
    ctx.effect(() => {
      void readDepartmentKeys().then((keys) => {
        this.keys = keys
        void this.publishDepartmentKey(null)
      })
      return () => undefined
    })
  }

  override async getState(): Promise<AccountView> {
    const record = await this.ctx.credentials.readRecord(KEY)
    return this.view(record === undefined ? 'signed-out' : 'credential-stored')
  }

  /**
   * Store the key this deployment issued under the reference the route reads.
   *
   * The route resolves stored credentials before it asks the account
   * provider, so writing the key here is what makes a freshly installed
   * build answer without a manual step; a later sign-in rewrites it with the
   * key of the department the roster attributes to that colleague.
   * @param department - the department of the signed-in colleague, if known.
   */
  private async publishDepartmentKey(department: string | null): Promise<void> {
    const key = this.qwenKeyFor(department)
    if (key === undefined) return
    const ref = credentialRef(DEPARTMENT_KEY_REF)
    try {
      const stored = await this.ctx.credentials.resolve(ref)
      if (stored?.value === key) return
      await this.ctx.credentials.set(ref, key)
    } catch {
      // A store that refuses the write leaves the route exactly as it was.
    }
  }

  /**
   * The Qwen API key this build assigned to a department.
   *
   * The route asks through this instead of reading a file, so a build that
   * shipped no table answers undefined and nothing else changes.
   * @param department - the department of the signed-in colleague, if known.
   * @returns the key, or undefined when the table covers neither the department nor the catch-all entry.
   */
  qwenKeyFor(department: string | null): string | undefined {
    return pickDepartmentKey(this.keys, department)
  }

  override async getProfile(client: AccountClientMetadata): Promise<AccountDetails['profile'] | null> {
    void client
    const grant = await this.readGrant()
    if (grant === undefined) return null
    // Refresh the published key now that the roster can name a department.
    void this.publishDepartmentKey(this.departmentOf(grant.user.name))
    return {
      status: 'ready',
      value: {
        id: grant.user.id as AccountUserId,
        name: grant.user.name,
        contact: null,
        ...grant.user.avatarUrl === undefined ? {} : { avatarUrl: grant.user.avatarUrl },
      },
    }
  }

  /** The department the roster attributes to a colleague name. */
  private departmentOf(name: string): string | null {
    const redaction = this.ctx.get('redaction') as {
      identify?: (account: string) => { department?: string } | undefined
    } | undefined
    return redaction?.identify?.(name)?.department ?? null
  }

  override async getBalance(client: AccountClientMetadata): Promise<AccountDetails['balance'] | null> {
    void client
    const grant = await this.readGrant()
    if (grant === undefined) return null
    return { status: 'ready', value: [], bonusWallets: [] }
  }

  override getUnnotifiedBonuses(client: AccountClientMetadata): Promise<AccountBonusBatch | null> {
    void client
    return Promise.resolve(null)
  }

  override ackBonusNotified(
    accountId: AccountUserId, orderId: AccountBonusOrderId, client: AccountClientMetadata,
  ): Promise<boolean> {
    void accountId
    void orderId
    void client
    return Promise.resolve(false)
  }

  override async startSignIn(
    client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop',
  ): Promise<AccountView> {
    void client
    void callbackOrigin
    void loginSource
    if (this.attempt !== undefined && !this.expired(this.attempt)) return this.getState()
    const attempt: Attempt = {
      view: {
        id: randomUUID() as SignInAttemptId,
        phase: 'waiting-browser',
        authorizeUrl: rworkLoginUrl(this.loginOrigin, this.appId, this.apiOrigin),
        expiresAt: Date.now() + this.attemptTimeout,
      },
      expiresAt: Date.now() + this.attemptTimeout,
    }
    this.attempt = attempt
    // The desktop shell opens its sign-in window from the watched stream, not from this
    // return value: without publishing, the new attempt never reaches the shell and the
    // window is never opened.
    const state = this.view('signed-out')
    this.publish(state)
    return state
  }

  /**
   * Commit a session the desktop shell captured in its own sign-in window.
   * @param session - provider tag plus the captured session cookie header.
   * @returns state after the identity was read and stored.
   */
  override async acceptExternalSession(session: unknown): Promise<AccountView> {
    const candidate = session as Partial<ExternalAccountSession> | null
    if (typeof candidate !== 'object' || candidate === null || typeof candidate.cookie !== 'string'
      || candidate.cookie.length === 0) {
      throw new RworkProtocolError('rwork: external session carried no cookie')
    }
    if (candidate.provider !== RWORK_PROVIDER) {
      throw new RworkProtocolError(`rwork: external session provider ${candidate.provider} is not supported`)
    }
    const user = await this.identify(candidate.cookie)
    await this.ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { cookie: candidate.cookie, user } }))
    if (this.attempt !== undefined) this.attempt = { view: { ...this.attempt.view, phase: 'succeeded' }, expiresAt: this.attempt.expiresAt }
    const state = await this.getState()
    this.publish(state)
    return state
  }

  override async cancelSignIn(id: SignInAttemptId): Promise<AccountView> {
    if (this.attempt?.view.id === id) {
      this.attempt = { view: { ...this.attempt.view, phase: 'cancelled' }, expiresAt: this.attempt.expiresAt }
      const state = await this.getState()
      this.publish(state)
      return state
    }
    return this.getState()
  }

  override async signOut(client: AccountClientMetadata): Promise<AccountView> {
    void client
    await this.ctx.credentials.deleteRecord(KEY)
    this.attempt = undefined
    this.ctx.emit('deepseek-account/signed-out')
    const state = await this.getState()
    this.publish(state)
    return state
  }

  override watch(signal: AbortSignal): AsyncIterable<AccountView> {
    const pending: AccountView[] = []
    let wake: (() => void) | undefined
    const listener = (state: AccountView): void => { pending.push(state); wake?.() }
    const read = (): Promise<AccountView> => this.getState()
    const forget = (): void => { this.listeners.delete(listener) }
    this.listeners.add(listener)
    const abort = (): void => { wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    return (async function* stream(): AsyncGenerator<AccountView> {
      try {
        yield await read()
        while (!signal.aborted) {
          if (pending.length === 0) {
            await new Promise<void>((resolve) => { wake = resolve })
            wake = undefined
            continue
          }
          yield pending.shift() as AccountView
        }
      } finally {
        forget()
        signal.removeEventListener('abort', abort)
      }
    })()
  }

  override resolveToken(url: string): Promise<string | undefined> {
    void url
    return Promise.resolve(undefined)
  }

  override rejectToken(token: string): Promise<void> {
    void token
    return Promise.resolve()
  }

  override getPlatformSession(): Promise<PlatformSession | null> {
    return Promise.resolve(null)
  }

  override getDeviceIdentity(): Promise<{ deviceId?: string; userId?: AccountUserId; osVersion: string }> {
    return Promise.resolve({ osVersion: '' })
  }

  private expired(attempt: Attempt): boolean {
    return attempt.expiresAt <= Date.now()
  }

  private async readGrant(): Promise<Grant | undefined> {
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined) return undefined
    if (record.kind !== 'grant') throw new RworkProtocolError('rwork: stored credential is not a grant')
    return isGrant(record.payload) ? record.payload : undefined
  }

  private async identify(cookie: string): Promise<RworkUser> {
    const response = await fetch(rworkIdentityUrl(this.apiOrigin, this.appId), {
      headers: { ...rworkIdentityHeaders(this.appId), cookie },
      signal: AbortSignal.timeout(this.requestTimeout),
    })
    if (!response.ok) throw new RworkProtocolError(`rwork: identity request failed with status ${String(response.status)}`)
    return parseRworkUser(await response.json())
  }

  private view(status: AccountView['status']): AccountView {
    return {
      status,
      links: { usageUrl: this.apiOrigin, topUpUrl: this.apiOrigin },
      attempt: this.attempt === undefined ? null : { ...this.attempt.view },
    }
  }

  private publish(state: AccountView): void {
    for (const listener of this.listeners) listener(state)
  }
}
