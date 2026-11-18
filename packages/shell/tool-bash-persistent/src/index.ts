/**
 * Model-facing persistent `bash` tool over the owner-scoped PTY seam.
 * @module @deepseek-ai/dsh-tool-bash-persistent
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { truncateWithoutSplittingSurrogatePair } from '@deepseek-ai/dsh-output-retention'
import type { JobHandle, JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendResult,
  TerminalSessionId,
} from '@deepseek-ai/dsh-terminal'
import { deadline, timeoutOf, type Deadline } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'

// TODO: Replace the file-search advice; arbitrary command output need not come from a searchable file.
const TRUNCATED_MESSAGE = '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>'
const LOST_PREFIX_MESSAGE = '<response clipped><NOTE>The beginning of this command output was dropped by the terminal scrollback limit. The following text is the earliest retained output.</NOTE>\n'
const SHELL_RESET_MESSAGE = 'The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.'
// Status trailer for a command that never reported an exit code; settled
// commands append `[Command finished with exit code N]` instead (see renderCaptured).
const TIMEOUT_STATUS_MARKER = '[Command timed out]'
const TIMEOUT_CODE = 'PERSISTENT_BASH_TIMEOUT'
// One page is enough to find a just-emitted completion marker; the full
// scrollback is assembled only when a command settles or needs partial output.
const SCROLLBACK_PAGE_LINES = 1_000
const POLL_INTERVAL_MS = 25
// A command still running after this window stops blocking the model's turn:
// it becomes a background job that keeps polling the same PTY.
const FOREGROUND_WINDOW_MS = 2_000

const DEFAULT_DESCRIPTION = 'Run commands in a persistent bash shell. State, including the current directory and exported environment variables, persists across calls for this agent.'

interface ResolvedConfig {
  backendType: string
  timeoutMs: number
  maxOutputChars: number
  description: string
}

interface CommandMarkers {
  start: string
  end: string
}

interface RetainedOutput {
  text: string
  truncated: boolean
}

interface CapturedOutput {
  text: string
  incomplete: boolean
  exitCode?: number
}

interface PersistentShells {
  get(owner: Agent, signal: AbortSignal): Promise<TerminalSessionId>
  reset(owner: Agent, reason: string): Promise<void>
}


/** The command one owner's persistent shell is currently executing in the background. */
interface ActiveShellCommand {
  readonly command: string
  readonly jobId: JobId
}

/** One observation of a command still running in its persistent shell. */
type FollowStep =
  | { kind: 'complete'; latest: TerminalReadResult; output: CapturedOutput }
  | { kind: 'timedOut'; latest: TerminalReadResult; timeoutMs: number }
  | { kind: 'aborted'; latest: TerminalReadResult }
  | { kind: 'cancelled' }
  | { kind: 'windowExpired' }
  | { kind: 'shellExit'; latest: TerminalReadResult; status: ShellExitStatus }
  | { kind: 'stdinRead'; latest: TerminalReadResult }
  | { kind: 'pending'; latest: TerminalReadResult }
  | { kind: 'failed'; error: unknown }

interface ShellExitStatus {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function duplicateCommandResult(active: ActiveShellCommand): string {
  return [
    'command_started: false',
    `The persistent bash shell is still running this exact command as background job ${active.jobId}: ${active.command}`,
    `Collect that job's output with job_output (job_id: ${active.jobId}). The command was not started again.`,
  ].join('\n')
}

function busyCommandResult(active: ActiveShellCommand): string {
  return [
    'requested_command_not_executed: true',
    `The persistent bash shell is busy with background job ${active.jobId}, which is still running a different command: ${active.command}`,
    'This command was not started and was not queued; it shares the same shell, so collect that job with job_output or stop it with job_kill and retry.',
  ].join('\n')
}

function promotedCommandResult(command: string, jobId: JobId): string {
  return [
    `Command exceeded the ${FOREGROUND_WINDOW_MS}ms foreground window and continues in the same persistent shell as background job ${jobId}.`,
    `Its command was not restarted, and the shell keeps its process id, working directory, and exported environment. Collect its output with job_output (job_id: ${jobId}) or stop it with job_kill.`,
    command,
  ].join('\n')
}

/**
 * Follows one already-written command to completion over its persistent shell.
 *
 * The first step writes the wrapped command; later steps only poll the session
 * with an empty send, so promoting the command to a background job never
 * re-runs it. The foreground window closes the model's turn without touching
 * the shell, while the hard deadline keeps running for both phases.
 */
class CommandFollower {
  private first = true
  private fallback = ''
  private fallbackTruncated = false
  private current: TerminalSendOperation | undefined
  private currentDone: Promise<TerminalSendResult> | undefined
  private cancelled = false
  private cancelReason: string | undefined
  private readonly cancelGate = Promise.withResolvers<void>()
  private readonly upstreamGate: Promise<'abort'>
  private upstreamActive = true
  private windowGate: Promise<'window'> | undefined
  private windowTimer: ReturnType<typeof setTimeout> | undefined
  private readonly deadlineGate: Promise<'expired'>

