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
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'settings.plugins.tab' entry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-conversation SlotMap merge (the input.right seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { RedactionBadge, type RedactionBadgeInjected } from './RedactionBadge.tsx'
import { RedactionStatusTab, type RedactionStatusTabInjected } from './RedactionStatusTab.tsx'
import { en, zh, type RedactionLocaleKey } from './locales.ts'

export type { RedactionStatusTabInjected, RedactionStatusTabProps } from './RedactionStatusTab.tsx'
export type { RedactionBadgeInjected, RedactionBadgeProps } from './RedactionBadge.tsx'
export type { RedactionLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Redaction page copy. */
    'settings.redaction': RedactionLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.redaction'

/**
 * Services required by the Settings registration, the composer badge, and the
 * generated Remote face.
 *
 * `configForms` is not optional: the badge's view toggle writes the `ui-chat`
 * preference through it, and a missing key would make that write throw inside
 * a click handler where nothing catches it.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.redaction', 'sessions', 'configForms']

/** The Chat namespace holding the transcript view preference. */
const CHAT_NAMESPACE = 'ui-chat'

/** The Chat preferences this plugin reads and writes. */
interface ChatPreferences {
  /** `placeholder` keeps what the model read; `original` shows what was typed. */
  redactionUserView?: 'original' | 'placeholder'
  /** Colour a restored original is painted in. */
  redactionHighlightColor?: string
}

/** Colour a restored original is painted in when the preference is unset. */
const DEFAULT_HIGHLIGHT = '#d92d20'

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
    drop: async request => unwrap('drop', await remote.drop(request)),
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

  // The composer badge: one cell before the model selector, listing the
  // placeholders this machine issued and owning the user-side view choice.
  // The shared chat preference store is read lazily inside the inject face:
  // the ui-chat namespace may be absent (an old client build), and the badge
  // then reports the default rather than failing the composer.
  const chatForm = (): ConfigForm<ChatPreferences> => ctx.configForms.get<ChatPreferences>(CHAT_NAMESPACE)

  const chatView = (): 'original' | 'placeholder' => {
    try {
      return chatForm().getSnapshot().value?.redactionUserView ?? 'original'
    } catch (_error) {
      // No Chat settings provider: the transcript reads originals by default.
      return 'original'
    }
  }

  const chatHighlight = (): string => {
    try {
      return chatForm().getSnapshot().value?.redactionHighlightColor ?? DEFAULT_HIGHLIGHT
    } catch (_error) {
      // No Chat settings provider: fall back to the shipped colour.
      return DEFAULT_HIGHLIGHT
    }
  }

  // The table is asked for by session: a mapping file belongs to one task, and
  // two conversations may hand the same placeholder to different values.
  const badgeInjected = (): RedactionBadgeInjected => ({
    entries: async () => unwrap('entries', await remote.entries()),
    status: async () => unwrap('status', await remote.status()),
    highlightColor: chatHighlight(),
    setHighlightColor: (color) => {
      try {
        void chatForm().set('redactionHighlightColor', color).catch((_error: unknown) => {
          // The colour stays in this session when persistence is unavailable.
        })
      } catch (_error) {
        // No Chat settings provider: nothing can be written, nothing breaks.
      }
    },
    // The mapping switch lives on the Host guard, not in a client preference:
    // the session-end write happens in the Host process.
    setMappings: (enabled) => {
      void remote.setMappings({ enabled }).catch((_error: unknown) => {
        // A refused write leaves the switch where the next poll reports it.
      })
    },
    userView: chatView(),
    readUserView: chatView,
    // The toggle's highlight has to follow the stored preference even when the
    // write lands after the click; a static face would leave the old button lit.
    subscribeUserView: (listener) => {
      try {
        return chatForm().subscribe(listener)
      } catch (_error) {
        return () => {}
      }
    },
    setUserView: (view) => {
      try {
        void chatForm().set('redactionUserView', view).catch((_error: unknown) => {
          // The choice stays session-local when persistence is unavailable.
        })
      } catch (_error) {
        // No Chat settings provider: nothing can be written, nothing breaks.
      }
    },
  })

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'redaction-badge',
    order: -10,
    locale: NS,
    inject: (): RedactionBadgeInjected => badgeInjected(),
  }, RedactionBadge))
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
