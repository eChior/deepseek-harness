/** Write the knowledge-base plugin's configuration from build secrets.
 *
 * The plugin repository is public, so its `config.json` cannot carry a service
 * address or an API key. Packaging writes that file here instead: the values
 * come from repository secrets, and the file stays a build artefact that is
 * never committed.
 *
 * Usage: node scripts/write-weknora-config.mjs [--check]
 *   --check prints what would be written and exits without touching disk.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(ROOT, 'packages', 'bundle', 'web-app', 'node_modules', 'dsh-weknora-panel', 'config.json')

/** Read one secret, treating an unset or empty variable as absent. */
function value(name) {
  const raw = process.env[name]
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim()
}

const baseUrl = value('WEKNORA_BASE_URL')
const apiKey = value('WEKNORA_API_KEY')
const maskerUrl = value('WEKNORA_MASKER_URL')

const missing = [
  ['WEKNORA_BASE_URL', baseUrl],
  ['WEKNORA_API_KEY', apiKey],
].filter(([, present]) => present === undefined).map(([name]) => name)
if (missing.length > 0) {
  console.error(`write-weknora-config: missing ${missing.join(', ')}`)
  console.error('The knowledge-base panel ships unconfigured without them; set the repository secrets.')
  console.error('re-run the packaging lane with skip_weknora enabled when that is deliberate.')
  process.exit(1)
}

const config = {
  baseUrl,
  apiKey,
  tenantId: value('WEKNORA_TENANT_ID') ?? '',
  ...(maskerUrl === undefined ? {} : { maskerUrl }),
}

if (process.argv.includes('--check')) {
  console.log(`Would write ${TARGET}:`)
  console.log(JSON.stringify({ ...config, apiKey: '[redacted]' }, null, 2))
  process.exit(0)
}

mkdirSync(dirname(TARGET), { recursive: true })
writeFileSync(TARGET, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
console.log(`Wrote the knowledge-base configuration to ${TARGET}`)
