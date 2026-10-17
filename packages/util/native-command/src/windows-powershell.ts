/** The PowerShell executable that runs host-native Windows adapters. */

import { release } from 'node:os'

/**
 * Pick the PowerShell for host-native Windows adapters. Windows 8 and later run the system Windows
 * PowerShell. Windows 7 ships Windows PowerShell 2.0, which lacks the PowerShell 3+ cmdlets and syntax the
 * adapters use (`ConvertTo-Json`, `::new()`) and does not exit after `-File` while its stdin stays open; the
 * Windows 7 build puts its bundled PowerShell 7 first on the Host PATH, where `pwsh.exe` resolves.
 * Decided by the running process, not by injected test platforms, and never for WSL's Linux kernel release.
 * @param platform - Running platform.
 * @param osRelease - Running kernel version such as `6.1.7601`.
 * @returns `pwsh.exe` on Windows before 8 (NT 6.2), otherwise `powershell.exe`.
 */
export function windowsPowerShell(
  platform: NodeJS.Platform = process.platform, osRelease: string = release(),
): 'pwsh.exe' | 'powershell.exe' {
  if (platform !== 'win32') return 'powershell.exe'
  const [major = 0, minor = 0] = osRelease.split('.').map(Number)
  return major < 6 || (major === 6 && minor < 2) ? 'pwsh.exe' : 'powershell.exe'
}
