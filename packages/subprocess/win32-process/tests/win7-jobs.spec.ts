import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import {
  CREATE_BREAKAWAY_FROM_JOB,
  CREATE_SUSPENDED,
  CREATE_UNICODE_ENVIRONMENT,
  JOB_OBJECT_LIMIT_BREAKAWAY_OK,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET,
} from '../src/abi.ts'
import { processInformationType } from '../src/ffi.ts'
import type { CurrentTokenProcessBindings, NativePtr, Win32ProcessBindings } from '../src/index.ts'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, release: () => '6.1.7601' }
})

// Job nesting support is decided when process.ts loads; it loads once here as a Windows 7 (NT 6.1) host.
// Windows 8 and later keep the default flags, which the other process specs cover.
const { spawnCurrentTokenJobProcess, spawnInheritedJobProcess } = await (async () => {
  const platform = process.platform
  Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: 'win32' })
  try {
    return await import('../src/process.ts')
  } finally {
    Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: platform })
  }
})()

type Bindings = CurrentTokenProcessBindings & Win32ProcessBindings

/** Bindings whose CreateProcess calls answer from `results` in order (1 creates pid 1234, 0 fails with `lastError`). */
function api(results: number[], lastError = 5): { bindings: Bindings; creationFlags: number[]; jobLimits: number[] } {
  const creationFlags: number[] = []
  const jobLimits: number[] = []
  let error = 0
  const create = (flags: number, info: NativePtr): number => {
    creationFlags.push(flags)
    if ((results.shift() ?? 1) === 0) {
      error = lastError
      return 0
    }
    koffi.encode(info, processInformationType(), { hProcess: 60n, hThread: 61n, dwProcessId: 1234, dwThreadId: 5678 })
    return 1
  }
  const bindings = {
    createJobObjectW: vi.fn(() => 50n),
    setInformationJobObject: vi.fn((_job: NativePtr, _cls: number, information: Buffer) => {
      jobLimits.push(information.readUInt32LE(JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET))
      return 1
    }),
    getStdHandle: vi.fn((selector: number) => BigInt(100 - selector)),
    uvGetOsfhandle: vi.fn((fileDescriptor: number) => BigInt(100 + fileDescriptor)),
    setHandleInformation: vi.fn(() => 1),
    createProcessW: vi.fn((_app, _line, _pa, _ta, _inherit, flags: number, _env, _cwd, _startup, info: NativePtr) =>
      create(flags, info)),
    createProcessAsUserW: vi.fn((_token, _app, _line, _pa, _ta, _inherit, flags: number, _env, _cwd, _startup, info: NativePtr) =>
      create(flags, info)),
    assignProcessToJobObject: vi.fn(() => 1),
    resumeThread: vi.fn(() => 0),
    terminateProcess: vi.fn(() => 1),
    closeHandle: vi.fn(() => 1),
    getLastError: vi.fn(() => error),
    formatMessageW: vi.fn(() => 0),
  } as unknown as Bindings
  return { bindings, creationFlags, jobLimits }
}

const currentToken = {
  command: 'probe.exe',
  applicationName: 'C:\\resolved\\probe.exe',
  args: [],
  cwd: 'C:\\work',
  env: {},
  stdio: { stdin: 4, stdout: 5, stderr: 6 },
}
const restricted = { command: 'probe.exe', args: [], cwd: 'C:\\work', token: 70n as NativePtr }
const ordinaryFlags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT

describe('Job nesting on Windows 7', () => {
  it('starts current-token children outside the creator Job and lets their own Job allow breakaway', () => {
    const { bindings, creationFlags, jobLimits } = api([1])
    expect(spawnCurrentTokenJobProcess(bindings, currentToken)).toEqual({ pid: 1234, process: 60n, job: 50n })
    expect(creationFlags).toEqual([ordinaryFlags | CREATE_BREAKAWAY_FROM_JOB])
    expect(jobLimits).toEqual([JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK])
  })

  it('creates the child inside a creator Job that forbids breakaway', () => {
    const { bindings, creationFlags } = api([0, 1])
    expect(spawnCurrentTokenJobProcess(bindings, currentToken)).toEqual({ pid: 1234, process: 60n, job: 50n })
    expect(creationFlags).toEqual([ordinaryFlags | CREATE_BREAKAWAY_FROM_JOB, ordinaryFlags])
  })

  it('starts restricted children outside the creator Job with the same fallback', () => {
    const leaving = api([1])
    expect(spawnInheritedJobProcess(leaving.bindings, restricted)).toEqual({ pid: 1234, process: 60n, job: 50n })
    expect(leaving.creationFlags).toEqual([CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB])
    expect(leaving.jobLimits).toEqual([JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE])

    const staying = api([0, 1])
    expect(spawnInheritedJobProcess(staying.bindings, restricted)).toEqual({ pid: 1234, process: 60n, job: 50n })
    expect(staying.creationFlags).toEqual([CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB, CREATE_SUSPENDED])
  })

  it('reports other creation failures without retrying', () => {
    const { bindings, creationFlags } = api([0, 1], 2)
    let caught: unknown
    try {
      spawnCurrentTokenJobProcess(bindings, currentToken)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'CreateProcessW', win32Code: 2 })
    expect(creationFlags).toEqual([ordinaryFlags | CREATE_BREAKAWAY_FROM_JOB])
  })
})
