# Recorder Feature Map

Last reviewed: 2026-06-04.

This document maps what the recorder can do today, where each feature is implemented, what files it writes, how state survives refresh / restart, and what the macOS 13 support story is. It covers the native addon, Electron IPC/preload, and recorder renderer windows.

## Executive Status

- Minimum deployment target is **macOS 13.0** in `packages/mac-addon/binding.gyp`.
- Screen video + system audio + built-in/default camera capture are intended to work on macOS 13.
- Microphone recording through ScreenCaptureKit is **macOS 15+ only**. There is currently no AVFoundation microphone fallback for macOS 13/14.
- Per-app system-audio scoping for display/region captures is **macOS 15+ only**. Window capture on macOS 13/14 gets practical app scoping from the window `SCContentFilter`; display/region does not.
- External / Continuity camera discovery is incomplete on macOS 13 because `Devices.mm` does not include the deprecated `AVCaptureDeviceTypeExternalUnknown` fallback.
- Long recordings avoid per-frame renderer IPC for the actual recorded media, but mid-recording native errors/backpressure are not promoted into `RecorderState`, and screen/camera writer finalization waits are unbounded.

## Source Map

| Area | Main files |
| --- | --- |
| Native JS API | `packages/mac-addon/index.js`, `packages/mac-addon/index.d.ts`, `packages/mac-addon/src/Bindings.mm` |
| Session coordinator | `packages/mac-addon/src/RecorderSession.mm`, `RecordingWorkers.mm` |
| Screen video writer | `packages/mac-addon/src/ScreenTrack.mm` |
| System audio | `packages/mac-addon/src/SystemAudioTrack.mm` |
| Microphone audio | `packages/mac-addon/src/MicrophoneTrack.mm` |
| Camera recording | `packages/mac-addon/src/CameraTrack.mm`, `MediaFileWriter.mm` |
| Camera preview | `packages/mac-addon/src/CameraPreview.mm`, `electron/ipc/camera-preview.ts`, `app/camera/page.tsx` |
| Input/cursor sidecars | `packages/mac-addon/src/InputTrack.mm`, `CursorTrack.mm` |
| Recorder state + menus | `electron/ipc/recorder.ts`, `app/recorder/page.tsx`, `app/recording-controls/page.tsx` |
| Native event bridge | `electron/ipc/mac-addon.ts`, `electron/preload.ts` |
| Project load/save | `electron/ipc/projects.ts`, `electron/ipc/project-schema.ts`, `components/editor/canvas/provider.tsx` |
| Permission gate | `electron/ipc/permissions.ts`, `app/permissions/page.tsx`, `packages/mac-addon/src/Permissions.mm` |
| Packaging | `electron-builder.yml`, `packages/mac-addon/binding.gyp` |

## Feature Matrix

| Feature | User surface | Native/Electron implementation | Output | macOS support | Current state |
| --- | --- | --- | --- | --- | --- |
| Display recording | Recorder display button / default Start | `display-target.ts`, `window-picker.ts`, `ScreenTrack.mm` | `screen.mov` or `screen.mp4` | 13+ | Supported |
| Window recording | Recorder window button | `window-picker.ts`, `SCContentFilter` window target | `screen.mov` or `screen.mp4` | 13+ | Supported |
| Region recording | Recorder region button | Region picker + display target metadata | `screen.mov` or `screen.mp4` | 13+ | Supported |
| Application target | Native type exists | `CaptureTarget` supports `application` | Screen writer | 13+ API shape, not primary UI | Native/API support is partial |
| Screen cursor baked into video | Settings menu "Don't record cursor" | `SCStreamConfiguration.showsCursor` | Screen pixels | 13+ | Supported |
| Cursor/input metadata | Always on for mouse/cursor; keystrokes opt-in | `InputTrack`, `CursorTrack` | `mousemoves-0.json`, `mouseclicks-0.json`, `cursors.json`, `cursors/*.png`, optional `keystrokes-0.json` | 13+ | Supported, sidecar-only |
| System audio all apps | System audio menu | `SystemAudioTrack`, SCK audio output | AAC track muxed into screen file | 13+ | Supported |
| System audio selected apps | System audio selected-app menu | `audioApplications`, `applicationsToInclude` | AAC track muxed into screen file | 15+ for display/region; window filter helps on 13/14 | Partially supported |
| Microphone | Microphone menu | `MicrophoneTrack`, SCK microphone output | AAC track muxed into screen file | 15+ only | UI allows it on 13/14 but no audio is recorded |
| Camera recording | Camera menu | `CameraTrack`, `MediaFileWriter` | `camera.mov` | 13+ for built-in/default; external discovery gap on 13 | Mostly supported |
| Camera preview | Floating camera window | `CameraPreview.mm`, `camera-preview.ts` | Renderer-only preview; not a separate file | 13+ for camera source | Supported with bounded IPC drops |
| Pause/resume | Recording controls | Native pause gates/PTS shift | Single continuous files, no pause segments | 13+ | Supported |
| Stop/save | Recording controls | `addon.stopRecording`, manifest write, project open | Media files + `recording.json` | 13+ | Supported, but finalize can hang |
| Restart/delete | Recording controls | `cancelRecording`, folder removal | Output folder removed by Electron | 13+ | Supported when cancel returns |
| Recording settings | Recording Quality window | `recording-quality.json`, coerced before start | Manifest resolved settings | 13+ | Supported |
| Open project | Recorder settings menu | `projects:pickAndOpen`, `setActiveProjectFromFolder` | Reads existing project/manifest | All app platforms, recorder macOS-only | Supported |

