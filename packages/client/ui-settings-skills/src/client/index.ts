/**
 * Contribute the skill publishing tab to the Plugins settings section.
 *
 * The tab is the only surface this plugin adds: a colleague picks one of the
 * skills already on this machine and sends it to the department repository. The
 * page never learns where the file landed — the provider decides the department
 * and records who sent it — so the browser cannot become a way to browse the
 * repository.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-skills/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the Plugins page's SlotMap merge (the 'settings.plugins.tab' entry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the Remote reply envelope.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.locale Context merge this page binds its copy through.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings SlotMap and the Plugins page section this tab joins.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SkillUploadTab, type SkillUploadTabInjected } from './SkillUploadTab.tsx'
import { en, zh } from './locales.ts'

export type { SkillUploadTabInjected, SkillUploadTabProps } from './SkillUploadTab.tsx'
export type { SkillUploadLocaleKey } from './locales.ts'

/** Locale namespace this page owns. */
const NS = 'settings.skills'

/** Open a Remote reply, turning the failure envelope into a thrown error. */
function unwrap<T>(
  operation: string,
  result: { readonly ok: boolean } & (
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  ),
): T {
  if (!result.ok) {
    throw new Error(`skillRepo.${operation} failed: ${result.error.code}: ${result.error.message}`)
  }
  return result.value
}

/**
 * Register the skill publishing tab.
 * @param ctx - Client context with slots, locale and the Remote namespace.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.skillRepo']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-skills: dictionaries')

  const t = ctx.locale.bind(NS)
  const remote = ctx.remote.skillRepo

  const injected: SkillUploadTabInjected = {
    entries: async () => unwrap('entries', await remote.entries()),
    departments: async () => unwrap('departments', await remote.departments()),
    upload: async (name, mode) => unwrap('upload', await remote.upload({ name, mode })),
    drop: async name => unwrap('drop', await remote.drop({ name })),
  }

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'skills-upload',
    order: 30,
    label: () => t('tab'),
    locale: NS,
    inject: (): SkillUploadTabInjected => injected,
  }, SkillUploadTab))
}
