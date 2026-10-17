/**
 * The redaction page, browser half: the term-list revision the provider loaded,
 * the compiled rule counts, this process's replacement counter, and the term
 * lists a department uploaded to this machine.
 *
 * The page registers into the Plugins page's tab list and reads the `redaction`
 * namespace the Host controller serves, so a deployment without that controller
 * shows no trace of it.
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
    /** Redaction page copy. */
    'settings.redaction': RedactionLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.redaction'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.redaction']

/** Contribute the redaction tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-redaction: dictionaries')

  const t = ctx.locale.bind(NS)
  const remote = ctx.remote.redaction

  const injected: RedactionStatusTabInjected = {
    status: async () => unwrap('status', await remote.status()),
    roster: async () => unwrap('roster', await remote.roster()),
    uploads: async () => unwrap('uploads', await remote.uploads()),
    upload: async request => unwrap('upload', await remote.upload(request)),
    remove: async request => unwrap('remove', await remote.remove(request)),
    setEnabled: async request => unwrap('setEnabled', await remote.setEnabled(request)),
    example: async () => unwrap('example', await remote.example()),
  }

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'redaction',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: (): RedactionStatusTabInjected => injected,
  }, RedactionStatusTab))
}

/**
 * Turn a Remote reply into a value or a thrown error.
 *
 * The page renders one failure banner for any refused call, so the only thing
 * that matters here is that a refusal arrives as a rejection rather than as an
 * empty view a reader would mistake for "nothing is loaded".
 * @param operation - which namespace method was called.
 * @param result - what the Remote layer returned.
 * @returns the value the call produced.
 * @throws Error naming the method, the code, and the message the Host sent.
 */
function unwrap<T>(
  operation: string,
  result: { readonly ok: boolean } & (
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  ),
): T {
  if (!result.ok) {
    throw new Error(`redaction.${operation} failed: ${result.error.code}: ${result.error.message}`)
  }
  return result.value
}
