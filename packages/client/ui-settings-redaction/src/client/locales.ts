/** Copy dictionaries for the redaction status page. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  tab: '脱敏状态',
  loading: '正在读取脱敏状态…',
  error: '暂时无法读取脱敏状态。',
  retry: '重试',
  refresh: '刷新',
  guardTitle: '脱敏常开',
  guardHint: '本功能没有关闭开关。进入会话的每条提示与每份工具结果都会先过词表，命中的词条换成稳定占位符，原文不进入会话记录。',
  revisionLabel: '词表修订',
  sourceLabel: '词表来源',
  sourceBundled: '随客户端分发',
  sourceCache: '本机缓存',
  sourceRemote: '内网发布',
  rulesLabel: '已编译规则',
  rulesValue: '{terms} 个词条 · {patterns} 条正则',
  replacementsLabel: '本进程替换次数',
  pendingLabel: '待提交词条',
  pendingHint: '这些词条在本机排队，等待交付通道。',
  checkedLabel: '上次检查发布',
  never: '从未',
  detailLabel: '当前状态',
  detailBlocked: '词表未加载，暂时不会替换任何内容：{detail}',
  staleLabel: '上次刷新未采用',
  rulesHint: '词条精确匹配，正则按 JavaScript 子集编译；同一词条在整段会话里始终换成同一个占位符，模型能看出结构与频次，看不出具体编号。',
} satisfies Record<string, string>

/** Redaction page locale key union. */
export type RedactionLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  tab: 'Redaction status',
  loading: 'Reading redaction status…',
  error: 'Redaction status is temporarily unavailable.',
  retry: 'Retry',
  refresh: 'Refresh',
  guardTitle: 'Always on',
  guardHint: 'This guard has no off switch. Every prompt and every tool result passes the term list before it reaches the session, and each match becomes a stable placeholder instead of the original text.',
  revisionLabel: 'Term list revision',
  sourceLabel: 'Term list source',
  sourceBundled: 'Shipped with the client',
  sourceCache: 'Local cache',
  sourceRemote: 'Intranet publisher',
  rulesLabel: 'Compiled rules',
  rulesValue: '{terms} terms · {patterns} patterns',
  replacementsLabel: 'Replacements in this process',
  pendingLabel: 'Queued term requests',
  pendingHint: 'These terms wait on this machine for a delivery target.',
  checkedLabel: 'Last publisher check',
  never: 'Never',
  detailLabel: 'Current state',
  detailBlocked: 'No term list is loaded, so nothing is being replaced: {detail}',
  staleLabel: 'Last refresh kept the loaded rules',
  rulesHint: 'Terms match exactly and patterns compile as a JavaScript subset. One term always becomes the same placeholder for the whole session, so the model reads structure and frequency but never a concrete identifier.',
} satisfies Record<RedactionLocaleKey, string>