  constructor(
    private readonly ctx: Context,
    private readonly owner: Agent,
    readonly sessionId: TerminalSessionId,
    readonly marker: CommandMarkers,
    private readonly wrapped: string,
    private readonly deadlineSignal: AbortSignal,
    upstreamSignal: AbortSignal,
  ) {
    this.upstreamGate = new Promise<'abort'>((resolve) => {
      if (upstreamSignal.aborted) {
        resolve('abort')
        return
      }
      upstreamSignal.addEventListener('abort', () => { resolve('abort') }, { once: true })
    })
    // The hard deadline aborts the send so the backend cancels the foreground
    // process group; observing it here also guarantees the follower reports
    // timedOut even if a backend settles the send late.
    this.deadlineGate = new Promise<'expired'>((resolve) => {
      if (deadlineSignal.aborted) {
        resolve('expired')
        return
      }
      deadlineSignal.addEventListener('abort', () => { resolve('expired') }, { once: true })
    })
  }

  /** Start the foreground window; after it expires the command belongs to a job. */
  openWindow(ms: number): void {
    this.windowGate = new Promise<'window'>((resolve) => {
      this.windowTimer = setTimeout(() => { resolve('window') }, ms)
    })
  }

  /** Close the foreground window and stop observing caller cancellation. */
  promote(): void {
    this.upstreamActive = false
    this.closeWindow()
  }

  /** Restore foreground cancellation observation after a failed promotion. */
  resumeForeground(): void {
    this.upstreamActive = true
  }

  /** Clear the foreground window timer; safe to call repeatedly. */
  closeWindow(): void {
    this.windowGate = undefined
    if (this.windowTimer !== undefined) clearTimeout(this.windowTimer)
    this.windowTimer = undefined
  }

  /** Request cancellation of the in-flight send; idempotent. */
  requestCancel(reason?: string): void {
    if (this.cancelled) return
    this.cancelled = true
    this.cancelReason = reason
    this.current?.cancel()
    this.cancelGate.resolve()
  }

  get cancelDetail(): string | undefined {
    return this.cancelReason
  }

  private isCancelled(): boolean {
    return this.cancelled
  }

  get fallbackText(): string {
    return this.fallback
  }

  get fallbackWasTruncated(): boolean {
    return this.fallbackTruncated
  }

  /** Partially captured output from the start marker through the newest chunk. */
  visible(latest: TerminalReadResult): CapturedOutput {
    return partialOutput(latest, this.marker, this.fallback, this.fallbackTruncated)
  }

  /** Give a cancelled send a bounded chance to settle before the job reports killed.
   * @param ms - how long to wait for the shell to come back to its prompt.
   * @returns true when the send settled inside the budget, false when it is still winding down.
   */
  async settleWithin(ms: number): Promise<boolean> {
    const done = this.currentDone
    if (done === undefined) return true
    const settled = new Promise<boolean>((resolve) => { done.then(() => { resolve(true) }, () => { resolve(true) }) })
    const expired = new Promise<boolean>((resolve) => {
      setTimeout(() => { resolve(false) }, ms)
    })
    return await Promise.race([settled, expired])
  }

