/**
 * The handful of git commands this provider needs, run without a shell.
 *
 * Every call disables the interactive credential prompts (`GIT_TERMINAL_PROMPT`,
 * `GCM_INTERACTIVE`): the mirror is fetched on startup, and a private remote that
 * asks for a password would otherwise hang the boot instead of failing.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Environment that keeps git from ever waiting on a human. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly detail: string,
  ) {
    super(`git ${args.join(' ')}: ${detail}`)
    this.name = 'GitError'
  }
}

async function git(args: readonly string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await run('git', [...args], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: GIT_ENV,
    })
    return stdout
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new GitError(args, detail)
  }
}

/** Whether `directory` is already a git working tree. */
export function isRepository(directory: string): boolean {
  return existsSync(join(directory, '.git'))
}

/** Clone a single branch at depth 1 into `directory`, which must not exist yet. */
export async function cloneRepository(
  url: string,
  directory: string,
  branch: string,
  timeoutMs: number,
): Promise<void> {
  await git(['clone', '--depth=1', '--single-branch', '--branch', branch, '--quiet', url, directory], timeoutMs)
}

/**
 * Fast-forward `directory` onto the remote tip of `branch`.
 *
 * `reset --hard` rather than `pull`: the mirror is a read-only copy this process
 * owns, and a hard reset also discards anything a previous half-finished sync left
 * behind.
 */
export async function updateRepository(directory: string, branch: string, timeoutMs: number): Promise<void> {
  await git(['-C', directory, 'fetch', '--depth=1', '--quiet', 'origin', branch], timeoutMs)
  await git(['-C', directory, 'reset', '--hard', '--quiet', 'FETCH_HEAD'], timeoutMs)
}

/** Current commit of `directory`, for logging which mirror revision is in use. */
export async function describeRevision(directory: string, timeoutMs: number): Promise<string> {
  const stdout = await git(['-C', directory, 'rev-parse', '--short', 'HEAD'], timeoutMs)
  return stdout.trim()
}
