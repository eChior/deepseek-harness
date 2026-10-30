/**
 * Write the publishing token a build ships, so a colleague never configures one.
 *
 * Reads DSH_SKILLS_TOKEN and stores it beside the bundled assets. A build without
 * the secret writes nothing, which keeps publishing as "report the missing token"
 * rather than failing the pack.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/skill/skill-repo/assets/skills.token')

const token = (process.env.DSH_SKILLS_TOKEN ?? '').trim()

if (token === '') {
  await rm(OUTPUT, { force: true })
  console.log('gen-skills-token: no DSH_SKILLS_TOKEN set; this build ships without a publishing token')
} else {
  await mkdir(dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, token, 'utf8')
  console.log(`gen-skills-token: wrote a ${String(token.length)}-character publishing token`)
}
