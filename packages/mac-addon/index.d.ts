export type PermissionKind =
  | 'screen'
  | 'camera'
  | 'microphone'
  | 'systemAudio'
  // Input Monitoring (TCC ListenEvent). Required only to capture global
  // keystrokes; mouse / cursor capture needs no permission.
  | 'inputMonitoring'

export type PermissionState =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'notDetermined'
  | 'unknown'
  | 'unsupported'

export type CaptureTarget =
  | (CaptureTargetMetadata & { type: 'display'; displayId?: number })
  | (CaptureTargetMetadata & { type: 'window'; windowId: number })
  | (CaptureTargetMetadata & { type: 'region'; displayId: number })
  | (CaptureTargetMetadata & { type: 'application'; bundleId: string; displayId?: number })

export interface CaptureTargetMetadata {
  title?: string
  applicationName?: string
  bundleId?: string
  processId?: number
  x?: number
  y?: number
  width?: number
  height?: number
  sourceX?: number
  sourceY?: number
  sourceWidth?: number
  sourceHeight?: number
  scaleFactor?: number
}

// Video codec for the screen track. The native side picks `hevc` on Apple
// Silicon and `h264` on Intel when the caller passes nothing.
//   - `hevc` : HEVC (H.265). Default. Best size/quality balance.
//   - `h264` : H.264 High AutoLevel. Maximum playback compatibility.
//
// ProRes 422 / 4444, HEVC-with-Alpha, and HDR were intentionally dropped to
// keep the output universally playable. The pipeline always emits BT.709
// SDR — see docs/screen-recording-addon.md.
export type VideoCodec = 'hevc' | 'h264'

// Bitrate preset for H.264 / HEVC. Higher quality = larger files.
//   - `low`    : Smallest files. Good for long captures.
//   - `medium` : Reasonable balance.
//   - `high`   : Default. Crisp text and edges.
//   - `xhigh`  : 2× of High. Near-lossless on screen content.
//   - `max`    : 4× of High. Minimal compression; large files.
export type VideoQuality = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Output container. Both `hevc` and `h264` work in both MOV and MP4.
// MOV is the default for QuickTime compatibility; MP4 is universally playable
// on Windows / Linux.
export type ContainerFormat = 'mov' | 'mp4'

// Resolution mode. `native` multiplies logical points by the display's
// `pointPixelScale` (Retina). `logical` uses the bare logical-point
// dimensions. Both still snap to even pixel counts for codec compatibility.
export type ResolutionMode = 'native' | 'logical'

// Frame rate selection. `0` means "native refresh" — the native side sets a
// 1/120 minimum interval, letting SCK deliver up to the display's refresh
// rate (e.g. 120 Hz on ProMotion). Explicit values pin the rate.
export type FrameRate = 0 | 24 | 30 | 60

export interface StartRecordingOptions {
  outputDir: string
  basename?: string
  target: CaptureTarget
  /** Legacy fps option. Prefer `frameRate`. Kept for back-compat. */
  fps?: 30 | 60
  width?: number
  height?: number
  includeCursor?: boolean
  recordSystemAudio?: boolean
  recordMicrophone?: boolean
  microphoneDeviceId?: string
  recordCamera?: boolean
  cameraDeviceId?: string
  excludeOwnApp?: boolean
  // Bundle IDs of applications whose audio should be exclusively captured.
  // Empty/undefined means no per-app filtering (default: all system audio
  // minus the recorder's own process). The native side honors this via
  // SCStreamConfiguration.applicationsToInclude on macOS 15+; on older OSes,
  // a window-targeted capture's SCContentFilter already constrains audio to
  // the picked window's owning app.
  audioApplications?: string[]

  // ── Screen video quality settings ────────────────────────────────────
  //
  // Every field is optional. Unknown enum values are coerced onto defaults
  // by the native side. Resolved values are written back into the
  // recording's manifest under `outputs`, so you can verify what was
  // actually used by reading `<basename>-recording.json`.
  /** Video codec. Default: `hevc` (Apple Silicon) / `h264` (Intel). */
  videoCodec?: VideoCodec
  /** Bitrate preset for the encoder. Default: `high`. */
  videoQuality?: VideoQuality
  /** Output container. Default: `mov`. */
  container?: ContainerFormat
  /** Resolution mode. Default: `native`. */
  resolutionMode?: ResolutionMode
  /** Frame rate. `0` = native refresh. Default: `60`. */
  frameRate?: FrameRate