## Capture And Encoding

The screen path is one ScreenCaptureKit stream and one AVAssetWriter:

- `SCStream` delivers screen frames, system audio samples, and macOS 15+ microphone samples.
- `ScreenTrack` owns the screen AVAssetWriter and adds video/system-audio/microphone inputs as needed.
- `SystemAudioTrack` and `MicrophoneTrack` are SCK output delegates that forward audio sample buffers into the screen writer.
- The output is SDR-only: BGRA 8-bit capture buffers, sRGB capture conversion, BT.709 writer tags, HEVC or H.264.
- Quality is controlled by `videoCodec`, `videoQuality`, `container`, `resolutionMode`, and `frameRate`.
- B-frames are left enabled by VideoToolbox defaults, and the stream queue depth is set to 8.

The camera path is separate:

- `CameraTrack` creates an AVCaptureSession and writes camera frames to `camera.mov`.
- Camera output uses `OSMediaFileWriter`, a bounded inflight queue, and drops frames when the writer queue is saturated.
- Camera is not muxed into `screen.mov`; the editor treats it as a second recording asset.

## Generated Files

Initial recorder output is written under `~/Documents/openscreen/<timestamp>/`.

| File or folder | Produced when | Owner | Notes |
| --- | --- | --- | --- |
| `screen.mov` / `screen.mp4` | Every successful recording with at least a screen writer | `ScreenTrack` | Contains screen video plus system audio and macOS 15+ mic audio when enabled. |
| `camera.mov` | Camera enabled | `CameraTrack` / `MediaFileWriter` | Separate H.264 video file. |
| `recording.json` | Stop/save succeeds far enough to write manifest | `RecorderSession.writeManifest` | Main manifest with `files`, `outputs`, target, settings, counters, and errors captured at finish. |
| `mousemoves-0.json` | Input capture enabled, which Electron always does | `InputTrack` | Streaming JSON array of move/drag events. |
| `mouseclicks-0.json` | Input capture enabled | `InputTrack` | Streaming JSON array of down/up events. |
| `keystrokes-0.json` | Keystrokes enabled and Input Monitoring granted | `InputTrack` | Plaintext keystrokes. Off by default. |
| `cursors.json` | Cursor-shape capture enabled, which Electron always does | `CursorTrack` | Cursor catalog metadata. |
| `cursors/*.png` | Cursor-shape capture enabled | `CursorTrack` | System/custom cursor bitmaps. |
| `project.json` | After the editor opens and autosaves the recording project | `projects:saveState` / editor provider | Atomic save, not produced by native stop itself. |
| `assets/videos/<id>/<filename>` | LEGACY — the import pipeline was removed (recordings are the only video source) | ~~`projects:importAsset`~~ (removed) | Existing files keep loading via their persisted `relativePath`; nothing writes here anymore. |
| `exports/*` | User exports from editor | Export pipeline | Not part of raw recorder output. |

Per-user app data:

- `<userData>/recording-quality.json` stores recording quality settings (invalid persisted values are coerced to defaults with a `console.warn` listing what changed).
- `<userData>/active-project.json` stores the sticky project record (`{ path, sessionId }`, written atomically) that refresh/app restart reopens; the sessionId lets a moved/renamed project folder be re-found by identity.
- `<userData>/window-bounds.json` stores user-positioned window bounds (editor, camera preview, recorder bar, export window), validated against connected displays on restore.

## Storage Handling

Raw recorder folders:

- `electron/ipc/recorder.ts` creates `~/Documents/openscreen` and a timestamp folder before native start.
- `removeRecordingDirectory` only deletes paths inside that root, guarding accidental removal outside the recorder tree.
- `restart` and `delete` call native cancel and then remove the entire active output folder.
- On start failure, JS clears the state, but the timestamp folder can remain empty or partially populated.
- On crash/power loss before stop, media may be missing final container metadata and input sidecars may be unterminated JSON arrays.

