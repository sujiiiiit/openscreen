#!/usr/bin/env node
// Removes build artifacts so a rebuild can never pick up stale output.
//
//   pnpm clean              # .next/ out/ dist-electron/
//   pnpm clean -- --release # also release/ (DMGs + unpacked .app)
//   pnpm clean -- --addon   # also packages/mac-addon/build/ (node-gyp output)
//
// `pnpm build` runs this first, so `pnpm build:mac` always packages a clean
// tree. Two paths deliberately do NOT run it:
//   - `pnpm build:mac -- --skip-build` repackages whatever is already on disk.
//   - `pnpm dev` keeps .next/ so Next's incremental cache survives restarts.
//
// tsc never deletes the output of a source file that was renamed or removed,
// and Next's export can leave orphaned files behind, so a full wipe is the
// only reliable way to guarantee the DMG matches the current sources.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

/** @type {string[]} */
const targets = ['.next', 'out', 'dist-electron']
if (argv.includes('--release')) targets.push('release')
if (argv.includes('--addon')) targets.push(path.join('packages', 'mac-addon', 'build'))

let removed = 0
for (const rel of targets) {
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) continue
  fs.rmSync(abs, { recursive: true, force: true })
  console.log(`[clean] removed ${rel}`)
  removed++
}

console.log(
  removed === 0 ? '[clean] nothing to remove' : `[clean] removed ${removed} director${removed === 1 ? 'y' : 'ies'}`,
)