  // ── Input capture (Screen Studio-style sidecar metadata) ─────────────
  //
  // When enabled, the session records mouse moves/drags/clicks (and, when
  // `captureKeyStrokes` is also on AND Input Monitoring is granted,
  // keystrokes) plus cursor-shape changes into streaming JSON sidecar files
  // next to the screen video, using Screen Studio's field schema. None of
  // these alter the recorded video — to let an editor restyle the cursor,
  // also pass `includeCursor: false`.
  /**
   * Master switch for input capture. Implied by `captureKeyStrokes` /
   * `captureCursorShapes`. Default: `false`.
   */
  captureInput?: boolean
  /**
   * Record keystrokes (`keystrokes-0.json`). Requires Input Monitoring
   * permission; silently no-ops for keys if not granted. Default: `false`.
   */
  captureKeyStrokes?: boolean
  /**
   * Build the NSCursor catalog (`cursors.json` + `cursors/*.png`) and stamp a
   * semantic `cursorId` onto every event. Default: `false`.
   */
  captureCursorShapes?: boolean
}

export interface Capabilities {
  platform: 'darwin'
  macosVersion: string
  screenCaptureKit: boolean
  systemAudio: boolean
  screenCaptureKitMicrophone: boolean
  microphoneFallback: boolean
  camera: boolean
  separateFiles: boolean
  scRecordingOutput: boolean
}

export interface DisplaySource {
  displayId: number
  width: number
  height: number
  x: number
  y: number
}

export interface WindowSource {
  windowId: number
  title: string
  applicationName: string
  bundleId: string
  iconDataUrl?: string
  processId: number
  onScreen: boolean
  x: number
  y: number
  width: number
  height: number
}

export interface ApplicationSource {
  applicationName: string
  bundleId: string
  processId: number
}

export interface ShareableContent {
  displays: DisplaySource[]
  windows: WindowSource[]
  applications: ApplicationSource[]
}

export interface CaptureDevice {
  deviceId: string
  uniqueID: string
  localizedName: string
  manufacturer: string
  modelID: string
  deviceType: string
  connected: boolean
  suspended: boolean
  inUseByAnotherApplication: boolean
  position: number
  isDefault: boolean
}

export type CameraDevice = CaptureDevice
export type AudioDevice = CaptureDevice

export interface RecordingFiles {
  // Single .mov/.mp4 containing screen video plus, when enabled, system audio
  // and macOS 15+ microphone audio. Written by the screen AVAssetWriter.
  screen: string
  camera?: string
  manifest: string
  // Screen Studio-style input sidecars, present only when captureInput is on.
  // Coordinates are display-relative logical points, top-left origin.
  mouseMoves?: string
  mouseClicks?: string
  keyStrokes?: string
  cursors?: string
}

export interface RecordingSession {
  sessionId: string
  files: RecordingFiles
}

export interface InputSessionMetadata {
  processTimeStartMs: number
  processTimeEndMs: number
  unixStartMs: number
  unixEndMs: number
  durationMs: number
  mouseMovesCount: number
  mouseClicksCount: number
  keyStrokesCount: number
}

export interface RecordingOutputMetadata {
  source: 'screen' | 'camera' | 'systemAudio' | 'microphone' | 'input'
  path?: string

  // ── Input track only (source === 'input') ───────────────────────────
  // Whether keystroke capture was actually active (requested AND Input
  // Monitoring granted) and whether the cursor catalog was built.
  captureKeyStrokes?: boolean
  captureCursorShapes?: boolean
  mouseMovesFilename?: string
  mouseClicksFilename?: string
  keyStrokesFilename?: string
  cursorsInfoFile?: string
  cursorImagesFolder?: string
  displayId?: number
  displayBoundsPoints?: { x: number; y: number; width: number; height: number }
  session?: InputSessionMetadata
  // True once the writer has actually accepted a sample (per-source; camera
  // reports its writer state, screen reports the first AVAssetWriter session).
  started?: boolean
  finished?: boolean
  samples?: number
  fileSize?: number
  firstPtsMs?: number
  lastPtsMs?: number
  durationMs?: number
  width?: number
  height?: number
  sampleRate?: number
  channelCount?: number
  // Codec actually used (screen track only). One of `hevc` / `h264`.
  codec?: string
  // The coerced screen-recording settings the writer actually used. Present
  // only on the screen track.
  videoCodec?: VideoCodec
  videoQuality?: VideoQuality
  container?: ContainerFormat
  resolutionMode?: ResolutionMode
  frameRate?: number
  bitsPerPixel?: number
  pixelFormat?: string
  colorPrimaries?: string
  colorTransfer?: string
  colorMatrix?: string
  averageBitRate?: number
  maxKeyFrameInterval?: number
  // Mirrors which output file the source landed in. Present for systemAudio
  // and microphone, where the audio is muxed into the screen .mov rather
  // than written to its own file.
  muxedInto?: 'screen'
  // Microphone-only: the input device the SCStream was bound to.
  deviceId?: string
  error?: string
  // Number of samples the writer dropped before they reached AVAssetWriter
  // due to backpressure. Absent when no samples were dropped.
  droppedSamples?: number
  droppedVideoSamples?: number
  completeFrames?: number
  idleFrames?: number
  blankFrames?: number
  suspendedFrames?: number
  startedFrames?: number
  stoppedFrames?: number
  unknownFrames?: number
  dirtyFrames?: number
  dirtyRects?: number
  maxDirtyRectsInFrame?: number
  lastContentScale?: number
  lastFrameScaleFactor?: number
  lastContentRect?: { x: number; y: number; width: number; height: number }
  lastBoundingRect?: { x: number; y: number; width: number; height: number }
  lastScreenRect?: { x: number; y: number; width: number; height: number }
  captureScope?: 'owningApplication' | 'filter' | string
  applicationName?: string
  bundleId?: string
  // Bundle IDs the renderer requested the system audio be scoped to. Mirrors
  // StartRecordingOptions.audioApplications. Present when the user opted into
  // per-app audio capture.
  audioApplicationBundleIds?: string[]
}

