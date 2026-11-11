require('dotenv').config({ quiet: true })
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// afterPack hook — runs after electron-builder lays out the .app, before its
// own signing pass (doSignAfterPack) and before afterSign/notarize.
//
// 1. Prunes prebuild tarballs from app.asar.unpacked (notarytool scans inside
//    them and rejects the unsigned .node files they contain).
// 2. Re-signs Electron frameworks + helpers inside-out so their Team ID matches
//    the main binary. Without this, ad-hoc builds crash at launch on macOS 15+
//    ("mapping process and mapped file have different Team IDs").
// 3. Signs the native .node modules (@openscreen/mac-addon, node-mac-permissions).
//
// Identity: APPLE_SIGNING_IDENTITY when it is actually installed in the
// keychain, otherwise ad-hoc ("-"). Shell-outs use execFileSync with an args
// array — never a template string — because identities and paths are untrusted.

function isIdentityAvailable(identity) {
  if (!identity || identity === '-') return true
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    })
    return out.includes(identity)
  } catch {
    return false
  }
}

function codesignFile(file, { identity, isAdHoc, entitlementsPath }) {
  console.log(`[afterPack] Signing: ${path.basename(file)}`)
  const args = ['--sign', isAdHoc ? '-' : identity, '--force']
  if (!isAdHoc) args.push('--timestamp', '--options', 'runtime', '--entitlements', entitlementsPath)
  args.push(file)
  // --timestamp round-trips to Apple and fails transiently under load; retry
  // identity signs. Ad-hoc has no network dependency.
  const attempts = isAdHoc ? 1 : 3
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('codesign', args, { stdio: 'inherit' })
      return
    } catch (err) {
      if (attempt >= attempts) throw err
      console.warn(`[afterPack] codesign failed (attempt ${attempt}/${attempts}) — retrying...`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * attempt)
    }
  }
}

/** Recursive walk; symlinks are never followed (avoids double-signing). */
function walkDir(dir, filter, results = [], depth = 0, maxDepth = 32) {
  if (depth > maxDepth) return results
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    let stat
    try {
      stat = fs.lstatSync(full)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    if (filter(full, entry, stat)) results.push(full)
    if (stat.isDirectory()) walkDir(full, filter, results, depth + 1, maxDepth)
  }
  return results
}

const MACHO_MAGICS = [
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xca, 0xfe, 0xba, 0xbf],
]

/** Magic-byte check — framework binaries and crashpad helpers carry no extension. */
function isMachOFile(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(4)
    if (fs.readSync(fd, head, 0, 4, 0) < 4) return false
    return MACHO_MAGICS.some((m) => m.every((v, i) => head[i] === v))
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function pruneUnsignablePrebuildTarballs(asarUnpackedPath) {
  const tarballs = walkDir(
    asarUnpackedPath,
    (full, entry, stat) =>
      stat.isFile() &&
      (entry.name.endsWith('.tar.gz') || entry.name.endsWith('.tar')) &&
      full.includes(`${path.sep}prebuilds${path.sep}`),
  )
  for (const f of tarballs) fs.rmSync(f, { force: true })
  if (tarballs.length > 0) console.log(`[afterPack] Pruned ${tarballs.length} prebuild tarball(s).`)
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  const frameworksPath = path.join(appPath, 'Contents/Frameworks')
  const asarUnpackedPath = path.join(appPath, 'Contents/Resources/app.asar.unpacked')
  const entitlementsPath = path.join(__dirname, 'entitlements.mac.plist')

  const requestedIdentity = process.env.APPLE_SIGNING_IDENTITY || '-'
  const identity = isIdentityAvailable(requestedIdentity) ? requestedIdentity : '-'
  const isAdHoc = identity === '-'
  const signOpts = { identity, isAdHoc, entitlementsPath }

  if (requestedIdentity !== '-' && isAdHoc) {
    console.warn(
      `[afterPack] WARNING: APPLE_SIGNING_IDENTITY="${requestedIdentity}" not found in keychain — ` +
        'falling back to ad-hoc signing.',
    )
  }
  console.log(`[afterPack] Signing identity: ${isAdHoc ? 'ad-hoc (-)' : identity}`)

  // ── Step 1: frameworks & helpers, inside-out (never --deep) ──
  if (fs.existsSync(frameworksPath)) {
    const root = path.resolve(frameworksPath)
    const items = walkDir(
      root,
      (full, entry) =>
        path.relative(root, full).split(path.sep).length <= 2 &&
        (entry.name.endsWith('.framework') ||
          entry.name.endsWith('.app') ||
          entry.name.endsWith('.dylib')),
      [],
      0,
      2,
    ).sort((a, b) => b.length - a.length)

    for (const item of items) {
      const nested = walkDir(item, (full, _e, stat) => stat.isFile() && isMachOFile(full)).sort(
        (a, b) => b.length - a.length,
      )
      for (const bin of nested) codesignFile(bin, signOpts)
      codesignFile(item, signOpts)
    }
    console.log('[afterPack] Frameworks re-signed.')
  }

  // ── Step 2: native .node modules ──
  if (fs.existsSync(asarUnpackedPath)) {
    pruneUnsignablePrebuildTarballs(asarUnpackedPath)
    const nodeFiles = walkDir(
      asarUnpackedPath,
      (_full, entry, stat) => stat.isFile() && entry.name.endsWith('.node'),
    )
    for (const file of nodeFiles) codesignFile(file, signOpts)
    console.log(`[afterPack] Signed ${nodeFiles.length} native module(s).`)

    // The recorder is useless without these; fail the build rather than ship
    // an app that crashes on the first `require`.
    for (const required of [
      'node_modules/@openscreen/mac-addon/build/Release/mac_addon.node',
      'node_modules/node-mac-permissions/build/Release/permissions.node',
    ]) {
      if (!fs.existsSync(path.join(asarUnpackedPath, required))) {
        throw new Error(`[afterPack] Missing native module in package: ${required}`)
      }
    }
  } else {
    throw new Error('[afterPack] No app.asar.unpacked — native addons were not unpacked.')
  }
}
