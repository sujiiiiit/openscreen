import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  screen,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import { mkdirSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import addon, {
  type AudioDevice,
  type CameraDevice,
  type CaptureTarget,
  type RecordingFiles,
  type RecordingResult,
  type StartRecordingOptions,
} from '@openscreen/mac-addon'

// IMPORTANT: the exported types below are mirrored in `types/api.d.ts` so
// the renderer can typecheck the preload bridge without importing from
// `electron/` (which the Next.js tsconfig excludes). Edits here MUST be
// reflected there.
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
  // Unix-epoch milliseconds when the current session entered the recording
  // state. Null when not recording. The renderer subtracts pausedMs from
  // (Date.now() - recordingStartedAt) to drive the live timer.
  recordingStartedAt: number | null
  // Total time the current session has spent paused, in milliseconds.
  pausedMs: number
}

interface RegisterRecorderHandlersOptions {
  getRecorderWindow: () => BrowserWindow | null
  getControlsWindow?: () => BrowserWindow | null
  onCameraPreviewChanged?: (deviceId: string | null) => void
  startPicker?: (mode: RecorderPickerMode) => void
  cancelPicker?: () => void
  // Called whenever state.status changes. Lets main.ts swap between the
  // recorder bar (idle) and the compact recording controls window
  // (recording / paused).
  onStatusChanged?: (status: RecorderStatus, snapshot: RecorderState) => void
}

let cameraPreviewListener: ((deviceId: string | null) => void) | null = null
let getRecorderWindowRef: (() => BrowserWindow | null) | null = null
let getControlsWindowRef: (() => BrowserWindow | null) | null = null
let statusChangedListener:
  | ((status: RecorderStatus, snapshot: RecorderState) => void)
  | null = null
let lastEmittedStatus: RecorderStatus = 'idle'
let activeCaptureTarget: CaptureTarget | null = null
let pendingDiscardConfirmation = false

const NO_MICROPHONE_LABEL = 'No microphone'
const NO_CAMERA_LABEL = 'No camera'
const SYSTEM_AUDIO_LABEL = 'System audio'
const NO_SYSTEM_AUDIO_LABEL = 'No system audio'

const state: RecorderState = {
  status: 'idle',
  settings: {
    systemAudio: false,
    microphoneDeviceId: null,
    microphoneLabel: NO_MICROPHONE_LABEL,
    cameraDeviceId: null,
    cameraLabel: NO_CAMERA_LABEL,
    hideCameraPreview: false,
  },
  sessionId: null,
  outputDir: null,
  activeFiles: null,
  lastResult: null,
  lastError: null,
  pickerMode: null,
  recordingStartedAt: null,
  pausedMs: 0,
}

function refreshPausedMs(): void {
  if (state.sessionId && process.platform === 'darwin') {
    try {
      const status = addon.getRecordingStatus(state.sessionId)
      if (status) {
        state.pausedMs = status.pausedMs
      }
    } catch {
      // Session was torn down between renders — ignore.
    }
  }
}

function publicState(): RecorderState {
  return JSON.parse(JSON.stringify(state)) as RecorderState
}

