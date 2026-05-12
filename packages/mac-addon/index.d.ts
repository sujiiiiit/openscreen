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
  screen: string
  camera?: string
  systemAudio?: string
  microphone?: string
  manifest: string
}

export interface RecordingSession {
  sessionId: string
  files: RecordingFiles
}

export interface RecordingOutputMetadata {
  source: 'screen' | 'camera' | 'systemAudio' | 'microphone'
  path: string
  started: boolean
  finished: boolean
  samples: number
  fileSize: number
  firstPtsMs: number
  lastPtsMs: number
  durationMs: number
  width?: number
  height?: number
  sampleRate?: number
  channelCount?: number
  error?: string
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
  type: 'started' | 'stopped' | 'cancelled' | 'fileStarted' | 'error'
  sessionId?: string
  source?: string
  message?: string
  durationMs?: number
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
}

export default _default
