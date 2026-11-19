/** Framework-hook projection into the desktop introduction's pure view. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { AccountSnapshot } from './AccountSection.tsx'
import type { DesktopOnboardingProps, DesktopOnboardingState } from './onboarding-contract.ts'
import { OnboardingSurface } from './OnboardingSurface.tsx'
import css from './DesktopOnboarding.module.css'
import { DesktopOnboarding } from './DesktopOnboarding.tsx'

/** Observable sources and actions supplied by the account plugin's apply closure. */
export interface DesktopOnboardingInjected extends Omit<DesktopOnboardingProps, 'state' | 'account' | 't' | 'exiting' | 'locale'> {
  hooks: {
    onboarding: HostObservable<DesktopOnboardingState>
    account: HostObservable<AccountSnapshot>
  }
}

/**
 * Read shared state through framework hooks; sessions do not control activation.
 * @param props - shell overlay bindings and account-owned actions.
 * @returns the unfinished flow, retained briefly after successful completion unless motion is reduced.
 */
export function DesktopOnboardingEntry({ useOnboarding, useAccount, ...props }:
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings.account'> & InjectFace<DesktopOnboardingInjected>) {
  const locale = props.t('onboardingArtworkLocale')
  const state = useOnboarding(value => value)
  const account = useAccount(value => value)
  const storedOnce = useRef(false)
  useLayoutEffect(() => {
    if (!state.visible) return
    const bridge = (globalThis as typeof globalThis & {
      dshOnboarding?: { setActive(active: boolean): void }
    }).dshOnboarding
    bridge?.setActive(true)
    return () => { bridge?.setActive(false) }
  }, [state.visible])
  const [lastVisible, setLastVisible] = useState(state.visible ? state : null)
  const done = !state.visible && state.progress.step === 'done'
    && account.view?.status === 'credential-stored'
  const pendingCompletion = done && state.status === 'saving'
  const completed = done && state.status === 'ready'
  const exiting = completed && lastVisible !== null
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useLayoutEffect(() => {
    if (state.visible) setLastVisible(state)
    else if (!completed && !pendingCompletion) setLastVisible(null)
  }, [state, completed, pendingCompletion])
  useEffect(() => {
    if (!exiting) return
    // Matches OnboardingSurface's exit animation; cleanup also covers sign-out.
    const timer = window.setTimeout(() => { setLastVisible(null) }, 180)
    return () => { window.clearTimeout(timer) }
  }, [exiting])

  const displayed = state.visible ? state : exiting || pendingCompletion ? lastVisible : null
  if (displayed === null) {
    // Without a stored credential the workspace never opens: the flow has no skip path,
    // and a sign-out lands here again instead of on an empty session list.
    // The account view arrives one tick after the first paint. Rendering the sign-in page
    // before it lands is what made every launch flash the login screen for a stored credential.
    // Switching a model or a mode remounts this entry while the account view reloads.
    // Once a credential was stored, a missing view means “reading”, not “signed out”:
    // painting the gate again would flash the sign-in page over a working workspace.
    if (account.view?.status === 'credential-stored') storedOnce.current = true
    if (account.view === undefined) {
      return storedOnce.current ? null : <OnboardingSurface><div className={css.page} aria-busy="true" /></OnboardingSurface>
    }
    if (account.view?.status !== 'credential-stored') {
      return (
        <OnboardingSurface>
          <div className={css.page}>
            <div className={css.welcome}>
              <div className={css.copy}>
                <h2>{props.t('onboardingSignInRequired')}</h2>
                <p>{props.t('onboardingSignInDescription')}</p>
                <div className={css.primaryAction}>
                  <button type="button" onClick={() => { props.showLogin?.(true) }}>
                    {props.t('onboardingSignInAction')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </OnboardingSurface>
      )
    }
    return state.status === 'loading'
      ? <OnboardingSurface><div role="status">{props.t('onboardingLoading')}</div></OnboardingSurface> : null
  }
  return <DesktopOnboarding {...props} locale={locale} state={pendingCompletion ? { ...displayed, status: 'saving' } : displayed}
    account={account} exiting={exiting} />
}
