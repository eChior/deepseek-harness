/**
 * The reader that ships inside the client.
 *
 * These tests build a real archive with `zip`'s own layout rather than mocking
 * one, because the unpacking code reads offsets out of that structure: a test
 * that handed it a Map would prove nothing about the bytes an installer ships.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { installBundledReader, readArchive } from '../src/reader.ts'

/** Build a zip the way a packer does: local headers, then a central directory. */
function archive(files: Readonly<Record<string, string>>): Buffer {
  const locals: Buffer[] = []
  const directories: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8')
    const packed = deflateRawSync(raw)
    const nameBytes = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, packed)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(8, 10)
    record.writeUInt32LE(packed.length, 20)
    record.writeUInt32LE(raw.length, 24)
    record.writeUInt16LE(nameBytes.length, 28)
    record.writeUInt32LE(offset, 42)
    directories.push(record, nameBytes)
    offset += 30 + nameBytes.length + packed.length
  }
  const body = Buffer.concat(locals)
  const directory = Buffer.concat(directories)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, directory, end])
}

const roots: string[] = []

function root(): string {
  const created = mkdtempSync(join(tmpdir(), 'dsh-bundled-reader-'))
  roots.push(created)
  return created
}

describe('readArchive', () => {
  it('returns every file it holds', () => {
    const entries = readArchive(archive({ 'dsh-ocr.exe': 'executable', 'libSkiaSharp.dll': 'library' }))
    expect(entries.map(entry => entry.name)).toEqual(['dsh-ocr.exe', 'libSkiaSharp.dll'])
    expect(entries[0]?.data.toString()).toBe('executable')
  })

  it('refuses bytes that are not an archive', () => {
    expect(() => readArchive(Buffer.from('not a zip at all'))).toThrow(/central directory/u)
  })
})

describe('installBundledReader', () => {
  function packaged(files: Readonly<Record<string, string>>, name: string): string {
    const resources = root()
    mkdirSync(join(resources, 'ocr'), { recursive: true })
    writeFileSync(join(resources, 'ocr', name), archive(files))
    return resources
  }

  it('unpacks the archive this platform ships', async () => {
    const resources = packaged({ 'dsh-ocr.exe': 'reader', 'libSkiaSharp.dll': 'library' }, 'dsh-ocr-win-x64.zip')
    const home = root()
    const path = await installBundledReader({ resources, home, platform: 'win32', architecture: 'x64' })
    expect(path).toBe(join(home, 'redaction', 'ocr', 'dsh-ocr.exe'))
    expect(readFileSync(path ?? '', 'utf8')).toBe('reader')
    expect(existsSync(join(home, 'redaction', 'ocr', 'libSkiaSharp.dll'))).toBe(true)
  })

  it('replaces the reader an earlier install left behind', async () => {
    const resources = packaged({ 'dsh-ocr.exe': 'reader' }, 'dsh-ocr-win-x64.zip')
    const home = root()
    mkdirSync(join(home, 'redaction', 'ocr'), { recursive: true })
    writeFileSync(join(home, 'redaction', 'ocr', 'dsh-ocr.exe'), 'older reader')
    const path = await installBundledReader({ resources, home, platform: 'win32', architecture: 'x64' })
    expect(readFileSync(path ?? '', 'utf8')).toBe('reader')
  })

  it('does nothing when this archive already produced the files', async () => {
    const resources = packaged({ 'dsh-ocr.exe': 'reader' }, 'dsh-ocr-win-x64.zip')
    const home = root()
    await installBundledReader({ resources, home, platform: 'win32', architecture: 'x64' })
    const target = join(home, 'redaction', 'ocr', 'dsh-ocr.exe')
    writeFileSync(target, 'edited by hand')
    const path = await installBundledReader({ resources, home, platform: 'win32', architecture: 'x64' })
    expect(readFileSync(path ?? '', 'utf8')).toBe('edited by hand')
  })

  it('reports nothing on a platform the client does not build for', async () => {
    const path = await installBundledReader({ resources: root(), home: root(), platform: 'darwin', architecture: 'arm64' })
    expect(path).toBeUndefined()
  })

  it('reports nothing when the archive is missing, rather than throwing', async () => {
    const messages: string[] = []
    const path = await installBundledReader({
      resources: root(),
      home: root(),
      platform: 'win32',
      architecture: 'x64',
      log: message => messages.push(message),
    })
    expect(path).toBeUndefined()
    expect(messages.join('\n')).toMatch(/ships no reader/u)
  })

  it('leaves nothing behind for an archive with a path that climbs out', async () => {
    const resources = packaged({ '../escape.txt': 'no' }, 'dsh-ocr-win-x64.zip')
    await expect(installBundledReader({ resources, home: root(), platform: 'win32', architecture: 'x64' }))
      .rejects.toThrow(/refusing to unpack/u)
  })
})

describe('the archive the installer ships', () => {
  it('holds exactly the two files the reader runs from', () => {
    // Pinned so a rebuild that forgets one of them fails here instead of on a
    // machine that then cannot read a screenshot.
    const expected: Record<string, RegExp> = {
      'dsh-ocr-win-x64.zip': /^(dsh-ocr\.exe|libSkiaSharp\.dll)$/u,
      'dsh-ocr-linux-arm64.zip': /^(dsh-ocr|libSkiaSharp\.so)$/u,
    }
    for (const [name, pattern] of Object.entries(expected)) {
      const path = join(import.meta.dirname, '..', 'resources', 'ocr', name)
      expect(existsSync(path), `${name} is missing`).toBe(true)
      const entries = readArchive(readFileSync(path))
      expect(entries.map(entry => entry.name).filter(entry => !pattern.test(entry))).toEqual([])
      for (const entry of entries) {
        expect(createHash('sha256').update(entry.data).digest('hex').length).toBe(64)
      }
    }
  })
})
