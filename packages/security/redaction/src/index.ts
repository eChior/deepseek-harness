/**
 * Conversation redaction: keep sensitive values out of everything the harness
 * stores or sends.
 *
 * Cordis loads this module as a plugin, so `apply` below is what registers the
 * service; the re-exports are the library surface the plugin's consumers and
 * tests use. The rule list is the pluggable half (see `terms.ts`).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { RedactionService, type Config } from './plugin.ts'

/**
 * How a model has to treat a placeholder this provider leaves in the text.
 *
 * A placeholder reads like an ordinary bracketed word, so a model asked to
 * summarise or translate will rewrite it — and a rewritten placeholder no longer
 * restores. The rule rides in the system prompt rather than in the settings page
 * because it has to hold for every request in every session, and because the
 * person who needs it is the model, not the user.
 */
const PLACEHOLDER_PROMPT = [
  '请遵循以下规则：',
  '',
  '1. 占位字段原样输出',
  '[XX-<整数>] 是脱敏工具生成的占位字段，属于正常文本，其中 <整数> 可为任意整数，如 [XX-1]、[XX-2]、[XX-10] 等。'
  + '正文输出和总结中必须逐字原样输出，包括方括号、XX、连字符和整数；不得替换、改写、翻译、扩写、缩写或修改其描述。',
  '无需推断占位字段本身指代什么，也不要通过脱敏字典寻找或还原其原始内容；只需把它当作正常文本标签处理。'
  + '其他脱敏标签（如 [公司1-1]）同理：原样保留，不还原原文。',
  '',
  '2. 基于当前材料回答',
  '遇到用户询问某个占位字段是什么时，应结合当前材料中与该占位字段相关的内容作答，而不是查找或输出其原文内容。',
  '示例：用户问“[公司1-1]是什么？”时，应结合当前材料回答“[公司1-1] 的相关内容”，例如“根据当前材料，[公司1-1] 是……”。'
  + '其中 [公司1-1] 必须原样保留；不要查找 [公司1-1] 原本对应的真实名称，也不要将其替换成原文。',
  '',
  '3. 区分编号与同义词组',
  '[XX-<整数>] 里不同的整数代表不同事物：[工艺-1]、[工艺-2]、[工艺-3] 是三个互不相同的占位字段，'
  + '即使方括号前的 XX 相同，也不得视为同义词，不得合并、不得互相替代，也不得由一个推断出另一个。',
  '只有形如 [XX<组号>-<写法号>] 的标签（如 [公司1-1] 与 [公司1-2]）才表示同一含义的不同写法：'
  + '组号相同、写法号不同即为同义词，正文中按原形式保留，总结时可按同一意思合并归纳，不必分别展开。',
  '',
  '4. 冲突处理',
  '若规则理解有冲突，优先保证 [XX-<整数>] 在正文和总结中原样输出；编号不同的占位字段永不合并。'
  + '同义词（组号相同、写法号不同）仅在总结层面合并，不改变正文中的标签形式。',
].join('\n')

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
  // Scoped to this plugin, so the section disappears with it. The provider has no
  // off switch, which is why the instruction is unconditional: a session with
  // placeholders in it always needs the rule that keeps them intact.
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: 'redaction:placeholders',
      order: scope.systemPrompt.getSectionOrder('REDACTION_PLACEHOLDERS'),
      text: PLACEHOLDER_PROMPT,
    })
  })
}

export {
  LOCAL_DIRECTORY,
  MAX_LOCAL_BYTES,
  MAX_LOCAL_FILES,
  MAX_PATTERN_SPAN,
  LocalTermError,
  checkLocalText,
  listLocalTermFiles,
  localDirectory,
  normalizeLocalName,
  readLocalTermLists,
  removeLocalTermFile,
  setLocalTermEnabled,
  stampAttribution,
  writeLocalTermFile,
  type LocalTermFile,
  type LocalTermList,
} from './local.ts'
export { RedactionMap, codeShape, groupShape, type RedactionEntry } from './map.ts'
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
