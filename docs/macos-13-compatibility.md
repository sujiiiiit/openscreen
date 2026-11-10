# macOS 13 (Ventura) Compatibility

Detailed audit of how the app behaves on macOS 13, verified file-by-file against the native addon source, the Electron layer, packaging config, and upstream Electron/Chromium requirements. Last verified **2026-06-07** by static analysis on Darwin 25 against the `MacOSX26.2.sdk` headers (see [Verification caveats](#verification-caveats)).

## Bottom line

**macOS 13.0 is the app's designed minimum, and the native layer is correctly engineered for it** — every 13.1+ / 14+ / 15+ symbol is properly gated. The effective floor is set by the native addon (`MACOSX_DEPLOYMENT_TARGET: "13.0"`, `packages/mac-addon/binding.gyp:34`), not Electron (Electron 42 supports macOS 12+). On macOS 13 the app records screen + system audio + camera fine, but with documented degradations — and a few real gaps remain (see [Gaps and risks](#gaps-and-risks)).

## Layer 1 — Electron runtime (no constraint at 13)

- `electron ^42.0.1` ships Chromium 148; Electron 42's README states support for **"macOS (Monterey and up)"** — i.e. macOS 12+. Electron comfortably covers macOS 13.
- Forward-looking: Chrome 151 (~July 2026) drops macOS 12 and requires **macOS 13+**, so future Electron majors will converge on exactly this app's native floor — macOS 13 itself is not at risk in the near term.
- `node-mac-permissions ^2.5.0` (used in `electron/ipc/permissions.ts`) supports 10.15+ — fine.
- Renderer features (PixiJS v8 WebGL canvas, WebCodecs export) ride on Chromium, not the OS. The export pipeline **probes** codec support at runtime (`components/editor/export/codec-probe.ts` via Mediabunny `canEncodeVideo` for avc/hevc/vp9) instead of assuming — older hardware without HEVC encode degrades gracefully.

## Layer 2 — Native addon: every gate verified

Every `@available` site and every ScreenCaptureKit / AVFoundation symbol newer than 13.0:

| Symbol | Needs | Gate location | Behavior on 13.0 |
|---|---|---|---|
| `SCStreamFrameInfoScreenRect` | 13.1 | `ScreenTrack.mm:1018` | Metadata omitted |
| `SCStreamFrameInfoBoundingRect` | 14.0 | `ScreenTrack.mm:1024` | Metadata omitted |
| `preservesAspectRatio`, `ignoreGlobalClipSingleWindow`, `ignoreShadowsSingleWindow` | 14.0 | `ScreenTrack.mm:689-694` | Default (pre-14) window framing; shadows / global clip included |
| `includeChildWindows` | 14.2 | `ScreenTrack.mm:697` | Older child-window behavior |
| `captureDynamicRange = .SDR` | 15.0 | `ScreenTrack.mm:733` | SCK is implicitly SDR on 13/14 — same output |
| `applicationsToInclude` (per-app audio) | 15.0 | `ScreenTrack.mm:757-784`, double-guarded with `respondsToSelector` + KVC | Not applied — see gap #2 |
| `captureMicrophone`, `microphoneCaptureDeviceID`, `SCStreamOutputTypeMicrophone` | 15.0 | `MicrophoneTrack.mm:33-55` — `isEnabled` returns `NO` pre-15 | **No mic audio at all** |
| `AVCaptureDeviceTypeExternal` / `ContinuityCamera` | 14.0 | `Devices.mm:27-29` | External/USB cams missing from list |
| `AVCaptureDeviceTypeMicrophone` (device listing) | 14.0 | `Devices.mm:32` | Mic list = default device only |
| `IOHIDCheckAccess` (input monitoring) | 10.15 | `Permissions.mm:27`, `InputTrack.mm:210` | Under the floor — always available |

Specifically checked and confirmed **safe**:

- The "× pointPixelScale" comments (`ScreenTrack.mm:266,619`) are conceptual naming only — the actual scale comes from `NSScreen.backingScaleFactor` / target `scaleFactor` options, **not** the 14.0+ `SCContentFilter.pointPixelScale` API.
- Core capture config is all 12.3/13.0 API: `SCContentFilter` initializers (`ScreenTrack.mm:477-503`), `sourceRect`, `queueDepth`, `showsCursor`, BGRA pixel format + sRGB `colorSpaceName`, `capturesAudio` / `sampleRate` / `channelCount` / `excludesCurrentProcessAudio` (`SystemAudioTrack.mm:31-34`).
- `AVCaptureDeviceTypeDeskViewCamera` (`Devices.mm:26`) is exactly 13.0 — at the floor, OK.
- Writer stack (`MediaFileWriter.mm`): H.264 High AutoLevel / HEVC — 10.13+ APIs.
- `CursorTrack.mm:83` guards every `NSCursor` selector with `respondsToSelector` before use.
- 15+-only `SCStreamError` enum values aren't referenced at all (compile-time constants anyway).
- `SCRecordingOutput` (15+) is never used — the recorder is pure `AVAssetWriter` (`docs/recorder-feature-map.md`).
- `getCapabilities()` (`Bindings.mm:368`) reports the version truthfully via `NSProcessInfo` (`Common.mm:16-20`): `screenCaptureKitMicrophone` and `scRecordingOutput` are `false` below 15.

## What a macOS 13 user actually experiences

**Works:** screen capture (display/window/region), HEVC/H.264 into MOV/MP4, sRGB color pipeline, system audio muxed into `screen.mov`, built-in / Desk View camera to `camera.mov`, cursor/input sidecar capture, pause/resume, the full editor + export.

**Degraded:**

- **No microphone audio** (13 and 14 — SCK mic is 15+, no AVFoundation fallback).
- 13.0 only (fixed in 13.1): no `screenRect` frame metadata in the sidecars.
- Window recordings include window shadows / global clip, no aspect-ratio preservation (14+ niceties).
- Per-app system-audio scoping only effective for *window* targets (implicit filter scoping); display/region scoping is 15+.
- External / USB / Continuity cameras don't appear in the picker (no deprecated `AVCaptureDeviceTypeExternalUnknown` fallback for 13).

## Gaps and risks

Ranked by real-world impact; none are fixed yet as of this audit.

1. **`getCapabilities` has zero consumers.** It's exported (`packages/mac-addon/index.d.ts:368`) but never called from main, preload, or any renderer — nothing reads `screenCaptureKitMicrophone`. On macOS 13/14 the mic picker in `app/recorder/page.tsx` looks fully functional, the user selects a mic, records… and gets a file with **no mic track, silently**. `docs/screen-recording-addon.md` acknowledges this but the UI doesn't. This is the worst real-world 13-compat issue.
2. **Per-app audio scoping is a silent no-op for display/region targets pre-15** — `electron/ipc/recorder.ts:877-924` sends `audioApplications` regardless of OS version; the native side drops it below 15 with no feedback to the user.
3. **Packaging allows installs on macOS 12, where the app will break.** `electron-builder.yml` sets no `mac.minimumSystemVersion`, so the DMG inherits Electron's `LSMinimumSystemVersion` (12.0). On a Monterey machine the app launches, then `require()` of the addon (`minos 13.0`) fails at dyld load — a crash / blank recorder instead of a clean "requires macOS 13" dialog. One-line fix: `mac.minimumSystemVersion: "13.0"`.
4. **Doc drift:** `CLAUDE.md` references `Capabilities.hdrCapture` — that field doesn't exist anywhere in the code (the capabilities object has no HDR field; HDR capture isn't implemented, the pipeline is explicitly SDR-only).

## Verification caveats

- This audit is static analysis + Apple availability annotations, performed on Darwin 25 against `MacOSX26.2.sdk` headers. There is no record of a smoke test on real macOS 13 hardware/VM; `@available` correctness can only truly be proven by running there. A 13.0 VM would also exercise the 13.0-vs-13.1 `screenRect` branch.
- Line numbers reference the source as of 2026-06-07 and will drift; symbol names are the stable anchor.

## Related docs

- `docs/screen-recording-addon.md` → "macOS version matrix" — capability matrix, verified accurate against code by this audit.
- `docs/recorder-feature-map.md` → "macOS Compatibility" — per-symbol table with Apple availability, also verified accurate.

## External sources

- [Electron v42 README — platform support](https://github.com/electron/electron/blob/v42.0.0/README.md) ("macOS (Monterey and up)")
- [Electron 42 release blog (Chromium 148)](https://www.electronjs.org/blog/electron-42-0)
- [Chrome ending macOS 12 support with Chrome 151, July 2026 (9to5Google)](https://9to5google.com/2026/01/23/google-chrome-ending-support-for-macos-monterey-in-july-2026/)
- [Chrome browser system requirements](https://support.google.com/chrome/a/answer/7100626?hl=en)
