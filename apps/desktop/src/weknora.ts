/** Seed the knowledge-base plugin's saved configuration on a first start.
 *
 * The plugin resolves its settings as explicit config, then a saved file in the
 * user's home directory, then a `config.json` shipped with the package, then
 * the environment. A package installed from the public repository carries no
 * `config.json`, so a fresh machine would open the panel unconfigured. The
 * packaging step writes the deployed settings into the application's resources;
 * this module copies them into the saved-file position once, before the plugin
 * reads them. An existing saved file is never overwritten: whatever the user
 * typed in the panel wins.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Saved configuration file name the plugin reads before its bundled copy. */
const SAVED_FILE = 'dsh-weknora-panel.json'

/** Name of the packaged settings file inside the application's resources. */
const RESOURCE_FILE = 'weknora.json'

/** Where the packaged settings and the user's home directory are. */
export interface KnowledgeBaseSeedOptions {
  /** Directory holding the packaged `weknora.json`. */
  readonly resources: string
  /** Directory the saved configuration belongs in, normally `~/.dsh`. */
  readonly home: string
  /** Receives one line when the configuration is seeded. */
  readonly log?: (message: string) => void
}

/** Copy the packaged settings into the saved-file position.
 *
 * @param options Packaged settings location and the home directory to seed.
 * @returns Whether a file was written.
 */
export function installKnowledgeBaseConfig(options: KnowledgeBaseSeedOptions): boolean {
  const target = join(options.home, SAVED_FILE)
  if (existsSync(target)) return false
  const source = join(options.resources, RESOURCE_FILE)
  if (!existsSync(source)) return false
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  options.log?.(`knowledge base: seeded ${target}`)
  return true
}