function emitState(): RecorderState {
  const snapshot = publicState()
  const recorder = getRecorderWindowRef?.()
  if (recorder && !recorder.isDestroyed()) {
    recorder.webContents.send('recorder:changed', snapshot)
  }
  const controls = getControlsWindowRef?.()
  if (controls && !controls.isDestroyed()) {
    controls.webContents.send('recorder:changed', snapshot)
  }
  if (snapshot.status !== lastEmittedStatus) {
    lastEmittedStatus = snapshot.status
    statusChangedListener?.(snapshot.status, snapshot)
  }
  return snapshot
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function timestampFolderName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function recordingsRoot(): string {
  return path.join(app.getPath('documents'), 'openscreen')
}

function outputDirectory(): string {
  const root = recordingsRoot()
  mkdirSync(root, { recursive: true })
  return path.join(root, timestampFolderName())
}

function defaultCaptureTarget(): CaptureTarget {
  return {
    type: 'display',
    displayId: screen.getPrimaryDisplay().id,
  }
}

function cloneCaptureTarget(target: CaptureTarget): CaptureTarget {
  return JSON.parse(JSON.stringify(target)) as CaptureTarget
}

function removeRecordingDirectory(directory: string | null): void {
  if (!directory) return
  const root = path.resolve(recordingsRoot())
  const resolved = path.resolve(directory)
  if (resolved === root || !resolved.startsWith(root + path.sep)) return
  rmSync(resolved, { recursive: true, force: true })
}

function canChangeSettings(): boolean {
  return state.status === 'idle' && state.pickerMode === null
}

function deviceLabel(device: AudioDevice | CameraDevice): string {
  const name = device.localizedName || 'Unknown device'
  return device.isDefault ? `${name} (default)` : name
}

function isConnectedDevice(device: AudioDevice | CameraDevice): boolean {
  return device.connected !== false && device.suspended !== true
}

function listMicrophones(): AudioDevice[] {
  if (process.platform !== 'darwin') return []
  return addon.listMicrophones().filter(isConnectedDevice)
}

function listCameras(): CameraDevice[] {
  if (process.platform !== 'darwin') return []
  return addon.listCameras().filter(isConnectedDevice)
}

function refreshSelectedDevices(): {
  microphones: AudioDevice[]
  cameras: CameraDevice[]
  changed: boolean
  cameraChanged: boolean
} {
  const microphones = listMicrophones()
  const cameras = listCameras()
  const previousCameraDeviceId = state.settings.cameraDeviceId
  let changed = false

  const selectedMicrophone = state.settings.microphoneDeviceId
    ? microphones.find((device) => device.deviceId === state.settings.microphoneDeviceId)
    : null
  if (state.settings.microphoneDeviceId && !selectedMicrophone) {
    state.settings.microphoneDeviceId = null
    state.settings.microphoneLabel = NO_MICROPHONE_LABEL
    changed = true
  } else if (selectedMicrophone) {
    const label = deviceLabel(selectedMicrophone)
    if (label !== state.settings.microphoneLabel) {
      state.settings.microphoneLabel = label
      changed = true
    }
  }

  const selectedCamera = state.settings.cameraDeviceId
    ? cameras.find((device) => device.deviceId === state.settings.cameraDeviceId)
    : null
  if (state.settings.cameraDeviceId && !selectedCamera) {
    state.settings.cameraDeviceId = null
    state.settings.cameraLabel = NO_CAMERA_LABEL
    changed = true
  } else if (selectedCamera) {
    const label = deviceLabel(selectedCamera)
    if (label !== state.settings.cameraLabel) {
      state.settings.cameraLabel = label
      changed = true
    }
  }

  return {
    microphones,
    cameras,
    changed,
    cameraChanged: previousCameraDeviceId !== state.settings.cameraDeviceId,
  }
}

function cameraPreviewDeviceId(): string | null {
  return state.settings.hideCameraPreview ? null : state.settings.cameraDeviceId
}

function notifyCameraPreviewChanged(previousPreviewDeviceId: string | null): void {
  const nextPreviewDeviceId = cameraPreviewDeviceId()
  if (previousPreviewDeviceId !== nextPreviewDeviceId && cameraPreviewListener) {
    cameraPreviewListener(nextPreviewDeviceId)
  }
}

function selectMicrophone(device: AudioDevice | null): void {
  if (!canChangeSettings()) return
  state.settings.microphoneDeviceId = device?.deviceId ?? null
  state.settings.microphoneLabel = device ? deviceLabel(device) : NO_MICROPHONE_LABEL
  state.lastError = null
  emitState()
}

function selectCamera(device: CameraDevice | null): void {
  if (!canChangeSettings()) return
  const previousPreviewDeviceId = cameraPreviewDeviceId()
  const nextDeviceId = device?.deviceId ?? null
  state.settings.cameraDeviceId = nextDeviceId
  state.settings.cameraLabel = device ? deviceLabel(device) : NO_CAMERA_LABEL
  state.lastError = null
  emitState()
  notifyCameraPreviewChanged(previousPreviewDeviceId)
}

function selectSystemAudio(enabled: boolean): void {
  if (!canChangeSettings()) return
  state.settings.systemAudio = enabled
  state.lastError = null
  emitState()
}

function setHideCameraPreview(hidden: boolean): void {
  if (!canChangeSettings()) return
  if (state.settings.hideCameraPreview === hidden) return

  const previousPreviewDeviceId = cameraPreviewDeviceId()
  state.settings.hideCameraPreview = hidden
  state.lastError = null
  emitState()
  notifyCameraPreviewChanged(previousPreviewDeviceId)
}

function microphoneMenuTemplate(devices: AudioDevice[]): MenuItemConstructorOptions[] {
  const enabled = canChangeSettings()
  const template: MenuItemConstructorOptions[] = [
    {
      label: NO_MICROPHONE_LABEL,
      type: 'radio',
      checked: state.settings.microphoneDeviceId === null,
      enabled,
      click: () => selectMicrophone(null),
    },
  ]

  if (devices.length > 0) {
    template.push({ type: 'separator' })
    for (const device of devices) {
      template.push({
        label: deviceLabel(device),
        type: 'radio',
        checked: state.settings.microphoneDeviceId === device.deviceId,
        enabled,
        click: () => selectMicrophone(device),
      })
    }
  }

  return template
}

function cameraMenuTemplate(devices: CameraDevice[]): MenuItemConstructorOptions[] {
  const enabled = canChangeSettings()
  const template: MenuItemConstructorOptions[] = [
    {
      label: NO_CAMERA_LABEL,
      type: 'radio',
      checked: state.settings.cameraDeviceId === null,
      enabled,
      click: () => selectCamera(null),
    },
  ]

  if (devices.length > 0) {
    template.push({ type: 'separator' })
    for (const device of devices) {
      template.push({
        label: deviceLabel(device),
        type: 'radio',
        checked: state.settings.cameraDeviceId === device.deviceId,
        enabled,
        click: () => selectCamera(device),
      })
    }
  }

  return template
}

function systemAudioMenuTemplate(): MenuItemConstructorOptions[] {
  const enabled = canChangeSettings()
  return [
    {
      label: 'Record system audio',
      type: 'radio',
      checked: state.settings.systemAudio,
      enabled,
      click: () => selectSystemAudio(true),
    },
    { type: 'separator' },
    {
      label: NO_SYSTEM_AUDIO_LABEL,
      type: 'radio',
      checked: !state.settings.systemAudio,
      enabled,
      click: () => selectSystemAudio(false),
    },
  ]
}

function recorderSettingsMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Hide camera preview',
      type: 'checkbox',
      checked: state.settings.hideCameraPreview,
      enabled: canChangeSettings(),
      click: () => setHideCameraPreview(!state.settings.hideCameraPreview),
    },
  ]
}

