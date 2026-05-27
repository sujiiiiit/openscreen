# Screen-Recording Addon

The native macOS recording stack in `packages/mac-addon`. Tracks the **screen** path end to end: capture via ScreenCaptureKit, encoding via AVAssetWriter / VideoToolbox, writing one MOV / MP4 per session. The microphone and camera paths share the same `AVAssetWriter` but live in separate source files (`MicrophoneTrack.mm`, `CameraTrack.mm`). A separate **input path** (`InputTrack.mm`, `CursorTrack.mm`) records mouse / keystroke / cursor-shape metadata into Screen Studio-shaped sidecar JSON — see [Input capture](#input-capture-mouse--keystrokes--cursor).

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

Exposed through `StartRecordingOptions` (see `packages/mac-addon/index.d.ts`) and stored per-user in `<userData>/recording-quality.json` by the Electron main process. The Recording Quality window (`app/recording-settings/page.tsx`) is the user-facing entry point; the menu item lives in the recorder bar's settings menu, just below "Don't record cursor".

| Option | Type | Default | Effect |
|---|---|---|---|
| `videoCodec` | `'hevc' \| 'h264'` | `hevc` on Apple Silicon, `h264` on Intel | Picks the AVAssetWriter codec. |
| `videoQuality` | `'low' \| 'medium' \| 'high'` | `high` | Bits-per-pixel multiplier for the encoder. |
| `container` | `'mov' \| 'mp4'` | `mov` | AVFileType. Both codecs work in both containers. |
| `resolutionMode` | `'native' \| 'logical'` | `native` | Native = logical × `pointPixelScale` (Retina). Logical = 1×. |
| `frameRate` | `0 \| 24 \| 30 \| 60` | `60` | `0` = native refresh (1/120 minimum interval). |

The Electron main process validates settings against this set before each `startRecording` call (`electron/ipc/recorder.ts` `coerceRecordingQualitySettings`); the native side does the same in `ScreenTrack -resolveOptions`. Unknown values fall back to defaults.

**Intentionally not exposed**: ProRes (300+ Mbps editing-only files), HEVC-with-Alpha (niche compositing workflows), HDR (requires HDR display + downstream tools that handle BT.2020/PQ correctly). Removing these kept the pipeline universally playable and the coercion logic small.

## Input capture (mouse / keystrokes / cursor)

A second capture path, **independent of the video**, records mouse, keystroke, and cursor-shape metadata into Screen Studio-shaped sidecar JSON files next to the screen video. Owned by `InputTrack` (events) + `CursorCatalog` (cursor shapes); wired into `RecorderSession` alongside the screen/camera/audio tracks. None of this alters the recorded frames — it's pure sidecar data an editor can use for cursor smoothing, click-driven auto-zoom, keystroke overlays, etc.

```
NSEvent global monitor (main run loop) ──► InputTrack ──► mousemoves-0.json / mouseclicks-0.json / keystrokes-0.json
CVDisplayLink-equivalent main-queue timer ─► CursorCatalog ─► cursors.json + cursors/<id>.png
```

**Options** (`StartRecordingOptions`, parsed in `Bindings.mm`):

| Option | Default | Effect |
|---|---|---|
| `captureInput` | `false` | Master switch. Implied by the two below. The Electron layer passes `true` on every recording. |
| `captureCursorShapes` | `false` | Build the NSCursor catalog + stamp a semantic `cursorId` on every event. Electron passes `true`. |
| `captureKeyStrokes` | `false` | Record keystrokes. **Opt-in** via the recorder settings menu ("Capture keystrokes", `RecorderSettings.captureKeystrokes`). Gated on the **Input Monitoring** permission — the native side silently no-ops key capture if it's not granted. |

**Output files** (written into the recording's `outputDir`, names match Screen Studio):

| File | Schema (keys sorted alphabetically, matching Screen Studio) |
|---|---|
| `mousemoves-0.json` | `{activeModifiers[], cursorId, processTimeMs, type:"mouseMoved"\|"mouseDragged", unixTimeMs, x, y}` (+`button` on drags) |
| `mouseclicks-0.json` | `{activeModifiers[], button, cursorId, processTimeMs, type:"mouseDown"\|"mouseUp", unixTimeMs, x, y}` |
| `keystrokes-0.json` | `{activeModifiers[], character, isARepeat, processTimeMs, type:"keyDown"\|"keyUp", unixTimeMs}` |
| `cursors.json` + `cursors/<id>.png` | `{hotSpot{x,y}, id, standardSize{width,height}, systemCursor}` per shape; PNGs at native asset resolution |

**Clock model** — events carry the same dual clock the rest of the session uses: `processTimeMs = NSEvent.timestamp × 1000` (seconds-since-boot, the `CMClockGetHostTimeClock` domain) and `unixTimeMs = processTimeMs + (startedAtUnixMs − hostStartMs)`. Unlike Screen Studio (whose `processTimeMs` is *process*-relative, ~444 ms at start), ours is *boot*-relative — the absolute origin differs but the editor-relevant relationship `event.processTimeMs − session.processTimeStartMs` and the `unixTimeMs` epoch are identical.

**Coordinates** — display-relative **logical points**, top-left origin: `CGEventGetLocation(event.CGEvent) − CGDisplayBounds(displayId).origin`. Map point → video pixel with the manifest's `scaleFactor` (Retina backing scale). The recorded display is `target.displayId` (or main display).

**Cursor shapes (full parity)** — `CursorCatalog` enumerates every `NSCursor` factory: 18 public + 20 private selectors (`_windowResizeEastWestCursor`, `busyButClickableCursor`, …), each guarded by `+respondsToSelector:`. On an initialized AppKit app this yields the full 38-cursor catalog with Screen Studio's exact ids. At runtime a 60 Hz main-queue timer resolves `[NSCursor currentSystemCursor]` by hashing its TIFF bitmap (FNV-1a) against the catalog; a shape change with no recent real move synthesises a `mouseMoved` so the shape timeline stays accurate while the pointer is stationary. Unknown bitmaps (an app's custom cursor) are added as `custom-N` with `systemCursor:false`.

**Manifest** — `RecorderSession` adds an `input`-source entry to `outputs[]` (filenames, `captureKeyStrokes`/`captureCursorShapes`, `displayId`, `displayBoundsPoints`, and a `session` block with the dual-clock window + per-stream counts), and merges the sidecar paths into the `files` map (`mouseMoves`/`mouseClicks`/`keyStrokes`/`cursors`).

**Threading & performance** — the `NSEvent` monitor handler and cursor sampler both run on the main thread (single-threaded, no locks on the cursor cache); event serialization + file I/O are dispatched to a private serial queue via `StreamingJSONArray`, so the high-frequency move stream (~120 Hz) never blocks the main thread or routes through per-event IPC. `start`/`finish` marshal their AppKit work (monitor install/remove, catalog build) to the main thread with `dispatch_sync`, so they're safe to call from the background `StartRecordingWorker`.

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

The screen-recording feature set is identical on 13.0 and 15.0+; only audio scoping and SCK-based microphone become available on 15+.

## Reliability invariants

- **`@available` gates on every 14+ / 15+ symbol** so the addon never crashes on macOS 13/14 against a newer SDK.
- **Settings validation runs twice** — once on the JS side before `startRecording`, once on the native side in `-resolveOptions`. Unknown enum values fall back to defaults.
- **`SCStreamFrameInfo.status` filter** — only `SCFrameStatusComplete` frames are passed to `appendSampleBuffer:`. Empty / idle / blank buffers would otherwise crash VideoToolbox.
- **Monotonic PTS guard** — drops any sample whose presentation timestamp is ≤ the previous appended frame, protecting against Presenter Overlay timing glitches that would otherwise permanently fail the writer.
- **`expectsMediaDataInRealTime = YES`** on every writer input lets the encoder make rate-control trade-offs suited to live capture.
- **Single `AVAssetWriter`** for the whole session — one MOV/MP4 with up to three muxed inputs (video, system audio, microphone audio). The audio tracks are forwarded into the screen writer by `SystemAudioTrack` / `MicrophoneTrack`.
- **`queueDepth = 8`** on the `SCStreamConfiguration` (the SCK default). Backpressure emits a single `'backpressure'` recording event so the renderer can surface it once.

## Settings UI flow

1. User opens the recorder bar's settings menu → "Recording quality…".
2. Renderer invokes `recorder:openRecordingSettings` → main process opens the Recording Quality `BrowserWindow` (configured via `windowConfigs.recordingSettingsWin`, loaded from `/recording-settings/`). The window is transparent: macOS uses `vibrancy: 'under-window'` with `titleBarStyle: 'hidden'`; Windows / Linux use `transparent: true` (Windows also requests `backgroundMaterial: 'acrylic'`). The page must render **no opaque background** so the native vibrancy / acrylic shows through. The root element sets `data-window="recording-settings"` and stays `bg-transparent`; the `html:has([data-window="recording-settings"])` selector in `app/globals.css` clears the default body background. Mirror this pattern when adding new transparent windows.
3. The page calls `recorder:getRecordingSettings` on mount to hydrate.
4. Every form change calls `recorder:setRecordingSettings(patch)`. The main process validates the merged settings, persists them to `<userData>/recording-quality.json`, broadcasts the new state via `recorder:changed`, and **returns the canonical resolved settings** so the form reflects any value coercion immediately.
5. On `startRecording`, the resolved settings flow into `StartRecordingOptions` (`videoCodec`, `videoQuality`, `container`, `resolutionMode`, `frameRate`). The native side validates once more and writes the final values into the manifest under `outputs[].videoCodec` etc.

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
ffmpeg -i ~/Movies/openscreen-recordings/<session>/screen.mov 2>&1 | head -40
mediainfo ~/Movies/openscreen-recordings/<session>/screen.mov | grep -E \
  "Format|Bit rate|Color primaries|Transfer|Matrix|Bit depth|Profile"
```

Expected tags for every recording (the pipeline is single-path SDR):

| `bit depth` | `colour primaries` | `transfer` | `matrix` |
|---|---|---|---|
| 8 | BT.709 | BT.709 | BT.709 |

The recording's `<basename>-recording.json` manifest also records every resolved setting under `outputs[]`.

For the input path, inspect the sidecars in the recording folder:

```bash
# Event counts + that the dual clock + cursorIds look sane.
head -c 400 <session>/mousemoves-0.json; echo
python3 -c "import json,glob; [print(f, len(json.load(open(f)))) for f in glob.glob('<session>/mouse*-0.json')]"
ls <session>/cursors/ | wc -l   # 38 system cursors on a normal session
```

## Known limitations

- The output is **SDR-only**. EDR / HDR content on the display gets tone-mapped to SDR. Intentional — keeps every recording universally playable.
- The output is **BT.709-only**. Display-P3 colors are perceptually gamut-mapped to BT.709 on the capture side. Intentional — same reason.
- The output uses **8-bit BGRA**. No 10-bit precision path. Intentional — Main10 SDR is occasionally mishandled by older players.
- Per-app audio scoping (`audioApplications`) is **macOS 15+** for `display` and `region` capture modes. On `window` mode pre-15, `SCContentFilter` implicitly scopes audio to the targeted window's owning app.
- SCK microphone capture is **macOS 15+**; older macOS receives no microphone track. The mic toggle remains in the UI but produces no audio on 13/14.
- SCK delivers frames only when content changes. The `frameRate` setting is a *minimum interval* — actual delivered rates are typically below 120 fps even on a ProMotion display when the screen is static.
- **Input capture sees only other apps' events.** `NSEvent` *global* monitors don't receive events delivered to the recorder's own windows, so interaction with OpenScreen's own UI isn't captured (matches Screen Studio; you record other apps).
- **Cursor-shape resolution depends on `[NSCursor currentSystemCursor]`.** Validated to resolve all 38 system cursors correctly under an initialized `NSApplication` (always true in Electron). A bare non-GUI process returns no images for `arrow`/`iBeam` — a test-harness artifact, not a runtime concern.
- **Keystroke capture records typed text in plaintext** (including passwords) when enabled. It is off by default, opt-in via the settings menu, and additionally gated by the Input Monitoring TCC permission.
- The input path does **not** capture scroll-wheel events (neither does Screen Studio in the inspected format).
- Pause/resume **gates** input events (drops them while paused) rather than splitting files; sidecar filenames stay at session index `0`.

## Source map

- `packages/mac-addon/binding.gyp` — deployment target (13.0), framework links.
- `packages/mac-addon/src/Common.h` — `RecordingOptions` struct (incl. `captureInput` / `captureKeyStrokes` / `captureCursorShapes`).
- `packages/mac-addon/src/Bindings.mm` — JS → `RecordingOptions` parser, `getCapabilities`.
- `packages/mac-addon/src/InputTrack.{h,mm}` — `NSEvent` global monitor, streaming-JSON sidecars, dual-clock stamping, cursor sampler.
- `packages/mac-addon/src/CursorTrack.{h,mm}` — `CursorCatalog`: NSCursor catalog (`cursors.json` + PNGs) and runtime bitmap matching.
- `packages/mac-addon/src/Permissions.mm` — Input Monitoring (`IOHIDCheckAccess` / `IOHIDRequestAccess`), `inputMonitoring` permission.
- `packages/mac-addon/src/ScreenTrack.mm` — `-resolveOptions`, `-streamConfigurationForContent:`, `-videoColorProperties`, `-videoCompressionProperties`, `-prepareWriter:`, `-appendVideoSampleBuffer:`, `-metadata`.
- `packages/mac-addon/src/RecorderSession.mm` — container-aware file extension, manifest assembly.
- `packages/mac-addon/index.d.ts` — `VideoCodec`, `VideoQuality`, `ContainerFormat`, `ResolutionMode`, `FrameRate`, `StartRecordingOptions`, manifest metadata fields.
- `electron/ipc/recorder.ts` — `RecordingQualitySettings`, persistence, `coerceRecordingQualitySettings`, IPC handlers.
- `electron/preload.ts` — `getRecordingSettings` / `setRecordingSettings` / `openRecordingSettings` bridge.
- `types/api.d.ts` — renderer-facing mirror of `RecordingQualitySettings`.
- `electron/main.ts` + `electron/windowConfigs.ts` — `createRecordingSettingsWindow` + `recordingSettingsWin` window config.
- `app/recording-settings/page.tsx` — Recording Quality window.
