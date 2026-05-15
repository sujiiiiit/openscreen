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
  type WindowSource,
} from '@openscreen/mac-addon'

// IMPORTANT: the exported types below are mirrored in `types/api.d.ts` so
// the renderer can typecheck the preload bridge without importing from
// `electron/` (which the Next.js tsconfig excludes). Edits here MUST be
// reflected there.
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
  // When systemAudio is true, this picks between capturing audio from every
  // app ('all') or only the bundle IDs in systemAudioApplications
  // ('selected'). Ignored when systemAudio is false.
  systemAudioScope: 'all' | 'selected'
  // Bundle IDs of apps to capture audio from when systemAudioScope === 'selected'.
  // Sticky across recordings; the user manages the list manually via the
  // system audio menu.
  systemAudioApplications: string[]
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
// When a picker confirm is in progress, this slot holds the targeted start so
// a concurrent generic recorder:start (no target) can defer to it instead of
// silently kicking off a default-display recording behind the picker's back.
// Reservation auto-expires so a thrown picker callback can't wedge the flag on.
let pickerStartInFlight = false
let pickerStartReservationTimer: ReturnType<typeof setTimeout> | null = null
const PICKER_START_RESERVATION_MS = 5_000

const NO_MICROPHONE_LABEL = 'No microphone'
const NO_CAMERA_LABEL = 'No camera'
const SYSTEM_AUDIO_LABEL = 'System audio'
const NO_SYSTEM_AUDIO_LABEL = 'No system audio'

const NO_MICROPHONE_MENU_LABEL = "Don't record microphone"
const NO_CAMERA_MENU_LABEL = "Don't record camera"
const NO_SYSTEM_AUDIO_MENU_LABEL = "Don't record system audio"