function popupPosition(anchor: unknown): RecorderMenuAnchor | undefined {
  if (!anchor || typeof anchor !== 'object') return undefined
  const candidate = anchor as Partial<RecorderMenuAnchor>
  if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number') {
    return undefined
  }
  return { x: Math.round(candidate.x), y: Math.round(candidate.y) }
}

function popupMenu(
  event: IpcMainInvokeEvent,
  template: MenuItemConstructorOptions[],
  anchor: unknown,
): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) return

  Menu.buildFromTemplate(template).popup({
    window,
    ...popupPosition(anchor),
  })
}

function showInputMenu(
  event: IpcMainInvokeEvent,
  kind: RecorderInputKind,
  anchor: unknown,
): RecorderState {
  if (kind === 'systemAudio') {
    popupMenu(event, systemAudioMenuTemplate(), anchor)
    return publicState()
  }

  try {
    const previousPreviewDeviceId = cameraPreviewDeviceId()
    const { microphones, cameras, changed, cameraChanged } = refreshSelectedDevices()
    if (changed) emitState()
    if (cameraChanged) notifyCameraPreviewChanged(previousPreviewDeviceId)
    popupMenu(
      event,
      kind === 'microphone'
        ? microphoneMenuTemplate(microphones)
        : cameraMenuTemplate(cameras),
      anchor,
    )
  } catch (error) {
    state.lastError = errorMessage(error)
    emitState()
  }

  return publicState()
}

function showSettingsMenu(
  event: IpcMainInvokeEvent,
  anchor: unknown,
): RecorderState {
  popupMenu(event, recorderSettingsMenuTemplate(), anchor)
  return publicState()
}

