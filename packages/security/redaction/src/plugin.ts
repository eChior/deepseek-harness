/**
 * The redaction provider: rewrite the text of a prompt before the harness turns
 * it into a message.
 *
 * The harness writes a message into the session log the moment it is accepted,
 * and that log is plain text the model itself can read back. Redacting at the
 * model boundary would therefore be too late — the value would already be on
 * disk. This provider exists so the rewrite happens while the prompt is still an
 * admission result, before any caller can append it anywhere.
 *
 * The replacement map is deliberately in memory only. Persisting it would turn
 * one file into the complete plaintext of everything this feature protects.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { RedactionMap } from './map.ts'
import { compileRules, isUsable, parseTermList, type RedactionRule } from './terms.ts'
import { redactText as applyRules } from './redact.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    redaction: RedactionService
  }
}

export const name = '@deepseek-ai/dsh-redaction'

/** Term list this build carries. A deployment can point at another file. */
const TERMS_PATH = fileURLToPath(new URL('../assets/terms.yaml', import.meta.url))

/**
 * What a caller has to look like for this provider to rewrite it. Prompts carry
 * more than text; the provider touches the parts that hold text and hands every
 * other part back untouched.
 */
export interface RedactablePart {
  readonly type: string
  readonly text?: string
}

/** Fields a deployment can set for this provider. */
export interface Config {
  /** Set to false to leave every message exactly as the user typed it. */
  enabled?: boolean
  /** Term list to load. Defaults to the copy inside this package. */
  termsPath?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  termsPath: z.string().default(TERMS_PATH),
})

/** What the provider has loaded and how much it has replaced so far. */
export interface RedactionStatus {
  readonly enabled: boolean
  /** Revision the loaded term list declares. */
  readonly revision: string | null
  /** Term entries the loaded list declares. */
  readonly terms: number
  /** Regular expressions the loaded list declares. */
  readonly patterns: number
  /** Replacements this process has made since it started. */
  readonly replacements: number
  readonly detail: string | null
}

/**
 * Rewrite the text of an admitted prompt into stable placeholders, so the values
 * it replaced reach neither the session log nor a model request.
 */
export class RedactionService extends Service {
  static inject: string[] = []

  private readonly config: Required<Config>
  private rules: RedactionRule[] = []
  private readonly map = new RedactionMap()
  private current: RedactionStatus

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'redaction')
    this.config = {
      enabled: config.enabled ?? true,
      termsPath: config.termsPath ?? TERMS_PATH,
    }
    this.current = {
      enabled: this.config.enabled,
      revision: null,
      terms: 0,
      patterns: 0,
      replacements: 0,
      detail: null,
    }
    ctx.effect(() => {
      void this.load()
      return () => {}
    }, 'redaction: load the term list')
  }

  /** What the term list declares and how many replacements this process has made. */
  get status(): RedactionStatus {
    return this.current
  }

  /**
   * Load the term list. Never throws: a missing or malformed file leaves the
   * provider holding no rules, which replaces nothing, and records why in
   * `detail` so the state is visible instead of silent.
   * @returns The status after the attempt; `detail` carries any failure reason.
   */
  async load(): Promise<RedactionStatus> {
    if (!this.config.enabled) return this.current
    try {
      const parsed = parseTermList(await readFile(this.config.termsPath, 'utf8'))
      if (!isUsable(parsed)) {
        throw new Error(`the term list at ${this.config.termsPath} reports ${String(parsed.problems.length)} problem(s)`)
      }
      this.rules = compileRules(parsed)
      this.current = {
        ...this.current,
        revision: parsed.revision,
        terms: this.rules.filter(rule => rule.kind === 'term').length,
        patterns: this.rules.filter(rule => rule.kind === 'pattern').length,
        detail: null,
      }
      this.ctx.logger.info(`redaction: ${String(this.rules.length)} rule(s) from ${this.config.termsPath} at ${parsed.revision}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.rules = []
      this.current = { ...this.current, revision: null, terms: 0, patterns: 0, detail }
      this.ctx.logger.warn(`redaction: nothing will be replaced: ${detail}`)
    }
    return this.current
  }

  /**
   * Rewrite the text parts. Parts that carry no text — images, file references,
   * anything this build does not understand — come back untouched, so a caller
   * can hand the result to the next stage exactly as it would have handed the
   * input.
   * @param parts Parts a caller is about to turn into a message.
   * @returns A new list in which every text part has been rewritten.
   */
  redact<T extends RedactablePart>(parts: readonly T[]): T[] {
    if (!this.config.enabled || this.rules.length === 0) return [...parts]
    return parts.map(part => part.type === 'text' && typeof part.text === 'string'
      ? { ...part, text: this.redactText(part.text) }
      : part)
  }

  /**
   * Rewrite one string, for callers holding text outside a part list.
   * @param text Text to rewrite.
   * @returns The rewritten text, or the input when no rule matched.
   */
  redactText(text: string): string {
    if (!this.config.enabled || this.rules.length === 0) return text
    const result = applyRules(text, this.rules, this.map)
    if (result.hits.length > 0) {
      this.current = { ...this.current, replacements: this.current.replacements + result.hits.length }
    }
    return result.text
  }

  /**
   * Turn the placeholders this session emitted back into the values they stand for.
   * @param text Text that may carry placeholders.
   * @returns The text with every placeholder this process issued restored.
   */
  restore(text: string): string {
    return this.map.restore(text)
  }
}