  /** Poll one step; never writes the command more than once. */
  async step(): Promise<FollowStep> {
    if (this.isCancelled()) return { kind: 'cancelled' }
    const status = this.ctx.terminals.list(this.owner)
      .find(session => session.sessionId === this.sessionId)?.status
    if (status?.kind === 'exited') {
      return {
        kind: 'shellExit',
        latest: this.readLatest(),
        status: { exitCode: status.exitCode, signal: status.signal },
      }
    }
    if (this.current === undefined) {
      try {
        const operation = this.ctx.terminals.startSend(this.owner, this.sessionId, {
          text: this.first ? this.wrapped : '',
          submit: this.first,
          signal: this.deadlineSignal,
        })
        this.first = false
        this.current = operation
        this.currentDone = operation.done
      } catch (error: unknown) {
        return { kind: 'failed', error }
      }
    }
    const done = this.currentDone
    if (done === undefined) {
      return { kind: 'failed', error: new Error('persistent bash send has no completion promise') }
    }
    const waits: Array<Promise<TerminalSendResult | 'cancel' | 'window' | 'abort' | 'expired'>> = [
      done,
      this.cancelGate.promise.then(() => 'cancel' as const),
      this.deadlineGate,
    ]
    if (this.upstreamActive) waits.push(this.upstreamGate)
    if (this.windowGate !== undefined) waits.push(this.windowGate)
    let raced: TerminalSendResult | 'cancel' | 'window' | 'abort' | 'expired'
    try {
      raced = await Promise.race(waits)
    } catch (error: unknown) {
      this.current = undefined
      this.currentDone = undefined
      return { kind: 'failed', error }
    }
    // The send may settle at the same moment cancellation arrives; the
    // cancellation gate wins so job_kill reports killed, never completed.
    if (this.isCancelled() || raced === 'cancel') return { kind: 'cancelled' }
    if (raced === 'window') {
      this.closeWindow()
      const latest = this.readLatest()
      const timedOut = timeoutOf(this.deadlineSignal, TIMEOUT_CODE)
      if (timedOut !== undefined) return { kind: 'timedOut', latest, timeoutMs: timedOut.timeoutMs }
      if (this.deadlineSignal.aborted) return { kind: 'aborted', latest }
      return { kind: 'windowExpired' }
    }
    if (raced === 'expired') {
      const latest = this.readLatest()
      const timedOut = timeoutOf(this.deadlineSignal, TIMEOUT_CODE)
      return { kind: 'timedOut', latest, timeoutMs: timedOut?.timeoutMs ?? 0 }
    }
    if (raced === 'abort') {
      const latest = this.readLatest()
      const timedOut = timeoutOf(this.deadlineSignal, TIMEOUT_CODE)
      if (timedOut !== undefined) return { kind: 'timedOut', latest, timeoutMs: timedOut.timeoutMs }
      return { kind: 'aborted', latest }
    }
    const operation = this.current
    this.current = undefined
    this.currentDone = undefined
    const incremental = operation.readOutput()
    this.fallback = incremental.delta.length > 0 ? this.fallback + incremental.delta : raced.viewport
    this.fallbackTruncated ||= incremental.truncated || raced.truncated
    const latest = this.readLatest()
    const timedOut = timeoutOf(this.deadlineSignal, TIMEOUT_CODE)
    if (timedOut !== undefined) return { kind: 'timedOut', latest, timeoutMs: timedOut.timeoutMs }
    if (this.deadlineSignal.aborted) return { kind: 'aborted', latest }
    if (latest.text.includes(this.marker.end)) {
      const complete = commandOutput(
        retainedScrollback(this.ctx, this.owner, this.sessionId, latest),
        this.marker,
      )
      if (complete !== undefined) return { kind: 'complete', latest, output: complete }
    }
    if (raced.sessionStatus.kind === 'exited') {
      return {
        kind: 'shellExit',
        latest,
        status: { exitCode: raced.sessionStatus.exitCode, signal: raced.sessionStatus.signal },
      }
    }
    if (raced.waitReason === 'stdin_read') return { kind: 'stdinRead', latest }
    return { kind: 'pending', latest }
  }

