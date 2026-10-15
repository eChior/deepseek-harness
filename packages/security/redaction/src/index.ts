/**
 * Conversation redaction: keep sensitive values out of everything the harness
 * stores or sends.
 *
 * The rule list is the pluggable half (see `terms.ts`); this entry point is the
 * library surface used by the plugin and by tests. Wiring into the message path —
 * the inbox splice, tool results, and image attachments — lives in the plugin that
 * consumes this package.
 */
export { RedactionMap, type RedactionEntry } from './map.ts'
export {
  Config,
  RedactionService,
  name,
  type RedactablePart,
  type RedactionStatus,
} from './plugin.ts'
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
