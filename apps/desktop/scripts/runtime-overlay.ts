/**
 * Apply a prepared file overlay to the materialized Desktop runtime before its descriptor is written.
 *
 * The Windows 7 build uses it to swap in Win7-compatible binaries (ripgrep, import-patched libvips and
 * LibreOffice Kit with their shim DLLs) and to add the winpty terminal backend. Replacements name the
 * SHA-256 of the file they replace, so a dependency version the overlay was not built for fails loudly.
 * The manifest also pins the versions it was built for, so packaging installs exactly those.
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { dump, load } from 'js-yaml'

/** One overlay entry: copy `source` (file or directory, overlay-relative) to `path` (runtime-relative). */
interface RuntimeOverlayEntry {
  readonly path: string
  readonly source: string
  /** SHA-256 the existing file must have; absent means the entry adds a path that must not exist yet. */
  readonly replaces?: string
}

/** `manifest.json` at the overlay root. */
interface RuntimeOverlayManifest {
  readonly schemaVersion: 1
  /** Exact versions of the packages whose files the entries replace, keyed by package name. */
  readonly pins?: Readonly<Record<string, string>>
  readonly entries: readonly RuntimeOverlayEntry[]
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

function readManifest(overlay: string): RuntimeOverlayManifest {
  const manifest = JSON.parse(readFileSync(join(overlay, 'manifest.json'), 'utf8')) as RuntimeOverlayManifest
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error(`runtime overlay: ${overlay} has no schemaVersion 1 manifest`)
  }
  return manifest
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function within(root: string, path: string, label: string): string {
  const full = resolve(root, path)
  const fromRoot = relative(root, full)
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`runtime overlay: ${label} ${JSON.stringify(path)} leaves its root`)
  }
  return full
}

/**
 * Copy every overlay entry into the runtime tree, refusing originals the overlay was not built for.
 * @param overlay - Directory holding `manifest.json` and the entry sources.
 * @param runtimeRoot - Materialized Desktop runtime root.
 * @returns Runtime-relative paths written, in manifest order.
 */
export function applyRuntimeOverlay(overlay: string, runtimeRoot: string): string[] {
  const manifest = readManifest(overlay)
  const written: string[] = []
  for (const entry of manifest.entries) {
    const source = within(overlay, entry.source, 'source')
    const target = within(runtimeRoot, entry.path, 'path')
    if (!existsSync(source)) throw new Error(`runtime overlay: source ${entry.source} is missing`)
    if (entry.replaces === undefined) {
      if (existsSync(target)) throw new Error(`runtime overlay: ${entry.path} already exists, but the entry adds a new path`)
    } else {
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new Error(`runtime overlay: ${entry.path} is missing; expected a file with SHA-256 ${entry.replaces}`)
      }
      const actual = sha256(target)
      if (actual !== entry.replaces) {
        throw new Error(`runtime overlay: ${entry.path} has SHA-256 ${actual}, expected ${entry.replaces}; rebuild the overlay for this dependency version`)
      }
    }
    cpSync(source, target, { recursive: true, force: true })
    written.push(entry.path)
  }
  return written
}

/**
 * Add the overlay's version pins to the runtime project's pnpm overrides before its lockfile is resolved.
 * External dependencies otherwise resolve to whatever is newest in range on the day of packaging.
 * @param overlay - Directory holding `manifest.json`.
 * @param workspaceFile - The runtime project's `pnpm-workspace.yaml`.
 * @returns The pins added, keyed by package name.
 */
export function pinRuntimeOverlayVersions(overlay: string, workspaceFile: string): Record<string, string> {
  const pins = readManifest(overlay).pins ?? {}
  for (const [name, version] of Object.entries(pins)) {
    if (!PACKAGE_NAME.test(name) || typeof version !== 'string' || !EXACT_VERSION.test(version)) {
      throw new Error(`runtime overlay: invalid pin ${JSON.stringify(name)}: ${JSON.stringify(version)}`)
    }
  }
  const workspace = (load(readFileSync(workspaceFile, 'utf8')) ?? {}) as Record<string, unknown>
  const overrides = { ...(workspace.overrides as Record<string, string> | undefined) }
  for (const [name, version] of Object.entries(pins)) {
    if (overrides[name] !== undefined && overrides[name] !== version) {
      throw new Error(`runtime overlay: pin ${name}@${version} conflicts with override ${JSON.stringify(overrides[name])}`)
    }
    overrides[name] = version
  }
  writeFileSync(workspaceFile, dump({ ...workspace, overrides }, { lineWidth: -1 }))
  return { ...pins }
}
