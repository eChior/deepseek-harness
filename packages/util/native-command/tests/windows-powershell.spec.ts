import { describe, expect, it } from 'vitest'
import { windowsPowerShell } from '../src/windows-powershell.ts'

describe('windowsPowerShell', () => {
  it('keeps the system Windows PowerShell on Windows 8 and later', () => {
    expect(windowsPowerShell('win32', '6.2.9200')).toBe('powershell.exe')
    expect(windowsPowerShell('win32', '6.3.9600')).toBe('powershell.exe')
    expect(windowsPowerShell('win32', '10.0.26100')).toBe('powershell.exe')
  })

  it('uses PowerShell 7 on Windows 7 and older', () => {
    expect(windowsPowerShell('win32', '6.1.7601')).toBe('pwsh.exe')
    expect(windowsPowerShell('win32', '6.0.6002')).toBe('pwsh.exe')
  })

  it('never reads a non-Windows kernel release as old Windows (WSL reaches the Windows adapter from Linux)', () => {
    expect(windowsPowerShell('linux', '5.15.167.4-microsoft-standard-WSL2')).toBe('powershell.exe')
    expect(windowsPowerShell('darwin', '23.6.0')).toBe('powershell.exe')
  })
})
