/**
 * Host Remote owner for the session-redaction status. One namespace,
 * `redaction`, which a Web client reads to show the term-list revision, the
 * compiled rule counts, how many replacements this process has made, and how
 * many unresolved terms are queued locally.
 *
 * The provider owns the record; this controller only republishes it over the
 * wire, so it holds no state of its own.
 *
 * @module @deepseek-ai/dsh-api-redaction-controller
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-redaction'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RedactionStatusView } from './types.ts'

/**
 * Read-only view of the redaction provider.
 *
 * Every field the record carries is display-safe by construction: placeholders
 * replace the sensitive literals, so the record never describes what was
 * rewritten, only how much.
 */
export class RedactionController extends TypertRemoteService {
  /** Required service: the provider whose status this controller republishes. */
  static inject = ['redaction']

  /**
   * @param ctx - Host with the redaction provider mounted.
   */
  constructor(ctx: Context) {
    super(ctx, 'redactionController', { namespace: 'redaction' })
  }

  /**
   * Read the current provider status.
   * @returns the active revision and source of the term list, the number of
   *   compiled terms and patterns, the replacement counter for this process,
   *   and the number of term requests still queued locally.
   */
  @Remote
  status(): Promise<RedactionStatusView> {
    const { enabled, revision, terms, patterns, replacements, source, lastChecked, lastError, detail, pending } = this.ctx.redaction.status
    return Promise.resolve({ enabled, revision, terms, patterns, replacements, source, lastChecked, lastError, detail, pending })
  }
}

export default RedactionController
