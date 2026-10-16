/**
 * The redaction provider: rewrite the text of a prompt before the harness turns
 * it into a message, and read the text out of an image on this machine.
 *
 * The harness writes a message into the session log the moment it is accepted,
 * and that log is plain text the model itself can read back. Redacting at the
 * model boundary would therefore be too late — the value would already be on
 * disk. This provider exists so the rewrite happens while the prompt is still an
 * admission result, before any caller can append it anywhere.
 *
 * The replacement map is deliberately in memory only. Persisting it would turn
 * one file into the complete plaintext of everything this feature protects.
 *
 * Rules come from a list a deployment publishes in a repository, so a term added
 * there reaches every client within one refresh interval. What each machine keeps
 * is a copy of the list, never of the values it matched: losing the copy only
 * means falling back to the list inside this package.
 */
import { Buffer } from 'node:buffer'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { RedactionMap } from './map.ts'
import { queueTermRequest, readTermRequests, settleTermRequest, type TermRequest } from './queue.ts'
import { fetchTermList, readCachedTermList, writeCachedTermList, type TermSourceConfig, type TermSourceKind } from './source.ts'
import { compileRules, isUsable, parseTermList, type RedactionRule } from './terms.ts'
import { redactText as applyRules } from './redact.ts'
import { DEFAULT_VISION_TIMEOUT_MS, recognizeImageText } from './vision.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    redaction: RedactionService
  }
}

export const name = '@deepseek-ai/dsh-redaction'

/** Term list this build carries. A deployment can point at another file. */
const TERMS_PATH = fileURLToPath(new URL('../assets/terms.yaml', import.meta.url))

/** Repository a deployment publishes the list in, read at start and every few minutes. */
const PUBLISHED_TERMS = 'http://10.151.5.175:3000/ITPublic/dsh-redaction-terms'

/** Revisions that compare as dates; anything else is left to the cache. */
const DATED_REVISION = /^\d{4}-\d{2}-\d{2}$/

/**
 * Decide whether the list carried by this package outranks a cached one.
 *
 * The cache exists so a machine that cannot reach the publisher keeps replacing
 * what it replaced yesterday. It must not outrank an upgrade: adopting an older
 * cache over a newer shipped list would silently drop every term the release
 * added, and the client would look configured while replacing less than before.
 * Revisions compare only when both read as dates; anything else leaves the cache
 * in place, which is the behaviour every install had before this check existed.
 * @param shipped The list inside the package, absent when it cannot be read.
 * @param held The list read from the cache.
 * @returns True when the shipped list declares a later revision.
 */
function supersedes(shipped: string | undefined, held: string): boolean {
  if (shipped === undefined) return false
  const next = parseTermList(shipped).revision
  const current = parseTermList(held).revision
  if (!DATED_REVISION.test(next) || !DATED_REVISION.test(current)) return false
  return next > current
}

/**
 * What a caller has to look like for this provider to rewrite it. Prompts carry
 * more than text; the provider touches the parts that hold text and hands every
 * other part back untouched.
 */
export interface RedactablePart {
  readonly type: string
  readonly text?: string
}

/**
 * Fields a deployment can set for this provider.
 *
 * There is deliberately no switch that turns the provider off. Redaction is the
 * one feature whose failure is silent: a disabled provider writes the very
 * values this feature exists to keep out of the session log, and neither the
 * user nor the model would see it happen. A rule that over-matches is corrected
 * on the publishing side, where the fix reaches every machine by itself — so the
 * escape hatch for a bad rule is the rule list, never a per-machine switch.
 */
export interface Config {
  /** Term list to load when nothing is cached. Defaults to the copy inside this package. */
  termsPath?: string
  /** Repository that publishes the list. An empty string keeps this build's copy in place. */
  remote?: string
  /** Branch whose tip is the published list. */
  branch?: string
  /** Path of the list inside that branch. */
  file?: string
  /** Directory holding this machine's copies of the list. */
  cacheDirectory?: string
  /** Minutes between refreshes. 0 loads the list once and never contacts the repository. */
  refreshMinutes?: number
  /** Per-request timeout, in milliseconds, for one refresh. */
  timeoutMs?: number
  /** Set to false to report no text for an image instead of reading it locally. */
  vision?: boolean
  /** How long one local recognition may take, in milliseconds. */
  visionTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  termsPath: z.string().default(TERMS_PATH),
  remote: z.string().default(PUBLISHED_TERMS),
  branch: z.string().default('main'),
  file: z.string().default('terms.yaml'),
  cacheDirectory: z.string().default(dshHomePath('redaction')),
  refreshMinutes: z.number().default(5),
  timeoutMs: z.number().default(3000),
  vision: z.boolean().default(true),
  visionTimeoutMs: z.number().default(DEFAULT_VISION_TIMEOUT_MS),
})

