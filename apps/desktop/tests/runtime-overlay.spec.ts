import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { applyRuntimeOverlay, pinRuntimeOverlayVersions } from '../scripts/runtime-overlay.ts'

const roots: string[] = []

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-overlay-'))
  roots.push(root)
  return root
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function overlay(manifest: Record<string, unknown>): string {
  const root = directory()
  write(join(root, 'files/rg.exe'), 'win7 rg')
  write(join(root, 'files/shim.dll'), 'shim')
  write(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, entries: [], ...manifest }))
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Windows 7 runtime overlay', () => {
  it('replaces files whose digest matches and adds new paths', () => {
    const runtime = directory()
    write(join(runtime, 'node_modules/rg/bin/rg.exe'), 'upstream rg')
    const source = overlay({ entries: [
      { path: 'node_modules/rg/bin/rg.exe', source: 'files/rg.exe', replaces: digest('upstream rg') },
      { path: 'node_modules/rg/bin/shim.dll', source: 'files/shim.dll' },
    ] })
    expect(applyRuntimeOverlay(source, runtime)).toEqual(['node_modules/rg/bin/rg.exe', 'node_modules/rg/bin/shim.dll'])
    expect(readFileSync(join(runtime, 'node_modules/rg/bin/rg.exe'), 'utf8')).toBe('win7 rg')
    expect(readFileSync(join(runtime, 'node_modules/rg/bin/shim.dll'), 'utf8')).toBe('shim')
  })

  it('refuses an original the overlay was not built for and an added path that already exists', () => {
    const runtime = directory()
    write(join(runtime, 'node_modules/rg/bin/rg.exe'), 'newer rg')
    expect(() => applyRuntimeOverlay(overlay({ entries: [
      { path: 'node_modules/rg/bin/rg.exe', source: 'files/rg.exe', replaces: digest('upstream rg') },
    ] }), runtime)).toThrow(/rebuild the overlay/u)
    expect(() => applyRuntimeOverlay(overlay({ entries: [
      { path: 'node_modules/rg/bin/rg.exe', source: 'files/shim.dll' },
    ] }), runtime)).toThrow(/already exists/u)
    expect(readFileSync(join(runtime, 'node_modules/rg/bin/rg.exe'), 'utf8')).toBe('newer rg')
  })

  it('refuses entries that leave the overlay or runtime root', () => {
    expect(() => applyRuntimeOverlay(overlay({ entries: [{ path: '../outside', source: 'files/shim.dll' }] }), directory()))
      .toThrow(/leaves its root/u)
  })

  it('adds version pins to the runtime project overrides and keeps its other settings', () => {
    const workspace = join(directory(), 'pnpm-workspace.yaml')
    write(workspace, 'packages:\n  - .\n\noverrides:\n  "@deepseek-ai/dsh": "file:./packages/dsh.tgz"\nnodeLinker: hoisted\n')
    const pins = { 'sharp': '0.35.5', '@img/sharp-win32-x64': '0.35.5' }
    expect(pinRuntimeOverlayVersions(overlay({ pins }), workspace)).toEqual(pins)
    expect(load(readFileSync(workspace, 'utf8'))).toEqual({
      packages: ['.'],
      overrides: { '@deepseek-ai/dsh': 'file:./packages/dsh.tgz', ...pins },
      nodeLinker: 'hoisted',
    })
  })

  it('leaves the workspace without pins unchanged in meaning', () => {
    const workspace = join(directory(), 'pnpm-workspace.yaml')
    write(workspace, 'packages:\n  - .\n')
    expect(pinRuntimeOverlayVersions(overlay({}), workspace)).toEqual({})
    expect(load(readFileSync(workspace, 'utf8'))).toEqual({ packages: ['.'], overrides: {} })
  })

  it('rejects ranges, invalid names and pins that conflict with an existing override', () => {
    const workspace = join(directory(), 'pnpm-workspace.yaml')
    write(workspace, 'overrides:\n  sharp: "0.35.3"\n')
    expect(() => pinRuntimeOverlayVersions(overlay({ pins: { sharp: '^0.35.5' } }), workspace)).toThrow(/invalid pin/u)
    expect(() => pinRuntimeOverlayVersions(overlay({ pins: { '../sharp': '0.35.5' } }), workspace)).toThrow(/invalid pin/u)
    expect(() => pinRuntimeOverlayVersions(overlay({ pins: { sharp: '0.35.5' } }), workspace)).toThrow(/conflicts/u)
    expect(readFileSync(workspace, 'utf8')).toBe('overrides:\n  sharp: "0.35.3"\n')
  })
})
