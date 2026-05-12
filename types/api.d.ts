import type {
  AudioDevice,
  CameraDevice,
  Capabilities,
  PermissionKind,
  PermissionState,
  RecordingEvent,
  RecordingFiles,
  RecordingResult,
  RecordingSession,
  ShareableContent,
  StartRecordingOptions,
  Unsubscribe,
} from '@openscreen/mac-addon'

export type MacPermissionKind =
  | 'screen'
  | 'microphone'
  | 'camera'
  | 'accessibility'
  | 'systemAudio'

export type RequiredMacPermissionKind = Exclude<MacPermissionKind, 'systemAudio'>

export type MacPermissionState =
  | 'granted'
  | 'notDetermined'
  | 'denied'
  | 'restricted'
  | 'unknown'

export interface PermissionSnapshot {
  permissions: Record<MacPermissionKind, MacPermissionState>
  required: RequiredMacPermissionKind[]
  missing: RequiredMacPermissionKind[]
  allGranted: boolean
  checkedAt: number
}

export interface PermissionChangeEvent {
  reason: string
  snapshot: PermissionSnapshot
}

export type RecorderInputKind = 'microphone' | 'camera' | 'systemAudio'

export interface RecorderMenuAnchor {
  x: number
  y: number
}

export interface RecorderSettings {
  systemAudio: boolean
  microphoneDeviceId: string | null
  microphoneLabel: string
  cameraDeviceId: string | null
  cameraLabel: string
}

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'stopping'

export interface RecorderState {
  status: RecorderStatus
  settings: RecorderSettings
  sessionId: string | null
  outputDir: string | null
  activeFiles: RecordingFiles | null
  lastResult: RecordingResult | null
  lastError: string | null
  platform: string
}

export interface Api {
  recorder: {
    getState: () => Promise<RecorderState>
    showInputMenu: (
      kind: RecorderInputKind,
      anchor: RecorderMenuAnchor,
    ) => Promise<RecorderState>
    start: () => Promise<RecorderState>
    stop: () => Promise<RecorderState>
    close: () => Promise<void>
    onChanged: (callback: (state: RecorderState) => void) => Unsubscribe
  }
  permissions: {
    getStatus: () => Promise<PermissionSnapshot>
    request: (kind: MacPermissionKind) => Promise<PermissionSnapshot>
    requestAll: () => Promise<PermissionSnapshot>
    openWindow: () => Promise<PermissionSnapshot>
    closeWindow: () => Promise<void>
    onChanged: (callback: (event: PermissionChangeEvent) => void) => Unsubscribe
  }
  macAddon: {
    hello: () => Promise<string>
    getCapabilities: () => Promise<Capabilities>
    getPermissions: () => Promise<Record<PermissionKind, PermissionState>>
    requestPermissions: (
      kinds: PermissionKind[],
    ) => Promise<Record<PermissionKind, PermissionState>>
    listShareableContent: () => Promise<ShareableContent>
    listCameras: () => Promise<CameraDevice[]>
    listMicrophones: () => Promise<AudioDevice[]>
    startRecording: (options: StartRecordingOptions) => Promise<RecordingSession>
    stopRecording: (sessionId: string) => Promise<RecordingResult>
    cancelRecording: (sessionId: string) => Promise<void>
    onRecordingEvent: (callback: (event: RecordingEvent) => void) => Unsubscribe
  }
}

declare global {
  interface Window {
    api: Api
  }
}

export {}