/** What the provider has loaded and how much it has replaced so far. */
export interface RedactionStatus {
  /** Always true: this provider has no off switch. */
  readonly enabled: boolean
  /** Revision the loaded term list declares. */
  readonly revision: string | null
  /** Term entries the loaded list declares. */
  readonly terms: number
  /** Regular expressions the loaded list declares. */
  readonly patterns: number
  /** Replacements this process has made since it started. */
  readonly replacements: number
  /** Which copy of the list the loaded rules came from. */
  readonly source: TermSourceKind
  /** When the publisher was last asked, as an ISO timestamp. */
  readonly lastChecked: string | null
  /** Why the last refresh kept the rules it already had. */
  readonly lastError: string | null
  /** Why nothing is being replaced, when a list could not be loaded at all. */
  readonly detail: string | null
  /** Term requests waiting on this machine for a delivery target. */
  readonly pending: number
}

/**
 * A destination that can take a term request off this machine.
 *
 * Nothing in this package implements one: the deployment decides whether a
 * request reaches the publisher through an intranet endpoint, a repository
 * issue, or a person copying a file. Exposing the shape lets a deployment wire
 * its own without this package knowing which one it is.
 */
export interface TermRequestSink {
  /** Name reported back with each delivery. */
  readonly name: string
  /**
   * Hand one request to the publisher.
   * @param request - the request to deliver.
   * @throws When the publisher refused it; the message becomes the request's detail.
   */
  send(request: TermRequest): Promise<void>
}

