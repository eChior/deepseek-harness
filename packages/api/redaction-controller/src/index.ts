/**
 * Host Remote owner for session redaction: the status a Web client shows, the
 * department term lists this machine holds, and the staff directory the upload
 * attribution comes from.
 *
 * The provider owns every one of those facts and this controller keeps no state
 * of its own. What it adds is one lookup the provider cannot do — asking the
 * account service who is signed in, so an upload can be filed under the right
 * department without the user typing it — and the mapping from the provider's
 * records to types the wire can carry.
 *
 * @module @deepseek-ai/dsh-api-redaction-controller
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-redaction'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from 'zod'
import type { RedactionEntryView, RedactionExampleView, RedactionRosterView, RedactionStatusView, RedactionUploadView } from './types.ts'

/** One upload as the page submits it. */
const UploadRequest = z.object({
  name: z.string().min(1).max(128),
  text: z.string().min(1).max(256 * 1024),
})

/** One stored upload, addressed by name. */
const NameRequest = z.object({ name: z.string().min(1).max(128) })

/** One stored upload and the state it should hold. */
const EnabledRequest = z.object({ name: z.string().min(1).max(128), enabled: z.boolean() })

/**
 * Name of the file an upload to this machine becomes.
 *
 * The provider decides the real rules; this only has to fail loudly enough that
 * a caller learns the request was malformed rather than that the upload worked.
 */
const EXAMPLE_FILE = 'terms-local.example.yaml'

/**
 * Read and write the session-redaction state over Remote.
 *
 * Every field the wire carries is display-safe by construction: placeholders
 * replace the sensitive literals, so no reply describes what was rewritten — a
 * status counts, an upload is the file the user wrote, and a directory summary
 * is a headcount.
 */
export class RedactionController extends TypertRemoteService {
  /** Required services: the provider to republish, and the account to attribute an upload to. */
  static inject = ['redaction', 'deepseekAccount']

  /**
   * @param ctx - Host with the redaction provider and the account service mounted.
   */
  constructor(ctx: Context) {
    super(ctx, 'redactionController', { namespace: 'redaction' })
  }

  /**
   * Read the current provider status.
   * @returns the active revision and source of the term list, the compiled term
   *   and pattern counts, the replacement counter for this process, how many
   *   uploaded lists are in force, how many directory names are in force, and how
   *   many term requests are still queued locally.
   */
  @Remote
  status(): Promise<RedactionStatusView> {
    const view = this.ctx.redaction.status
    return Promise.resolve({
      enabled: view.enabled,
      revision: view.revision,
      terms: view.terms,
      patterns: view.patterns,
      replacements: view.replacements,
      source: view.source,
      lastChecked: view.lastChecked,
      lastError: view.lastError,
      detail: view.detail,
      pending: view.pending,
      localFiles: view.localFiles,
      roster: view.roster,
      mappings: view.mappings,
      imageTool: view.imageTool,
    })
  }

  /**
   * Turn the mapping write-back on or off.
   *
   * With it on, an ended session writes its placeholder table to the local
   * mappings directory so the restore tool can put the originals back into an
   * exported file. With it off nothing is written and the table stays in memory
   * until this process ends.
   * @param request - Whether write-back should be on.
   * @returns The value now in force.
   */
  @Remote
  setMappings(request: { readonly enabled: boolean }): Promise<{ readonly enabled: boolean }> {
    return Promise.resolve({ enabled: this.ctx.redaction.setMappings(request.enabled) })
  }

  /**
   * Every placeholder pairing this machine can restore, for the browser that
   * renders its sessions. Each entry is one value the model must not see but the
   * signed-in user may; the client swaps these back into the text it renders and
   * never stores or transmits them further.
   *
   * The table is machine-wide: a placeholder means the same value wherever it is
   * read, so the browser never has to ask which task wrote a pairing, and a
   * session that has not been opened for weeks still shows its originals.
   * @returns Every restorable entry, first-seen order.
   */
  @Remote
  entries(): Promise<readonly RedactionEntryView[]> {
    return Promise.resolve(this.ctx.redaction.entries().map(entry => ({
      placeholder: entry.placeholder,
      category: entry.category,
      original: entry.original,
    })))
  }

  /**
   * Describe the staff directory, including what it says about the caller.
   * @returns the directory counts and, when it lists the signed-in colleague,
   *   the department and employee number an upload should be filed under.
   */
  @Remote
  async roster(): Promise<RedactionRosterView> {
    const summary = this.ctx.redaction.rosterSummary()
    const account = await this.accountName()
    const person = account === null ? undefined : this.ctx.redaction.identify(account)
    return {
      ...summary,
      account,
      department: person?.department ?? null,
      employeeId: person?.employeeId ?? null,
    }
  }

  /**
   * List the term lists uploaded to this machine.
   * @returns one record per file, whether or not it compiles. A file with
   *   problems is listed with them: its author has to see what is wrong.
   */
  @Remote
  async uploads(): Promise<RedactionUploadView[]> {
    const files = await this.ctx.redaction.localFiles()
    return files.map(file => present(file))
  }