const state: RecorderState = {
  status: 'idle',
  settings: {
    systemAudio: false,
    microphoneDeviceId: null,
    microphoneLabel: NO_MICROPHONE_LABEL,
    cameraDeviceId: null,
    cameraLabel: NO_CAMERA_LABEL,
    hideCameraPreview: false,
    systemAudioScope: 'all',
    systemAudioApplications: [],
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
  // structuredClone is ~5x faster than JSON round-tripping and handles
  // nested objects without dropping prototypes. Hot path: called on every
  // emit + every getState IPC.
  return structuredClone(state)
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

function clearPickerStartReservation(): void {
  pickerStartInFlight = false
  if (pickerStartReservationTimer) {
    clearTimeout(pickerStartReservationTimer)
    pickerStartReservationTimer = null
  }
}

export function reservePickerStart(): void {
  pickerStartInFlight = true
  if (pickerStartReservationTimer) clearTimeout(pickerStartReservationTimer)
  pickerStartReservationTimer = setTimeout(() => {
    pickerStartReservationTimer = null
    pickerStartInFlight = false
  }, PICKER_START_RESERVATION_MS)
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

// System audio is configured in three orthogonal pieces:
//  - selectSystemAudio: master on/off
//  - setSystemAudioScope: when on, capture from 'all' apps or 'selected' ones
//  - toggleSystemAudioApplication: when scope is 'selected', the membership of
//    the bundle-ID list
// All three use a looser gate than canChangeSettings — they configure the
// upcoming recording and should remain operable while the user is in a picker
// (pickerMode !== null), at which point canChangeSettings would otherwise
// refuse. 'idle' status is the right invariant.
function selectSystemAudio(enabled: boolean): void {
  if (state.status !== 'idle') return
  state.settings.systemAudio = enabled
  state.lastError = null
  emitState()
}

function setSystemAudioScope(scope: 'all' | 'selected'): void {
  if (state.status !== 'idle') return
  if (!state.settings.systemAudio) return
  state.settings.systemAudioScope = scope
  state.lastError = null
  emitState()
}

function toggleSystemAudioApplication(bundleId: string): void {
  if (state.status !== 'idle') return
  if (!state.settings.systemAudio) return
  if (state.settings.systemAudioScope !== 'selected') return
  if (!bundleId) return
  const current = state.settings.systemAudioApplications
  const index = current.indexOf(bundleId)
  state.settings.systemAudioApplications =
    index >= 0
      ? [...current.slice(0, index), ...current.slice(index + 1)]
      : [...current, bundleId]
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
      label: NO_MICROPHONE_MENU_LABEL,
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
      label: NO_CAMERA_MENU_LABEL,
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

interface SystemAudioMenuApp {
  bundleId: string
  applicationName: string
}

function systemAudioMenuTemplate(
  applications: SystemAudioMenuApp[],
): MenuItemConstructorOptions[] {
  // Looser enable gate than canChangeSettings: this menu is also opened while
  // a picker is active (pickerMode !== null), and the user should still be
  // able to configure audio for the upcoming recording in that state.
  const enabled = state.status === 'idle'
  const allChecked =
    state.settings.systemAudio && state.settings.systemAudioScope === 'all'
  const selectedChecked =
    state.settings.systemAudio && state.settings.systemAudioScope === 'selected'

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Record system audio from all apps',
      type: 'radio',
      checked: allChecked,
      enabled,
      click: () => {
        if (!state.settings.systemAudio) selectSystemAudio(true)
        setSystemAudioScope('all')
      },
    },
    {
      label: 'Record system audio from selected apps',
      type: 'radio',
      checked: selectedChecked,
      enabled,
      click: () => {
        if (!state.settings.systemAudio) selectSystemAudio(true)
        setSystemAudioScope('selected')
      },
    },
    { type: 'separator' },
    {
      label: NO_SYSTEM_AUDIO_MENU_LABEL,
      type: 'radio',
      checked: !state.settings.systemAudio,
      enabled,
      click: () => selectSystemAudio(false),
    },
  ]

  if (selectedChecked) {
    template.push({ type: 'separator' })
    if (applications.length === 0) {
      template.push({
        label: 'No running applications detected',
        enabled: false,
      })
    } else {
      // Sort by display name for a stable, scannable menu. The shareable-
      // content API returns apps in process order, which jumps around as
      // apps launch/quit.
      const sorted = [...applications].sort((a, b) =>
        a.applicationName.localeCompare(b.applicationName),
      )
      for (const app of sorted) {
        if (!app.bundleId) continue
        template.push({
          label: app.applicationName || app.bundleId,
          type: 'checkbox',
          checked: state.settings.systemAudioApplications.includes(app.bundleId),
          enabled,
          click: () => toggleSystemAudioApplication(app.bundleId),
        })
      }
    }
  }

  return template
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

function visibleAppsFromWindows(windows: WindowSource[]): SystemAudioMenuApp[] {
  // Dedupe by bundleId — multiple windows from the same app collapse to one
  // entry. The native `listVisibleWindows` already filters out system chrome
  // (Dock, Finder desktop, Window Manager, etc.) and the recorder's own
  // process, so we don't re-apply those exclusions here.
  const byBundle = new Map<string, SystemAudioMenuApp>()
  for (const window of windows) {
    if (!window.bundleId) continue
    if (byBundle.has(window.bundleId)) continue
    byBundle.set(window.bundleId, {
      bundleId: window.bundleId,
      applicationName: window.applicationName || window.bundleId,
    })
  }
  return Array.from(byBundle.values())
}

function showInputMenu(
  event: IpcMainInvokeEvent,
  kind: RecorderInputKind,
  anchor: unknown,
): RecorderState {
  if (kind === 'systemAudio') {
    // Build the per-app list from currently-visible windows rather than every
    // running process — apps without an on-screen window (background helpers,
    // menu-bar agents) aren't generally things a user thinks of as "the app
    // playing audio" and clutter the menu. listVisibleWindows is sync, so we
    // can keep the menu sync too.
    let applications: SystemAudioMenuApp[] = []
    if (process.platform === 'darwin') {
      try {
        applications = visibleAppsFromWindows(addon.listVisibleWindows(false))
      } catch (error) {
        state.lastError = errorMessage(error)
        emitState()
      }
    }
    popupMenu(event, systemAudioMenuTemplate(applications), anchor)
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
  // A picker confirm has reserved the start slot — defer generic (no-target)
  // starts so the picker's targeted start wins the race. The picker call
  // passes a target, so it bypasses this gate and consumes the reservation.
  if (!targetOverride && pickerStartInFlight) return publicState()
  if (state.status !== 'idle') return publicState()
  if (targetOverride && pickerStartInFlight) {
    clearPickerStartReservation()
  }
  // Picker mode is set by startPicker and cleared via finishPickerMode (called
  // from main.ts onPickerFinished). A generic start while a picker is open
  // would race the picker's confirm path; refuse it.
  if (!targetOverride && state.pickerMode !== null) return publicState()
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
    // 'selected' scope with an empty list means "no apps" — capture no system
    // audio. Translating that to recordSystemAudio:false avoids the native
    // codepath silently falling back to "all apps" when audioApplications is
    // empty (the native scoping block is gated on a non-empty bundle list).
    const systemAudioEnabled =
      state.settings.systemAudio &&
      !(
        state.settings.systemAudioScope === 'selected' &&
        state.settings.systemAudioApplications.length === 0
      )

    const options: StartRecordingOptions = {
      outputDir,
      target,
      fps: 60,
      includeCursor: true,
      excludeOwnApp: true,
      recordSystemAudio: systemAudioEnabled,
      recordMicrophone: state.settings.microphoneDeviceId !== null,
      microphoneDeviceId: state.settings.microphoneDeviceId ?? undefined,
      recordCamera: state.settings.cameraDeviceId !== null,
      cameraDeviceId: state.settings.cameraDeviceId ?? undefined,
    }
    // System audio scoping: when the user picks the 'selected' mode, send the
    // bundle IDs they've checked. 'all' mode and 'off' state both leave
    // audioApplications undefined. (Empty 'selected' is handled above by
    // turning off system audio outright, so the array here is non-empty.)
    if (systemAudioEnabled && state.settings.systemAudioScope === 'selected') {
      options.audioApplications = [...state.settings.systemAudioApplications]
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
  // Clear sessionId in finally regardless of cancel outcome: if the native
  // call rejects, the session is in an unknown state and any further
  // pause/resume/stop against the stale id will fail anyway. Forcing the
  // local state to "no session" lets the catch in the caller fall through to
  // 'idle' instead of leaving the UI claiming a session that no longer exists.
  // The directory removal stays in the success path — if cancel rejected,
  // the native writer may still be holding file handles inside outputDir and
  // racing the rmdir would risk a partial-delete or crash.
  try {
    await addon.cancelRecording(sessionId)
    removeRecordingDirectory(outputDir)
  } finally {
    state.sessionId = null
  }
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
    // discardActiveRecording's finally always clears state.sessionId, so a
    // null sessionId here means the cancel attempted to run; fall through to
    // idle. A non-null sessionId means we never reached the cancel call
    // (e.g., dialog was dismissed via throw) and the previous session is
    // still alive — preserve the previous status.
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
  if (mode !== 'display' && mode !== 'window' && mode !== 'region') {
    state.lastError = 'Unknown recording picker mode.'
    return emitState()
  }
  if (state.status !== 'idle') return publicState()
  if (!options.startPicker) {
    state.lastError = 'Recording picker is not available.'
    return emitState()
  }
  if (state.pickerMode === mode) {
    options.cancelPicker?.()
    state.pickerMode = null
    state.lastError = null
    return emitState()
  }

  try {
    state.pickerMode = mode
    state.lastError = null
    options.startPicker(mode)
    if (mode === 'region') {
      const recorder = options.getRecorderWindow()
      if (recorder && !recorder.isDestroyed()) recorder.hide()
    }
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

export function isRecordingActive(): boolean {
  return state.status === 'recording' || state.status === 'paused' || state.status === 'stopping'
}

// Drives the active recording to completion so files are finalized before the
// process exits. Used by main.ts on before-quit. Safe to call when no
// recording is active. If the recording is already stopping (another caller
// kicked off addon.stopRecording), waits up to 12 s for the state machine to
// transition out of 'stopping' rather than re-issuing the stop.
export async function flushActiveRecording(): Promise<void> {
  if (state.status === 'recording' || state.status === 'paused') {
    await stopRecording()
  }
  if (state.status !== 'stopping') return
  // Native cancel/stop bounds itself at 10 s (see RecorderSession stopSync /
  // cancelSync deadlines). Add a small margin on top.
  const deadline = Date.now() + 12_000
  while (state.status === 'stopping' && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  // Timed out waiting for the stop to finalize: the native side is wedged.
  // Escalate to cancel so we don't proceed to window-destroy / app-quit with
  // an orphan SCKit session still owning the camera / display capture.
  if (state.status === 'stopping' && state.sessionId) {
    try {
      await discardActiveRecording()
    } catch (error) {
      console.error('[recorder] flush escalation cancel failed', error)
    }
    state.status = 'idle'
  }
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
  ipcMain.handle('recorder:close', async (event) => {
    // Tearing the recorder bar down while a session is live orphans the native
    // recorder: files keep growing with no UI to stop them, and the only
    // remaining exit path (quit) used to lose the moov atom. Drive the
    // recording to completion first so the .mov / .m4a are finalized.
    if (isRecordingActive()) {
      await flushActiveRecording()
    }
    options.cancelPicker?.()
    finishPickerMode()
    const window = options.getRecorderWindow() ?? BrowserWindow.fromWebContents(event.sender)
    window?.close()
  })
}

export { NO_CAMERA_LABEL, NO_MICROPHONE_LABEL, NO_SYSTEM_AUDIO_LABEL, SYSTEM_AUDIO_LABEL }
