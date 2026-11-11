# macOS Build & Signing

How `pnpm build:mac` turns the repo into `release/OpenScreen-<version>-<arch>.dmg`. `pnpm package` and `pnpm package:mac` are kept as aliases for the same script. The pipeline is the same one `~/frontend` (Videoo) uses: electron-builder with an `afterPack` re-sign hook, an `afterSign` notarize hook, and an ad-hoc fallback when Apple credentials are missing.

## Pipeline

1. **`scripts/build-mac.mjs`** loads `.env`, picks the signing identity, and runs `pnpm build` (clean → addon → Next static export `out/` → `dist-electron/`). Then it runs `electron-builder --mac --<arch> --config.mac.identity=<identity>`.
   - `APPLE_SIGNING_IDENTITY` set **and** present in `security find-identity -v -p codesigning` → that identity.
   - Otherwise → `-` (ad-hoc).
   - `CSC_IDENTITY_AUTO_DISCOVERY=false` is always set. The keychain can hold `Apple Development` / `Apple Distribution` certs, which electron-builder would otherwise pick up, and those can't be notarized for direct distribution.
   - An empty `CSC_LINK` / `CSC_KEY_PASSWORD` is removed from the env. electron-builder would resolve `""` to the project dir and fail with `not a file`.
2. **`build-resources/afterPack.cjs`** runs before electron-builder's own signing pass. It prunes `prebuilds/*.tar.gz`, then re-signs the Electron frameworks and helpers inside-out (never `--deep`) and signs the `.node` addons. It fails the build if `mac_addon.node` or `permissions.node` is missing from `app.asar.unpacked`.
3. electron-builder signs the `.app` with the chosen identity, the hardened runtime, and `build-resources/entitlements.mac{,.inherit}.plist`.
4. **`build-resources/notarize.cjs`** (afterSign) notarizes via `@electron/notarize`. It skips with a log line when the build is ad-hoc, when `APPLE_ID` / `APPLE_ID_PASSWORD` / `APPLE_TEAM_ID` are missing, or when `OPENSCREEN_SKIP_NOTARIZE=1`. electron-builder's built-in notarize is off (`mac.notarize: false`) so a build never double-submits.

## Clean builds

`pnpm build` runs `pnpm clean` first, which deletes `.next/`, `out/` and `dist-electron/` before anything is compiled. Without the wipe, `tsc` keeps the output of renamed/deleted `electron/` sources and Next's export can strand orphaned files, so a DMG could ship code that no longer exists in the repo.

- `pnpm build:mac -- --skip-build` deliberately skips the clean — that path repackages exactly what is already on disk.
- `pnpm dev` does not clean, so Next's incremental cache in `.next/` survives restarts.
- `pnpm clean -- --release` also removes `release/` (old DMGs + unpacked `.app`); `pnpm clean -- --addon` also removes `packages/mac-addon/build/`. Both are opt-in: deleting the last good DMG before a build that then fails is worse than leaving a stale one.

## Signing modes

| `.env` | Result |
|---|---|
| nothing (default) | Ad-hoc signed, hardened runtime, not notarized. Runs on the build Mac. Other Macs: right-click → Open, or `xattr -dr com.apple.quarantine /Applications/OpenScreen.app`. |
| `APPLE_SIGNING_IDENTITY` only | Developer ID signed, not notarized. Gatekeeper still warns. |
| identity + `APPLE_ID` + `APPLE_ID_PASSWORD` + `APPLE_TEAM_ID` | Signed + notarized (≈5–15 min extra). |

Ad-hoc signatures change on every build, so macOS treats each build as a new app for **Screen Recording / Camera / Microphone** permission (TCC). Re-grant after installing a new build, or reset with `tccutil reset ScreenCapture com.openscreen.app`.

## What ships

- `app.asar`: `dist-electron/`, `out/`, `package.json`, and from `node_modules` **only** `@openscreen/mac-addon`, `node-mac-permissions`, `bindings`, and `file-uri-to-path`. Every renderer dependency is already bundled into `out/` by the static export, so shipping `node_modules/next` etc. was ~370 MB of dead weight. **If `electron/` starts importing a new runtime package, add it to `files` in `electron-builder.yml`.**
- `app.asar.unpacked`: the two `.node` addons and their JS entry points.
- `npmRebuild: false`: both addons are N-API, so the Node-built binaries load in Electron.

## Packaged CSP

Packaged windows load `app://` with the CSP from `electron/main.ts`. The Next static export hydrates through inline `<script>` tags, so `script-src` allow-lists their sha256 hashes. `collectInlineScriptHashes(OUT_DIR)` computes them once at startup, which avoids `'unsafe-inline'`. Without this, every packaged window rendered but never hydrated. `worker-src` allows `blob:` for PixiJS texture-decode workers. Dev (`next dev`) has no CSP.

## Verify a build

```bash
codesign --verify --deep --strict --verbose=2 release/mac-arm64/OpenScreen.app
codesign -d --entitlements - --xml release/mac-arm64/OpenScreen.app | plutil -p -
hdiutil verify release/OpenScreen-*-arm64.dmg
# Launch from the mounted DMG and check for CSP / require errors:
"/Volumes/OpenScreen */OpenScreen.app/Contents/MacOS/OpenScreen" --enable-logging=stderr
# Notarized builds only:
spctl -a -vv -t install release/OpenScreen-*.dmg
```

## Known limitations

- No app icon yet (`build-resources/icon.icns`). electron-builder uses the default Electron icon.
- No auto-update feed (no `publish` config / `electron-updater`).
- No automated launch smoke test in `afterPack` (Videoo has `resources/smoke-test.js`). Verify manually with the commands above.
