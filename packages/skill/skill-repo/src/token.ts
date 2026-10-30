/** The token a deployment ships, so a colleague never has to configure one. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Where the packaged token lives, beside the bundled skill assets. */
const TOKEN_PATH = fileURLToPath(new URL('../assets/skills.token', import.meta.url))

/**
 * Read the publishing token that was packaged with this build.
 *
 * A deployment that ships a token here lets every colleague publish without configuring
 * anything; a build without one keeps the previous behaviour and reports the missing token
 * when somebody tries.
 *
 * @returns The trimmed token, or an empty string when the build shipped none.
 */
export async function readBundledToken(): Promise<string> {
  try {
    return (await readFile(TOKEN_PATH, 'utf8')).trim()
  } catch {
    return ''
  }
}
