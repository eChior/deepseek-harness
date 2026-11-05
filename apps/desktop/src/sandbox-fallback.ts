/**
 * Remembers graphics-process crashes so a machine whose Chromium sandbox cannot
 * start stops failing and starts instead.
 *
 * One build reached a machine where the GPU process died on every launch with
 * `STATUS_BREAKPOINT` and took the renderer with it; the only flag that helped
 * was `--no-sandbox`. Waiting for a person to read a crash dialog and pass that
 * flag by hand is not a recovery, so the count is kept on disk across launches
 * and the second crash restarts the application once without the sandbox.
 *
 * The record is cleared after a launch that stayed up, so an occasional driver
 * reset does not accumulate into a permanent downgrade.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** File name inside the user-data directory. */
export const FALLBACK_FILE = 'sandbox-fallback.json'

/** Crashes in a row that mean this machine cannot run the sandbox. */
export const FALLBACK_THRESHOLD = 2

/** How long a launch must stay up before the count is forgiven. */
export const FALLBACK_STABLE_MS = 60_000

/** The switch the fallback restart adds. */
export const FALLBACK_SWITCH = '--no-sandbox'

/** What the file holds. */
export interface FallbackRecord {
  /** Crashes recorded since the last launch that stayed up. */
  crashes: number
  /** When the last one happened, for a report reader. */
  lastAt: string
}

/**
 * Read the record, treating a missing or unreadable file as "no crashes".
 * @param directory - the user-data directory.
 * @returns The stored record, or undefined when there is none.
 */
export function readFallback(directory: string): FallbackRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, FALLBACK_FILE), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const crashes = (parsed as { crashes?: unknown }).crashes
    const lastAt = (parsed as { lastAt?: unknown }).lastAt
    if (typeof crashes !== 'number' || !Number.isFinite(crashes) || crashes < 0) return undefined
    return { crashes, lastAt: typeof lastAt === 'string' ? lastAt : new Date(0).toISOString() }
  } catch {
    return undefined
  }
}

/**
 * Add one crash to a record.
 * @param record - the previous record, if any.
 * @param at - when the crash happened.
 * @returns The record to store.
 */
export function bumpFallback(record: FallbackRecord | undefined, at: Date): FallbackRecord {
  return { crashes: (record?.crashes ?? 0) + 1, lastAt: at.toISOString() }
}

/**
 * Whether this machine has crashed enough to warrant the sandbox-free restart.
 * @param record - the stored record.
 * @returns true when the next launch must carry {@link FALLBACK_SWITCH}.
 */
export function shouldFallBack(record: FallbackRecord | undefined): boolean {
  return (record?.crashes ?? 0) >= FALLBACK_THRESHOLD
}

/**
 * Store a record, ignoring a filesystem that refuses the write: the fallback is
 * a convenience, and losing the count only costs one more crash.
 * @param directory - the user-data directory.
 * @param record - the record to store.
 */
export function writeFallback(directory: string, record: FallbackRecord): void {
  try {
    writeFileSync(join(directory, FALLBACK_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } catch {
    // Nothing to report: the next crash counts from zero and tries again.
  }
}

/**
 * Forget every recorded crash.
 * @param directory - the user-data directory.
 */
export function clearFallback(directory: string): void {
  try {
    rmSync(join(directory, FALLBACK_FILE), { force: true })
  } catch {
    // Already gone is the intended state.
  }
}

/**
 * The arguments that restart this application without the sandbox, keeping every
 * argument it was started with and adding the switch only once.
 * @param argv - the arguments of the current process, including the executable.
 * @returns The argument list to relaunch with.
 */
export function fallbackArguments(argv: readonly string[]): string[] {
  const rest = argv.slice(1).filter(argument => argument !== FALLBACK_SWITCH)
  return [...rest, FALLBACK_SWITCH]
}

/**
 * Whether this process is already running without the sandbox.
 * @param argv - the arguments of the current process, including the executable.
 * @returns true when the switch is present.
 */
export function sandboxDisabled(argv: readonly string[]): boolean {
  return argv.some(argument => argument === FALLBACK_SWITCH || argument === '--no-sandbox-for-testing')
}
