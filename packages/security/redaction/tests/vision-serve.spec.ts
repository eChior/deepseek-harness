import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

/** One pipe of a fake reader: enough of a stream for the code under test. */
class FakeStream extends EventEmitter {
  readonly written: string[] = []

  setEncoding(): this {
    return this
  }

  write(chunk: string): boolean {
    this.written.push(chunk)
    return true
  }

  end(chunk?: unknown): void {
    if (typeof chunk === 'string') this.written.push(chunk)
  }
}

/** A reader process the test drives by hand. */
class FakeChild extends EventEmitter {
  readonly stdin = new FakeStream()
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()

  kill(): boolean {
    return true
  }
}

const { recognizeImage } = await import('../src/vision.ts')

/** Existing files: the reader is only used when its path exists. */
const binary = fileURLToPath(new URL('../src/vision.ts', import.meta.url))
const otherBinary = fileURLToPath(new URL('../src/plugin.ts', import.meta.url))

const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47)

const report = JSON.stringify({
  version: 1,
  backend: 'cpu',
  elapsedMs: 34,
  image: { width: 2, height: 2 },
  text: '编号 42',
  lines: [
    {
      text: '编号 42',
      box: { x1: 1, y1: 2, x2: 3, y2: 2, x3: 3, y3: 4, x4: 1, y4: 4 },
      detectionScore: 0.9,
      recognitionScore: 12.5,
      classificationScore: 1,
      rotationDegrees: 0,
    },
  ],
})

/** Let the promise chain reach the point where the reader was started. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

describe('serve reader', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('sends one image per line and reads one report per line', async () => {
    const probe = new FakeChild()
    const server = new FakeChild()
    spawnMock.mockImplementationOnce(() => probe).mockImplementationOnce(() => server)

    const pending = recognizeImage(png, { paddlePath: binary, backend: 'cpu', timeoutMs: 5_000 })
    await tick()
    probe.stdout.emit('data', 'dsh-ocr 2\n')
    probe.emit('close', 0)

    await vi.waitFor(() => {
      expect(server.stdin.written).toHaveLength(1)
    })
    expect(server.stdin.written[0]).toBe(`${Buffer.from(png).toString('base64')}\n`)

    server.stdout.emit('data', `${report}\n`)
    const result = await pending
    expect(result.engine).toBe('paddle')
    expect(result.lines).toHaveLength(1)
    expect(result.text).toBe('编号42')
    expect(result.backend).toBe('cpu')
  })

  it('falls back to a process per image when the reader cannot stay up', async () => {
    const probe = new FakeChild()
    const server = new FakeChild()
    const oneShot = new FakeChild()
    spawnMock
      .mockImplementationOnce(() => probe)
      .mockImplementationOnce(() => server)
      .mockImplementationOnce(() => oneShot)

    const pending = recognizeImage(png, { paddlePath: otherBinary, backend: 'cpu', timeoutMs: 5_000 })
    await tick()
    probe.stdout.emit('data', 'dsh-ocr 2\n')
    probe.emit('close', 0)

    await vi.waitFor(() => {
      expect(server.stdin.written).toHaveLength(1)
    })
    server.emit('close', 1)

    await vi.waitFor(() => {
      expect(oneShot.stdin.written).toHaveLength(1)
    })
    oneShot.stdout.emit('data', '纯文本')
    oneShot.emit('close', 0)

    const result = await pending
    expect(result.text).toBe('纯文本')
    expect(result.lines).toEqual([])
  })
})
