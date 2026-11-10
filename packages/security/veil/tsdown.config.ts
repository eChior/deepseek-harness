import { defineConfig } from 'tsdown'

/**
 * The plugin is shipped as a single minified file so that reading the
 * installed `lib/index.js` tells a reader nothing about the order the
 * rules run in, the shapes a placeholder can take, or the paths the
 * write-back tries. The sources stay in the repository — this only
 * keeps the deployed copy opaque.
 *
 * Exported names and property names are left alone: cordis resolves the
 * service by the string passed to `super()`, Typert wires the remote
 * methods by the names it generated, and the tools are registered by
 * the names in their descriptors.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: false,
  minify: true,
})