export interface RecordingManifest {
  // Manifest schema version. Absent in recordings made before the field
  // shipped (treat as the original/unversioned shape).
  version?: number
  sessionId: string
  startedAtUnixMs: number
  hostStartMs: number
  target: CaptureTarget
  fps: number
  includeCursor: boolean
  excludeOwnApp: boolean
  files: RecordingFiles
  outputs: RecordingOutputMetadata[]
  microphoneSource: 'screenCaptureKit' | 'avFoundation'
  cameraDeviceId?: string
  microphoneDeviceId?: string
}

export interface RecordingResult {
  sessionId: string
  files: RecordingFiles
  manifest: RecordingManifest
}

export interface RecordingEvent {
  type:
    | 'started'
    | 'stopped'
    | 'cancelled'
    | 'paused'
    | 'resumed'
    | 'fileStarted'
    | 'error'
    // Emitted once per writer the first time it has to drop samples to keep
    // memory bounded. The source field identifies which writer.
    | 'backpressure'
  sessionId?: string
  source?: string
  message?: string
  durationMs?: number
}

export interface CameraPreviewFrame {
  width: number
  height: number
  rowBytes: number
  data: Buffer
}

export interface StartCameraPreviewOptions {
  deviceId?: string
}

export type Unsubscribe = () => void

export declare function hello(): string
export declare function getCapabilities(): Capabilities
export declare function getPermissions(): Record<PermissionKind, PermissionState>
export declare function requestPermissions(
  kinds: PermissionKind[],
): Promise<Record<PermissionKind, PermissionState>>
export declare function listShareableContent(): Promise<ShareableContent>
export declare function listVisibleWindows(includeIcons?: boolean): WindowSource[]
export declare function getWindowUnderCursor(includeIcon?: boolean): WindowSource | null
export declare function getDisplayUnderCursor(): DisplaySource | null
export declare function listCameras(): CameraDevice[]
export declare function listMicrophones(): AudioDevice[]
export declare function startRecording(
  options: StartRecordingOptions,
): Promise<RecordingSession>
export declare function stopRecording(sessionId: string): Promise<RecordingResult>
export declare function cancelRecording(sessionId: string): Promise<void>
export declare function pauseRecording(sessionId: string): RecordingPauseState
export declare function resumeRecording(sessionId: string): RecordingPauseState
export declare function getRecordingStatus(sessionId: string): RecordingPauseState | null

export interface RecordingPauseState {
  sessionId: string
  paused: boolean
  pausedMs: number
}
export declare function onRecordingEvent(callback: (event: RecordingEvent) => void): Unsubscribe
export declare function startCameraPreview(
  options: StartCameraPreviewOptions,
  callback: (frame: CameraPreviewFrame) => void,
): Promise<void>
export declare function stopCameraPreview(): Promise<void>
export declare function pinWindowAcrossSpaces(nativeHandle: Buffer): boolean
export declare function onActiveSpaceChange(callback: () => void): void
// Fire-and-forget. Kicks an async SCShareableContent fetch and caches the
// result so the next startRecording can skip the 500ms–1s cold-call wait.
// Idempotent; safe to call multiple times — already-in-flight or recent
// caches are reused.
export declare function prewarmShareableContent(): void

declare const _default: {
  hello: typeof hello
  getCapabilities: typeof getCapabilities
  getPermissions: typeof getPermissions
  requestPermissions: typeof requestPermissions
  listShareableContent: typeof listShareableContent
  listVisibleWindows: typeof listVisibleWindows
  getWindowUnderCursor: typeof getWindowUnderCursor
  getDisplayUnderCursor: typeof getDisplayUnderCursor
  listCameras: typeof listCameras
  listMicrophones: typeof listMicrophones
  startRecording: typeof startRecording
  stopRecording: typeof stopRecording
  cancelRecording: typeof cancelRecording
  pauseRecording: typeof pauseRecording
  resumeRecording: typeof resumeRecording
  getRecordingStatus: typeof getRecordingStatus
  onRecordingEvent: typeof onRecordingEvent
  startCameraPreview: typeof startCameraPreview
  stopCameraPreview: typeof stopCameraPreview
  pinWindowAcrossSpaces: typeof pinWindowAcrossSpaces
  onActiveSpaceChange: typeof onActiveSpaceChange
  prewarmShareableContent: typeof prewarmShareableContent
}

export default _default