Project persistence:

- `project.json` is the source of truth after a recording is opened in the editor.
- `projects:saveState` validates the project state and writes atomically via temp file + rename.
- Imported assets are copied under the project folder; the app does not rely on blob URLs for persisted assets.
- `setActiveProjectFromFolder` is the promotion path that stores `active-project.json`; `projects:getLatest` is read-only.

## Long Recording Profile

Good properties for hour-long screen + camera recordings:

- Recorded media does not travel through renderer IPC frame-by-frame.
- Screen callbacks append on native dispatch queues.
- Camera writer has a bounded inflight queue and drops samples instead of growing memory without bound.
- Camera preview drops frames if its renderer window is hidden or minimized.
- Input sidecars stream to disk rather than accumulating all mouse events in memory.
- The controls timer ticks only four times per second.

Remaining reliability risks:

- `ScreenTrack.finishWriterSync` and `MediaFileWriter.finishSync` wait forever for AVAssetWriter finish callbacks.
- `SCStreamDelegate didStopWithError` emits a native event but does not stop/finalize the JS state machine.
- Native `error` and `backpressure` events are forwarded only as raw `recorder:event`; preload does not expose them, and the active controls window subscribes only to `recorder:changed`.
- Persistent screen append failure can increment dropped samples without a visible in-session error.
- No preflight free-space check or projected storage warning exists.
- Camera recording lacks AVCaptureSession runtime/interruption observers, unlike camera preview.

## macOS Compatibility

Verified with:

- Official Apple docs: [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit), [SCStreamConfiguration](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration), [SCStreamOutputType](https://developer.apple.com/documentation/screencapturekit/scstreamoutputtype), [ScreenCaptureKit sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos), [AVCaptureDevice](https://developer.apple.com/documentation/avfoundation/avcapturedevice).
- Local SDK headers from Xcode SDK `MacOSX26.2.sdk`, especially `ScreenCaptureKit.framework/Headers/SCStream.h`, `SCError.h`, and `AVFoundation.framework/Headers/AVCaptureDevice.h`.

| Capability / symbol | Apple availability | Code behavior | macOS 13 fallback |
| --- | --- | --- | --- |
| `ScreenCaptureKit` screen/audio stream | ScreenCaptureKit framework used as app minimum | Built with deployment target 13.0 | Primary path |
| `SCStreamFrameInfoScreenRect` | macOS 13.1+ | Metadata only | Omit metadata on 13.0 |
| `SCStreamFrameInfoBoundingRect` | macOS 14.0+ | Metadata only | Omit metadata |
| `preservesAspectRatio`, `ignoreShadowsSingleWindow`, `ignoreGlobalClipSingleWindow` | macOS 14.0+ | `@available` gated | Use older defaults |
| `includeChildWindows` | macOS 14.2+ | `@available` gated | Older window behavior |
| `captureDynamicRange` | macOS 15.0+ | Explicit SDR only on 15+ | SCK implicit SDR |
| `applicationsToInclude` | macOS 15.0+ in SDK headers | Applied only on 15+ | No display/region selected-app fallback |
| `captureMicrophone`, `microphoneCaptureDeviceID`, `SCStreamOutputTypeMicrophone` | macOS 15.0+ | `MicrophoneTrack.isEnabled` returns false pre-15 | No mic recording |
| `SCStreamErrorFailedToStartMicrophoneCapture`, `SCStreamErrorSystemStoppedStream` | macOS 15.0+ | Not central to control state | Generic stream error event only |
| `SCStream.addRecordingOutput` / `SCRecordingOutput` | macOS 15.0+ | Capability reports true only on 15+; recorder uses AVAssetWriter instead | Not used by current recorder |
| `AVCaptureDeviceTypeExternal` | macOS 14.0+ | Listed only on 14+ | Missing `AVCaptureDeviceTypeExternalUnknown` fallback |
| `AVCaptureDeviceTypeExternalUnknown` | macOS 10.15-14.0 deprecated replacement | Not used | Needed for fuller USB camera listing on 13 |
| `AVCaptureDeviceTypeMicrophone` | macOS 14.0+ | Listed on 14+; default mic fallback on 13 | Device list only; recorder mic still unavailable before 15 |

## Export Relationship

Recorder output and editor/export output are separate:

- The recorder writes raw sources and sidecars.
- The editor hydrates those files into `project.json`.
- The export pipeline later renders a composed video from the project snapshot.
- Recorder features that are part of the final viewer-visible output, such as cursor overlay styling after import, must also be implemented in `components/editor/export/`.
- Recorder-only chrome such as controls, selection UI, picker overlays, and previews are not part of exported pixels.