export async function startRecording(targetOverride?: CaptureTarget): Promise<RecorderState> {
  if (state.status !== 'idle') return publicState()
  if (process.platform !== 'darwin') {
    state.lastError = 'Screen recording is only available on macOS in this build.'
    return emitState()
  }

  state.status = 'starting'
  state.pickerMode = null
  state.lastError = null
  state.lastResult = null
  emitState()

  try {
    const previousPreviewDeviceId = cameraPreviewDeviceId()
    const { changed, cameraChanged } = refreshSelectedDevices()
    if (changed) emitState()
    if (cameraChanged) notifyCameraPreviewChanged(previousPreviewDeviceId)

    const outputDir = outputDirectory()
    const target = cloneCaptureTarget(targetOverride ?? defaultCaptureTarget())
    const options: StartRecordingOptions = {
      outputDir,
      target,
      fps: 60,
      includeCursor: true,
      excludeOwnApp: true,
      recordSystemAudio: state.settings.systemAudio,
      recordMicrophone: state.settings.microphoneDeviceId !== null,
      microphoneDeviceId: state.settings.microphoneDeviceId ?? undefined,
      recordCamera: state.settings.cameraDeviceId !== null,
      cameraDeviceId: state.settings.cameraDeviceId ?? undefined,
    }

    const session = await addon.startRecording(options)
    state.status = 'recording'
    state.sessionId = session.sessionId
    state.outputDir = outputDir
    state.activeFiles = session.files
    activeCaptureTarget = target
    state.recordingStartedAt = Date.now()
    state.pausedMs = 0
    state.lastError = null
  } catch (error) {
    state.status = 'idle'
    state.sessionId = null
    state.outputDir = null
    state.activeFiles = null
    activeCaptureTarget = null
    state.recordingStartedAt = null
    state.pausedMs = 0
    state.lastError = errorMessage(error)
  }

  return emitState()
}

function resetDiscardedRecording(): void {
  state.status = 'idle'
  state.sessionId = null
  state.outputDir = null
  state.activeFiles = null
  state.lastResult = null
  activeCaptureTarget = null
  state.recordingStartedAt = null
  state.pausedMs = 0
  state.lastError = null
}

async function confirmDiscardRecording(
  _event: IpcMainInvokeEvent,
  intent: 'restart' | 'delete',
): Promise<boolean> {
  const restart = intent === 'restart'
  const primaryButton = restart ? 'Restart the entire recording' : 'Delete the recording'
  const secondaryButton = 'Cancel'
  const options: Electron.MessageBoxOptions = {
    type: 'none',
    buttons: [primaryButton, secondaryButton],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: restart
      ? 'Restart entire recording'
      : 'Delete recording',
    detail: restart
      ? 'Are you sure you want to restart the entire recording?'
      : 'Are you sure you want to delete this recording?',
  }
  const { response } = await dialog.showMessageBox(options)
  return response === 0
}

async function discardActiveRecording(): Promise<void> {
  const sessionId = state.sessionId
  if (!sessionId) return
  const outputDir = state.outputDir
  await addon.cancelRecording(sessionId)
  removeRecordingDirectory(outputDir)
}

async function restartRecording(event: IpcMainInvokeEvent): Promise<RecorderState> {
  if (state.status !== 'recording' && state.status !== 'paused') return publicState()
  if (!state.sessionId) return publicState()
  if (pendingDiscardConfirmation) return publicState()

  pendingDiscardConfirmation = true
  const previousStatus = state.status
  try {
    const confirmed = await confirmDiscardRecording(event, 'restart')
    if (!confirmed) return publicState()

    const target = cloneCaptureTarget(activeCaptureTarget ?? defaultCaptureTarget())
    state.status = 'stopping'
    state.lastError = null
    emitState()

    await discardActiveRecording()
    resetDiscardedRecording()
    return startRecording(target)
  } catch (error) {
    state.status = state.sessionId ? previousStatus : 'idle'
    state.lastError = errorMessage(error)
    return emitState()
  } finally {
    pendingDiscardConfirmation = false
  }
}

async function deleteRecording(event: IpcMainInvokeEvent): Promise<RecorderState> {
  if (state.status !== 'recording' && state.status !== 'paused') return publicState()
  if (!state.sessionId) return publicState()
  if (pendingDiscardConfirmation) return publicState()

  pendingDiscardConfirmation = true
  const previousStatus = state.status
  try {
    const confirmed = await confirmDiscardRecording(event, 'delete')
    if (!confirmed) return publicState()

    state.status = 'stopping'
    state.lastError = null
    emitState()

    await discardActiveRecording()
    resetDiscardedRecording()
    return emitState()
  } catch (error) {
    state.status = state.sessionId ? previousStatus : 'idle'
    state.lastError = errorMessage(error)
    return emitState()
  } finally {
    pendingDiscardConfirmation = false
  }
}

export function pauseRecording(): RecorderState {
  if (state.status !== 'recording' || !state.sessionId) return publicState()
  if (process.platform !== 'darwin') return publicState()

  try {
    const result = addon.pauseRecording(state.sessionId)
    state.status = 'paused'
    state.pausedMs = result.pausedMs
    state.lastError = null
  } catch (error) {
    state.lastError = errorMessage(error)
  }
  return emitState()
}

