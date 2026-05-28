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
  // Opt-in keystroke capture (Screen Studio-style). Off by default; requires
  // macOS Input Monitoring permission. Mouse + cursor metadata is always
  // captured regardless.
  captureKeystrokes: boolean
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

// ─── project.json schema (mirrored from electron/ipc/project-schema.ts) ──
// Edits here MUST be reflected in electron/ipc/project-schema.ts. Renderer
// code imports these types from `@/types/api`.

export type ProjectStateVersion = 1

export type ProjectArtboardPresetId =
  | 'wide'
  | 'vertical'
  | 'portrait'
  | 'standard'
  | 'square'
  | 'auto'

export type ProjectArtboardBackground =
  | { type: 'color'; value: string }
  | { type: 'wallpaper'; value: string; blurRadius?: number }

export interface ProjectArtboard {
  presetId: ProjectArtboardPresetId
  width: number
  height: number
  background: ProjectArtboardBackground | null
  padding: number
  grain: number
  // Recorded-cursor render-size multiplier (1 = recorded-accurate minimum).
  // Optional on disk: older project.json files predate it and the validator
  // supplies the default, so they keep loading. See electron/ipc/project-schema.ts.
  cursorSizeMultiplier?: number
  // Cursor motion-blur intensity, 0..1 (0 = off). Optional on disk for the same
  // back-compat reason; validator defaults + clamps. See project-schema.ts.
  cursorMotionBlur?: number
}

export type ProjectVideoRole = 'screen' | 'camera' | 'media'
export type ProjectBorderAlignment = 'inside' | 'center' | 'outside'

export type ProjectVideoSource =
  | { kind: 'recording'; assetRole: 'screen' | 'camera' }
  | { kind: 'imported'; relativePath: string; fileSize: number }

export interface ProjectVideo {
  id: string
  fileName: string
  source: ProjectVideoSource
  /**
   * Whether the video is placed on the canvas / timeline. Optional for
   * back-compat: missing means `true`. `false` marks a video the user removed
   * from the canvas — kept in the project so it can be re-added.
   */
  onCanvas?: boolean
  intrinsicWidth: number
  intrinsicHeight: number
  durationMs: number
  role: ProjectVideoRole
  x: number
  y: number
  width: number
  height: number
  rotation: number
  locked: boolean
  cornerRadius: number
  cornerSmoothing: number
  borderWidth: number
  borderColor: string
  borderOffset: number
  borderAlignment: ProjectBorderAlignment
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
  shadowSpread: number
}

export interface ProjectTimelineClip {
  id: string
  videoId: string
  start: number
  end: number
  sourceIn: number
  sourceOut: number
}

export interface ProjectStateV1 {
  version: 1
  artboard: ProjectArtboard
  videos: ProjectVideo[]
  timelineClips: ProjectTimelineClip[]
  updatedAtUnixMs: number
}

export interface ImportAssetPayload {
  id: string
  fileName: string
  bytes: ArrayBuffer
}

export interface ImportAssetResult {
  relativePath: string
  fileUrl: string
  fileSize: number
}

export type SaveProjectStateResult =
  | { ok: true; writtenAtUnixMs: number }
  | { ok: false; reason: string }

// ─── export-settings schema (mirrored from electron/ipc/export-schema.ts) ──

export type ExportFormatId = 'mp4-avc' | 'mp4-hevc' | 'webm-vp9'

export type ExportResolutionId =
  | 'artboard'
  | '720p'
  | '1080p'
  | '1440p'
  | '4k'

export type ExportFrameRate = 30 | 60

export interface ExportSettings {
  format: ExportFormatId
  resolution: ExportResolutionId
  fps: ExportFrameRate
}

export type ExportPhase =
  | 'idle'
  | 'preparing'
  | 'encoding'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'cancelled'

export interface ExportProgress {
  framesDone: number
  framesTotal: number
  etaSeconds: number | null
}

export interface ExportJobState {
  phase: ExportPhase
  settings: ExportSettings
  progress: ExportProgress
  outputPath: string | null
  startedAtUnixMs: number | null
  lastError: string | null
}

export interface ExportSourceVideo {
  id: string
  fileUrl: string
}

export interface ExportStartPayload {
  settings: ExportSettings
  state: ProjectStateV1
  // Pre-resolved file:// URLs for every video in `state.videos`.
  // Mirrors `ProjectSummary.assetUrlsByVideoId`.
  assetUrlsByVideoId: Record<string, string>
  // Filename basename (no extension) used to derive the timestamp portion
  // of the output file. Defaults to the active project name.
  outputBaseName?: string
}

export interface ExportCodecSupport {
  format: ExportFormatId
  supported: boolean
}

export interface ProjectSummary {
  id: string
  name: string
  path: string
  createdAtUnixMs: number
  recordingType: ProjectRecordingType | null
  assets: ProjectAsset[]
  state: ProjectStateV1 | null
  assetUrlsByVideoId: Record<string, string>
}

// Mirrors `electron/ipc/projects.ts`.
export interface CursorMoveSample {
  processTimeMs: number
  x: number
  y: number
  cursorId?: string
  type?: string
}

export interface CursorTrackData {
  moves: CursorMoveSample[]
  processTimeStartMs: number
  displayWidth: number
  displayHeight: number
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
    saveState: (
      folderPath: string,
      state: ProjectStateV1,
    ) => Promise<SaveProjectStateResult>
    importAsset: (
      folderPath: string,
      payload: ImportAssetPayload,
    ) => Promise<ImportAssetResult>
    getCursorData: (folderPath: string) => Promise<CursorTrackData | null>
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
  export: {
    openWindow: (payload: ExportStartPayload) => Promise<void>
    getStartPayload: () => Promise<ExportStartPayload | null>
    getState: () => Promise<ExportJobState>
    getSettings: () => Promise<ExportSettings>
    setSettings: (patch: Partial<ExportSettings>) => Promise<ExportSettings>
    markPreparing: () => Promise<void>
    reportProgress: (progress: ExportProgress) => Promise<void>
    reportDone: (bytes: ArrayBuffer) => Promise<{ outputPath: string }>
    reportError: (message: string) => Promise<void>
    cancel: () => Promise<void>
    revealOutput: (path: string) => Promise<void>
    closeWindow: () => Promise<void>
    onStateChanged: (callback: (state: ExportJobState) => void) => Unsubscribe
  }
}

declare global {
  interface Window {
    api: Api
  }
}

export {}
