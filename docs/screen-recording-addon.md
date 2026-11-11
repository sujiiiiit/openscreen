# Screen-Recording Addon

The native macOS recording stack in `packages/mac-addon`. Tracks the **screen** path end to end: capture via ScreenCaptureKit, encoding via AVAssetWriter / VideoToolbox, writing one MOV / MP4 per session. System audio and macOS 15+ microphone audio are muxed into the screen writer; the camera path (`CameraTrack.mm`) uses a separate AVCaptureSession + AVAssetWriter and writes `camera.mov`. A separate **input path** (`InputTrack.mm`, `CursorTrack.mm`) records mouse / keystroke / cursor-shape metadata into Screen Studio-shaped sidecar JSON - see [Input capture](#input-capture-mouse--keystrokes--cursor).

For the full recorder audit, see:

- [Recorder Feature Map](recorder-feature-map.md) - feature, file, storage, and macOS compatibility map.
- [Recorder Case Map](recorder-case-map.md) - handled, partially handled, and unhandled failure cases.

> Whenever you touch the screen path (`ScreenTrack.mm`, `RecorderSession.mm`, `Common.h`, `Bindings.mm`, `binding.gyp`, the recorder settings IPC, or the Recording Quality window) or the input path (`InputTrack.mm`, `CursorTrack.mm`, the input-capture options, or the Input Monitoring permission), update this doc in the same change. See `CLAUDE.md`.

## Pipeline

```
SCShareableContent ─┐
SCContentFilter   ─┼─► SCStream ─► CMSampleBuffer ─► AVAssetWriterInput(s) ─► .mov / .mp4
SCStreamConfig    ─┘                                  (one AVAssetWriter per session)
```

- `ScreenTrack` owns the `SCStream`, the `AVAssetWriter`, and three writer inputs (screen video, system audio, microphone audio).
- `RecorderSession` glues `ScreenTrack` + `CameraTrack` together, builds the manifest, and exposes the lifecycle to JS via `Bindings.mm`.
- All three sample-buffer outputs share `SCStream.synchronizationClock` so audio/video stay in sync without resampling.
- Sample-buffer callbacks are delivered synchronously on per-output dispatch queues (`openscreen.sck.screen`, `.systemAudio`, `.microphone`).

## Settings surface

Exposed through `StartRecordingOptions` (see `packages/mac-addon/index.d.ts`) and stored per-user in `<userData>/recording-quality.json` by the Electron main process. The Settings window (`src/app/recording-settings/page.tsx`) is the user-facing entry point; the menu item lives in the recorder bar's settings menu, just below "Don't record cursor". Since 2026-06-07 the same window also hosts an **Editor** section (grouped with `SectionTitle` headers "Recording" / "Editor") with two default-size `Switch` rows — "Autoplay on open" and "Remember sidebar tab" — that read/write the editor's `localStorage` preference keys directly (helpers in `src/components/editor/canvas/autoplay-preference.ts` and `src/components/editor/sidebar/tab-preference.ts`; no IPC — all windows share the same origin's `localStorage`, and the editor picks up tab-persist toggles via the cross-window `storage` event). See `docs/editor-canvas.md` for those features.

| Option | Type | Default | Effect |
|---|---|---|---|
| `videoCodec` | `'hevc' \| 'h264'` | `hevc` on Apple Silicon, `h264` on Intel | Picks the AVAssetWriter codec. |
| `videoQuality` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | `high` | Bits-per-pixel multiplier for the encoder. |
| `container` | `'mov' \| 'mp4'` | `mov` | AVFileType. Both codecs work in both containers. |
| `resolutionMode` | `'native' \| 'logical'` | `native` | Native = logical × `pointPixelScale` (Retina). Logical = 1×. |
| `frameRate` | `0 \| 24 \| 30 \| 60` | `60` | `0` = native refresh (1/120 minimum interval). |

The Electron main process validates settings against this set before each `startRecording` call (`electron/ipc/recorder.ts` `coerceRecordingQualitySettings`); the native side does the same in `ScreenTrack -resolveOptions`. Unknown values fall back to defaults.

**Intentionally not exposed**: ProRes (300+ Mbps editing-only files), HEVC-with-Alpha (niche compositing workflows), HDR (requires HDR display + downstream tools that handle BT.2020/PQ correctly). Removing these kept the pipeline universally playable and the coercion logic small.

## Input capture (mouse / keystrokes / cursor)

A second capture path, **independent of the video**, records mouse, keystroke, and cursor-shape metadata into Screen Studio-shaped sidecar JSON files next to the screen video. Owned by `InputTrack` (events) + `CursorCatalog` (cursor shapes); wired into `RecorderSession` alongside the screen/camera/audio tracks. None of this alters the recorded frames — it's pure sidecar data an editor can use for cursor smoothing, click-driven auto-zoom, keystroke overlays, etc.

```
CGEventTap (HID, listen-only, dedicated thread) ──► InputTrack ──► mousemoves-0.json / mouseclicks-0.json / keystrokes-0.json
keyDown ─(+40 ms, coalesced)─► _axQueue: AX focused element caret ─► typingcaret-0.json
main-queue timer (display-refresh) ─► CursorCatalog ─► cursors.json + cursors/<id>.png
```

**Options** (`StartRecordingOptions`, parsed in `Bindings.mm`):

| Option | Default | Effect |
|---|---|---|
| `captureInput` | `false` | Master switch. Implied by the two below. The Electron layer passes `true` on every recording. |
| `captureCursorShapes` | `false` | Build the NSCursor catalog + stamp a semantic `cursorId` on every event. Electron passes `true`. |
| `captureKeyStrokes` | `false` | Record keystrokes (+ text-caret rects when Accessibility is granted). The Electron layer passes `RecorderSettings.captureKeystrokes`, which is **on by default** (2026-11-11) and togglable from the recorder settings menu ("Capture keystrokes"). Gated on the **Input Monitoring** permission — the native side silently no-ops key capture if it's not granted; `recorder.ts` `ensureKeystrokePermissionRequested` fires the TCC prompt (fire-and-forget) at each recording start while the state is `notDetermined`, so a session started before the grant simply has no keys. |

**Output files** (written into the recording's `outputDir`, names match Screen Studio):

| File | Schema (keys sorted alphabetically, matching Screen Studio) |
|---|---|
| `mousemoves-0.json` | `{activeModifiers[], cursorId, processTimeMs, type:"mouseMoved"\|"mouseDragged", unixTimeMs, x, y}` (+`button` on drags) |
| `mouseclicks-0.json` | `{activeModifiers[], button, cursorId, processTimeMs, type:"mouseDown"\|"mouseUp", unixTimeMs, x, y}` |
| `keystrokes-0.json` | `{activeModifiers[], character, isARepeat, processTimeMs, type:"keyDown"\|"keyUp", unixTimeMs}` |
| `typingcaret-0.json` | `{activeModifiers[], height, processTimeMs, source:"caret"\|"element", type:"caret", unixTimeMs, width, x, y}` — display-relative points, top-left (same space as mouse samples). Only with keystrokes **and** `AXIsProcessTrusted()`. |
| `cursors.json` + `cursors/<id>.png` | `{hotSpot{x,y}, id, standardSize{width,height}, systemCursor}` per shape; PNGs at native asset resolution |

**Clock model** — events carry host-clock timestamps (`processTimeMs`, `CMClockGetHostTimeClock` domain in ms) plus `unixTimeMs`. The CGEventTap path stamps `processTimeMs` with the host clock at callback time; the NSEvent fallback uses `NSEvent.timestamp × 1000` (same domain). The input `session.processTimeStartMs` is **anchored to the screen video's first written frame** (`ScreenTrack -sessionStartHostMs`, passed via `RecorderSession -setVideoStartHostMs:`), **not** the stream-start `hostStartMs`. This matters: ScreenCaptureKit delivers the first frame ~100–200 ms after the stream starts, and the `.mov`'s source time 0 is that first frame — so anchoring the cursor timeline to `hostStartMs` instead would make the cursor lag the video by that startup delay. With the anchor, `event.processTimeMs − session.processTimeStartMs` equals the video's source time, so cursor and video share origin 0. Moves captured before the first frame get a negative relative time and are dropped by the renderer.

**Boundary bookends** — capture is event-based, so it writes nothing while the pointer is stationary. That left two gaps the editor saw as a missing cursor: a *leading* gap (mouse still until its first move after Start) and a *trailing* gap (mouse parked on the Stop button before the click). `InputTrack` now bookends the move stream so the recorded data spans the whole session: it samples the pointer location (`_startPoint`, read directly from CoreGraphics) and, in `-finish`, appends one synthetic `mouseMoved` stamped at the anchor time (`_videoStartHostMs` → source time 0) and one at the session-end host time (`_endProcessMs`, at the pointer's resting spot). `_startPoint` is captured once at recording start (before the tap is even live) as a fallback, then **re-sampled the moment the timeline origin is anchored** (`-setVideoStartHostMs:`, the first written frame), so the held opening position matches the timestamp it is stamped with even if the pointer drifted during ScreenCaptureKit's startup gap. These appends run on the write queue and are flushed before the stream is finalized; the renderer sorts by time, so inserting the start sample out of order is fine. The leading sample carries the default `arrow` shape (the real start shape isn't known retroactively; the 60 Hz shape sampler corrects it within a frame or two). Independently, the renderer **holds** the first/last position across any residual gap rather than hiding — see `docs/editor-canvas.md` → Cursor Overlay.

**Coordinates** — display-relative **logical points**, top-left origin: `CGEventGetLocation(event.CGEvent) − CGDisplayBounds(displayId).origin`. Map point → video pixel with the manifest's `scaleFactor` (Retina backing scale). The recorded display is `target.displayId` (or main display).

**Cursor shapes (full parity)** — `CursorCatalog` enumerates every `NSCursor` factory: 18 public + 20 private selectors (`_windowResizeEastWestCursor`, `busyButClickableCursor`, …), each guarded by `+respondsToSelector:`. On an initialized AppKit app this yields the full 38-cursor catalog with Screen Studio's exact ids. At runtime a 60 Hz main-queue timer resolves `[NSCursor currentSystemCursor]` by hashing its TIFF bitmap (FNV-1a) against the catalog; a shape change with no recent real move synthesises a `mouseMoved` so the shape timeline stays accurate while the pointer is stationary. Unknown bitmaps (an app's custom cursor) are added as `custom-N` with `systemCursor:false`.

**Text caret (Accessibility)** — every keyDown calls `-scheduleCaretQuery`, which (via an atomic flag) schedules at most ONE read `kCaretQueryDelayMs` (40 ms) later on the private serial `_axQueue`, so the focused app has processed the key and a burst of keys coalesces into one read (≈25 Hz ceiling). `CopyFocusedCaretRect` asks the system-wide element (`AXUIElementCreateSystemWide`, messaging timeout 50 ms so a hung app can't stall the queue) for `kAXFocusedUIElementAttribute` → `kAXSelectedTextRangeAttribute` → `kAXBoundsForRangeParameterizedAttribute`; an empty range most apps can't measure falls back to the trailing edge of the previous character, and failing that to the focused element's frame (`source:"element"`). Rects off the recorded display are dropped. `-finish` drains `_axQueue` (reads no-op once `_stopping` is set) before closing the sidecars. The AX calls never run on the tap thread. Requires linking **ApplicationServices** (`binding.gyp`). The editor consumes it for hide-cursor-while-typing and caret-follow zoom (`docs/editor-canvas.md` → Typing Behavior); main forwards only key **timestamps** (shortcuts / Escape / F-keys filtered out by `isTypingKeyStroke`) and the caret rects to the renderer — never the typed characters.

**Manifest** — `RecorderSession` adds an `input`-source entry to `outputs[]` (filenames, `captureKeyStrokes`/`captureTypingCaret`/`captureCursorShapes`, `displayId`, `displayBoundsPoints`, and a `session` block with the dual-clock window + per-stream counts incl. `typingCaretCount`), and merges the sidecar paths into the `files` map (`mouseMoves`/`mouseClicks`/`keyStrokes`/`typingCaret`/`cursors`).

**Capture mechanism** — a **listen-only `CGEventTap` at `kCGHIDEventTap`** on a dedicated `CFRunLoop` thread is the primary path. It's chosen over an `NSEvent` global monitor for three reasons the global monitor can't satisfy: (1) it captures moves **over our own recorder UI** (global `NSEvent` monitors only see *other* apps' events — the cause of the multi-second opening gap), (2) it sees **every HID sample before coalescing**, and (3) it's **independent of the main run loop** so main-thread load can't throttle capture. It relies on the **Accessibility** permission, which the app already requires (`REQUIRED_PERMISSIONS` in `electron/ipc/permissions.ts`); keystroke events additionally need Input Monitoring (gated by `_keyStrokesActive`). If `CGEventTapCreate` fails (e.g. Accessibility revoked), `InputTrack` falls back to an `NSEvent` global monitor with mouse coalescing disabled. The tap callback runs on the tap thread, so `_currentCursorId` (written by the main-thread cursor sampler) is guarded by an `os_unfair_lock`; a `dispatch_semaphore` handshake makes `-finish` stop the tap thread without racing its setup/teardown.

**Threading & performance** — event serialization + file I/O are dispatched to a private serial queue via `StreamingJSONArray`, so the high-frequency move stream (~120 Hz) never blocks the capture thread or routes through per-event IPC. The cursor sampler + catalog build run on the main thread (NSCursor is main-thread-affine); the catalog build is kicked off **asynchronously after** the tap/monitor is live so it never delays the first captured movement.

## Color-fidelity philosophy

The screen-recording stack targets the **"Apple gold standard"** for SDR output — visually identical to what `Cmd+Shift+5` (QuickTime screen recording) produces on the same display, including correct perceptual P3 → BT.709 gamut handling on Display-P3 monitors. Concretely:

- **Pixel format**: BGRA 8-bit. Always.
- **`SCStreamConfiguration.colorSpaceName = kCGColorSpaceSRGB`.** ScreenCaptureKit performs a **hardware-accelerated GPU color conversion** to sRGB before delivering the buffer, so wide-gamut Display-P3 source pixels are properly gamut-mapped to sRGB instead of being silently clipped. Writer-side `AVVideoColorPropertiesKey` tags the output BT.709 (sRGB shares primaries with BT.709 — only a small transfer-function adjustment remains, which AVAssetWriter handles cleanly). Without setting `colorSpaceName`, recordings on P3 displays come out visibly washed-out — the bug OBS Studio shipped with for years ([`obsproject/obs-studio#12414`](https://github.com/obsproject/obs-studio/issues/12414), [`#9658`](https://github.com/obsproject/obs-studio/issues/9658)).
- **`captureDynamicRange = .SDR`** (macOS 15+; on 13/14 SCKit is implicitly SDR).
- **Encoder profile**: VideoToolbox's default — Main 8-bit for HEVC, High AutoLevel for H.264. Matches BetterCapture.
- **B-frames**: enabled (VT default).
- **Bitrate**: `width × height × fps × bpp` with the BetterCapture bpp table. No artificial floor.
- **Audio**: 48 kHz / 2-channel AAC at 256 kbps. No explicit `AVChannelLayoutKey` — derived from channel count.

The output is **universally playable** — every macOS / iOS / Windows / Linux / web player handles BT.709 8-bit HEVC and H.264 correctly. If a future need for wide-gamut SDR (P3-D65) or HDR arises, those are documented design space, not present code.

## Codec & container matrix

| Codec | MOV | MP4 | Profile / pixel format |
|---|---|---|---|
| H.264 | ✅ | ✅ | High AutoLevel, 8-bit BGRA. |
| HEVC | ✅ | ✅ | Default Main 8-bit, BGRA. |

Both codecs work in both containers with no compatibility coercion needed.

## Color tagging

One pipeline, written into every file:

- Capture side: `SCStreamConfiguration.colorSpaceName = kCGColorSpaceSRGB`, `captureDynamicRange = .SDR`, `pixelFormat = BGRA`. SCKit performs a GPU-accelerated source-gamut → sRGB conversion before delivering the buffer — this is the critical step that fixes the "washed-out P3" failure mode.
- Writer side: `AVVideoColorPropertiesKey = { BT.709, BT.709, BT.709 }` — universal SDR colorimetry. No profile-level key (VideoToolbox picks HEVC Main 8-bit / H.264 High AutoLevel by default).

Net effect: visually identical to `Cmd+Shift+5`.

## Bitrate model

```
bitrate = width × height × frameRate × bitsPerPixel
```

| Quality | H.264 bpp | HEVC bpp | Notes |
|---|---|---|---|
| Low | 0.04 | 0.02 | Smallest files; visible compression on text. |
| Medium | 0.20 | 0.15 | Reasonable balance. |
| **High (default)** | **0.60** | **0.40** | Crisp text and edges. Matches BetterCapture "High". |
| XHigh | 1.20 | 0.80 | 2× of High. Near-lossless on screen content. |
| Max | 2.40 | 1.60 | 4× of High. Minimal compression; large files. |

HEVC needs roughly half the rate of H.264 for the same perceived quality. Keyframes are placed every `frameRate × 2` (~2 s). B-frames are left at the VideoToolbox default (enabled).

The XHigh and Max tiers are above the typical "diminishing returns" knee for HEVC — VideoToolbox won't always spend every requested bit (a static UI frame produces a tiny encoded payload regardless of the budget), so effective file size grows sub-linearly past XHigh. Useful when the user wants encoding quality to be a non-variable.

## macOS version matrix

Deployment target: **macOS 13.0**. Symbols newer than 13.0 are gated with `@available`.

| Capability | 13.0 | 13.1 | 14.0 | 14.2 | 15.0+ |
|---|:-:|:-:|:-:|:-:|:-:|
| SCK screen capture, HEVC/H.264, MOV/MP4, sRGB color conversion | ✅ | ✅ | ✅ | ✅ | ✅ |
| `SCStreamFrameInfo.screenRect` attachment | — | ✅ | ✅ | ✅ | ✅ |
| `SCStreamFrameInfo.boundingRect` attachment | — | — | ✅ | ✅ | ✅ |
| `preservesAspectRatio`, `ignoreShadowsSingleWindow`, `ignoreGlobalClipSingleWindow` | — | — | ✅ | ✅ | ✅ |
| `includeChildWindows` | — | — | — | ✅ | ✅ |
| `captureDynamicRange = .SDR` (explicit) | — | — | — | — | ✅ |
| `applicationsToInclude` (per-app audio scoping for display/region) | — | — | — | — | ✅ |
| SCStream microphone output (`captureMicrophone`) | — | — | — | — | ✅ |
| AVFoundation external-camera discovery via `AVCaptureDeviceTypeExternal` | — | — | ✅ | ✅ | ✅ |

Minimum support is macOS 13.0 for screen capture, built-in / default camera capture, system audio, cursor/input sidecars, and output writing. macOS 13/14 do **not** record microphone audio through the current pipeline; `getCapabilities().screenCaptureKitMicrophone` reports `false` and there is no AVFoundation microphone fallback. Per-app system-audio scoping for `display` / `region` targets is macOS 15+; on pre-15, only a window target gets practical app-level scoping from the `SCContentFilter`. External / Continuity camera discovery is incomplete on macOS 13 because `Devices.mm` does not include the deprecated pre-14 external camera type.

## Reliability invariants

- **`@available` gates on every 14+ / 15+ symbol** so the addon never crashes on macOS 13/14 against a newer SDK.
- **Settings validation runs twice** — once on the JS side before `startRecording`, once on the native side in `-resolveOptions`. Unknown enum values fall back to defaults.
- **Display picking is cursor-scoped, not primary-display-scoped.** The display picker and the generic default display target ask the native addon for the CoreGraphics display under the cursor, then map that `CGDirectDisplayID` back to Electron for overlay bounds. The display/window picker overlay is moved onto the target display instead of relying on one virtual-desktop-sized panel; macOS can otherwise keep that panel attached to the Dock/active Space display, making the selection for another monitor render off-screen. If the native lookup is unavailable, the fallback first checks which Electron display contains the cursor before using `getDisplayNearestPoint`.
- **Region picking uses one overlay per display until drawing starts.** Region mode creates a transparent picker panel on every attached display so the user can start a drag on any monitor. Once the first real drag is reported from one panel, the picker destroys the other display panels and keeps the active panel for resizing/confirmation. This avoids cross-display `NSPanel` visibility issues and prevents accidental multi-display regions.
- **`SCStreamFrameInfo.status` filter** — only `SCFrameStatusComplete` frames are passed to `appendSampleBuffer:`. Empty / idle / blank buffers would otherwise crash VideoToolbox.
- **Pause timestamp shifting is lock-guarded** — pause/resume does not split files; samples captured after resume are shifted backward by accumulated pause time before append.
- **`expectsMediaDataInRealTime = YES`** on every writer input lets the encoder make rate-control trade-offs suited to live capture.
- **Single `AVAssetWriter` for the screen file** — one MOV/MP4 with screen video plus system audio and, on macOS 15+, microphone audio. Camera is intentionally separate in `camera.mov`.
- **`queueDepth = 8`** on the `SCStreamConfiguration`. Backpressure emits a single native `'backpressure'` event and dropped counts are written to the manifest, but the current preload/renderer bridge does not surface those events to the active controls UI yet.

## Settings UI flow

1. User opens the recorder bar's settings menu → "Recording quality…".
2. Renderer invokes `recorder:openRecordingSettings` → main process opens the Recording Quality `BrowserWindow` (configured via `windowConfigs.recordingSettingsWin`, loaded from `/recording-settings/`). The window is transparent: macOS uses `vibrancy: 'under-window'` with `titleBarStyle: 'hidden'`; Windows / Linux use `transparent: true` (Windows also requests `backgroundMaterial: 'acrylic'`). The page must render **no opaque background** so the native vibrancy / acrylic shows through. The root element sets `data-window="recording-settings"` and stays `bg-transparent`; the `html:has([data-window="recording-settings"])` selector in `src/app/globals.css` clears the default body background. Mirror this pattern when adding new transparent windows.
3. The page calls `recorder:getRecordingSettings` on mount to hydrate.
4. Every form change calls `recorder:setRecordingSettings(patch)`. The main process validates the merged settings, persists them to `<userData>/recording-quality.json`, broadcasts the new state via `recorder:changed`, and **returns the canonical resolved settings** so the form reflects any value coercion immediately.
5. The Editor section bypasses this IPC loop entirely: its two switches write `localStorage` synchronously (shared across all windows of the origin), so there is nothing to hydrate from main and no coercion step.
6. On `startRecording`, the resolved settings flow into `StartRecordingOptions` (`videoCodec`, `videoQuality`, `container`, `resolutionMode`, `frameRate`). The native side validates once more and writes the final values into the manifest under `outputs[].videoCodec` etc.

## Verification

After any change, rebuild the addon and inspect a sample recording's metadata.

```bash
# Rebuild the native addon.
cd packages/mac-addon
npx node-gyp rebuild

# Type-check the TypeScript surface.
cd ../..
pnpm typecheck

# Inspect a recording's actual stream parameters.
ffmpeg -i ~/Documents/openscreen/<session>/screen.mov 2>&1 | head -40
mediainfo ~/Documents/openscreen/<session>/screen.mov | grep -E \
  "Format|Bit rate|Color primaries|Transfer|Matrix|Bit depth|Profile"
```

Expected tags for every recording (the pipeline is single-path SDR):

| `bit depth` | `colour primaries` | `transfer` | `matrix` |
|---|---|---|---|
| 8 | BT.709 | BT.709 | BT.709 |

The recording's `recording.json` manifest, or `<basename>-recording.json` when a basename is supplied, also records every resolved setting under `outputs[]`, and carries a root **`version: 1`** schema field (`RecorderSession.mm` → `manifestDictionary`; optional `version?: number` on the TS `RecordingManifest`). Recordings made before the field shipped have no `version` — readers must treat absence as the original/unversioned shape and must never *require* the field. Bump it when a manifest field changes shape or meaning so readers can branch on the version instead of inferring from heuristics (the editor already had to guess old-vs-new sidecar clock anchors once).

```bash
# A fresh recording's manifest carries the schema version.
head -3 ~/Documents/openscreen/<session>/recording.json   # expect "version": 1
```

For the input path, inspect the sidecars in the recording folder:

```bash
# Event counts + that the dual clock + cursorIds look sane.
head -c 400 <session>/mousemoves-0.json; echo
head -c 400 <session>/typingcaret-0.json; echo   # caret rects after typing (needs Accessibility)
python3 -c "import json,glob; [print(f, len(json.load(open(f)))) for f in glob.glob('<session>/mouse*-0.json')]"
ls <session>/cursors/ | wc -l   # 38 system cursors on a normal session
```

## Known limitations

- The output is **SDR-only**. EDR / HDR content on the display gets tone-mapped to SDR. Intentional — keeps every recording universally playable.
- The output is **BT.709-only**. Display-P3 colors are perceptually gamut-mapped to BT.709 on the capture side. Intentional — same reason.
- The output uses **8-bit BGRA**. No 10-bit precision path. Intentional — Main10 SDR is occasionally mishandled by older players.
- Per-app audio scoping (`audioApplications`) is **macOS 15+** for `display` and `region` capture modes. On `window` mode pre-15, `SCContentFilter` implicitly scopes audio to the targeted window's owning app.
- SCK microphone capture is **macOS 15+**; older macOS receives no microphone track. The mic toggle remains in the UI but produces no audio on 13/14.
- Native recording events (`error`, `backpressure`) are emitted by the addon but not yet promoted into `RecorderState` or exposed through `window.api.recorder`, so mid-recording faults may be visible only after Stop or in the manifest.
- `AVAssetWriter.finishWritingWithCompletionHandler` waits are currently unbounded in the screen and camera writer paths. This is the main remaining stop/finalize risk for very long recordings.
- SCK delivers frames only when content changes. The `frameRate` setting is a *minimum interval* — actual delivered rates are typically below 120 fps even on a ProMotion display when the screen is static.
- **Input capture requires Accessibility.** The primary `CGEventTap` needs the Accessibility grant (already a `REQUIRED_PERMISSIONS` entry). Without it, capture falls back to an `NSEvent` global monitor, which does **not** see moves over our own recorder UI (causing a multi-second opening gap) and only delivers ~refresh-rate coalesced moves.
- **Cursor-shape resolution depends on `[NSCursor currentSystemCursor]`.** Validated to resolve all 38 system cursors correctly under an initialized `NSApplication` (always true in Electron). A bare non-GUI process returns no images for `arrow`/`iBeam` — a test-harness artifact, not a runtime concern.
- **Keystroke capture records typed text in plaintext** (including passwords) in `keystrokes-0.json` inside the project folder. It is **on by default** (so the editor's typing features work out of the box), can be turned off from the settings menu, and is gated by the Input Monitoring TCC permission. The renderer never receives the characters — only key timestamps — but the sidecar on disk does contain them.
- **Caret precision depends on the focused app's Accessibility support.** Native AppKit text views report exact carets; some Electron / web apps report only the field frame (`source:"element"`) or nothing (no caret sample — the editor falls back to the pointer).
- The input path does **not** capture scroll-wheel events (neither does Screen Studio in the inspected format).
- Pause/resume **gates** input events (drops them while paused) rather than splitting files; sidecar filenames stay at session index `0`.

## Source map

- `packages/mac-addon/binding.gyp` — deployment target (13.0), framework links.
- `packages/mac-addon/src/Common.h` — `RecordingOptions` struct (incl. `captureInput` / `captureKeyStrokes` / `captureCursorShapes`).
- `packages/mac-addon/src/Bindings.mm` — JS → `RecordingOptions` parser, `getCapabilities`.
- `packages/mac-addon/src/InputTrack.{h,mm}` — `CGEventTap` (+ `NSEvent` fallback), streaming-JSON sidecars, dual-clock stamping, cursor sampler, Accessibility text-caret sampling.
- `packages/mac-addon/src/CursorTrack.{h,mm}` — `CursorCatalog`: NSCursor catalog (`cursors.json` + PNGs) and runtime bitmap matching.
- `packages/mac-addon/src/Permissions.mm` — Input Monitoring (`IOHIDCheckAccess` / `IOHIDRequestAccess`), `inputMonitoring` permission.
- `packages/mac-addon/src/ScreenTrack.mm` — `-resolveOptions`, `-streamConfigurationForContent:`, `-videoColorProperties`, `-videoCompressionProperties`, `-prepareWriter:`, `-appendVideoSampleBuffer:`, `-metadata`.
- `packages/mac-addon/src/RecorderSession.mm` — container-aware file extension, manifest assembly.
- `packages/mac-addon/index.d.ts` — `VideoCodec`, `VideoQuality`, `ContainerFormat`, `ResolutionMode`, `FrameRate`, `StartRecordingOptions`, manifest metadata fields.
- `electron/ipc/display-target.ts` — cursor-scoped display resolution shared by display picker and default recorder start.
- `electron/ipc/recorder.ts` — `RecordingQualitySettings`, persistence, `coerceRecordingQualitySettings`, IPC handlers.
- `electron/preload.ts` — `getRecordingSettings` / `setRecordingSettings` / `openRecordingSettings` bridge.
- `src/types/api.d.ts` — renderer-facing mirror of `RecordingQualitySettings`.
- `electron/main.ts` + `electron/windowConfigs.ts` — `createRecordingSettingsWindow` + `recordingSettingsWin` window config.
- `src/app/recording-settings/page.tsx` — Settings window (Recording quality section + Editor preferences section).
