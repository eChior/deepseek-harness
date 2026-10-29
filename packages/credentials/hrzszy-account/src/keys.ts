/**
 * The Qwen API keys this build shipped, one per department.
 *
 * The keys never live in the repository: `scripts/gen-qwen-keys.mjs` writes
 * `assets/qwen-keys.json` from the `DSH_QWEN_KEYS` secret while the desktop
 * package is built, and a build without that secret ships `{}`.  A colleague
 * signs in, the roster turns the account into a department, and the route
 * authenticates with that department's key instead of a hand-typed one.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Where the packaging step leaves the generated key table. */
export const QWEN_KEYS_PATH = fileURLToPath(new URL('../assets/qwen-keys.json', import.meta.url))

/** The field a table uses for colleagues whose department has no key of its own. */
export const QWEN_KEYS_FALLBACK = '*'

/** Department name to API key; empty when the build carried no secret. */
export type DepartmentKeys = Readonly<Record<string, string>>

/** An empty table, which is what a build without the secret ships. */
export const NO_KEYS: DepartmentKeys = {}

/**
 * Read the generated table, treating every broken shape as "no keys".
 * @param path - the file to read; defaults to the packaged asset.
 * @returns the table, or an empty one when the file is absent or unusable.
 */
export async function readDepartmentKeys(path: string = QWEN_KEYS_PATH): Promise<DepartmentKeys> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return NO_KEYS
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return NO_KEYS
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return NO_KEYS
  const kept = Object.entries(parsed as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
  return Object.fromEntries(kept.map(([department, key]) => [department, key.trim()]))
}

/**
 * The key for one department, falling back to the catch-all entry.
 * @param keys - the table to read.
 * @param department - the department the signed-in colleague belongs to.
 * @returns the key, or undefined when the table covers neither case.
 */
export function pickDepartmentKey(keys: DepartmentKeys, department: string | null | undefined): string | undefined {
  if (department !== null && department !== undefined) {
    const exact = keys[department]
    if (exact !== undefined) return exact
  }
  return keys[QWEN_KEYS_FALLBACK]
}
