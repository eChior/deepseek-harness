/**
 * A packaged asset path an outside interpreter can actually open.
 *
 * Electron redirects `fs` for this process only, so a path inside `app.asar`
 * reads back fine here and then fails in the child: a spawned `python.exe` or
 * `powershell.exe` gets the literal path and reports it missing. electron-builder
 * unpacks the redaction assets next to the archive, so the same file sits under
 * `app.asar.unpacked` with a single segment changed.
 * @module @deepseek-ai/dsh-veil/assets
 */

import { existsSync } from 'node:fs'

/**
 * Prefer the unpacked copy of a packaged asset.
 * @param path the path this module derived from its own module URL.
 * @returns the unpacked path when it exists, otherwise the original.
 */
export function readablePath(path: string): string {
  if (!path.includes('app.asar')) return path
  const unpacked = path.replace('app.asar', 'app.asar.unpacked')
  return existsSync(unpacked) ? unpacked : path
}
