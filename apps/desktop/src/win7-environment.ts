/** Windows 7 Host environment: the bundled PowerShell 7.2 comes first on PATH. */

import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'

/**
 * Whether an `os.release()` string names Windows before 8 (NT 6.2).
 * @param osRelease - Windows kernel version such as `6.1.7601`.
 * @returns true for NT 6.1 and older.
 */
export function isPreWindows8(osRelease: string): boolean {
  const [major = 0, minor = 0] = osRelease.split('.').map(Number)
  return major < 6 || (major === 6 && minor < 2)
}

/**
 * Prepend the Win7 build's bundled `resources/runtime/pwsh` to the Host PATH on Windows 7. Windows
 * PowerShell 2.0 cannot start under the ACL sandbox's restricted token and lacks the PowerShell 5
 * syntax the pwsh executor's encoding preamble uses; pwsh-local prefers a PATH `pwsh.exe` over it.
 * @param environment - Host environment before the change.
 * @param resourcesPath - Packaged application's resources directory.
 * @param platform - Current platform.
 * @param osRelease - Current kernel version.
 * @returns The environment, with PATH changed only on Windows 7 when the bundled pwsh exists.
 */
export function win7HostEnvironment(
  environment: NodeJS.ProcessEnv,
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
  osRelease: string = release(),
): NodeJS.ProcessEnv {
  if (platform !== 'win32' || !isPreWindows8(osRelease)) return environment
  const pwsh = join(resourcesPath, 'runtime', 'pwsh')
  if (!existsSync(join(pwsh, 'pwsh.exe'))) return environment
  // A spread Windows environment keeps the original key case (usually "Path"); reuse it.
  const key = Object.keys(environment).find(name => name.toUpperCase() === 'PATH') ?? 'Path'
  const current = environment[key]
  return { ...environment, [key]: current === undefined || current === '' ? pwsh : `${pwsh};${current}` }
}
