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
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  listLocalTermFiles,
  readLocalTermLists,
  removeLocalTermFile,
  setLocalTermEnabled,
  stampAttribution,
  writeLocalTermFile,
  type LocalTermFile,
  type LocalTermList,
} from './local.ts'
import { RedactionMap, type RedactionEntry } from './map.ts'
import type { Agent, SessionStartSource } from '@deepseek-ai/dsh-agent'
import { findPerson, ROSTER_PATH, readRoster, type Roster, type RosterPerson } from './roster.ts'
import { queueTermRequest, readTermRequests, settleTermRequest, type TermRequest } from './queue.ts'
import { fetchTermList, readCachedTermList, writeCachedTermList, type TermSourceConfig, type TermSourceKind } from './source.ts'
import { compileRules, isUsable, parseTermList, type ParsedTermList, type RedactionCategory, type RedactionRule } from './terms.ts'
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

/** Upload template this build ships, for a department to fill in and hand back. */
const LOCAL_EXAMPLE_PATH = fileURLToPath(new URL('../assets/terms-local.example.yaml', import.meta.url))

/** Repository a deployment publishes the list in, read at start and every few minutes. */
const PUBLISHED_TERMS = 'http://10.151.5.175:3000/ITPublic/dsh-redaction-terms'

/** The one mapping file this machine appends to, under the mappings directory. */
const MAPPING_FILE = 'mappings.jsonl'

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
  /**
   * Add every colleague and department from the shipped staff directory to the
   * rules, and let an upload inherit its department from it.
   *
   * Per-machine rather than fixed, because the directory belongs to one
   * deployment: a build that carries somebody else's staff list must be able to
   * leave it out, and a user who would rather not have their own name rewritten
   * needs a switch they can reach.
   */
  includeRoster?: boolean
  /**
   * Ciphertext of the staff directory. Defaults to the copy inside this package.
   *
   * Exposed so a deployment can point at its own directory without rebuilding,
   * and so a test can reach one it sealed itself instead of reading the list
   * that ships here.
   */
  rosterPath?: string
  /** Persist the placeholder table to the local mappings directory when a session ends. */
  mappings?: boolean
  /** Deny the read-image tool to every agent of this deployment. Defaults to true: images go through local OCR, not the model. */
  readImage?: boolean
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
  includeRoster: z.boolean().default(true),
  rosterPath: z.string().default(ROSTER_PATH),
  mappings: z.boolean().default(true),
  readImage: z.boolean().default(true),
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
  /** Uploaded lists that compiled into the rules in force. */
  readonly localFiles: number
  /** Names the shipped staff directory contributed to the rules, or 0 when it is off. */
  readonly roster: number
  /** Whether an ended session writes its placeholder table to the local mappings directory. */
  readonly mappings: boolean
  /** Whether the read-image tool is denied for every agent of this deployment. */
  readonly imageTool: boolean
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
  /** The published list in force, absent until one loads without problems. */
  private main: { readonly parsed: ParsedTermList; readonly origin: string; readonly source: TermSourceKind } | undefined = undefined
  /** Uploaded lists as last read, whether or not every one of them compiled. */
  private local: LocalTermList[] = []
  /** Staff directory as last read, absent when it is off or could not be opened. */
  private roster: Roster | undefined = undefined
  private current: RedactionStatus
  /**
   * Switches the settings surface can flip at runtime. They start from the
   * deployment defaults and live past the constructor, so turning the mapping
   * write-back off does not need a restart.
   */
  private mappingsOn: boolean
  private readImageOn: boolean
  /** How many entries have already reached a mapping file on this machine. */
  private written = 0
  /** The read-back of the mapping files, awaited before the first write. */
  private readonly ready: Promise<void>

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
      includeRoster: config.includeRoster ?? true,
      rosterPath: config.rosterPath ?? ROSTER_PATH,
      mappings: config.mappings ?? true,
      readImage: config.readImage ?? true,
    }
    this.mappingsOn = this.config.mappings
    this.readImageOn = this.config.readImage
    // Started here rather than in an effect: a session can end before an effect
    // runs, and a write must never outrun the read it depends on.
    this.ready = this.loadMappings()
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
      localFiles: 0,
      roster: 0,
      mappings: this.config.mappings,
      imageTool: this.config.readImage,
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
    // A session's placeholders only stay restorable while the mapping exists, so
    // the mapping goes to the local mappings directory the moment the session
    // leaves the store. The file is machine-wide: a placeholder means the same
    // value in every conversation, so leaving it behind for one task would lose
    // the pairings another task still shows. The restore tool reads it there,
    // puts the originals back into exported files, and leaves the file in place.
    ctx.on('session/disposed', () => {
      void this.writeMappings()
    })
    // Images go through the local reader, so the model never needs a tool that
    // would hand a picture to the provider. Deny the tool for every agent this
    // deployment creates; the status view tells the settings page it happened.
    ctx.on('agent/created', ({ agent }: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }) => {
      if (!this.readImageOn) return
      agent.ctx.tools.guard(execution => execution.name === 'read_image'
        ? 'read_image is not available: this deployment reads images through local OCR'
        : undefined)
    })
  }

  /** Whether an ended session writes its placeholder table to the mappings directory. */
  get mappings(): boolean {
    return this.mappingsOn
  }

  /**
   * Turn the mapping write-back on or off for the rest of this process.
   * @param on - whether an ended session should leave a restorable table behind.
   * @returns The value now in force.
   */
  setMappings(on: boolean): boolean {
    this.mappingsOn = on
    this.current = { ...this.current, mappings: on }
    return this.mappingsOn
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
    await this.reloadLocal()
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
    if (!adopted) {
      // Nothing published could be read at all; the uploads stand on their own.
      this.main = undefined
      this.recompile()
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
   * Parse a list and make it the published half of the rules in force.
   *
   * Every uploaded list stays in force across this call, because the two answer
   * different questions: the published one says what the whole company must not
   * leak, an uploaded one says what this department must not.
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
    this.main = { parsed, origin, source }
    this.recompile()
    this.current = { ...this.current, detail: null }
    const uploaded = this.current.localFiles === 0 ? '' : ` plus ${String(this.current.localFiles)} uploaded list(s)`
    this.ctx.logger.info(`redaction: ${String(this.rules.length)} rule(s) from ${origin} at ${parsed.revision}${uploaded}`)
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
   * Record that the published list could not be loaded.
   *
   * Uploaded lists keep replacing: a department writes its own terms because the
   * published list does not cover them, and losing the publisher is no reason to
   * stop honouring what it wrote.
   * @param error Why the attempt failed.
   */
  private record(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    this.main = undefined
    this.recompile()
    this.current = { ...this.current, detail }
    const outcome = this.rules.length === 0
      ? 'nothing will be replaced'
      : `keeping ${String(this.rules.length)} rule(s) from uploaded lists`
    this.ctx.logger.warn(`redaction: ${outcome}: ${detail}`)
  }

  /** Read the uploaded lists and the staff directory, so a synchronous recompile can use both. */
  private async reloadLocal(): Promise<void> {
    this.local = await readLocalTermLists(this.config.cacheDirectory)
    await this.reloadRoster()
  }

  /**
   * Read the staff directory, unless the deployment turned it off.
   *
   * A directory that cannot be opened — no key in a build that shipped none, or
   * a ciphertext this build cannot read — leaves nothing in force and says so
   * once. It is a convenience the published list also answers, so losing it is
   * never a reason to stop replacing what the published list already covers.
   */
  private async reloadRoster(): Promise<void> {
    if (!this.config.includeRoster) {
      this.roster = undefined
      return
    }
    try {
      this.roster = await readRoster(this.config.rosterPath)
    } catch (error) {
      this.roster = undefined
      const detail = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`redaction: no staff directory is in force: ${detail}`)
    }
  }

  /**
   * Rebuild the rules from the published list in hand plus every usable upload.
   *
   * Uploaded categories come first so a department's own rule wins when two of
   * them match the same span at the same length: the published list is the floor
   * every install stands on, not the ceiling. Only lists that parsed without a
   * single problem take part, so a half-finished upload cannot disable the rest.
   */
  private recompile(): void {
    const uploaded = this.local.filter(entry => entry.file.enabled && isUsable(entry.list))
    const roster = this.rosterCategories()
    const main = this.main
    const rules = main === undefined && uploaded.length === 0 && roster.length === 0
      ? []
      : compileRules({
        version: main?.parsed.version ?? '1',
        revision: main?.parsed.revision ?? 'local',
        categories: [
          ...uploaded.flatMap(entry => entry.list.categories),
          ...roster,
          ...main?.parsed.categories ?? [],
        ],
      })
    this.rules = rules
    this.current = {
      ...this.current,
      revision: main?.parsed.revision ?? null,
      terms: rules.filter(rule => rule.kind === 'term').length,
      patterns: rules.filter(rule => rule.kind === 'pattern').length,
      ...main === undefined ? {} : { source: main.source },
      localFiles: uploaded.length,
      roster: roster.reduce((count, category) => count + category.terms.length, 0),
      mappings: this.mappingsOn,
      imageTool: this.readImageOn,
    }
  }

  /**
   * The staff directory no longer contributes redaction rules.
   *
   * It used to turn colleagues and departments into `person`/`department`
   * terms; the confidentiality office retired that behaviour because redacting
   * the people a colleague mentions makes the conversation unreadable. The
   * roster itself stays loaded: {@link identify} and {@link attributionFor}
   * still read it to stamp uploads and describe the signed-in account.
   * @returns Always empty; kept so the recompile seam stays in one place.
   */
  private rosterCategories(): RedactionCategory[] {
    return []
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
   * Append the placeholders this process issued to the machine's mapping file.
   *
   * One file for the machine, not one per session: a placeholder means the same
   * value wherever it is read, so `[产品-3]` minted in one task has to restore in
   * the next one too. A reader therefore never has to know which task wrote the
   * pairing it is looking at. Repeated turns append to the same file.
   *
   * The map is NOT emptied. An entry that leaves memory stops restoring while the
   * reader is still looking at the session, and the counters would restart from
   * one and hand a fresh value a number this file already gave to another.
   */
  private async writeMappings(): Promise<void> {
    // Checked before anything is read: with write-back off nothing leaves this
    // process at all.
    if (!this.mappingsOn) return
    await this.ready
    const all = this.map.liveEntries()
    // Only what this process added since the last file. The entries read back at
    // startup are not in the live log at all, and the ones already appended must
    // not be appended twice.
    const fresh = all.slice(this.written)
    if (fresh.length === 0) return
    this.written = all.length
    const directory = join(this.config.cacheDirectory, 'mappings')
    try {
      await mkdir(directory, { recursive: true })
      const body = fresh.map(entry => JSON.stringify({ placeholder: entry.placeholder, category: entry.category, original: entry.original })).join('\n') + '\n'
      await appendFile(join(directory, MAPPING_FILE), body, 'utf8')
    } catch {
      // A mapping that cannot be written only costs the restore step; the
      // placeholders in the session stay in force and this process keeps
      // restoring them for as long as it lives.
    }
  }

  /**
   * Read the mapping files this machine already holds back into the map, so
   * text from an earlier process still restores and a fresh value never takes a
   * number one of those files already used.
   *
   * Files are read in name order and the first entry for a value wins, which is
   * the order the restore tool applies them in.
   */
  private async loadMappings(): Promise<void> {
    const directory = join(this.config.cacheDirectory, 'mappings')
    // Every file is folded into the one table, including the per-session files an
    // earlier release wrote: their pairings are just as valid today.
    for (const name of await mappingFiles(directory)) {
      const entries = await readMappingFile(directory, name)
      if (entries.length === 0) continue
      this.map.adopt(entries)
    }
    this.written = this.map.liveEntries().length
  }

  /**
   * Every pairing the machine can restore right now, read back before answering.
   * @returns The entries the mapping file records, in the order they were written.
   */
  async mappingsFor(): Promise<readonly RedactionEntry[]> {
    await this.ready
    return this.map.entries()
  }

  /**
   * Every pairing this machine can currently restore, for a reader that renders
   * session text to the user. The values are what the model must not see but the
   * user may: they cross to the browser that renders this machine's own sessions
   * and nowhere else.
   *
   * Includes what earlier processes wrote to a mapping file, because a session
   * outlives the process that wrote it and a reader coming back to an older
   * conversation must still be shown the originals behind its placeholders.
   * @returns Every restorable entry, this process's own first.
   */
  entries(): readonly RedactionEntry[] {
    return this.map.entries()
  }

  /**
   * Turn the placeholders a text carries back into the values they stand for.
   * @param text Text that may carry placeholders.
   * @returns The text with every placeholder it carries restored.
   */
  restore(text: string): string {
    return this.map.restore(text)
  }

  /**
   * Look one colleague up by the name the account service reports.
   * @param account Name as the signed-in account gives it.
   * @returns The directory entry, or undefined when the directory is off or lists nobody by that name.
   */
  identify(account: string): RosterPerson | undefined {
    if (!this.config.includeRoster) return undefined
    const roster = this.roster
    if (roster === undefined) return undefined
    return findPerson(roster, account)
  }

  /**
   * The attribution an upload by this colleague should carry.
   *
   * The department is the one fact a colleague cannot be asked to type correctly
   * and the one fact the directory already knows, so an upload is stamped from
   * it; a name the directory does not list leaves the department empty rather
   * than guessing at one.
   * @param account Name as the signed-in account gives it.
   * @returns Author and, when the directory knows it, department.
   */
  attributionFor(account: string): { department?: string; author?: string } {
    const name = account.trim()
    if (name === '') return {}
    const person = this.identify(name)
    return {
      author: name,
      ...person === undefined || person.department === '' ? {} : { department: person.department },
    }
  }

  /**
   * What the staff directory contributes, for a page that has to describe it.
   * @returns Whether it is on, and how many colleagues and departments it lists.
   */
  rosterSummary(): { enabled: boolean; revision: string | null; people: number; departments: number } {
    const roster = this.roster
    return {
      enabled: this.config.includeRoster,
      revision: roster?.revision ?? null,
      people: roster?.people.length ?? 0,
      departments: roster?.departments.length ?? 0,
    }
  }

  /**
   * List the lists uploaded on this machine, including the ones that do not compile.
   *
   * A file that reports problems is still listed: whoever wrote it has to see what
   * is wrong with it, and hiding it would leave them with a file they cannot find
   * and a rule that silently does nothing.
   * @returns One record per file, as last read.
   */
  async localFiles(): Promise<LocalTermFile[]> {
    return await listLocalTermFiles(this.config.cacheDirectory)
  }

  /**
   * Store one uploaded list and put it in force.
   * @param name File name the upload is stored under.
   * @param text The YAML a department wrote, in the format this provider reads.
   * @param attribution Department and person to name when the text names neither.
   * @returns What the stored file declares.
   * @throws LocalTermError when the text does not compile or the machine is full.
   */
  async importLocal(name: string, text: string, attribution: { department?: string; author?: string } = {}): Promise<LocalTermFile> {
    const file = await writeLocalTermFile(this.config.cacheDirectory, name, stampAttribution(text, attribution))
    await this.reloadLocal()
    this.recompile()
    this.ctx.logger.info(`redaction: uploaded the term list ${file.name} with ${String(file.terms)} term(s) and ${String(file.patterns)} pattern(s)`)
    return file
  }

  /**
   * Drop one uploaded list and take its rules back out of force.
   * @param name File name as it was uploaded.
   * @returns True when a file was removed.
   */
  async removeLocal(name: string): Promise<boolean> {
    const removed = await removeLocalTermFile(this.config.cacheDirectory, name)
    if (!removed) return false
    await this.reloadLocal()
    this.recompile()
    this.ctx.logger.info(`redaction: removed the uploaded term list ${name}`)
    return true
  }

  /**
   * Turn one uploaded list on or off without touching what it declares.
   *
   * The published list has no such switch: it is the floor every install stands
   * on, and a client that could turn it off would spend part of its life
   * replacing nothing.
   * @param name File name as it was uploaded.
   * @param enabled Whether the list should take part.
   * @returns The stored file as it reads after the change.
   * @throws LocalTermError when no list is stored under that name.
   */
  async setLocalEnabled(name: string, enabled: boolean): Promise<LocalTermFile> {
    const file = await setLocalTermEnabled(this.config.cacheDirectory, name, enabled)
    await this.reloadLocal()
    this.recompile()
    this.ctx.logger.info(`redaction: the uploaded list ${file.name} is now ${enabled ? 'in' : 'out of'} force`)
    return file
  }

  /**
   * The upload template this build ships, for a department to start from.
   * @returns The template as YAML text.
   */
  async localExample(): Promise<string> {
    return await readFile(LOCAL_EXAMPLE_PATH, 'utf8')
  }
}

/**
 * Names of the mapping files in one directory, oldest name first; empty when the
 * directory does not exist yet.
 * @param directory Directory that holds one `.jsonl` file per task.
 * @returns The file names, sorted, or an empty list.
 */
async function mappingFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter(name => name.endsWith('.jsonl')).sort()
  } catch {
    // No directory yet: this install has never ended a session with the
    // write-back on.
    return []
  }
}

/**
 * Entries recorded in one mapping file.
 * @param directory Directory that holds the file.
 * @param name File name to read.
 * @returns The entries it records; empty when it is missing or empty.
 */
async function readMappingFile(directory: string, name: string): Promise<RedactionEntry[]> {
  let body: string
  try {
    body = await readFile(join(directory, name), 'utf8')
  } catch {
    return []
  }
  const entries: RedactionEntry[] = []
  for (const line of body.split('\n')) {
    const entry = parseMappingLine(line)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

/**
 * One line of a mapping file, or undefined when it is blank or malformed.
 * @param line Raw line from a `.jsonl` mapping file.
 * @returns The entry it records, when it records a complete one.
 */
function parseMappingLine(line: string): RedactionEntry | undefined {
  if (line.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { placeholder, category, original } = parsed as Partial<RedactionEntry>
    if (typeof placeholder !== 'string' || typeof category !== 'string' || typeof original !== 'string') return undefined
    return { placeholder, category, original }
  } catch {
    return undefined
  }
}