  private readLatest(): TerminalReadResult {
    return this.ctx.terminals.read(this.owner, this.sessionId, {
      offset: 0,
      count: SCROLLBACK_PAGE_LINES,
    })
  }
}

/**
 * Drive a promoted command to settlement on the job's producer face.
 * Output chunks are appended incrementally; every terminal outcome is
 * reported as a `JobOutcome` so `job_output` sees a structured result.
 */
async function runBackgroundCommand(
  ctx: Context,
  shells: PersistentShells,
  owner: Agent,
  config: ResolvedConfig,
  follower: CommandFollower,
  handle: JobHandle,
  resolve: (outcome: JobOutcome) => void,
): Promise<void> {
  let emitted = ''
  const append = (output: CapturedOutput): void => {
    if (output.text === emitted) return
    if (output.text.startsWith(emitted)) {
      const chunk = output.text.slice(emitted.length)
      if (chunk.length > 0) handle.append(chunk)
    } else if (output.text.length > 0) {
      handle.append(output.text, { gapBefore: true })
    }
    emitted = output.text
  }
  try {
    while (true) {
      const step = await follower.step()
      switch (step.kind) {
        case 'cancelled': {
          handle.updateProgress('stopping')
          if (!await follower.settleWithin(1_000)) {
            // The foreground process group ignored the interrupt: reset before settling so the
            // next command never starts against a shell that is still winding down.
            await shells.reset(owner, 'persistent bash command cancelled')
          }
          resolve({ status: 'killed', detail: follower.cancelDetail ?? 'cancelled by request' })
          return
        }
        case 'timedOut': {
          append(follower.visible(step.latest))
          await shells.reset(owner, 'persistent bash command timed out')
          resolve({
            status: 'failed',
            detail: `timed out after ${Math.round(step.timeoutMs / 1000)} seconds; the persistent shell was reset`,
          })
          return
        }
        case 'aborted': {
          handle.updateProgress('stopping')
          if (!await follower.settleWithin(1_000)) {
            await shells.reset(owner, 'persistent bash command cancelled')
          }
          resolve({ status: 'killed', detail: 'cancelled by request' })
          return
        }
        case 'failed': {
          await shells.reset(owner, 'persistent bash send failed')
          resolve({ status: 'failed', detail: errorMessage(step.error) })
          return
        }
        case 'shellExit': {
          append(follower.visible(step.latest))
          const text = await respondToSessionExit(
            ctx, shells, owner, follower.sessionId, step.status, follower.marker,
            follower.fallbackText, follower.fallbackWasTruncated, config,
          )
          resolve({ status: 'failed', detail: text })
          return
        }
        case 'complete': {
          append(step.output)
          if (step.output.exitCode !== undefined && step.output.exitCode !== 0) {
            resolve({
              status: 'failed',
              detail: `command finished with exit code ${step.output.exitCode}`,
            })
          } else {
            resolve({ status: 'completed', detail: 'command finished' })
          }
          return
        }
        case 'stdinRead': {
          append(follower.visible(step.latest))
          resolve({
            status: 'completed',
            detail: 'the shell returned to its prompt before reporting an exit code',
          })
          return
        }
        case 'pending': {
          append(follower.visible(step.latest))
          break
        }
        case 'windowExpired':
          // A promoted follower never reports another window.
          break
      }
      await pause()
    }
  } catch (error: unknown) {
    resolve({ status: 'failed', detail: errorMessage(error) })
  }
}

/** Register the promoted command as a job and hand it the remaining deadline. */
function startBackgroundCommand(
  ctx: Context,
  shells: PersistentShells,
  owner: Agent,
  command: string,
  config: ResolvedConfig,
  follower: CommandFollower,
  busy: WeakMap<Agent, ActiveShellCommand>,
  hardDeadline: Deadline,
): JobId {
  const outcome = Promise.withResolvers<JobOutcome>()
  follower.promote()
  let jobId: JobId
  try {
    jobId = ctx.jobs.start({
      kind: 'bash',
      label: command,
      owner: owner.id,
      run: (handle) => {
        void runBackgroundCommand(ctx, shells, owner, config, follower, handle, outcome.resolve)
        return {
          done: outcome.promise,
          cancel: (reason?: string) => { follower.requestCancel(reason) },
        }
      },
    })
  } catch (error: unknown) {
    follower.resumeForeground()
    throw error
  }
  busy.set(owner, { command, jobId })
  const clearBusy = (): void => {
    if (busy.get(owner)?.jobId === jobId) busy.delete(owner)
  }
  void outcome.promise.then(clearBusy, clearBusy)
  void outcome.promise.finally(() => { hardDeadline[Symbol.dispose]() })
  return jobId
}

function maybeTruncate(content: string, maxOutputChars: number, incomplete = false): string {
  if (content.length <= maxOutputChars && !incomplete) return content
  return content.length <= maxOutputChars
    ? content + TRUNCATED_MESSAGE
    : truncateWithoutSplittingSurrogatePair(content, maxOutputChars) + TRUNCATED_MESSAGE
}

function markers(): CommandMarkers {
  const nonce = randomUUID()
  return {
    start: `__DSH_PERSISTENT_BASH_START_${nonce}__`,
    end: `__DSH_PERSISTENT_BASH_END_${nonce}:`,
  }
}

function quoteForBash(value: string): string {
  return `$'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')}'`
}

function wrapCommand(command: string, marker: CommandMarkers): string {
  // Keep the wrapper on one physical line. An interactive bash prints PS2 for
  // embedded newlines before executing the buffer, which would leak terminal
  // prompts and marker source text into the model-facing result.
  return `printf '%s\\n' ${quoteForBash(marker.start)}; eval -- ${quoteForBash(command)}; __dsh_persistent_bash_status=$?; printf '%s%s\\n' ${quoteForBash(marker.end)} "$__dsh_persistent_bash_status"`
}

function trimTrailingNewline(text: string): string {
  return text.replace(/(?:\r?\n)+$/, '')
}

function commandOutput(
  snapshot: RetainedOutput,
  marker: CommandMarkers,
): CapturedOutput | undefined {
  const text = snapshot.text
  const end = text.lastIndexOf(marker.end)
  const status = /^(\d+)\r?\n/.exec(text.slice(end + marker.end.length))?.[1]
  if (status === undefined) return undefined
  const startMarker = text.lastIndexOf(marker.start, end)
  const start = startMarker < 0 ? 0 : startMarker + marker.start.length
  return {
    text: trimTrailingNewline(text.slice(start, end).replace(/^\r?\n/, '')),
    incomplete: startMarker < 0,
    exitCode: Number(status),
  }
}

function partialOutput(
  snapshot: RetainedOutput,
  marker: CommandMarkers,
  fallback: string,
  fallbackTruncated = false,
): CapturedOutput {
  const startMarker = snapshot.text.lastIndexOf(marker.start)
  if (startMarker >= 0) {
    return {
      text: trimTrailingNewline(snapshot.text.slice(startMarker + marker.start.length).replace(/^\r?\n/, '')),
      incomplete: false,
    }
  }
  const fallbackStart = fallback.lastIndexOf(marker.start)
  const afterStart = fallbackStart < 0
    ? fallback
    : fallback.slice(fallbackStart + marker.start.length).replace(/^\r?\n/, '')
  const fallbackEnd = afterStart.lastIndexOf(marker.end)
  const beforeEnd = fallbackEnd < 0 ? afterStart : afterStart.slice(0, fallbackEnd)
  return {
    text: trimTrailingNewline(beforeEnd),
    incomplete: fallbackTruncated || fallbackStart < 0,
  }
}

async function pause(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
}

function nextScrollbackOffset(page: TerminalReadResult, offset: number): number | undefined {
  if (page.text.length === 0 || page.lineEnd <= offset) return undefined
  return page.lineEnd
}

function retainedScrollback(
  ctx: Context,
  owner: Agent,
  id: TerminalSessionId,
  latest = ctx.terminals.read(owner, id, { offset: 0, count: SCROLLBACK_PAGE_LINES }),
): RetainedOutput {
  const pages: string[] = latest.text.length === 0 ? [] : [latest.text]
  let offset = latest.lineEnd
  let truncated = latest.truncated
  while (true) {
    if (offset >= latest.totalLines) break
    const page = ctx.terminals.read(owner, id, { offset, count: SCROLLBACK_PAGE_LINES })
    truncated ||= page.truncated
    if (page.text.length > 0) pages.unshift(page.text)
    const next = nextScrollbackOffset(page, offset)
    if (next === undefined || next >= page.totalLines) break
    offset = next
  }
  return { text: pages.join('\n'), truncated }
}

function settle(output: CapturedOutput, maxOutputChars: number): string {
  const text = renderCaptured(output, maxOutputChars)
  if (output.exitCode !== undefined && output.exitCode !== 0) throw new Error(text)
  return text
}

function renderCaptured(output: CapturedOutput, maxOutputChars: number): string {
  const rendered = maybeTruncate(output.text, maxOutputChars, output.incomplete)
  const withPrefix = output.incomplete && output.text.length > 0
    ? LOST_PREFIX_MESSAGE + rendered
    : rendered
  const marker = output.exitCode !== undefined
    ? `[Command finished with exit code ${output.exitCode}]`
    : undefined
  return appendStatusMarker(withPrefix, marker)
}

function appendStatusMarker(content: string, marker: string | undefined): string {
  if (marker === undefined) return content
  return content.length === 0 ? marker : `${content}\n${marker}`
}

function renderShellExitStatus(
  content: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): string {
  const marker = signal !== null
    ? `[shell killed by signal: ${signal}]`
    : exitCode !== null
      ? `[shell exited: code ${exitCode}]`
      : '[shell exited]'
  return appendStatusMarker(content, marker)
}

/**
 * Render the exited-session result, reset the owner's shell, and reset the
 * message that tells the model the next call starts fresh.
 * @param shells - the owner-scoped registry to reset.
 * @param status - the exited session status (exit code and signal).
 * @returns the complete model-facing result.
 */
async function respondToSessionExit(
  ctx: Context,
  shells: PersistentShells,
  owner: Agent,
  id: TerminalSessionId,
  status: { exitCode: number | null; signal: NodeJS.Signals | null },
  marker: CommandMarkers,
  fallback: string,
  fallbackTruncated: boolean,
  config: ResolvedConfig,
): Promise<string> {
  const snapshot = retainedScrollback(ctx, owner, id)
  await shells.reset(owner, 'persistent bash shell exited')
  return [
    renderShellExitStatus(
      renderCaptured(partialOutput(snapshot, marker, fallback, fallbackTruncated), config.maxOutputChars),
      status.exitCode,
      status.signal,
    ),
    SHELL_RESET_MESSAGE,
  ].filter(part => part.length > 0).join('\n')
}

function persistentShells(ctx: Context, config: ResolvedConfig): PersistentShells {
  const pending = new WeakMap<Agent, Promise<TerminalSessionId>>()
  const live = new Map<Agent, TerminalSessionId>()
  const creating = new Set<Promise<TerminalSessionId>>()
  const ownerCleanupInstalled = new WeakSet<Agent>()
  const lifecycle = new AbortController()

  const close = async (owner: Agent, id: TerminalSessionId, reason: string): Promise<void> => {
    if (!ctx.terminals.list(owner).some(snapshot => snapshot.sessionId === id)) return
    await ctx.terminals.kill(owner, id, reason)
  }

  ctx.effect(() => async () => {
    lifecycle.abort(new Error('tool-bash-persistent disposed during shell creation'))
    await Promise.allSettled([...creating])
    const closing = [...live].map(async ([owner, id]) => { await close(owner, id, 'tool-bash-persistent disposed') })
    await Promise.all(closing)
    live.clear()
  }, 'tool-bash-persistent shell cleanup')

  const reset = async (owner: Agent, reason: string): Promise<void> => {
    pending.delete(owner)
    const id = live.get(owner)
    live.delete(owner)
    if (id !== undefined) await close(owner, id, reason)
  }

  const get = (owner: Agent, signal: AbortSignal): Promise<TerminalSessionId> => {
    const existing = pending.get(owner)
    if (existing !== undefined) return existing
    const combinedSignal = AbortSignal.any([signal, lifecycle.signal])
    const creation = (async () => {
      try {
        const cwd = owner.session.header.cwd
        const spawned = await ctx.terminals.spawn(owner, {
          type: config.backendType,
          ...cwd === undefined ? {} : { cwd },
        }, combinedSignal)
        live.set(owner, spawned.sessionId)
        if (!ownerCleanupInstalled.has(owner)) {
          ownerCleanupInstalled.add(owner)
          owner.ctx.effect(() => () => {
            pending.delete(owner)
            live.delete(owner)
          }, 'tool-bash-persistent owner cache cleanup')
        }
        // Echo suppression only: the prompt stays the backend's own, so the
        // backend's prompt-based readiness detection keeps working.
        const setup = ctx.terminals.startSend(owner, spawned.sessionId, {
          text: 'stty -echo',
          submit: true,
          signal: combinedSignal,
        })
        const result = await setup.done
        if (result.sessionStatus.kind === 'exited' || result.waitReason === 'timeout') {
          throw new Error('persistent bash shell did not accept initialization')
        }
        return spawned.sessionId
      } catch (error: unknown) {
        await reset(owner, 'persistent bash initialization failed')
        throw error
      }
    })()
    const tracked = creation.finally(() => {
      creating.delete(tracked)
    })
    creating.add(tracked)
    pending.set(owner, tracked)
    return tracked
  }

  return { get, reset }
}

async function executeCommand(
  ctx: Context,
  shells: PersistentShells,
  owner: Agent,
  command: string,
  config: ResolvedConfig,
  upstream: AbortSignal,
  busy: WeakMap<Agent, ActiveShellCommand>,
): Promise<string> {
  const active = busy.get(owner)
  if (active !== undefined) {
    return active.command === command
      ? duplicateCommandResult(active)
      : busyCommandResult(active)
  }
  // The hard deadline is timer-only so the promoted job keeps it while the
  // foreground tool call is already gone; caller cancellation is observed
  // separately and stops applying once the command is promoted.
  const hardDeadline = deadline(undefined, config.timeoutMs, TIMEOUT_CODE)
  const frontSignal = AbortSignal.any([upstream, hardDeadline.signal])
  let handedOff = false
  try {
    let id: TerminalSessionId
    try {
      id = await shells.get(owner, frontSignal)
    } catch (error: unknown) {
      // Initialization owns rollback; only this caller's cancellation becomes ABORTED.
      if (upstream.aborted && error === upstream.reason) return ''
      throw error
    }
    const marker = markers()
    const follower = new CommandFollower(
      ctx, owner, id, marker, wrapCommand(command, marker), hardDeadline.signal, frontSignal,
    )
    // A deadline that already fits inside the foreground window needs no
    // promotion: the turn simply waits for the hard timeout as before.
    if (config.timeoutMs > FOREGROUND_WINDOW_MS) follower.openWindow(FOREGROUND_WINDOW_MS)

    while (true) {
      const step = await follower.step()
      switch (step.kind) {
        case 'complete': {
          follower.closeWindow()
          return settle(step.output, config.maxOutputChars)
        }
        case 'timedOut': {
          follower.closeWindow()
          const snapshot = retainedScrollback(ctx, owner, id, step.latest)
          const partial = renderCaptured(
            partialOutput(snapshot, marker, follower.fallbackText, follower.fallbackWasTruncated),
            config.maxOutputChars,
          )
          await shells.reset(owner, 'persistent bash command timed out')
          throw new Error([
            `Your command timed out after ${Math.round(step.timeoutMs / 1000)} seconds. Below is partial output:`,
            appendStatusMarker(partial, TIMEOUT_STATUS_MARKER),
            SHELL_RESET_MESSAGE,
          ].join('\n'))
        }
        case 'aborted': {
          follower.closeWindow()
          await shells.reset(owner, 'persistent bash command aborted')
          // ToolRuntime publishes ABORTED after this cancelled invocation settles.
          return ''
        }
        case 'cancelled': {
          follower.closeWindow()
          return ''
        }
        case 'failed': {
          follower.closeWindow()
          await shells.reset(owner, 'persistent bash send failed')
          throw step.error instanceof Error ? step.error : new Error(errorMessage(step.error))
        }
        case 'windowExpired': {
          let jobId: JobId
          try {
            jobId = startBackgroundCommand(ctx, shells, owner, command, config, follower, busy, hardDeadline)
          } catch (error: unknown) {
            // Registration failed; keep waiting in the foreground under the hard
            // deadline instead of pretending the command runs in the background.
            ctx.logger.warn(`persistent bash could not start a background job: ${errorMessage(error)}`)
            await pause()
            continue
          }
          handedOff = true
          return promotedCommandResult(command, jobId)
        }
        case 'shellExit': {
          follower.closeWindow()
          return await respondToSessionExit(
            ctx, shells, owner, id, step.status, marker,
            follower.fallbackText, follower.fallbackWasTruncated, config,
          )
        }
        case 'stdinRead': {
          follower.closeWindow()
          const snapshot = retainedScrollback(ctx, owner, id, step.latest)
          return renderCaptured(
            partialOutput(snapshot, marker, follower.fallbackText, follower.fallbackWasTruncated),
            config.maxOutputChars,
          )
        }
        case 'pending':
          break
      }
      await pause()
    }
  } finally {
    if (!handedOff) hardDeadline[Symbol.dispose]()
  }
}

/**
 * Register the model-facing persistent `bash` tool.
 * @param ctx - plugin context carrying tools and the owner-scoped PTY service.
 * @param config - selected PTY backend and command deadline.
 */
function registerPersistentBash(ctx: Context, config: ResolvedConfig): void {
  const shells = persistentShells(ctx, config)
  const queues = new WeakMap<Agent, Promise<void>>()
  const busy = new WeakMap<Agent, ActiveShellCommand>()

  const serialized = async <T>(owner: Agent, operation: () => Promise<T>): Promise<T> => {
    const prior = queues.get(owner) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    queues.set(owner, tail)
    try {
      return await run
    } finally {
      if (queues.get(owner) === tail) queues.delete(owner)
    }
  }

  ctx.tools.register(defineTool({
    name: 'bash',
    description: config.description,
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The bash command to run. Relative path is preferred in the command.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (args.command.trim().length === 0) throw new Error('command must be a non-empty string')
      const owner = exec.agent
      if (owner === undefined) throw new Error('bash requires an owning agent session')
      return serialized(owner, async () => {
        if (exec.signal.aborted) return '' // ToolRuntime publishes ABORTED after settlement.
        return executeCommand(ctx, shells, owner, args.command, config, exec.signal, busy)
      })
    },
    presentCall: args => ({ card: 'terminal', title: args.command }),
  }))
}

