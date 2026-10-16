/**
 * The redaction status page, browser half: the term-list revision the provider
 * loaded, the compiled rule counts, this process's replacement counter, and the
 * term requests still queued locally. The page registers into the Plugins
 * page's tab list and reads the `redaction` namespace the Host controller
 * serves, so a deployment without that controller shows no trace of it.
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'settings.plugins.tab' entry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { RedactionStatusTab, type RedactionStatusTabInjected } from './RedactionStatusTab.tsx'
import { en, zh, type RedactionLocaleKey } from './locales.ts'

export type { RedactionStatusTabInjected, RedactionStatusTabProps } from './RedactionStatusTab.tsx'
export type { RedactionLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Redaction status page copy. */
    'settings.redaction': RedactionLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.redaction'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.redaction']

/** Contribute the read-only status tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-redaction: dictionaries')

  const t = ctx.locale.bind(NS)
  const status: RedactionStatusTabInjected['status'] = async () => {
    const result = await ctx.remote.redaction.status()
    if (!result.ok) {
      throw new Error(`redaction.status failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'redaction',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: (): RedactionStatusTabInjected => ({ status }),
  }, RedactionStatusTab))
}
