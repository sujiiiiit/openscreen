#!/usr/bin/env node
// Builds the macOS DMG.
//
//   pnpm build:mac                  # clean + build + package for the host arch
//   pnpm build:mac -- --skip-build  # repackage the existing out/ + dist-electron/
//   pnpm build:mac -- --arch x64    # arm64 | x64 | universal
//
// `pnpm package` and `pnpm package:mac` are aliases for `pnpm build:mac`.
// The non-skip path wipes .next/ out/ dist-electron/ first (via `pnpm clean`);
// --skip-build intentionally repackages whatever is already on disk.
//
// Signing is decided here, from `.env` (see `.env.example`):
//   - APPLE_SIGNING_IDENTITY set AND installed in the keychain → signed with it;
//     build-resources/notarize.cjs then notarizes when APPLE_ID /
//     APPLE_ID_PASSWORD / APPLE_TEAM_ID are also set.
//   - otherwise → ad-hoc ("-") signed, not notarized. Runs locally; other Macs
//     need right-click → Open (or `xattr -dr com.apple.quarantine`).
//
// Identity auto-discovery is always OFF: this keychain may hold "Apple
// Development" / "Apple Distribution" certs, which electron-builder would
// otherwise pick up and produce an app Gatekeeper rejects anyway.
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(root, '.env'), quiet: true })

const argv = process.argv.slice(2)
const skipBuild = argv.includes('--skip-build')
const archIdx = argv.indexOf('--arch')
const arch = archIdx >= 0 ? argv[archIdx + 1] : process.arch
if (!['arm64', 'x64', 'universal'].includes(arch)) {
  console.error(`[build-mac] Unsupported --arch "${arch}" (arm64 | x64 | universal).`)
  process.exit(1)
}

function identityInstalled(identity) {
  try {
    return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    }).includes(identity)
  } catch {
    return false
  }
}

const requested = process.env.APPLE_SIGNING_IDENTITY?.trim() || '-'
let identity = '-'
if (requested !== '-') {
  if (identityInstalled(requested)) {
    identity = requested
  } else {
    console.warn(
      `[build-mac] APPLE_SIGNING_IDENTITY="${requested}" is not in the keychain — building ad-hoc.`,
    )
  }
}
const isAdHoc = identity === '-'

const env = { ...process.env }
// electron-builder resolves an empty CSC_LINK against the project dir and fails
// with "not a file"; treat empty as unset.
for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD']) {
  if (!env[key]?.trim()) delete env[key]
}
Object.assign(env, {
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  // Keep the hooks (afterPack / notarize) on the same identity this script chose.
  APPLE_SIGNING_IDENTITY: identity,
})

console.log(`[build-mac] arch=${arch} signing=${isAdHoc ? 'ad-hoc (unsigned)' : identity}`)

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit' })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

if (!skipBuild) run('pnpm', ['build'])

// electron-builder strips the "Developer ID Application: " prefix itself.
run('pnpm', [
  'exec',
  'electron-builder',
  '--mac',
  `--${arch}`,
  '--publish',
  'never',
  `--config.mac.identity=${identity}`,
])

console.log(`\n[build-mac] Done → ${path.join(root, 'release')}`)