export const name = 'tool-bash-persistent'
export const inject = ['tools', 'terminals', 'jobs']

/** Configuration for the persistent Bash tool. */
export interface Config {
  /** PTY backend used for each owner-isolated persistent shell (default `shell`). */
  backendType?: string
  /** Wall-clock limit for one command (default 300000). */
  timeoutMs?: number
  /** Maximum returned command-output characters before clipping (default 16000). */
  maxOutputChars?: number
  /** Model-facing tool description; deployments may describe their environment. */
  description?: string
}

/** Runtime configuration schema for the persistent Bash tool. */
export const Config: z<Config> = z.object({
  backendType: z.string().default('shell'),
  timeoutMs: z.number().default(300_000),
  maxOutputChars: z.number().default(16_000),
  description: z.string().default(DEFAULT_DESCRIPTION),
})

/** Register one owner-scoped persistent `bash` tool. */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    backendType: config.backendType ?? 'shell',
    timeoutMs: config.timeoutMs ?? 300_000,
    maxOutputChars: config.maxOutputChars ?? 16_000,
    description: config.description ?? DEFAULT_DESCRIPTION,
  }
  if (resolved.backendType.trim().length === 0) {
    throw new Error('tool-bash-persistent: backendType must be non-empty')
  }
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0) {
    throw new Error('tool-bash-persistent: timeoutMs must be a positive safe integer')
  }
  if (!Number.isSafeInteger(resolved.maxOutputChars) || resolved.maxOutputChars <= 0) {
    throw new Error('tool-bash-persistent: maxOutputChars must be a positive safe integer')
  }
  if (resolved.description.trim().length === 0) {
    throw new Error('tool-bash-persistent: description must be non-empty')
  }
  registerPersistentBash(ctx, resolved)
}