  /**
   * Store one uploaded list and put it in force.
   * @param request - the file name and the YAML a department wrote.
   * @returns what the stored file declares.
   * @throws RemoteError when the text does not compile, the name is unusable, or
   *   the machine already holds as many uploads as it takes.
   */
  @Remote
  async upload(request: { readonly name: string; readonly text: string }): Promise<RedactionUploadView> {
    const parsed = UploadRequest.safeParse(request)
    if (!parsed.success) throw badRequest('upload', parsed.error)
    const account = await this.accountName()
    const attribution = account === null ? {} : this.ctx.redaction.attributionFor(account)
    try {
      return present(await this.ctx.redaction.importLocal(parsed.data.name, parsed.data.text, attribution))
    } catch (error) {
      throw rejected('upload', error)
    }
  }

  /**
   * Drop one uploaded list and take its rules back out of force.
   *
   * The wire name is `drop`, not `remove`: the Browser face installs every
   * endpoint as a member of the namespace service, and `remove` is one of that
   * service's own methods, so a `redaction/remove` endpoint makes the whole
   * Client assembly refuse to mount rather than fail one call.
   * @param request - the name the file was uploaded under.
   * @returns whether a file was removed.
   * @throws RemoteError when the payload is malformed.
   */
  @Remote
  async drop(request: { readonly name: string }): Promise<boolean> {
    const parsed = NameRequest.safeParse(request)
    if (!parsed.success) throw badRequest('drop', parsed.error)
    return await this.ctx.redaction.removeLocal(parsed.data.name)
  }

  /**
   * Turn one uploaded list on or off without touching what it declares.
   * @param request - the name and the state it should hold.
   * @returns the stored file, as it now reads.
   * @throws RemoteError when the payload is malformed or no such file exists.
   */
  @Remote
  async setEnabled(request: { readonly name: string; readonly enabled: boolean }): Promise<RedactionUploadView> {
    const parsed = EnabledRequest.safeParse(request)
    if (!parsed.success) throw badRequest('setEnabled', parsed.error)
    try {
      return present(await this.ctx.redaction.setLocalEnabled(parsed.data.name, parsed.data.enabled))
    } catch (error) {
      throw rejected('setEnabled', error)
    }
  }

  /**
   * Hand back the example a department starts from.
   * @returns the file name to save it under and the example itself, comments and
   *   all, exactly as this build ships it.
   */
  @Remote
  async example(): Promise<RedactionExampleView> {
    return { name: EXAMPLE_FILE, text: await this.ctx.redaction.localExample() }
  }

  /**
   * Name the signed-in colleague, for attributing an upload.
   *
   * A machine with nobody signed in, or an account service that cannot answer,
   * yields null rather than a failure: an upload is still worth taking, it just
   * carries no department.
   * @returns the display name, or null.
   */
  private async accountName(): Promise<string | null> {
    try {
      const profile = await this.ctx.deepseekAccount.getProfile({
        version: '0.0.0',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      if (profile === null || profile.status !== 'ready') return null
      const name = (profile.value.name ?? '').trim()
      return name === '' ? null : name
    } catch {
      return null
    }
  }
}

/**
 * Project one stored file onto the wire.
 * @param file - the record the provider keeps.
 * @returns the display-safe view, with each problem folded into one line.
 */
function present(file: {
  readonly name: string
  readonly bytes: number
  readonly revision: string | null
  readonly department: string | null
  readonly author: string | null
  readonly enabled: boolean
  readonly terms: number
  readonly patterns: number
  readonly problems: readonly { readonly line: number; readonly message: string }[]
}): RedactionUploadView {
  return {
    name: file.name,
    bytes: file.bytes,
    revision: file.revision ?? '',
    department: file.department,
    author: file.author,
    enabled: file.enabled,
    terms: file.terms,
    patterns: file.patterns,
    problems: file.problems.map(problem => `${String(problem.line)}: ${problem.message}`),
  }
}

/**
 * Report a payload this namespace cannot accept.
 * @param operation - which method was called.
 * @param error - what the schema objected to; the first message becomes the detail.
 * @returns the error to throw.
 */
function badRequest(operation: string, error: { readonly issues: readonly { readonly message: string }[] }): RemoteError {
  const first = error.issues[0]?.message ?? 'the payload does not match this method'
  return new RemoteError('gateway/bad-request', `invalid payload for redaction.${operation}: ${first}`, {})
}

/**
 * Report a provider refusal in the shape the wire expects.
 * @param operation - which method was called.
 * @param error - what the provider threw.
 * @returns the error to throw.
 */
function rejected(operation: string, error: unknown): RemoteError {
  const detail = error instanceof Error ? error.message : String(error)
  return new RemoteError('gateway/bad-request', `redaction.${operation} was refused: ${detail}`, {})
}

export default RedactionController
