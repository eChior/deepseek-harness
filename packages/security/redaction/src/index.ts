/**
 * Conversation redaction: keep sensitive values out of everything the harness
 * stores or sends.
 *
 * Cordis loads this module as a plugin, so `apply` below is what registers the
 * service; the re-exports are the library surface the plugin's consumers and
 * tests use. The rule list is the pluggable half (see `terms.ts`).
 */
import type { Context } from '@deepseek-ai/cordis'
import { RedactionService, type Config } from './plugin.ts'

/**
 * Register the redaction service as `ctx.redaction`.
 *
 * Cordis accepts a plugin only as a function or as an object carrying `apply`, so
 * a module that exports the service class alone is rejected before anything is
 * registered. The consumers that rewrite a message all look `ctx.redaction` up
 * and step aside when it is undefined, which makes a missing registration silent
 * rather than loud — hence the export this entry point exists to provide.
 * @param ctx - Context the service is registered on.
 * @param config - Term list, refresh, and image-recognition settings.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(RedactionService, config)
}

export { RedactionMap, type RedactionEntry } from './map.ts'
export {
  Config,
  RedactionService,
  name,
  type RedactablePart,
  type RedactionStatus,
  type TermRequestDelivery,
  type TermRequestSink,
} from './plugin.ts'
export {
  TERM_REQUEST_FILE,
  assertTermShape,
  queueTermRequest,
  readTermRequests,
  settleTermRequest,
  writeTermRequests,
  type TermRequest,
  type TermRequestState,
} from './queue.ts'
export {
  compileRules,
  isUsable,
  parseTermList,
  type ParsedTermList,
  type RedactionCategory,
  type RedactionRule,
  type RedactionTermList,
  type TermListProblem,
} from './terms.ts'
export {
  DEFAULT_PRIORITY,
  findHits,
  redactText,
  resolveOverlaps,
  type RedactionHit,
  type RedactionResult,
} from './redact.ts'
export {
  CURRENT_POINTER,
  fetchTermList,
  readCachedTermList,
  termListUrl,
  writeCachedTermList,
  type TermSourceConfig,
  type TermSourceKind,
} from './source.ts'
export { DEFAULT_VISION_TIMEOUT_MS, normalizeRecognized, recognizeImageText } from './vision.ts'
