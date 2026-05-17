export type PermissionKind = 'screen' | 'camera' | 'microphone' | 'systemAudio'

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

export interface StartRecordingOptions {
  outputDir: string
  basename?: string
  target: CaptureTarget
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
  // Single .mov containing screen video plus, when enabled, system audio and
  // microphone (all muxed by SCRecordingOutput).
  screen: string
  camera?: string
  manifest: string
}

export interface RecordingSession {
  sessionId: string
  files: RecordingFiles
}

export interface RecordingOutputMetadata {
  source: 'screen' | 'camera' | 'systemAudio' | 'microphone'
  path?: string
  // True once SCRecordingOutput / AVAssetWriter has actually accepted a sample
  // (per-source; camera reports its writer state, screen reports the
  // SCRecordingOutput didStartRecordingAtFileURL callback).
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
  // Codec actually used (screen track only): 'hevc' on Apple Silicon, 'h264' on Intel.
  codec?: 'hevc' | 'h264' | string
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
