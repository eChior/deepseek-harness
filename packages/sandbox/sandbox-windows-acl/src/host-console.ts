/**
 * The host-console precondition for the windows-acl runner: give THIS process
 * a console of its own, hidden, before it spawns a WRITE_RESTRICTED child.
 *
 * Why this module exists. Console ownership, not the DACL, decides whether a
 * restricted child survives: a restricted child inherits the console of the
 * process that created it and never builds one of its own. When the host
 * process owns NO console, Windows must build a fresh conhost for the child
 * with the child's ALREADY-RESTRICTED token, and that path's permission checks
 * fail — the child dies during DLL initialization with
 * STATUS_DLL_INIT_FAILED (0xC0000142, read back as 3221225794) before it can
 * write a single byte to stdout or stderr. The upstream
 * `@deepseek-ai/dsh-sandbox-windows-acl` notes document the child side of this
 * (children created with CREATE_NO_WINDOW / CREATE_NEW_CONSOLE end during DLL
 * initialization with STATUS_DLL_INIT_FAILED; children share the host console)
 * but not the caller-side precondition it implies: the HOST process must own a
 * console. The runner neither enforced nor provided one, so the desktop app —
 * Electron on the GUI subsystem, with no console at all — crashed every pwsh
 * tool call in workspace-write / read-only mode while danger-full-access stayed
 * fine.
 *
 * What it does. This module is the runner's FIRST import, so its top-level
 * allocation runs before any other runner module evaluates: it drops any
 * inherited console (FreeConsole — only a console this process owns can be
 * hidden, and AllocConsole fails while one is attached), creates one this
 * process owns (AllocConsole), and hides its window (ShowWindow, SW_HIDE — an
 * AllocConsole window is visible by default). Restricted children then inherit
 * an existing console instead of building one under the restricted token.
 *
 * What it does NOT do. The DACL, the restricting SID lists, and the creation
 * flags stay exactly as they are: CREATE_NO_WINDOW / CREATE_NEW_CONSOLE remain
 * absent, and the existing STARTF_USESHOWWINDOW patch is untouched. Allocation
 * is best-effort and never throws: a host that fails to own a console keeps
 * running (pipe-based stdio is unaffected), and the runner reports that
 * degraded state on stderr WITHOUT the `windows-acl-run: <detail>` + 127
 * failure contract, which stays reserved for failures that prevent the spawn.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/host-console
 */

import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import { isNullPtr } from '@deepseek-ai/dsh-win32-process'
import type { NativePtr } from '@deepseek-ai/dsh-win32-process'

type Koffi = typeof import('koffi')['default']
type Library = ReturnType<Koffi['load']>
type Ptr = ReturnType<Koffi['pointer']>
type KoffiFunction = ReturnType<Library['func']>

/** The console calls the host allocation needs, from kernel32 and user32. */
export interface HostConsoleBindings {
  /** kernel32!FreeConsole — detach from any console this process inherited. */
  freeConsole(): number
  /** kernel32!AllocConsole — create a console this process owns; 0 on failure. */
  allocConsole(): number
  /** kernel32!GetConsoleWindow — the console's window handle, NULL when absent. */
  getConsoleWindow(): NativePtr | null
  /** user32!ShowWindow — show or hide a window (SW_HIDE hides). */
  showWindow(window: NativePtr, command: number): number
}

/** Platform and binding seams for production callers and tests. */
export interface HostConsoleContext {
  /** Platform to decide for; defaults to `process.platform`. */
  platform?: string
  /** Binding source; defaults to the lazy koffi loader. */
  load?: () => HostConsoleBindings
}

/** The import-time allocation outcome the runner reads and reports. */
export interface HostConsoleState {
  /** The platform the allocation decision was made for. */
  readonly platform: string
  /** Whether this process owns a console after the import-time allocation. */
  readonly owned: boolean
}

/** `SW_HIDE`: the ShowWindow command that hides the allocated console window. */
const SW_HIDE = 0

const requireKoffi = createLazyRequire<Koffi>('koffi', import.meta.url)
let cached: HostConsoleBindings | undefined

/* v8 ignore start -- real koffi bindings; every test injects a stub loader. */
function bindings(): HostConsoleBindings {
  if (cached !== undefined) return cached
  const koffi = requireKoffi()
  // user32 is not part of the shared Win32BindingContext and must not be added
  // to it: this module loads the one extra library it needs on its own.
  const kernel32 = koffi.load('kernel32.dll')
  const user32 = koffi.load('user32.dll')
  const pointer: Ptr = koffi.pointer('void')
  const bind = (library: Library, name: string, result: Ptr | string, args: Array<Ptr | string>): KoffiFunction =>
    library.func('__stdcall', name, result, args)
  const api: HostConsoleBindings = {
    freeConsole: bind(kernel32, 'FreeConsole', 'int', []),
    allocConsole: bind(kernel32, 'AllocConsole', 'int', []),
    getConsoleWindow: bind(kernel32, 'GetConsoleWindow', pointer, []),
    showWindow: bind(user32, 'ShowWindow', 'int', [pointer, 'int']),
  }
  return cached = api
}
/* v8 ignore stop */

/**
 * Ensure this process owns a console, hidden, before it spawns a restricted
 * child. Off Windows nothing runs and no binding is loaded.
 * @param context - Platform and binding seams; production callers pass nothing.
 * @returns whether this process owns a console after the call.
 */
export function ensureHostConsole(context: HostConsoleContext = {}): boolean {
  if ((context.platform ?? process.platform) !== 'win32') return false
  try {
    const api = (context.load ?? bindings)()
    // Drop any inherited console first: only a console this process owns can be
    // hidden, and AllocConsole fails while one is still attached.
    api.freeConsole()
    if (api.allocConsole() === 0) return false
    const window = api.getConsoleWindow()
    // A console without a window is already invisible, and ShowWindow's return
    // value is the PREVIOUS show state, not an error code — do not check it.
    if (!isNullPtr(window)) api.showWindow(window, SW_HIDE)
    return true
  } catch {
    // Best-effort by contract: hosts that cannot own a console keep running,
    // and the runner reports the degraded state without failing the run.
    return false
  }
}

/** Allocate for the current process and record the outcome for the runner. */
function allocateHostConsole(): HostConsoleState {
  const platform = process.platform
  return { platform, owned: ensureHostConsole({ platform }) }
}

/**
 * The allocation this module performs while it evaluates, as the runner's
 * first import. `owned: false` off Windows and when allocation failed.
 */
export const hostConsole: HostConsoleState = allocateHostConsole()
