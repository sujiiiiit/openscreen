export type PermissionKind = 'screen' | 'camera' | 'microphone' | 'systemAudio'

export type PermissionState =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'notDetermined'
  | 'unknown'
  | 'unsupported'

export type CaptureTarget =
  | { type: 'display'; displayId?: number }
  | { type: 'window'; windowId: number }
  | { type: 'application'; bundleId: string; displayId?: number }

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
export declare function listCameras(): CameraDevice[]
export declare function listMicrophones(): AudioDevice[]
export declare function startRecording(
  options: StartRecordingOptions,
): Promise<RecordingSession>
export declare function stopRecording(sessionId: string): Promise<RecordingResult>
export declare function cancelRecording(sessionId: string): Promise<void>
export declare function onRecordingEvent(callback: (event: RecordingEvent) => void): Unsubscribe
export declare function startCameraPreview(
  options: StartCameraPreviewOptions,
  callback: (frame: CameraPreviewFrame) => void,
): Promise<void>
export declare function stopCameraPreview(): Promise<void>

declare const _default: {
  hello: typeof hello
  getCapabilities: typeof getCapabilities
  getPermissions: typeof getPermissions
  requestPermissions: typeof requestPermissions
  listShareableContent: typeof listShareableContent
  listCameras: typeof listCameras
  listMicrophones: typeof listMicrophones
  startRecording: typeof startRecording
  stopRecording: typeof stopRecording
  cancelRecording: typeof cancelRecording
  onRecordingEvent: typeof onRecordingEvent
  startCameraPreview: typeof startCameraPreview
  stopCameraPreview: typeof stopCameraPreview
}

export default _default
