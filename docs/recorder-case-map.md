# Recorder Case Map

Last reviewed: 2026-06-04.

This document maps recorder behavior across success, failure, compatibility, and storage cases. It is intentionally blunt: "handled" means the current app has a clear code path and user-visible result; "partial" means the system avoids the worst crash/data-loss path but has UX or recovery gaps; "not handled" means the current behavior can be misleading, silent, or stuck.

## Severity Key

| Severity | Meaning |
| --- | --- |
| P0 | Can hang, lose a recording, or leave the user believing recording is safe when it is not. |
| P1 | Feature works only on some supported OS/device combinations or failure is not visible enough. |
| P2 | Cleanup, diagnostics, or edge-case UX issue. |

## Handled Cases

| Case | Behavior today | Evidence |
| --- | --- | --- |
| Non-macOS start | Start returns an error state; recorder is macOS-only in this build. | `electron/ipc/recorder.ts` |
| Missing output directory string | Native start rejects. | `RecorderSession.prepareOutputFiles` |
| Output path exists as a file | Native start rejects. | `RecorderSession.prepareOutputFiles` |
| Generic display start with no picker | Uses the display under the cursor instead of primary display. | `display-target.ts`, `recorder.ts` |
| Selected-app system audio with an empty list | Electron disables system audio instead of falling back to all apps. | `recorder.ts` |
| Device disconnected before start | Electron refreshes selected camera/mic lists and clears missing selections. | `refreshSelectedDevices` |
| SCK start failure | Native tears down partial screen/camera writers and JS returns to idle with `lastError`. | `RecorderSession.teardownPartialStart`, `recorder.ts` |
| User pauses | Native gates screen/camera/input samples and shifts later timestamps by accumulated pause time. | `ScreenTrack`, `MediaFileWriter`, `InputTrack` |
| User stops while paused | Electron resumes native state first, then stops. | `stopRecording` |
| SCK `stopCapture` completion hangs | Native stop/cancel waits 10 seconds, emits an error, and returns failure. | `RecorderSession.stopSync`, `cancelSync` |
| Delete/restart active recording | Native cancel runs and Electron removes the active output folder under `~/Documents/openscreen`. | `discardActiveRecording`, `removeRecordingDirectory` |
| App quit while recording | Main prevents immediate quit and calls `flushActiveRecording` before quitting again. | `main.ts`, `flushActiveRecording` |
| Camera preview renderer hidden/minimized | Main drops preview frames before IPC queue growth. | `camera-preview.ts` |
| Preview callback queue lags | Native preview TSFN uses non-blocking call and bounded reusable frame pool. | `CameraPreview.mm` |
| Mouse/cursor sidecar volume | Input events stream to disk on a serial queue instead of being buffered in JS memory. | `InputTrack.mm` |
| Project autosave write failure | `projects:saveState` returns `{ ok:false, reason }`; editor save-status state can surface it. | `projects.ts`, editor provider |
| Imported asset path traversal | Asset IDs and filenames are sanitized and writes outside the project folder are rejected. | `projects.ts` |

## Partially Handled Cases

| Severity | Case | What works | Gap |
| --- | --- | --- | --- |
| P0 | Native stream stops with `didStopWithError` mid-recording | Addon emits an `error` event. | Event is not promoted into `RecorderState`; active controls UI may keep showing "recording". |
| P0 | Writer finish fails on Stop | Native writes the manifest before returning failure; JS shows `lastError`. | JS restores previous recording/paused status and does not open the project, so a partial but useful recording can be stranded. |
| P0 | App quit while `stopRecording()` promise hangs | Quit flush exists. | `flushActiveRecording` awaits `stopRecording()` first, so it cannot reach its 12 second escalation if native finish never resolves. |
| P1 | Screen writer backpressure | Samples are dropped; a one-time native `backpressure` event and manifest counts exist. | Active UI does not subscribe to or expose that event. |
| P1 | Camera writer backpressure | Inflight queue is capped and drops samples. | Active UI does not expose the native event; user sees only final manifest counters. |
| P1 | Screen append failure when input is "ready" but append returns false | Dropped sample counter increments. | No in-session error event is emitted for that append failure path. |
| P1 | Keystroke capture without Input Monitoring | Native no-ops key capture and metadata records whether key capture was active. | UI can enable it without a persistent warning that no keys will be recorded until permission is granted. |
| P1 | Accessibility revoked during recording | Event tap fallback exists only if primary tap creation fails at start. | A tap disabled/revoked mid-session is not clearly surfaced to the active UI. |
| P1 | Camera preview runtime/interruption error | Native emits `cameraPreview` error event. | `mac-addon.ts` sends native events to recorder bar, not directly to the camera window; preview-specific errors can be lost. |
| P2 | Start fails after timestamp folder creation | JS clears state. | Empty/partial timestamp folders can remain under `~/Documents/openscreen`. |
| P2 | Crash/power loss during input sidecar write | Streaming design avoids memory growth. | JSON arrays may be left without a closing `]`. |
| P2 | Active project path persistence fails | It is best-effort and does not lose project data. | Refresh may fall back to latest-by-mtime instead of the intended project. |

## Not Handled / Misleading Cases