/** What one delivery attempt did with the requests it was offered. */
export interface TermRequestDelivery {
  /** Sink the requests were offered to, or null when no sink is configured. */
  readonly sink: string | null
  /** Requests the publisher accepted. */
  readonly sent: number
  /** Requests the publisher refused, each recorded with its reason. */
  readonly failed: number
  /** Requests still waiting, which is every one of them when no sink is configured. */
  readonly pending: number
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
      termsPath: config.termsPath ?? TERMS_PATH,
      remote: config.remote ?? PUBLISHED_TERMS,
      branch: config.branch ?? 'main',
      file: config.file ?? 'terms.yaml',
      cacheDirectory: config.cacheDirectory ?? dshHomePath('redaction'),
      refreshMinutes: config.refreshMinutes ?? 5,
      timeoutMs: config.timeoutMs ?? 3000,
      vision: config.vision ?? true,
      visionTimeoutMs: config.visionTimeoutMs ?? DEFAULT_VISION_TIMEOUT_MS,
    }
    this.current = {
      enabled: true,
      revision: null,
      terms: 0,
      patterns: 0,
      replacements: 0,
      source: 'bundled',
      lastChecked: null,
      lastError: null,
      detail: null,
      pending: 0,
    }
    ctx.effect(() => {
      void this.load()
      void this.countPending()
      const minutes = this.config.refreshMinutes
      if (minutes <= 0 || this.config.remote === '') return () => {}
      const timer: NodeJS.Timeout = setInterval(() => {
        void this.refresh()
      }, minutes * 60_000)
      /* A pending refresh must not hold the process open after the session ends. */
      timer.unref()
      return () => {
        clearInterval(timer)
      }
    }, 'redaction: load the term list and refresh it')
    // A tool result is the second way a value reaches the session log: reading a
    // data file, running a query, listing a directory. The decision this handler
    // returns is what the loop commits, so rewriting it here happens before the
    // text is appended anywhere. Registered after every other listener of this
    // event, so it rewrites the text they produced rather than the other way round.
    ctx.on('tools/post-execute', async (_exec, result, next) => {
      const decision = await next()
      if (this.rules.length === 0) return decision
      if (decision.kind === 'block') return { ...decision, feedback: this.redact(decision.feedback) }
      if (decision.value !== undefined) return decision
      const content = this.redact(decision.content ?? result.content)
      // A UI renders the call from this payload and the session log keeps it, so a
      // value left here stays readable in a transcript the model never saw. Read
      // results carry the file's lines in it.
      const payload: JsonValue | undefined = decision.meta ?? result.meta
      const meta = payload === undefined ? undefined : this.redactValue(payload)
      return {
        kind: 'accept',
        content,
        ...meta === undefined ? {} : { meta },
        ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
      }
    })
  }

  /** What the term list declares and how many replacements this process has made. */
  get status(): RedactionStatus {
    return this.current
  }

  /** Where this deployment publishes the list, as the refresh reads it. */
  private get source(): TermSourceConfig {
    return {
      remote: this.config.remote,
      branch: this.config.branch,
      file: this.config.file,
      directory: this.config.cacheDirectory,
      timeoutMs: this.config.timeoutMs,
    }
  }

  /**
   * Load a term list and start refreshing it.
   *
   * The cached copy is preferred because it is the one this machine last saw a
   * publisher confirm, and the copy inside the package is the fallback for an
   * install that never reached the publisher — except when the package carries a
   * later revision, which is what an upgrade looks like. A refresh follows
   * whenever a list was loaded and the deployment tracks a repository.
   * @returns The status after the attempt; `detail` carries any failure reason.
   */
  async load(): Promise<RedactionStatus> {
    const cached = await readCachedTermList(this.config.cacheDirectory)
    let shipped: string | undefined
    try {
      shipped = await readFile(this.config.termsPath, 'utf8')
    } catch (error) {
      if (cached === undefined) this.record(error)
    }
    let adopted = false
    if (cached !== undefined && !supersedes(shipped, cached.text)) {
      adopted = this.tryAdopt(cached.text, cached.path, 'cache')
    }
    if (!adopted && shipped !== undefined) {
      adopted = this.tryAdopt(shipped, this.config.termsPath, 'bundled')
    }
    if (!adopted && cached !== undefined) {
      adopted = this.tryAdopt(cached.text, cached.path, 'cache')
    }
    if (adopted && this.config.refreshMinutes > 0 && this.config.remote !== '') void this.refresh()
    return this.current
  }

  /**
   * Ask the publisher for the list and adopt it when it changed.
   *
   * A refresh that fails or times out keeps the rules already in hand: a client
   * that cannot reach the repository must go on replacing what it replaced before,
   * which is the reason the list is cached at all.
   * @returns The status after the attempt; `lastError` carries a failure reason.
   */
  async refresh(): Promise<RedactionStatus> {
    if (this.config.remote === '') return this.current
    const checked = new Date().toISOString()
    try {
      const text = await fetchTermList(this.source)
      const parsed = parseTermList(text)
      if (!isUsable(parsed)) {
        throw new Error(`the published term list reports ${String(parsed.problems.length)} problem(s)`)
      }
      if (parsed.revision === this.current.revision && this.current.source === 'remote') {
        this.current = { ...this.current, lastChecked: checked, lastError: null }
        return this.current
      }
      this.adopt(text, this.source.remote, 'remote')
      this.current = { ...this.current, lastChecked: checked, lastError: null }
      await writeCachedTermList(this.source, text, parsed.revision)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.current = { ...this.current, lastChecked: checked, lastError: detail }
      this.ctx.logger.warn(`redaction: keeping the term list already loaded: ${detail}`)
    }
    return this.current
  }

  /**
   * Parse a list and make it the rules in force.
   * @param text The list as published or cached.
   * @param origin Where the text came from, for the log and for failure messages.
   * @param source Which copy it is.
   * @throws When the list declares problems or declares nothing usable.
   */
  private adopt(text: string, origin: string, source: TermSourceKind): void {
    const parsed = parseTermList(text)
    if (!isUsable(parsed)) {
      throw new Error(`the term list at ${origin} reports ${String(parsed.problems.length)} problem(s)`)
    }
    this.rules = compileRules(parsed)
    this.current = {
      ...this.current,
      revision: parsed.revision,
      terms: this.rules.filter(rule => rule.kind === 'term').length,
      patterns: this.rules.filter(rule => rule.kind === 'pattern').length,
      source,
      detail: null,
    }
    this.ctx.logger.info(`redaction: ${String(this.rules.length)} rule(s) from ${origin} at ${parsed.revision}`)
  }

  private tryAdopt(text: string, origin: string, source: TermSourceKind): boolean {
    try {
      this.adopt(text, origin, source)
      return true
    } catch (error) {
      this.record(error)
      return false
    }
  }

  /**
   * Record that no list could be loaded, which leaves the provider replacing nothing.
   * @param error Why the attempt failed.
   */
  private record(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    this.rules = []
    this.current = { ...this.current, revision: null, terms: 0, patterns: 0, detail }
    this.ctx.logger.warn(`redaction: nothing will be replaced: ${detail}`)
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
    if (this.rules.length === 0) return [...parts]
    return parts.map((part) => {
      if (part.type !== 'text' || typeof part.text !== 'string') return part
      const text = this.redactText(part.text)
      return text === part.text ? part : { ...part, text }
    })
  }

  /**
   * Rewrite one string, for callers holding text outside a part list.
   * @param text Text to rewrite.
   * @returns The rewritten text, or the input when no rule matched.
   */
  redactText(text: string): string {
    if (this.rules.length === 0) return text
    const result = applyRules(text, this.rules, this.map)
    if (result.hits.length > 0) {
      this.current = { ...this.current, replacements: this.current.replacements + result.hits.length }
    }
    return result.text
  }

  /**
   * Rewrite every string inside a presentation payload.
   *
   * A UI renders the call from this payload and the session log keeps it, so a
   * value that survives here is readable in a transcript even when the model
   * never saw it.
   * @param value The payload, as the tool projected it.
   * @returns The same shape with every string rewritten.
   */
  redactValue(value: JsonValue): JsonValue {
    if (typeof value === 'string') return this.redactText(value)
    if (Array.isArray(value)) return value.map(item => this.redactValue(item))
    if (typeof value === 'object' && value !== null) {
      const rewritten: Record<string, JsonValue> = {}
      for (const [key, item] of Object.entries(value)) rewritten[key] = this.redactValue(item)
      return rewritten
    }
    return value
  }

  /**
   * Read the text out of one encoded image on this machine and redact it.
   *
   * The image is decoded in memory and read by a local recognizer: it is never
   * stored, never returned, and never sent to a model, so a screenshot reaches
   * the session as the text it held and nothing else. A caller that gets
   * `undefined` reports the failure and keeps the image out of the session —
   * handing the pixels to the model is the one outcome this must not produce.
   * @param data The image as canonical base64.
   * @param mediaType Its media type, for the log.
   * @returns The redacted text, or `undefined` when no text could be read.
   */
  async recognizeImage(data: string, mediaType: string): Promise<string | undefined> {
    if (!this.config.vision || this.rules.length === 0) return undefined
    try {
      const text = await recognizeImageText(Buffer.from(data, 'base64'), this.config.visionTimeoutMs)
      return text === '' ? '[图片-无文字]' : this.redactText(text)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`redaction: could not read a ${mediaType} image locally: ${detail}`)
      return undefined
    }
  }

  /**
   * Ask the publisher to add a term to the list.
   *
   * The request is queued on this machine first, so a machine that cannot reach
   * the publisher loses nothing by asking: the term waits in the queue file and
   * a later delivery carries it. A request never holds a value a session
   * matched — it is the missing term itself, which is what a publisher adds.
   * @param term - the term to add to the list.
   * @param note - why the term belongs in the list.
   * @returns The queued request.
   * @throws Error when the term breaks the shape a list entry can hold.
   */
  async requestTerm(term: string, note?: string): Promise<TermRequest> {
    const request = await queueTermRequest(this.config.cacheDirectory, term, note)
    await this.countPending()
    return request
  }

  /**
   * Everything this machine has queued, oldest first.
   * @returns every request the queue file holds, whatever state each one is in.
   */
  async pendingRequests(): Promise<TermRequest[]> {
    return await readTermRequests(this.config.cacheDirectory)
  }

  /**
   * Offer every pending request to a sink and record how each one ended.
   *
   * A sink is optional because the default deployment delivers nothing: the
   * queue exists so a machine can hold a request until someone wires a
   * destination, and this method is the seam that destination plugs into. A
   * request the sink refuses stays on disk as rejected with its reason, so the
   * next reader sees what happened instead of watching the entry disappear.
   * @param sink - destination to offer the requests to; omitted means none is configured.
   * @returns What the attempt did with the queue.
   */
  async deliverRequests(sink?: TermRequestSink): Promise<TermRequestDelivery> {
    const requests = await readTermRequests(this.config.cacheDirectory)
    const waiting = requests.filter(request => request.state === 'pending')
    if (sink === undefined || waiting.length === 0) {
      const pending = waiting.length
      this.current = { ...this.current, pending }
      return { sink: sink?.name ?? null, sent: 0, failed: 0, pending }
    }
    let sent = 0
    let failed = 0
    for (const request of waiting) {
      try {
        await sink.send(request)
        await settleTermRequest(this.config.cacheDirectory, request.id, 'uploaded')
        sent += 1
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        await settleTermRequest(this.config.cacheDirectory, request.id, 'rejected', detail)
        failed += 1
      }
    }
    const pending = await this.countPending()
    this.ctx.logger.info(`redaction: ${sink.name} took ${String(sent)} term request(s) and refused ${String(failed)}`)
    return { sink: sink.name, sent, failed, pending }
  }

  /** Record how many requests are still waiting, for {@link RedactionStatus}. */
  private async countPending(): Promise<number> {
    const requests = await readTermRequests(this.config.cacheDirectory)
    const pending = requests.filter(request => request.state === 'pending').length
    if (pending !== this.current.pending) this.current = { ...this.current, pending }
    return pending
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
