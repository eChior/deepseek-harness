#!/usr/bin/env node
/**
 * lefthook writes hook shims that call `node_modules/lefthook/bin/index.js` as
 * if it were executable. On Windows git runs them through bash, which reads the
 * JavaScript and dies on the first parenthesis. Prefix the call with node; it is
 * the same shim otherwise. Idempotent, and silent when there is nothing to do.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const BARE = '"$dir/node_modules/lefthook/bin/index.js" "$@"'
const WRAPPED = 'node "$dir/node_modules/lefthook/bin/index.js" "$@"'
const HOOKS = ['.git/dsh-hooks/pre-commit', '.git/dsh-hooks/pre-push']

let patched = 0
for (const hook of HOOKS) {
  if (!existsSync(hook)) continue
  const text = readFileSync(hook, 'utf8')
  if (!text.includes(BARE)) continue
  writeFileSync(hook, text.split(BARE).join(WRAPPED))
  patched += 1
}
if (patched > 0) console.log(`fix-lefthook-hooks: repaired ${patched} hook(s)`)
