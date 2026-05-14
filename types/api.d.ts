// IMPORTANT: these renderer-facing types are duplicated from
// `electron/ipc/permissions.ts` and `electron/ipc/recorder.ts`. They are
// the contract for the preload bridge in `electron/preload.ts`. The Next.js
// tsconfig excludes `electron/` and the electron tsconfig's rootDir is
// `electron/`, so neither side can directly import the other; until we
// refactor into a shared workspace, edits here MUST be mirrored in the
// matching IPC module (and vice versa).
import type {
  CameraPreviewFrame,
  CaptureTarget,
  RecordingFiles,
  RecordingResult,
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
export type RecorderPickerMode = 'display' | 'window'

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
  hideCameraPreview: boolean
}

export type RecorderStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'stopping'

export interface RecorderState {
  status: RecorderStatus
  settings: RecorderSettings
  sessionId: string | null
  outputDir: string | null
  activeFiles: RecordingFiles | null
  lastResult: RecordingResult | null
  lastError: string | null
  pickerMode: RecorderPickerMode | null
  recordingStartedAt: number | null
  pausedMs: number
}

export interface PickerOverlayTarget {
  mode: RecorderPickerMode
  title: string
  sizeLabel: string
  modeLabel: string
  bounds: { x: number; y: number; width: number; height: number }
  iconDataUrl?: string
  target: CaptureTarget
}

export interface Api {
  recorder: {
    getState: () => Promise<RecorderState>
    showInputMenu: (
      kind: RecorderInputKind,
      anchor: RecorderMenuAnchor,
    ) => Promise<RecorderState>
    showSettingsMenu: (anchor: RecorderMenuAnchor) => Promise<RecorderState>
    startPicker: (mode: RecorderPickerMode) => Promise<RecorderState>
    cancelPicker: () => Promise<RecorderState>
    start: () => Promise<RecorderState>
    stop: () => Promise<RecorderState>
    pause: () => Promise<RecorderState>
    resume: () => Promise<RecorderState>
    restart: () => Promise<RecorderState>
    delete: () => Promise<RecorderState>
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
  cameraPreview: {
    onFrame: (callback: (frame: CameraPreviewFrame) => void) => Unsubscribe
    onError: (callback: (message: string) => void) => Unsubscribe
  }
  windowPicker: {
    confirm: () => Promise<void>
    cancel: () => Promise<void>
    setInteractive: (interactive: boolean) => Promise<void>
    getCurrentTarget: () => Promise<PickerOverlayTarget | null>
    onTargetChanged: (callback: (target: PickerOverlayTarget | null) => void) => Unsubscribe
  }
}

declare global {
  interface Window {
    api: Api
  }
}

export {}
