/** Account settings renders safe Host state and explicit login actions. */
import { Big } from 'big.js'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Button, IconRightUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountDetails, AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { PropsRuntime, PropsLocale, InjectFace, HostObservable, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { PlatformPage, PlatformPages } from './platform-pages.ts'
import { formatBalance } from './formatBalance.ts'
import { AccountAvatar } from './AccountAvatar.tsx'
import { authorizeUrlWithTheme } from './authorize-url.ts'
import type { BonusNotice } from './bonus-notices.ts'
import css from './AccountSection.module.css'

/** Safe account snapshot shared by the settings page and launcher. */
export interface AccountSnapshot {
  /** Server-authored bonus notice awaiting display, absent when none is available. */
  notice?: BonusNotice

  /** Latest Host state, absent until the stream responds. */
  view: AccountView | undefined
  /**
   * Staff-directory attribution of the signed-in account.
   *
   * Absent until the read settles, null when no directory serves this
   * deployment, and the record itself once one answered. The account service
   * this deployment signs in with carries no employee number or department, so
   * the identity card reads them from the directory the redaction provider
   * already keeps — the same directory that stamps an upload's department.
   */
  attribution?: AccountAttribution | null | undefined
  /** Sanitized profile and balance query outcomes, absent while loading. */
  details: Partial<AccountDetails> | undefined
  /** Whether the state stream failed. */
  failed: boolean
  /** Explicitly opened account dialog outside onboarding. */
  loginVisible?: boolean
  /** Latest explicit start request failed before a Host state was available. */
  loginFailed?: boolean
  /** Mounted onboarding owns the dialog while active. */
  onboarding?: boolean
}

/** Employee number and department the staff directory reports for the signed-in account. */
export interface AccountAttribution {
  /** Department the directory lists the account under, or null when it lists none. */
  department: string | null
  /** Employee number the directory lists for the account, or null when it lists none. */
  employeeId: string | null
}

/** Host operations injected into the Cordis-free account component. */
export interface AccountSectionInjected {
  /** Subscribe to live credential-expiry notifications.
   * @param listener - callback after the current credential is removed.
   * @returns listener cleanup.
   */
  subscribeSessionExpired?: (listener: () => void) => () => void
  /** Subscribe to live model sign-in guidance; the returned function removes the listener.
   * @param listener - callback for one rejected account-model request.
   * @returns listener cleanup.
   */
  subscribeModelSignInRequired?: (listener: () => void) => () => void
  /** Desktop-only: show one page in the account feature's shared native host; absent in ordinary browsers. */
  openPlatformPage?: PlatformPages['open']

  /** Account stream owned by the Host and theme snapshots published by the renderer, observed through framework hooks. */
  hooks: {
    account: HostObservable<AccountSnapshot>
    /** Palette the Platform login pages follow. */
    theme: HostObservable<ThemeSnapshot>
  }
  /**
   * Read the balance, bonus wallets and unnotified bonus once. The Settings launcher
   * calls it on each entry, and a page opener on return from top-up.
   * @returns after both reads settle.
   */
  refreshAccount: () => Promise<void>
  /** Open the external support questionnaire with the account, build and environment sampled by this click. */
  contactUs: () => void
  /** Open or dismiss the login dialog. */
  showLogin: (visible: boolean) => void
  /** Claim dialog ownership for the onboarding step. */
  setOnboarding: (active: boolean) => void
  /** @param orderId - notice whose card finished a presented frame while visible. */
  bonusNoticeShown: (orderId: BonusNotice['orderId']) => void
  /** @param orderId - notice the user closed. */
  bonusNoticeDismissed: (orderId: BonusNotice['orderId']) => void
  /** @returns after the login attempt is created. */
  start: () => Promise<void>
  /** @param id - attempt to cancel. @returns after cancellation or an already-admitted commit. */
  cancel: (id: SignInAttemptId) => Promise<void>
  /** @returns whether a running task currently uses the account token. */
  hasRunningAccountTasks: () => Promise<boolean>
  /** @returns after local account credentials are removed. */
  signOut: () => Promise<void>
}
/** Composed account section props. */
export type AccountSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected>

/**
 * The identity line under the account name.
 *
 * The employee number and department live in the staff directory, and the
 * account service this deployment signs in with reports neither, so the line
 * reads what the directory knows about the signed-in name. A directory that
 * lists nobody by that name leaves the line blank instead of claiming the
 * account has no details.
 * @param attribution - what the directory reported, absent while the read is in flight.
 * @param t - copy of the account namespace.
 * @returns the line to render, or the loading copy while the directory has not answered.
 */
function directoryLine(attribution: AccountAttribution | null | undefined, t: TranslateNS<'settings.account'>): string {
  if (attribution === undefined) return t('loading')
  if (attribution === null) return ''
  return [attribution.employeeId, attribution.department]
    .filter((value): value is string => value !== null && value !== '')
    .join(' · ')
}
/** @param props - localized actions, account subscription, and the shared Platform page channel. @returns account settings UI. */
export function AccountSection({ t, useAccount, useTheme, start, cancel, openPlatformPage }: AccountSectionProps) {
  const { view: state, details, attribution, failed: streamFailed } = useAccount(value => value)
  const colorScheme = useTheme(snapshot => snapshot.active.colorScheme)
  // The shared host owns the native view; this page holds only its own request,
  // and only while it is the latest owner.
  const releasePage = useRef<(() => void) | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const profile = details?.profile?.status === 'ready' ? details.profile.value : undefined
  const bonusWallets = details?.balance?.status === 'ready'
    ? details.balance.bonusWallets.filter(wallet => new Big(wallet.balance).gt(0)) : []
  const showBonusRow = details?.balance?.status !== 'ready' || bonusWallets.length > 0
  const attempt = state?.attempt
  const active = attempt !== null && attempt !== undefined
    && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(attempt.phase)
  const signedIn = state?.status === 'credential-stored'
  useEffect(() => () => { releasePage.current?.(); releasePage.current = undefined }, [])
  useEffect(() => {
    if (signedIn) return
    releasePage.current?.()
    releasePage.current = undefined
  }, [signedIn])
  const showPage = (open: PlatformPages['open'], page: PlatformPage) => {
    releasePage.current?.()
    releasePage.current = open(page, () => { releasePage.current = undefined })
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setFailed(false)
    try { await action() } catch { setFailed(true) } finally { setBusy(false) }
  }
  /**
   * @param event - click on a Platform destination link.
   * @returns nothing; on Desktop the embedded page replaces the pending navigation.
   */
  const openUsage = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (openPlatformPage !== undefined && signedIn) { event.preventDefault(); showPage(openPlatformPage, 'usage') }
  }
  /**
   * The Platform entry the balance rows share with the Usage action: an embedded page on
   * Desktop, a new tab elsewhere. A wallet read that failed still reaches the same
   * destination, so the user can inspect the balance the Harness could not load; the
   * destination comes from the account links, not from the wallet response.
   * @param label - localized link copy.
   * @param className - link treatment for the row that renders it, absent when the sheet has no such rule.
   * @returns the Platform anchor.
   */
  const platformLink = (label: string, className: string | undefined) => (
    <a className={className} href={state?.links.usageUrl} aria-disabled={state === undefined}
      target="_blank" rel="noreferrer" onClick={openUsage}>{label}</a>
  )
  const status = failed || streamFailed || attempt?.phase === 'failed' ? t('failed')
    : attempt?.phase === 'expired' ? t('expired')
      : active ? t(attempt.phase === 'initializing' ? 'initializing' : attempt.phase === 'waiting-browser' ? 'waiting' : 'completing')
        // The account service this deployment signs in with reports no contact
        // detail, so the line carries what the staff directory knows instead of
        // a field that is null by construction. A directory that lists nobody
        // by this name leaves the line empty rather than reporting a failure.
        : signedIn ? directoryLine(attribution, t) : t('signInDescription')
  if (!signedIn && !active) return (
    <section className={css.signedOut} aria-label={t('nav')}>
      <div className={css.signedOutContent}>
        <div className={css.signedOutCopy}>
          <span className={css.signedOutTitle}>{t('settingsSignedOutTitle')}</span>
          <span className={css.signedOutDescription} role="status">
            {failed || streamFailed ? t('failed') : t('settingsSignedOutDescription')}
          </span>
        </div>
        <Button variant="primary" className={css.signInButton} disabled={busy || state === undefined}
          onClick={() => { void run(start) }}>{t('signIn')}</Button>
      </div>
    </section>
  )
  return (
    <section className={css.section} aria-label={t('nav')}>
      <div className={css.card}>
        <div className={css.identity}>
          <span className={css.avatar}><AccountAvatar url={signedIn ? profile?.avatarUrl : null} /></span>
          <div className={css.identityCopy}>
            <span className={css.name}>{signedIn ? profile?.name ?? t('signedIn') : t('signedOut')}</span>
            <span className={css.status} role="status">{status}</span>
          </div>
        </div>
        {signedIn && <a className={css.accountInfo} href={new URL('/', state.links.usageUrl).href} target="_blank" rel="noopener noreferrer">
          {t('accountInfo')}<IconRightUpOutlineRegular size={12} />
        </a>}
      </div>
      {active && <div className={css.actions}>
        {attempt.authorizeUrl && <a className={css.linkButton} href={authorizeUrlWithTheme(attempt.authorizeUrl, colorScheme)}
          target="_blank" rel="noreferrer">
          {t('open')}
        </a>}
        <Button variant="outline" disabled={busy || attempt.phase === 'committing'}
          onClick={() => { void run(() => cancel(attempt.id)) }}>{t('cancel')}</Button>
      </div>}
      <div className={css.balanceCard}>
        {signedIn && showBonusRow && <>
          <div className={css.row}>
            <span>{t('bonusBalance')}</span>
            <span className={css.bonusValue}>
              {bonusWallets.length > 0
                ? <span className={css.amount}>{bonusWallets.map(wallet => <span key={wallet.currency}>
                  {formatBalance(wallet.balance, wallet.currency === 'CNY' ? '¥' : '$')}
                </span>)}</span>
                : details?.balance === undefined
                  ? <span className={css.unavailable}>{t('loading')}</span>
                  : platformLink(t('balanceUnavailable'), css.unavailableLink)}
            </span>
          </div>
          <div className={css.divider} />
        </>}
      </div>
    </section>
  )
}
