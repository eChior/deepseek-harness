/**
 * Materialise the per-department Qwen key table for a packaged build.
 *
 * The keys are deployment secrets: they arrive as the `DSH_QWEN_KEYS`
 * environment variable (JSON, `{ "department": "sk-…" }`, with `"*"` as the
 * catch-all entry) and land in `packages/credentials/hrzszy-account/assets/qwen-keys.json`,
 * which is ignored by git.  A build without the variable ships an empty table,
 * which leaves the route authenticating exactly as it did before.
 *
 * Usage: `node scripts/gen-qwen-keys.mjs`
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TARGET = fileURLToPath(new URL('../packages/credentials/hrzszy-account/assets/qwen-keys.json', import.meta.url))
const SOURCE = process.env.DSH_QWEN_KEYS ?? ''

/** Reject a table whose every value is not a non-empty string. */
function readTable(raw) {
  if (raw.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`DSH_QWEN_KEYS is not valid JSON: ${error.message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('DSH_QWEN_KEYS must be a JSON object of department names to API keys')
  }
  const table = {}
  for (const [department, key] of Object.entries(parsed)) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error(`DSH_QWEN_KEYS entry ${JSON.stringify(department)} is not a non-empty string`)
    }
    table[department] = key.trim()
  }
  return table
}

const table = readTable(SOURCE)
await mkdir(dirname(TARGET), { recursive: true })
await writeFile(TARGET, `${JSON.stringify(table, null, 2)}\n`, 'utf8')
const rooms = Object.keys(table)
console.log(`gen-qwen-keys: wrote ${String(rooms.length)} department key(s)${rooms.length === 0 ? ' (no secret set)' : ''}`)
