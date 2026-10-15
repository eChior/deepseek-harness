/** Electron Node-mode startup, with private shell launchers scoped to package installation. */

import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Select Electron's Node mode and the shell launcher used by package scripts.
 * @param executable - Electron executable running the application.
 * @param bin - Directory containing the node shell launcher.
 * @param environment - Caller environment preserved for plugin execution.
 * @returns Environment for a Node-mode child process.
 */
export function desktopNodeEnvironment(executable: string, bin: string | undefined, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    ELECTRON_RUN_AS_NODE: '1',
    ...(bin === undefined ? {} : { DSH_DESKTOP_NODE_EXECUTABLE: executable, PATH: `${bin}${delimiter}${environment.PATH ?? ''}` }),
  }
}

/**
 * Name the WPS-backed Office CLI when this installation ships one.
 *
 * Upstream publishes no LibreOffice engine for Linux, so a Linux build carries a WPS-backed CLI
 * under `resources/wps` with the kit's command surface. Handing its location to the Host lets the
 * Office conversion provider drive WPS instead of an engine that does not exist on this platform.
 * @param primaryRuntime - Bundled dependency payload the Host receives as its own source directory.
 * @returns The added variable, or an empty object when this installation carries no such CLI.
 */
export function officeCliEnvironment(primaryRuntime: string): NodeJS.ProcessEnv {
  if (process.platform !== 'linux') return {}
  const cli = join(primaryRuntime, '..', '..', 'wps', 'office-cli.mjs')
  return existsSync(cli) ? { DSH_WPS_OFFICE_CLI: cli } : {}
}
