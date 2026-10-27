import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

/** One pipe of a recognizer child; `setEncoding` is all the code under test calls. */
class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this
  }

  end(_chunk?: unknown): void {
    // The fake child decides when its pipes fail, not the caller.
  }
}

/** A recognizer that has already exited by the time its input is written. */
class FakeChild extends EventEmitter {
  readonly stdin = new FakeStream()
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()

  kill(): boolean {
    return true
  }
}

const { recognizeImageText } = await import('../src/vision.ts')

/**
 * A recognizer that refuses its input — powershell blocked by policy, tesseract
 * missing a language pack — closes its stdin before the image is written. That
 * failure arrives as an `error` event on the stream rather than as a rejected
 * promise, so an unhandled one escapes every `try` the caller wrote and ends the
 * Host process. One unreadable picture must cost a warning, not the session.
 */
describe('recognizeImageText pipe failures', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('survives an input pipe that closed before the image was written', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const pending = recognizeImageText(Uint8Array.of(0x89, 0x50, 0x4e, 0x47), 5_000)
    child.stdin.emit('error', Object.assign(new Error('write EOF'), { code: 'EOF', errno: -4095, syscall: 'write' }))
    child.emit('close', 1)
    await expect(pending).rejects.toThrow(/exited with 1/u)
  })

  it('survives a closed read pipe as well', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const pending = recognizeImageText(Uint8Array.of(1, 2, 3), 5_000)
    child.stdout.emit('error', Object.assign(new Error('read EPIPE'), { code: 'EPIPE', errno: -4047 }))
    child.stderr.emit('error', new Error('nobody is reading'))
    child.emit('close', 1)
    await expect(pending).rejects.toThrow(/exited with 1/u)
  })

  it('reports the recognizer diagnostic when the pipe stayed healthy', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const pending = recognizeImageText(Uint8Array.of(4, 5, 6), 5_000)
    child.stderr.emit('data', 'powershell: cannot find vision.ps1')
    child.emit('close', 1)
    await expect(pending).rejects.toThrow(/cannot find vision\.ps1/u)
  })
})
