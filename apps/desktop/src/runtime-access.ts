import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The ACE that makes a runtime directory usable by a confined child.
 *
 * A sandbox child runs under a token whose restricting SIDs are the logon SID,
 * Everyone, and the workspace capability SID. Windows requires every
 * restricting SID to pass the directory's DACL, and a directory under the
 * Harness home (`%USERPROFILE%\.dsh`) names only the signed-in user, SYSTEM
 * and Administrators — none of them a restricting SID — so starting the
 * bundled interpreter fails with `Access is denied` before it can read a
 * single byte. Everyone is the one SID present in both lists, so granting it
 * read-and-execute is what makes the tree reachable. The ACE is inheritable,
 * so the runtime update that follows inherits it as well.
 */
const READ_EXECUTE = '*S-1-1-0:(OI)(CI)RX'

/** Marker so a second launch does not walk the whole tree again. */
const MARKER = '.dsh-read-granted'

/** How long the grant is trusted before the walk runs again. */
const MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** What {@link grantRuntimeRead} did, for the caller to log. */
export type GrantOutcome = 'missing' | 'done' | 'skipped' | 'failed'

/**
 * Give the sandbox's restricting SIDs read-and-execute access to a runtime
 * directory, once per {@link MARKER_MAX_AGE_MS}.
 *
 * Failures are reported, never thrown: a machine where `icacls` refuses still
 * starts, and the reader reports the denial when a picture is read.
 * @param directory - the runtime directory (`dsh-runtimes`, the reader folder).
 * @param options - `apply` performs the walk (tests only), `now` is the clock, `log` receives failures.
 * @returns what happened.
 */
export function grantRuntimeRead(
  directory: string,
  options: {
    apply?: (directory: string) => void
    now?: () => number
    log?: (message: string) => void
  } = {},
): GrantOutcome {
  if (process.platform !== 'win32') return 'missing'
  if (!existsSync(directory)) return 'missing'
  const now = options.now?.() ?? Date.now()
  const marker = join(directory, MARKER)
  const stamped = readStamp(marker)
  if (stamped !== undefined && now - stamped < MARKER_MAX_AGE_MS) return 'skipped'
  const apply = options.apply ?? ((target: string) => {
    execFileSync('icacls', [target, '/grant', READ_EXECUTE, '/T', '/C', '/Q'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 180_000,
    })
  })
  try {
    apply(directory)
  } catch (error) {
    options.log?.(`Could not give the sandbox read access to ${directory}: ${String(error)}`)
    return 'failed'
  }
  try {
    writeFileSync(marker, String(now))
  } catch (error) {
    options.log?.(`Could not record the read grant for ${directory}: ${String(error)}`)
  }
  return 'done'
}

/**
 * When the marker was written, or undefined when it cannot be read.
 * @param marker - the marker file path.
 * @returns the epoch milliseconds, or undefined.
 */
function readStamp(marker: string): number | undefined {
  try {
    const value = Number.parseInt(readFileSync(marker, 'utf8').trim(), 10)
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}
