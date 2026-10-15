/** Linux launches that start as root adopt the invoking account before the shell writes anything. */

import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { userInfo } from 'node:os'

/** The account a root Linux launch hands its process over to. */
export interface LinuxLaunchUser {
  readonly uid: number
  readonly gid: number
}

/** Outcome of an adoption attempt, reported by the caller. */
export interface LinuxLaunchUserAdoption {
  /** Whether the process now runs as the invoking account. */
  readonly adopted: boolean
  /** Account the process runs as after a successful adoption. */
  readonly username?: string
  /** Why the process was left as root, when it was. */
  readonly reason?: string
}

/** Id switch and account lookup, injectable so tests do not need root. */
export interface LinuxLaunchUserHooks {
  /** Switch the process ids; must set the group before the user. */
  readonly setIds?: (gid: number, uid: number) => void
  /** Read the adopted account; defaults to `os.userInfo()`. */
  readonly account?: () => { readonly homedir: string; readonly username: string }
}

/**
 * Resolve the account a root Linux launch should adopt.
 *
 * `sudo` publishes the invoking ids in `SUDO_UID`/`SUDO_GID`. A session that logged in as root
 * directly publishes nothing, and then no account exists to hand the process to.
 * @param platform - Operating system running the shell.
 * @param uid - Effective uid of the launch, `undefined` where the platform reports none.
 * @param environment - Process environment carrying the `sudo` ids.
 * @returns The account to adopt, or undefined to leave the process as it is.
 */
export function resolveLinuxLaunchUser(
  platform: NodeJS.Platform,
  uid: number | undefined,
  environment: NodeJS.ProcessEnv,
): LinuxLaunchUser | undefined {
  if (platform !== 'linux' || uid !== 0) return undefined
  const uidText = environment.SUDO_UID
  const gidText = environment.SUDO_GID
  if (uidText === undefined || gidText === undefined) return undefined
  const sudoUid = Number.parseInt(uidText, 10)
  const sudoGid = Number.parseInt(gidText, 10)
  if (!Number.isSafeInteger(sudoUid) || sudoUid <= 0) return undefined
  if (!Number.isSafeInteger(sudoGid) || sudoGid <= 0) return undefined
  return { uid: sudoUid, gid: sudoGid }
}

/**
 * Drop the process to `user` and repoint the session variables at its account.
 *
 * Everything the shell creates afterwards — the profile, the workspace, and every file an agent
 * writes inside it — then belongs to that account instead of root. `HOME`, `USER`, `LOGNAME` and
 * the XDG roots are rewritten because `sudo` forwards the ids but leaves root's own values in place.
 * @param user - Account resolved by {@link resolveLinuxLaunchUser}.
 * @param environment - Environment rewritten in place.
 * @param hooks - Id switch and account lookup, injectable for tests.
 * @returns Whether the process adopted the account, and why not when it did not.
 */
export function adoptLinuxLaunchUser(
  user: LinuxLaunchUser,
  environment: NodeJS.ProcessEnv,
  hooks: LinuxLaunchUserHooks = {},
): LinuxLaunchUserAdoption {
  const setIds = hooks.setIds ?? defaultSetIds
  const account = hooks.account ?? userInfo
  try {
    setIds(user.gid, user.uid)
  } catch (error) {
    return { adopted: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const { homedir, username } = account()
  environment.HOME = homedir
  environment.USER = username
  environment.LOGNAME = username
  if (environment.XDG_CONFIG_HOME === undefined || environment.XDG_CONFIG_HOME.startsWith('/root')) {
    environment.XDG_CONFIG_HOME = posix.join(homedir, '.config')
  }
  const runtimeDir = `/run/user/${String(user.uid)}`
  if ((environment.XDG_RUNTIME_DIR === undefined || environment.XDG_RUNTIME_DIR.startsWith('/root'))
    && existsSync(runtimeDir)) {
    environment.XDG_RUNTIME_DIR = runtimeDir
  }
  return { adopted: true, username }
}

function defaultSetIds(gid: number, uid: number): void {
  const setGroup = process.setgid
  const setUser = process.setuid
  if (setGroup === undefined || setUser === undefined) throw new Error('the platform cannot switch user ids')
  setGroup(gid)
  setUser(uid)
}
