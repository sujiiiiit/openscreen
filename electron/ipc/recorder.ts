import {
  BrowserWindow,
  Menu,
  app,
  ipcMain,
  screen,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import { mkdirSync } from 'node:fs'
import * as path from 'node:path'
import addon, {
  type AudioDevice,
  type CameraDevice,
  type RecordingFiles,
  type RecordingResult,
  type StartRecordingOptions,
} from '@openscreen/mac-addon'

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
  platform: NodeJS.Platform
}

interface RegisterRecorderHandlersOptions {
  getRecorderWindow: () => BrowserWindow | null
  onCameraSelectionChanged?: (deviceId: string | null) => void
}

let cameraSelectionListener: ((deviceId: string | null) => void) | null = null
let getRecorderWindowRef: (() => BrowserWindow | null) | null = null

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
  },
  sessionId: null,
  outputDir: null,
  activeFiles: null,
  lastResult: null,
  lastError: null,
  platform: process.platform,
}

function publicState(): RecorderState {
  return JSON.parse(JSON.stringify(state)) as RecorderState
}

function emitState(): RecorderState {
  const snapshot = publicState()
  const target = getRecorderWindowRef?.()
  if (target && !target.isDestroyed()) {
    target.webContents.send('recorder:changed', snapshot)
  }
  return snapshot
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function timestampFolderName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function outputDirectory(): string {
  const root = path.join(app.getPath('documents'), 'openscreen')
  mkdirSync(root, { recursive: true })
  return path.join(root, timestampFolderName())
}

function canChangeSettings(): boolean {
  return state.status === 'idle'
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

function notifyCameraSelectionChanged(cameraChanged: boolean): void {
  if (cameraChanged && cameraSelectionListener) {
    cameraSelectionListener(state.settings.cameraDeviceId)
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
  const previousDeviceId = state.settings.cameraDeviceId
  const nextDeviceId = device?.deviceId ?? null
  state.settings.cameraDeviceId = nextDeviceId
  state.settings.cameraLabel = device ? deviceLabel(device) : NO_CAMERA_LABEL
  state.lastError = null
  emitState()
  if (cameraSelectionListener && previousDeviceId !== nextDeviceId) {
    cameraSelectionListener(nextDeviceId)
  }
}

function selectSystemAudio(enabled: boolean): void {
  if (!canChangeSettings()) return
  state.settings.systemAudio = enabled
  state.lastError = null
  emitState()
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
    const { microphones, cameras, changed, cameraChanged } = refreshSelectedDevices()
    if (changed) emitState()
    notifyCameraSelectionChanged(cameraChanged)
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

async function startRecording(): Promise<RecorderState> {
  if (state.status !== 'idle') return publicState()
  if (process.platform !== 'darwin') {
    state.lastError = 'Screen recording is only available on macOS in this build.'
    return emitState()
  }

  state.status = 'starting'
  state.lastError = null
  state.lastResult = null
  emitState()

  try {
    const { changed, cameraChanged } = refreshSelectedDevices()
    if (changed) emitState()
    notifyCameraSelectionChanged(cameraChanged)

    const outputDir = outputDirectory()
    const options: StartRecordingOptions = {
      outputDir,
      target: {
        type: 'display',
        displayId: screen.getPrimaryDisplay().id,
      },
      fps: 30,
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
    state.lastError = null
  } catch (error) {
    state.status = 'idle'
    state.sessionId = null
    state.outputDir = null
    state.activeFiles = null
    state.lastError = errorMessage(error)
  }

  return emitState()
}

async function stopRecording(): Promise<RecorderState> {
  if (state.status !== 'recording' || !state.sessionId) return publicState()

  const sessionId = state.sessionId
  state.status = 'stopping'
  state.lastError = null
  emitState()

  try {
    const result = await addon.stopRecording(sessionId)
    state.status = 'idle'
    state.sessionId = null
    state.activeFiles = null
    state.outputDir = result.files.manifest
      ? path.dirname(result.files.manifest)
      : state.outputDir
    state.lastResult = result
    state.lastError = null
  } catch (error) {
    state.status = 'recording'
    state.lastError = errorMessage(error)
  }

  return emitState()
}

export function registerRecorderHandlers(options: RegisterRecorderHandlersOptions): void {
  cameraSelectionListener = options.onCameraSelectionChanged ?? null
  getRecorderWindowRef = options.getRecorderWindow
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
  ipcMain.handle('recorder:start', () => startRecording())
  ipcMain.handle('recorder:stop', () => stopRecording())
  ipcMain.handle('recorder:close', (event) => {
    const window = options.getRecorderWindow() ?? BrowserWindow.fromWebContents(event.sender)
    window?.close()
  })
}

export { NO_CAMERA_LABEL, NO_MICROPHONE_LABEL, NO_SYSTEM_AUDIO_LABEL, SYSTEM_AUDIO_LABEL }