export function resumeRecording(): RecorderState {
  if (state.status !== 'paused' || !state.sessionId) return publicState()
  if (process.platform !== 'darwin') return publicState()

  try {
    const result = addon.resumeRecording(state.sessionId)
    state.status = 'recording'
    state.pausedMs = result.pausedMs
    state.lastError = null
  } catch (error) {
    state.lastError = errorMessage(error)
  }
  return emitState()
}

export function finishPickerMode(): RecorderState {
  if (state.pickerMode === null) return publicState()
  state.pickerMode = null
  return emitState()
}

function startPicker(
  mode: RecorderPickerMode,
  options: RegisterRecorderHandlersOptions,
): RecorderState {
  if (mode !== 'display' && mode !== 'window') {
    state.lastError = 'Unknown recording picker mode.'
    return emitState()
  }
  if (state.status !== 'idle') return publicState()
  if (!options.startPicker) {
    state.lastError = 'Recording picker is not available.'
    return emitState()
  }
  if (state.pickerMode === mode) return publicState()

  try {
    state.pickerMode = mode
    state.lastError = null
    options.startPicker(mode)
  } catch (error) {
    state.pickerMode = null
    state.lastError = errorMessage(error)
  }

  return emitState()
}

function cancelPicker(options: RegisterRecorderHandlersOptions): RecorderState {
  options.cancelPicker?.()
  return finishPickerMode()
}

async function stopRecording(): Promise<RecorderState> {
  if (state.status !== 'recording' && state.status !== 'paused') return publicState()
  if (!state.sessionId) return publicState()

  const sessionId = state.sessionId
  const previousStatus = state.status
  // If we're stopping while paused, resume first so the writers can flush
  // any in-flight pause bookkeeping cleanly before finishWriterSync.
  if (previousStatus === 'paused') {
    try {
      addon.resumeRecording(sessionId)
    } catch {
      // Native side may have already torn down — proceed with stop anyway.
    }
  }
  state.status = 'stopping'
  state.lastError = null
  emitState()

  try {
    const result = await addon.stopRecording(sessionId)
    refreshPausedMs()
    state.status = 'idle'
    state.sessionId = null
    state.activeFiles = null
    state.outputDir = result.files.manifest
      ? path.dirname(result.files.manifest)
      : state.outputDir
    state.lastResult = result
    activeCaptureTarget = null
    state.recordingStartedAt = null
    state.pausedMs = 0
    state.lastError = null
  } catch (error) {
    state.status = previousStatus
    state.lastError = errorMessage(error)
  }

  return emitState()
}

export function registerRecorderHandlers(options: RegisterRecorderHandlersOptions): void {
  cameraPreviewListener = options.onCameraPreviewChanged ?? null
  getRecorderWindowRef = options.getRecorderWindow
  getControlsWindowRef = options.getControlsWindow ?? null
  statusChangedListener = options.onStatusChanged ?? null
  ipcMain.handle('recorder:getState', () => publicState())
  ipcMain.handle(
    'recorder:showInputMenu',
    (event, kind: RecorderInputKind, anchor: RecorderMenuAnchor) => {
      if (kind !== 'microphone' && kind !== 'camera' && kind !== 'systemAudio') {
        state.lastError = 'Unknown recorder input menu.'
        return emitState()
      }
      return showInputMenu(event, kind, anchor)
    },
  )
  ipcMain.handle('recorder:showSettingsMenu', (event, anchor: RecorderMenuAnchor) =>
    showSettingsMenu(event, anchor),
  )
  ipcMain.handle('recorder:start', () => startRecording())
  ipcMain.handle('recorder:stop', () => stopRecording())
  ipcMain.handle('recorder:pause', () => pauseRecording())
  ipcMain.handle('recorder:resume', () => resumeRecording())
  ipcMain.handle('recorder:restart', (event) => restartRecording(event))
  ipcMain.handle('recorder:delete', (event) => deleteRecording(event))
  ipcMain.handle('recorder:startPicker', (_event, mode: RecorderPickerMode) =>
    startPicker(mode, options),
  )
  ipcMain.handle('recorder:cancelPicker', () => cancelPicker(options))
  ipcMain.handle('recorder:close', (event) => {
    options.cancelPicker?.()
    finishPickerMode()
    const window = options.getRecorderWindow() ?? BrowserWindow.fromWebContents(event.sender)
    window?.close()
  })
}

export { NO_CAMERA_LABEL, NO_MICROPHONE_LABEL, NO_SYSTEM_AUDIO_LABEL, SYSTEM_AUDIO_LABEL }
