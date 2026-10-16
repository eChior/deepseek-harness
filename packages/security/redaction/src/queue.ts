/**
 * Terms a machine wants added to the published list but cannot deliver yet.
 *
 * A term request is the one piece of redaction state that travels outward, so
 * its file is deliberately plain: the entries are the terms themselves, which
 * is exactly what a publisher needs in order to add them. No matched value from
 * a session ever reaches this file — those live only in the in-memory map.
 *
 * The queue is a file rather than a push because the machine that notices a
 * missing term is often the machine that cannot reach the intranet. Requests
 * accumulate under `pending`; a delivery attempt settles each one as `uploaded`
 * or `rejected`. An installation with no delivery target never changes a state,
 * which is the intended default until a deployment configures one.
 *
 * Every settled write is a full rewrite: a term list gains a handful of entries
 * a month, and one file is the only way to record a state change without a
 * second file to keep in step.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Name of the queue inside the redaction directory. */
export const TERM_REQUEST_FILE = 'pending.jsonl'

/** Settled entries kept on disk; pending ones are never dropped. */
const MAX_SETTLED_REQUESTS = 500

/** Longest term a request may carry, chosen so one request stays one line. */
const MAX_TERM_LENGTH = 64

/** Where a request stands in its journey to the publisher. */
export type TermRequestState = 'pending' | 'uploaded' | 'rejected'

/** One term a machine wants the publisher to add to the list. */
export interface TermRequest {
  /** Identity of the request, stable across rewrites. */
  readonly id: string
  /** The term itself, as the requester typed it. */
  readonly term: string
  /** Why the requester thinks the term belongs in the list. */
  readonly note?: string
  /** When the request was first queued, as an ISO timestamp. */
  readonly createdAt: string
  /** Where the request stands. */
  readonly state: TermRequestState
  /** Why a delivery was refused, when one was. */
  readonly detail?: string
}

/**
 * Refuse a term the queue cannot carry or a list cannot hold.
 * @param term - the candidate term.
 * @throws Error naming the shape rule the term broke.
 */
export function assertTermShape(term: string): void {
  if (term.length === 0) throw new Error('a term request needs a term')
  if (term.length > MAX_TERM_LENGTH) {
    throw new Error(`a term request carries at most ${String(MAX_TERM_LENGTH)} characters`)
  }
  if (term.trim() !== term) throw new Error('a term request must not start or end with whitespace')
  if (/[\r\n\t]/u.test(term)) throw new Error('a term request must fit on one line')
}

/** Read one line back, ignoring anything that is not a request this module wrote. */
function parseRequest(line: string): TermRequest | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const { id, term, createdAt, state } = record
  if (typeof id !== 'string' || typeof term !== 'string' || typeof createdAt !== 'string') return undefined
  if (state !== 'pending' && state !== 'uploaded' && state !== 'rejected') return undefined
  const note = typeof record.note === 'string' ? record.note : undefined
  const detail = typeof record.detail === 'string' ? record.detail : undefined
  return {
    id,
    term,
    ...(note === undefined ? {} : { note }),
    createdAt,
    state,
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * Read the queue, oldest first.
 *
 * A queue that cannot be read is an empty queue: the alternative is refusing to
 * start over a file this module owns and can always rewrite.
 * @param directory - the redaction directory, `<DSH_HOME>/redaction`.
 * @returns every request the file holds; unreadable lines are dropped.
 */
export async function readTermRequests(directory: string): Promise<TermRequest[]> {
  let text: string
  try {
    text = await readFile(join(directory, TERM_REQUEST_FILE), 'utf8')
  } catch {
    return []
  }
  const requests: TermRequest[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const request = parseRequest(line)
    if (request !== undefined) requests.push(request)
  }
  return requests
}

/** Keep every pending request plus the most recent settled ones. */
function prune(requests: readonly TermRequest[]): TermRequest[] {
  const pending = requests.filter(request => request.state === 'pending')
  const settled = requests.filter(request => request.state !== 'pending')
  return [...pending, ...settled.slice(-MAX_SETTLED_REQUESTS)]
}

/**
 * Write the queue back, atomically.
 *
 * The rename is what keeps a crash from leaving a half-written queue: a reader
 * sees either the previous file or the new one, never a truncated line.
 * @param directory - the redaction directory.
 * @param requests - every request that should survive the write.
 */
export async function writeTermRequests(directory: string, requests: readonly TermRequest[]): Promise<void> {
  await mkdir(directory, { recursive: true })
  const target = join(directory, TERM_REQUEST_FILE)
  const scratch = `${target}.tmp`
  const body = prune(requests).map(request => `${JSON.stringify(request)}\n`).join('')
  await writeFile(scratch, body, 'utf8')
  await rename(scratch, target)
}

/**
 * Add one term to the queue, unless it is already waiting there.
 *
 * The duplicate check is on the term, not the request: two people noticing the
 * same missing term should leave one entry, and a term already delivered should
 * be requestable again only by the publisher's own history.
 * @param directory - the redaction directory.
 * @param term - the term to request.
 * @param note - why the term belongs in the list.
 * @returns the request now holding the term, new or already there.
 * @throws Error when the term breaks {@link assertTermShape}.
 */
export async function queueTermRequest(directory: string, term: string, note?: string): Promise<TermRequest> {
  assertTermShape(term)
  const requests = await readTermRequests(directory)
  const waiting = requests.find(request => request.term === term && request.state === 'pending')
  if (waiting !== undefined) return waiting
  const request: TermRequest = {
    id: randomUUID(),
    term,
    ...(note === undefined ? {} : { note }),
    createdAt: new Date().toISOString(),
    state: 'pending',
  }
  await writeTermRequests(directory, [...requests, request])
  return request
}

/**
 * Record how a delivery attempt ended.
 * @param directory - the redaction directory.
 * @param id - identity of the request to settle.
 * @param state - `uploaded` when the publisher took it, `rejected` when it refused.
 * @param detail - the publisher's reason, kept for the next reader.
 * @returns the settled request, or undefined when the queue no longer holds it.
 */
export async function settleTermRequest(
  directory: string,
  id: string,
  state: Exclude<TermRequestState, 'pending'>,
  detail?: string,
): Promise<TermRequest | undefined> {
  const requests = await readTermRequests(directory)
  const found = requests.find(request => request.id === id)
  if (found === undefined) return undefined
  const settled: TermRequest = {
    ...found,
    state,
    ...(detail === undefined ? {} : { detail }),
  }
  await writeTermRequests(directory, requests.map(request => (request.id === id ? settled : request)))
  return settled
}
