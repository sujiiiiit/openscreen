require('dotenv').config({ quiet: true })

// afterSign hook. Submits the signed .app to Apple's notary service; the
// ticket is then stapled so Gatekeeper accepts the app offline.
//
// Real notarization needs ALL of:
//   - APPLE_SIGNING_IDENTITY → a "Developer ID Application" cert in the keychain
//   - APPLE_ID, APPLE_ID_PASSWORD (app-specific password), APPLE_TEAM_ID
//
// Missing any of them is the normal state for local / unsigned builds, so we
// skip with a clear log instead of failing the build.

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const { APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID, APPLE_SIGNING_IDENTITY } = process.env
  const isAdHoc = !APPLE_SIGNING_IDENTITY || APPLE_SIGNING_IDENTITY === '-'
  const missingCreds = !APPLE_ID || !APPLE_ID_PASSWORD || !APPLE_TEAM_ID

  if (isAdHoc || missingCreds || process.env.OPENSCREEN_SKIP_NOTARIZE === '1') {
    console.log('\n' + '='.repeat(60))
    console.log('[notarize] Skipping notarization')
    console.log('='.repeat(60))
    if (isAdHoc) console.log('[notarize] APPLE_SIGNING_IDENTITY is unset or "-" (ad-hoc build).')
    if (missingCreds) {
      console.log('[notarize] Missing one or more of: APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID.')
    }
    console.log('[notarize] The app runs, but Gatekeeper will warn on other Macs.')
    console.log('[notarize] See .env.example to enable signing + notarization.\n')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appBundleId = context.packager.appInfo.macBundleIdentifier
  const appPath = `${appOutDir}/${appName}.app`

  console.log(`\n[notarize] Notarizing ${appBundleId} (team ${APPLE_TEAM_ID}) — ${appPath}`)
  const { notarize } = await import('@electron/notarize')
  await notarize({
    appBundleId,
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_ID_PASSWORD,
    teamId: APPLE_TEAM_ID,
  })
  console.log('[notarize] Notarization successful.\n')
}
