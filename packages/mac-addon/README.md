# @openscreen/mac-addon

Native macOS Node.js addon for the openscreen Electron app. Wraps ScreenCaptureKit, AVFoundation, and the system permission/device APIs into a single N-API surface.

The addon's recording pipeline is tuned to match the quality and color fidelity of the macOS native screen recorder and OBS Studio: native backing-pixel resolution, 10-bit RGB capture in Display P3, HEVC Main10 encoding with explicit P3-D65 / Rec.709 color tags.

---

## Table of contents

1. [Requirements](#requirements)
2. [Build](#build)
3. [Architecture](#architecture)
4. [Public API](#public-api)
5. [Recording pipeline](#recording-pipeline)
6. [Quality settings — every knob, why it's set the way it is](#quality-settings)
   - [Resolution](#resolution)
   - [Color: pixel format, color space, color tags](#color)
   - [Codec](#codec)
   - [Frame rate, queue depth, dynamic range](#frame-rate)
   - [Audio](#audio)
7. [Camera (separate path)](#camera)
8. [Camera preview (live frames to JS)](#camera-preview)
9. [Permissions](#permissions)
10. [Capabilities](#capabilities)
11. [Output: file layout & manifest](#output)
12. [Diagnostics](#diagnostics)
13. [Verification recipes (ffprobe)](#verification)
14. [Troubleshooting](#troubleshooting)
15. [Design decisions & history](#design-decisions)

---

## Requirements

| | Required |
|---|---|
| macOS | **15.0+** (Sequoia) — drops pre-15 fallbacks; relies on `SCStream.captureMicrophone` and 10-bit HEVC Main10 paths shipped in 15. |
| Node.js | 24.x (built against the version that produced `index.js`). |
| Xcode CLI tools | Latest stable. |
| Frameworks linked | `ScreenCaptureKit`, `AVFoundation`, `VideoToolbox`, `CoreMedia`, `CoreVideo`, `CoreGraphics`, `IOSurface`, `AudioToolbox`, `AppKit`, `Foundation`, `Accelerate`. |
| ARC | **Required.** `binding.gyp` passes `-fobjc-arc`. Without ARC, static `gPreviewSession` (and similar) become dangling pointers after the next autorelease drain. |

---

## Build

```bash
cd packages/mac-addon
npx node-gyp rebuild      # full clean build
npx node-gyp build        # incremental
```

Build settings live in [`binding.gyp`](binding.gyp):

```python
"MACOSX_DEPLOYMENT_TARGET": "15.0",
"OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-stdlib=libc++", "-fobjc-arc"],
```

---

## Architecture

The addon is **split per source**, not monolithic. Each source file owns one capture concern; the session coordinator wires them together.

```
src/
├── Bindings.mm           N-API exports (Init, Start/Stop/Cancel, getCapabilities, …)
├── Common.h / .mm        Shared option/info structs, NSString⇄std::string,
│                         IsMacOSAtLeast, error helpers, Napi-property getters.
├── Events.h / .mm        EmitEvent + JS callback bridge for recorder events
│                         ("started", "stopped", "fileStarted", "error", …).
├── Permissions.h / .mm   AVCaptureDevice / CGPreflightScreenCaptureAccess /
│                         AXIsProcessTrusted checks + request helpers.
├── Devices.h / .mm       AVCaptureDeviceDiscoverySession for cameras / mics.
│
├── RecorderSession.h     Coordinator + SCStreamDelegate. Owns the four track
│  / .mm                  helpers (screen, camera, sysaudio, mic) and the
│                         shared SCStream. Holds the in-memory session store.
├── RecordingWorkers.h    Napi::AsyncWorker subclasses that move the synchronous
│  / .mm                  startSync / stopSync / cancelSync calls off the JS
│                         thread.
│
├── ScreenTrack.h / .mm   Owns the AVAssetWriter that writes screen.mov. Holds
│                         up to three AVAssetWriterInputs (video + sysaudio +
│                         mic, all muxed). Implements SCStreamOutput for screen
│                         frames; provides -appendSystemAudioSampleBuffer:
│                         and -appendMicrophoneSampleBuffer: for the audio
│                         tracks to forward into.
├── SystemAudioTrack.h    SCStreamOutput delegate for SCStreamOutputTypeAudio.
│  / .mm                  Configures sysaudio settings on SCStreamConfiguration
│                         and forwards each sample to ScreenTrack.
├── MicrophoneTrack.h     SCStreamOutput delegate for SCStreamOutputTypeMicrophone.
│  / .mm                  Same idea for the mic.
├── CameraTrack.h / .mm   Separate AVCaptureSession + AVAssetWriter for camera.
│                         Not muxed; camera is not an SCKit source.
├── MediaFileWriter.h     Generic AVAssetWriter wrapper for the camera path
│  / .mm                  (single video input). The audio-input branches are
│                         dead code from the pre-15 pipeline; left in place
│                         until camera audio is wired up.
└── CameraPreview.h       Independent AVCaptureSession that delivers live
   / .mm                  BGRA→RGBA frames to JS via Napi::ThreadSafeFunction
                          NonBlockingCall (queue 4, frames dropped if JS lags).
```

---

## Public API

Types live in [`index.d.ts`](index.d.ts). All async methods return native Promises.

### Capability + permission discovery

```ts
addon.hello(): string
addon.getCapabilities(): Capabilities
addon.getPermissions(): Record<PermissionKind, PermissionState>
addon.requestPermissions(kinds: PermissionKind[])
  : Promise<Record<PermissionKind, PermissionState>>
```

### Sources & devices

```ts
addon.listShareableContent(): Promise<ShareableContent>   // SCShareableContent
addon.listCameras():   CameraDevice[]
addon.listMicrophones(): AudioDevice[]
```

### Recording

```ts
addon.startRecording(options: StartRecordingOptions): Promise<RecordingSession>
addon.stopRecording(sessionId: string): Promise<RecordingResult>
addon.cancelRecording(sessionId: string): Promise<void>
addon.onRecordingEvent(cb: (event: RecordingEvent) => void): Unsubscribe
```

`StartRecordingOptions`:

```ts
{
  outputDir:           string                                     // required
  basename?:           string                                     // optional filename prefix
  target:              { type: 'display'; displayId?: number }
                       | { type: 'window'; windowId: number }
                       | { type: 'application'; bundleId: string; displayId?: number }
  fps?:                30 | 60     // default 30 (the addon clamps to one of these)
  width?:              number      // 0/omitted = use native backing pixels
  height?:             number
  includeCursor?:      boolean     // default true
  recordSystemAudio?:  boolean     // default true
  recordMicrophone?:   boolean     // default false
  microphoneDeviceId?: string      // uniqueID from listMicrophones()
  recordCamera?:       boolean     // default false
  cameraDeviceId?:     string
  excludeOwnApp?:      boolean     // default true
}
```

### Camera preview (not tied to recording)

```ts
addon.startCameraPreview(
  { deviceId?: string },
  cb: (frame: CameraPreviewFrame) => void,
): Promise<void>

addon.stopCameraPreview(): Promise<void>
```

A preview can run alongside a recording — both will hold an `AVCaptureSession` on the same camera. macOS permits this but it is two opens of the device.

---

## Recording pipeline

```
┌─────────────────┐
│  startRecording │
└────────┬────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│ RecorderSession.startSync                                        │
│                                                                  │
│  1. prepareOutputFiles  → screen URL, camera URL, manifest URL   │
│  2. getShareableContent (SCShareableContent)                     │
│  3. contentFilterFromContent (SCContentFilter)                   │
│  4. streamConfigurationForContent (SCStreamConfiguration ─────┐  │
│       resolves backing-pixel dims, picks codec, sets pixel    │  │
│       format / color space / queueDepth / fps / cursor / SDR) │  │
│  5. SystemAudio.configureSCStreamConfig (capturesAudio etc.)  │  │
│  6. Microphone.configureSCStreamConfig (captureMicrophone)    │  │
│  7. ScreenTrack.prepareWriter                                 │  │
│       → AVAssetWriter(.mov) + video input (HEVC Main10 +      │  │
│         AVVideoColorPropertiesKey: P3-D65 / Rec.709 / Rec.709)│  │
│  8. ScreenTrack.addSystemAudioInput (AAC 48k stereo)          │  │
│  9. ScreenTrack.addMicrophoneInput (AAC 48k stereo)           │  │
│ 10. Camera.setupAVCaptureSession (separate file)              │  │
│ 11. SCStream init w/ filter + config                          │  │
│ 12. addStreamOutput screen / sysaudio / microphone            │  │
│ 13. Camera.startCapture                                       │  │
│ 14. SCStream.startCapture (blocks via semaphore)              │  │
└──────────────────────────────────────────────────────────────────┘
                       │
                       ▼
   ┌─────────────────────────────────────────────────────────┐
   │ While capturing                                         │
   │                                                         │
   │   Screen frames  ─► ScreenTrack (SCStreamOutput)        │
   │       └ first frame: startWriting + startSessionAtPTS   │
   │       └ append to video input                           │
   │                                                         │
   │   Audio frames   ─► SystemAudioTrack                    │
   │       └ forward to ScreenTrack.appendSystemAudioSample  │
   │       └ drop if session not yet started                 │
   │                                                         │
   │   Mic frames     ─► MicrophoneTrack (same shape)        │
   │                                                         │
   │   Camera frames  ─► CameraTrack (own writer, own file)  │
   └─────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│ stopSync                                                         │
│   1. markStopping on all tracks                                  │
│   2. SCStream.stopCapture (waits for completion)                 │
│   3. Camera.stopCapture                                          │
│   4. ScreenTrack.finishWriterSync — markAsFinished on all 3      │
│      inputs, await finishWritingWithCompletionHandler            │
│   5. Camera.finishWriterSync                                     │
│   6. writeManifest (recording.json)                              │
│   7. emit "stopped"                                              │
└──────────────────────────────────────────────────────────────────┘
```

All sources share `CMClockGetHostTimeClock()` as their reference clock — `_hostStartTime` is captured at start and used in the manifest for cross-source alignment.

---

## Quality settings

This is the section worth coming back to. Every value here has been tuned, broken, or reverted at least once.

### Resolution

| Knob | Setting | Why |
|---|---|---|
| Width / height source | `CGDisplayCopyDisplayMode(displayID)` then `CGDisplayModeGetPixelWidth/Height(mode)` | Returns the **rendered pixel count** of the active mode (e.g. 3024×1964 on a 14" M-Pro at Default scaling). On Retina this is what SCKit captures at; configuring the stream with anything smaller means SCKit downsamples → blurry output. |
| Fallback chain | `CGDisplayMode` → `NSScreen.frame × backingScaleFactor` → `SCDisplay.width/height` | The last hop (`SCDisplay`) returns points on Retina in practice despite Apple's docs saying "pixels", so we treat it as last resort. |
| Even-dimension rounding | `if (w % 2 != 0) w -= 1;` for both axes | HW HEVC + H.264 encoders silently rescale odd dimensions. One pixel lost; sharpness preserved. |
| `scalesToFit` | **`NO`** | Apple's default is `YES` on macOS 14+. With `YES` and any drift between source surface and configured width/height, SCKit silently resamples → soft output. `NO` makes mismatches surface as letterboxing rather than blur. |
| `sourceRect` | unset (zero rect → full capture) | We want the whole display. |

The configured values are surfaced under `outputs[source=screen]` in the manifest as `width`, `height`, `scaleFactor`, `pixelSizeSource`.

### Color

The single biggest quality lever. We mirror what OBS does in [mac-sck-video-capture.m](https://github.com/obsproject/obs-studio/blob/master/plugins/mac-capture/mac-sck-video-capture.m).

| Knob | Setting | Why |
|---|---|---|
| `SCStreamConfiguration.pixelFormat` | **`kCVPixelFormatType_ARGB2101010LEPacked`** (FourCC `l10r`) | 10 bits per RGB channel, 2 bits alpha, full-range, packed in 32 bits. **No chroma subsampling.** 4× the color information per pixel vs the 8-bit YUV 4:2:0 default. Same format OBS uses. |
| `SCStreamConfiguration.colorSpaceName` | **Dynamic** — `kCGColorSpaceDisplayP3` on a P3-capable display (`[NSScreen canRepresentDisplayGamut:NSDisplayGamutP3]`), otherwise `kCGColorSpaceSRGB`. | Match SCKit's capture space to what the target display actually is. P3 panels (every Apple Silicon laptop, modern external Apple displays) get full wide-gamut capture; sRGB-only externals get sRGB to avoid mis-tagged saturation. |
| `AVVideoColorPropertiesKey.AVVideoColorPrimariesKey` | **Dynamic — paired with the capture space.** `AVVideoColorPrimaries_P3_D65` on P3 displays, `AVVideoColorPrimaries_ITU_R_709_2` on sRGB displays. | The file's primaries tag must match the gamut SCKit captured into; otherwise players misinterpret the YCbCr values. ffprobe surfaces P3-D65 as `smpte432`. |
| `AVVideoColorPropertiesKey.AVVideoTransferFunctionKey` | `AVVideoTransferFunction_ITU_R_709_2` | sRGB-curve transfer (TransferCharacteristics = 1). Same for both gamuts in SDR. |
| `AVVideoColorPropertiesKey.AVVideoYCbCrMatrixKey` | `AVVideoYCbCrMatrix_ITU_R_709_2` | Rec.709 matrix for the RGB→YCbCr conversion AVFoundation does internally. Same for both gamuts in SDR. |
| `SCStreamConfiguration.captureDynamicRange` | `SCCaptureDynamicRangeSDR` | Explicit SDR — without it, on a system with an HDR-capable display in the chain SCKit may pick HDR pixel formats that conflict with our sRGB-transfer tagging. |
| `SCStreamConfiguration.backgroundColor` | `kCGColorBlack` | Cosmetic. Black on letterbox is safer than the default. |

**Why these specific tags?** Display-P3 video files on macOS are conventionally tagged `primaries=smpte432 / transfer=bt709 / matrix=bt709`. QuickTime, Safari, Chrome, and Quick Look all honor this exact triplet and render the wide gamut correctly. Asymmetric tagging (e.g. primaries=P3 but transfer=P3 too) breaks at least one major player.

### Codec

| Knob | Setting | Why |
|---|---|---|
| `AVVideoCodecKey` (Apple Silicon) | `AVVideoCodecTypeHEVC` | HW-accelerated on M-series. Same codec the native macOS recorder uses. |
| `AVVideoCodecKey` (Intel) | `AVVideoCodecTypeH264` | HW HEVC encoder availability is patchy on older Intel Macs. |
| `AVVideoProfileLevelKey` (HEVC) | `kVTProfileLevel_HEVC_Main10_AutoLevel` (from `<VideoToolbox/VTCompressionProperties.h>`) | **Main10 = 10-bit encode**. Required to actually carry the 10-bit precision we capture in. Without this, the encoder downconverts to 8-bit and the wide-gamut capture is wasted. |
| `AVVideoProfileLevelKey` (H.264) | `AVVideoProfileLevelH264HighAutoLevel` | Standard high-quality H.264 profile. |
| `AVVideoAverageBitRateKey` | `width × height × fps × 0.1` bits/s, floor 8 Mbps | VideoToolbox's adaptive default targets general video (~5–10 Mbps even at 4K) and looks soft on screen content. The native macOS recorder runs higher. Our formula gives ~36 Mbps for 3024×1964 @ 60fps, ~12 Mbps for 1080p @ 60fps — in line with QuickTime's native screen captures. |
| `AVVideoMaxKeyFrameIntervalKey` | `fps` (1 keyframe / second) | Screen content tends to be static for long stretches. Refreshing the I-frame every second keeps fine detail from drifting across long P-frame chains. |
| `AVVideoAllowFrameReorderingKey` | `NO` | Disables B-frames. They reference both past and future frames; on text/UI content the bidirectional averaging produces a faint perceptible smudging. P-only streams are slightly larger but visibly sharper. |
| `AVVideoExpectedSourceFrameRateKey` | `_options.fps` (30 or 60) | Hint only; helps the encoder pre-allocate rate-control budget. |
| Architecture detection | `sysctlbyname("hw.optional.arm64", …)` at runtime | One binary covers both arches. |

### Frame rate, queue depth, dynamic range

| Knob | Setting | Why |
|---|---|---|
| `minimumFrameInterval` | `CMTimeMake(1, fps)` where `fps ∈ {30, 60}` | UI defaults to 60. |
| `queueDepth` | **8** (max allowed by SCKit) | Recording prefers no dropped frames over low latency; live streaming would want 3. |
| `showsCursor` | option flag, default true | |
| Pixel-format / color-space / dynamic-range / dimensions | as above | |

### Audio

The screen `.mov` file is **muxed** — up to three streams in one container:

| Input | Codec | Sample rate | Channels | Bitrate | Source |
|---|---|---|---|---|---|
| Video | HEVC Main10 / H.264 High | – | – | adaptive (VTB) | SCKit (`l10r` RGB) |
| System audio | AAC LC | 48 000 Hz | 2 (stereo, explicit `AVChannelLayoutKey`) | 192 kbps | SCKit `SCStreamOutputTypeAudio` |
| Microphone | AAC LC | 48 000 Hz | 2 | 192 kbps | SCKit `SCStreamOutputTypeMicrophone` (macOS 15+) |

System audio config (`SystemAudioTrack.configureSCStreamConfig:`):
- `capturesAudio = YES` when enabled
- `sampleRate = 48000`
- `channelCount = 2`
- `excludesCurrentProcessAudio = YES`  *(don't capture our own beeps)*

Microphone config (`MicrophoneTrack.configureSCStreamConfig:`):
- `captureMicrophone = YES` when enabled
- `microphoneCaptureDeviceID = <uniqueID>` (omit for system default)

**Session start.** AVAssetWriter requires `startSessionAtSourceTime:` to be called once with the PTS of the first sample. We anchor it to the first **video** frame so the file starts with a displayable frame. Audio samples that arrive earlier are dropped; the count is surfaced as `droppedSystemAudioBeforeStart` / `droppedMicrophoneBeforeStart` in the manifest.

---

## Camera

`CameraTrack` runs an independent `AVCaptureSession` with `AVCaptureSessionPresetHigh` and writes to its own `camera.mov` via `AVAssetWriter`. Camera is not an SCKit source, so it doesn't mux into the screen file.

While *recording with camera*, the camera hardware has two `AVCaptureSession` instances open (record + preview if the preview is also active). macOS permits this but it is two opens of the same device.

---

## Camera preview

`CameraPreview` is independent of the recording session. It runs its own `AVCaptureSession` at preset `640×480`, throttled to 30 fps, BGRA→RGBA swizzled and row-packed in C++. Frames are pushed to JS via `Napi::ThreadSafeFunction::NonBlockingCall` (queue size 4 — frames are dropped when JS lags).

The renderer process draws frames into a `<canvas>` via `putImageData(new ImageData(Uint8ClampedArray, w, h))`.

The Electron main process relays frames to the camera window over the `cameraPreview:frame` channel.

---

## Permissions

| Permission | API | Required for |
|---|---|---|
| Screen Recording | `CGPreflightScreenCaptureAccess`, `CGRequestScreenCaptureAccess` | Screen capture, system audio, app/window listing |
| Camera | `[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]` | Camera recording, camera preview |
| Microphone | `[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]` | Microphone recording |
| Accessibility | `AXIsProcessTrusted` | Optional — required only for global shortcuts / window manipulation |

`startRecording` rejects synchronously (before queueing the worker) if a required permission is missing.

---

## Capabilities

`addon.getCapabilities()` returns:

```ts
{
  platform: 'darwin',
  macosVersion: string,         // e.g. "15.4.0"
  screenCaptureKit: true,       // always — we require macOS 15+
  systemAudio: true,
  screenCaptureKitMicrophone: true,
  microphoneFallback: false,    // AVCaptureSession mic path removed
  camera: true,
  separateFiles: false,         // audio is muxed into screen.mov
  scRecordingOutput: true,      // SCRecordingOutput is available, though we use AVAssetWriter instead
}
```

---

## Output

A single recording produces, under `outputDir/`:

```
screen.mov         HEVC Main10 + AAC (sysaudio) + AAC (mic) muxed
camera.mov         only when recordCamera = true; H.264 / 1080p AVCaptureSession output
recording.json     manifest (below)
```

`basename` option prefixes each file (`<basename>-screen.mov`, etc.).

### Manifest (`recording.json`)

```json
{
  "sessionId": "…",
  "startedAtUnixMs": 1739385600123.456,
  "hostStartMs": 87234567.890,
  "target":         { "type": "display", "displayId": 1 },
  "fps":            60,
  "includeCursor":  true,
  "excludeOwnApp":  true,
  "files": {
    "screen":   "/path/screen.mov",
    "camera":   "/path/camera.mov",
    "manifest": "/path/recording.json"
  },
  "outputs": [
    {
      "source": "screen",
      "path":   "/path/screen.mov",
      "started":  true,
      "finished": true,
      "codec":          "hevc-main10",
      "pixelFormat":    "ARGB2101010LEPacked",
      "colorPrimaries": "P3_D65",
      "colorTransfer":  "ITU_R_709_2",
      "colorMatrix":    "ITU_R_709_2",
      "colorSpace":     "DisplayP3",
      "gamut":          "P3",
      "width":  3024,
      "height": 1964,
      "scaleFactor": 2.0,
      "pixelSizeSource": "CGDisplayModeGetPixelWidth",
      "averageBitRate": 35640960,
      "maxKeyFrameInterval": 60,
      "allowFrameReordering": false,
      "videoSamples": 1804
    },
    { "source": "camera", "path": "…", "started": true, "finished": true, … },
    {
      "source": "systemAudio",
      "muxedInto": "screen",
      "sampleRate": 48000,
      "channelCount": 2,
      "samplesForwarded": 2823
    },
    { "source": "microphone", "muxedInto": "screen", … }
  ],
  "microphoneSource": "screenCaptureKit"
}
```

---

## Diagnostics

Every `streamConfigurationForContent:` call logs one summary line to the console (visible when Electron runs from a terminal, or via Console.app filtered to `openscreen.recorder`):

```
[openscreen.recorder] screen config: 3024x1964 @ 60fps  codec=hevc-main10  \
  pixelFormat=ARGB2101010LEPacked(l10r)  colorSpace=DisplayP3  \
  primaries=AVVideoColorPrimaries_P3_D65 (gamut=P3)  \
  bitrate=35.6 Mbps  keyframeInterval=60f  \
  scale=2.00x  pixelSizeSource=CGDisplayModeGetPixelWidth  scalesToFit=NO  queueDepth=8  \
  allowFrameReordering=NO
```

On an sRGB-only display the line would instead read `colorSpace=sRGB  primaries=AVVideoColorPrimaries_ITU_R_709_2 (gamut=Rec.709)`.

The same numbers are in the manifest under `outputs[source=screen]`.

Recording events (subscribe with `addon.onRecordingEvent`):

| `type` | Meaning |
|---|---|
| `started` | All inputs added; SCStream.startCapture completed. |
| `fileStarted` | First sample appended; `AVAssetWriter.startSession` called. |
| `stopped` | All writers finalized. |
| `cancelled` | `cancelRecording` invoked — files removed. |
| `error` | Stream or writer reported a non-recoverable error. |
| `backpressure` | (Reserved — not currently emitted for the screen path; was used by the old `MediaFileWriter` bounded-inflight design.) |

---

## Verification

### Resolution + codec + color tagging

```bash
ffprobe -hide_banner -show_streams ~/Documents/openscreen/<latest>/screen.mov 2>&1 \
  | grep -E '^(codec_name|profile|width|height|pix_fmt|color_)'
```

Expected on Apple Silicon:

```
codec_name=hevc
profile=Main 10
width=3024            # = your display's CGDisplayModeGetPixelWidth
height=1964
pix_fmt=yuv420p10le   # 10-bit — proves Main10 actually engaged
color_range=tv
color_space=bt709     # YCbCr matrix
color_transfer=bt709
color_primaries=smpte432   # P3-D65 primaries
```

`smpte432` is the ITU code for "Display P3 D65 primaries" (ISO/IEC 23001-8 ColourPrimaries value 12). Some ffprobe builds surface it as `display-p3` or `bt2020-12`.

### Display info (so you know what to compare against)

```bash
system_profiler SPDisplaysDataType | grep -A2 Resolution
```

The recording's `width × height` should match the display's "Resolution" line.

### Audio streams

```bash
ffprobe -hide_banner -show_streams ~/Documents/openscreen/<latest>/screen.mov \
  2>&1 | grep -E '^(codec_type|codec_name|sample_rate|channels)='
```

You should see one video stream plus 0–2 audio streams (sysaudio + mic, depending on options). All audio streams: `codec_name=aac`, `sample_rate=48000`, `channels=2`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Recording resolution is half of the display's pixel count | Stale build, or running on macOS < 15 (extremely unlikely now) | `npx node-gyp rebuild`, restart Electron (native modules load once at process start). |
| Recording looks blurry but resolution is correct | Player is downscaling (e.g. QuickTime in a small window with "Fit Width") | Verify with `ffprobe`. If the file is at the right dimensions, it's a player issue. |
| Colors look desaturated in VLC / `ffplay` | Those players are not color-managed and ignore P3 primaries tags. | Verify in QuickTime or Safari — both honor the P3 tags. |
| Colors look desaturated in **QuickTime** | Pipeline isn't producing 10-bit output. | Check `ffprobe` — `pix_fmt` should be `yuv420p10le` and `profile=Main 10`. If you see `yuv420p` / `Main`, VideoToolbox silently fell back to 8-bit. |
| `ffprobe` reports `profile=Main` (8-bit) instead of `Main 10` | Older M1 chips, certain virtualised macOS environments, or an SDK quirk. | The fallback is acceptable but loses precision. File an issue with the chip model and macOS version. |
| `permissions: screen=denied` after granting | The Electron binary path changed (development rebuild can do this). | Re-grant in System Settings → Privacy & Security → Screen Recording. |
| Camera preview lags | JS callback is slow; `Napi::ThreadSafeFunction` queue (size 4) drops new frames. | Use `requestAnimationFrame` in the renderer; keep the `putImageData` work on the main thread minimal. |
| Recording silently produces zero-byte file | `startWriting` failed before first sample. Check the `error` recorder event and the `error` field on `outputs[source=screen]`. | |

---

## Design decisions

A short log of why the pipeline looks the way it does, so future-you doesn't re-litigate it:

1. **We use `AVAssetWriter`, not `SCRecordingOutput`.** `SCRecordingOutput` is a convenience wrapper that doesn't expose `AVVideoColorPropertiesKey`. With Display P3 capture it writes inconsistent color tags (P3 primaries but Rec.709 matrix with no proper transfer), which causes opposite-direction shifts in P3-aware vs sRGB-only players. `AVAssetWriter` lets us write the canonical Display-P3 triplet explicitly — and lets us *match* the file's primaries tag to the gamut we asked SCKit to capture into (see #9).
2. **We use 10-bit packed RGB (`l10r`) for the SCKit pixel format, not 10-bit YCbCr.** That's what OBS uses ([mac-sck-video-capture.m:213](https://github.com/obsproject/obs-studio/blob/master/plugins/mac-capture/mac-sck-video-capture.m#L213)). The RGB→YCbCr conversion happens inside AVFoundation's HEVC Main10 encoder; precision is preserved end-to-end.
3. **Audio is muxed into the screen file.** A single `screen.mov` with video + sysaudio + mic is what downstream consumers want. Camera stays separate because it's not an SCKit source.
4. **Bitrate is set explicitly, tuned for screen content.** We initially left `AVVideoAverageBitRateKey` unset on the theory that VideoToolbox's adaptive default would Just Work — and for general video it does. For *screen* content (text, fine UI edges) the default targets too low a bitrate and the output looks visibly soft even at native resolution + 10-bit + P3. We now set `bitrate = width × height × fps × 0.1` bits/s (floor 8 Mbps), which lines up with what QuickTime's native screen recorder writes. Paired with `AVVideoMaxKeyFrameIntervalKey = fps` (1-second keyframes) and `AVVideoAllowFrameReorderingKey = NO` (no B-frames, no inter-frame averaging blur).
5. **Audio session start is anchored to the first video frame.** AVAssetWriter requires a single `startSessionAtSourceTime:` and we need the file to begin with a displayable frame. The handful of audio samples that arrive earlier are dropped (counted in the manifest).
6. **`scalesToFit = NO`.** With macOS 14+'s default of `YES`, any rounding error between SCKit's source surface and our configured `width × height` causes silent resampling. `NO` makes those mismatches surface as letterboxing instead of blur, which is a louder failure mode.
7. **Even-dimension rounding.** HW HEVC encoders silently rescale odd dimensions; we lose at most one row/column of pixels and avoid that rescaling.
8. **macOS 15 is the floor.** That gives us SCStream microphone capture, eliminates the pre-15 `AVCaptureSession` mic fallback, and lets us assume HEVC Main10 hardware encoding everywhere we'd ship.
9. **Gamut detection is dynamic, but matched at both ends.** We branch *both* `SCStreamConfiguration.colorSpaceName` and the file's `AVVideoColorPrimariesKey` on `[NSScreen canRepresentDisplayGamut:NSDisplayGamutP3]`. Earlier attempts only switched the SCKit side — that produced files where SCKit captured P3 but the tags claimed Rec.709 (or vice versa), and players disagreed on how to render them. Keeping the capture space and the file's primaries tag in lock-step is what makes the output render consistently across QuickTime, Safari, Chrome, ffplay, and VLC.

---

## Reference

- WWDC 2022 — [Meet ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2022/10156/)
- WWDC 2022 — [Take ScreenCaptureKit to the next level](https://developer.apple.com/videos/play/wwdc2022/10155/)
- WWDC 2023 — [What's new in ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2023/10136/)
- WWDC 2024 — [Capture HDR content with ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2024/10088/)
- OBS Studio SCKit plugin — [`mac-sck-video-capture.m`](https://github.com/obsproject/obs-studio/blob/master/plugins/mac-capture/mac-sck-video-capture.m) (reference for the `l10r` + Display P3 + queueDepth 8 recipe)
- [Nonstrict — Recording to disk with ScreenCaptureKit](https://nonstrict.eu/blog/2023/recording-to-disk-with-screencapturekit/) (Retina-scaling gotcha, AVOutputSettingsAssistant pattern)
- `<VideoToolbox/VTCompressionProperties.h>` — the canonical list of HEVC profile/level constants usable as `AVVideoProfileLevelKey`.
