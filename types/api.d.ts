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
  ContainerFormat,
  FrameRate,
  RecordingFiles,
  RecordingResult,
  ResolutionMode,
  Unsubscribe,
  VideoCodec,
  VideoQuality,
} from '@openscreen/mac-addon'

/** Mirror of RecordingQualitySettings from electron/ipc/recorder.ts. */
export interface RecordingQualitySettings {
  videoCodec: VideoCodec
  videoQuality: VideoQuality
  container: ContainerFormat
  resolutionMode: ResolutionMode
  frameRate: FrameRate
}

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
export type RecorderPickerMode = 'display' | 'window' | 'region'

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
  // When true, the recorder asks ScreenCaptureKit to omit the system cursor
  // from captured frames. Inverted into the addon's `includeCursor` option at
  // recording start; default false keeps cursor-visible as the out-of-box
  // behavior.
  hideCursor: boolean
  // When systemAudio is true, this picks between capturing audio from every
  // app ('all') or only the bundle IDs in systemAudioApplications
  // ('selected'). Ignored when systemAudio is false.
  systemAudioScope: 'all' | 'selected'
  // Bundle IDs of apps to capture audio from when systemAudioScope === 'selected'.
  // Sticky across recordings; the user manages the list manually via the
  // system audio menu.
  systemAudioApplications: string[]
  recordingQuality: RecordingQualitySettings
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
  locked?: boolean
  target: CaptureTarget
}

export interface WindowPickerSession {
  mode: RecorderPickerMode | null
  minRegionWidth: number
  minRegionHeight: number
  locked: boolean
}

export interface RegionSelectionBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface RegionSelectionResult {
  target: PickerOverlayTarget | null
  message: string | null
}

export interface WindowStateSnapshot {
  platform: NodeJS.Platform
  isMaximized: boolean
  isFullScreen: boolean
}

export interface WindowStateChange {
  isMaximized: boolean
  isFullScreen: boolean
}

export type ProjectAssetRole = 'screen' | 'camera'

export type ProjectRecordingType =
  | 'display'
  | 'window'
  | 'region'
  | 'application'

export interface ProjectAssetAudioTrack {
  source: 'systemAudio' | 'microphone'
  sampleRate?: number
  channelCount?: number
}

export interface ProjectAsset {
  role: ProjectAssetRole
  fileName: string
  filePath: string
  fileUrl: string
  fileSize: number
  durationMs?: number
  width?: number
  height?: number
  codec?: string
  audioTracks: ProjectAssetAudioTrack[]
}

export interface ProjectSummary {
  id: string
  name: string
  path: string
  createdAtUnixMs: number
  recordingType: ProjectRecordingType | null
  assets: ProjectAsset[]
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
    getRecordingSettings: () => Promise<RecordingQualitySettings>
    setRecordingSettings: (
      patch: Partial<RecordingQualitySettings>,
    ) => Promise<RecordingQualitySettings>
    openRecordingSettings: () => Promise<void>
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
  platform: NodeJS.Platform
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
    getState: () => Promise<WindowStateSnapshot>
    onStateChanged: (callback: (state: WindowStateChange) => void) => Unsubscribe
  }
  projects: {
    getLatest: () => Promise<ProjectSummary | null>
    open: (folderPath: string) => Promise<ProjectSummary | null>
    pickAndOpen: () => Promise<ProjectSummary | null>
  }
  windowPicker: {
    confirm: () => Promise<void>
    cancel: () => Promise<void>
    setInteractive: (interactive: boolean) => Promise<void>
    getCurrentTarget: () => Promise<PickerOverlayTarget | null>
    getSession: () => Promise<WindowPickerSession>
    setRegionSelection: (bounds: RegionSelectionBounds | null) => Promise<RegionSelectionResult>
    onTargetChanged: (callback: (target: PickerOverlayTarget | null) => void) => Unsubscribe
  }
}

declare global {
  interface Window {
    api: Api
  }
}

export {}