| Severity | Case | Current behavior | Recommended fix |
| --- | --- | --- | --- |
| P0 | Unbounded AVAssetWriter finalization | `finishWritingWithCompletionHandler` waits forever in screen and camera writer paths. | Add bounded waits around writer finish; after timeout, mark session failed, surface recoverable partial files, and avoid blocking quit forever. |
| P0 | Native recording events not part of recorder state | `error`/`backpressure` are sent as raw `recorder:event` to the recorder bar only; preload exposes only `recorder:changed`. | Add a main-process native-event handler that updates `RecorderState`, forwards to controls, and stops/fails the session when appropriate. |
| P1 | macOS 13/14 microphone selection | UI lists/selects microphones and passes `recordMicrophone:true`, but native disables mic before macOS 15. | Gate mic UI with `getCapabilities().screenCaptureKitMicrophone`, or implement an AVFoundation microphone fallback mux/sync path. |
| P1 | macOS 13/14 selected-app audio for display/region | UI allows selected-app scope; native can apply `applicationsToInclude` only on macOS 15+. | Disable selected-app scope for display/region before macOS 15, or explain fallback in UI. |
| P1 | macOS 13 external USB camera discovery | Device listing omits `AVCaptureDeviceTypeExternalUnknown`, the pre-14 external-camera type. | Add `AVCaptureDeviceTypeExternalUnknown` under `@available(macOS 14, *)` else branch, or use a broader discovery fallback. |
| P1 | Disk nearly full | No preflight free-space check or projected-size estimate. | Before start, estimate bitrate x duration presets, warn below threshold, and monitor write failures during recording. |
| P1 | Camera unplugged/interrupted during recording | Camera recording path lacks AVCaptureSession runtime/interruption observers. | Mirror preview observers in `CameraTrack`; emit recorder state errors and mark camera track failed/partial. |
| P1 | Packaging entitlements files missing from repo | `electron-builder.yml` references `build-resources/entitlements.mac.plist` and `.inherit.plist`, but no matching files are present. | Add entitlements files or update packaging config before distribution testing. |
| P2 | Manifest says `microphoneSource: "screenCaptureKit"` even pre-15 no mic track is actually enabled | Manifest can imply a mic source even when only `samplesForwarded: 0` exists for a requested mic. | Add explicit `unsupportedBeforeMacOS: 15` / `enabled:false` metadata, or omit mic output when disabled by OS. |

## Hours-Long Screen + Camera Recording

The recorder is designed well in a few important ways for hour-long screen + camera sessions:

- Recorded screen/camera frames stay native; they are not copied through renderer IPC.
- ScreenCaptureKit sample callbacks run on native queues.
- Camera recording drops frames under writer backpressure instead of growing memory without bound.
- Preview IPC is bounded/filtered so a hidden preview window does not accumulate 1 MB+ frame messages.
- Input sidecars stream to disk.

The risk is not steady-state memory growth as much as failure detection and finalization:

- If ScreenCaptureKit stops the stream mid-run, the app may not update visible recorder state.
- If AVAssetWriter finish never calls back, Stop can hang indefinitely.
- If disk fills or the writer fails late, the user may see the problem only on Stop, and a partial folder may not automatically open.
- If camera capture is interrupted, camera samples can stop without the same explicit recording-state path that screen start/stop uses.

For "will hours-long screen + camera fail in between?", the best answer is:

- It should not fail simply because frames are routed through JS; that part is avoided.
- It can fail or hang if macOS capture/encoder/storage components fail, and several of those failures are currently not surfaced promptly.
- The highest-priority hardening work is bounded writer finalization, native event -> state integration, free-space monitoring, and camera recording runtime observers.

## Storage Cases

| Case | Current behavior | Risk |
| --- | --- | --- |
| Successful stop | Raw files and `recording.json` remain in timestamp folder; editor opens and later writes `project.json`. | Good. |
| User deletes/restarts | Native cancel + Electron folder deletion. | Good if cancel returns. |
| Start fails before native files | Empty timestamp folder may remain. | Cleanup gap. |
| Start fails after some native setup | `teardownPartialStart` cancels screen/camera writer and removes screen URL; folder may remain. | Partial cleanup gap. |
| Stop fails after manifest write | Folder can contain useful media/manifest, but JS does not open it as a project. | Recovery gap. |
| Crash during recording | Media may be unplayable until writer finalizes; sidecars can be invalid JSON. | Expected for abrupt process death; no crash-recovery repair path yet. |
| Project autosave crash | Atomic rename gives old or new `project.json`, not a half-written file. | Good. |
| Imported assets | Copied into sanitized project-local paths. | Good. |

## Recommended Fix Order

1. **P0:** Add bounded AVAssetWriter finish waits and make `flushActiveRecording` capable of escalation even when stop hangs.
2. **P0:** Route native `error` and `backpressure` through main-process recorder state, preload, and both recorder/control windows.
3. **P1:** Gate microphone UI by macOS capability or add an AVFoundation fallback for macOS 13/14.
4. **P1:** Gate selected-app audio scope by target type + macOS version.
5. **P1:** Add macOS 13 external camera discovery fallback.
6. **P1:** Add disk-space preflight and basic health monitoring during long recordings.
7. **P1:** Add camera recording runtime/interruption observers.
8. **P2:** Clean empty/partial folders after start failure and offer "open partial recording" on stop failure.

## Verification Checklist

Run after hardening changes:

- `pnpm typecheck`
- Rebuild the native addon: `cd packages/mac-addon && npx node-gyp rebuild`
- macOS 13.x: screen-only display recording.
- macOS 13.x: screen + built-in/default camera.
- macOS 13.x: external USB camera listing and recording.
- macOS 13.x: selecting mic should be disabled or explicitly reported unsupported.
- macOS 13.x: selected-app audio display/region should be disabled or explicitly reported unsupported.
- macOS 15+: screen + system audio + mic + camera.
- Long-run smoke: 2+ hour screen + camera at High/HEVC, inspect memory, dropped counters, and final manifest.
- Simulated storage failure: record to a nearly full volume or mocked writer failure and confirm user-visible state.
- Quit while recording and quit while stopping.
- Camera unplug/interruption during recording.
