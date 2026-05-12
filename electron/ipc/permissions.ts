import { BrowserWindow, ipcMain } from 'electron'
import {
  askForAccessibilityAccess,
  askForCameraAccess,
  askForMicrophoneAccess,
  askForScreenCaptureAccess,
  getAuthStatus,
  type AuthType,
  type PermissionType,
} from 'node-mac-permissions'

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

interface PermissionHandlerOptions {
  openPermissionWindow: () => void
  closePermissionWindow: () => void
  ensureRecorderBarWindow: () => void
}

const REQUIRED_PERMISSIONS: RequiredMacPermissionKind[] = [
  'screen',
  'microphone',
  'camera',
  'accessibility',
]

let callbacks: PermissionHandlerOptions | null = null
let lastSnapshot: PermissionSnapshot | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let readyCloseTimer: ReturnType<typeof setTimeout> | null = null

function mapStatus(status: PermissionType | 'not determined'): MacPermissionState {
  if (status === 'authorized') return 'granted'
  if (status === 'not determined') return 'notDetermined'
  if (status === 'denied' || status === 'restricted') return status
  return 'unknown'
}

function authTypeForPermission(kind: RequiredMacPermissionKind): AuthType {
  return kind === 'screen' ? 'screen' : kind
}

function readStatus(kind: RequiredMacPermissionKind): MacPermissionState {
  try {
    return mapStatus(getAuthStatus(authTypeForPermission(kind)))
  } catch {
    return 'unknown'
  }
}

function snapshotChanged(a: PermissionSnapshot | null, b: PermissionSnapshot): boolean {
  if (!a) return true
  if (a.allGranted !== b.allGranted) return true
  return REQUIRED_PERMISSIONS.some((kind) => a.permissions[kind] !== b.permissions[kind])
}

function emitPermissionChange(snapshot: PermissionSnapshot, reason: string): void {
  console.log('[permissions] snapshot', {
    reason,
    allGranted: snapshot.allGranted,
    permissions: snapshot.permissions,
    missing: snapshot.missing,
  })

  const event: PermissionChangeEvent = { reason, snapshot }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('permissions:changed', event)
    }
  }
}

function handleSnapshot(snapshot: PermissionSnapshot): void {
  if (!callbacks) return

  if (snapshot.allGranted) {
    callbacks.ensureRecorderBarWindow()
    if (!readyCloseTimer) {
      readyCloseTimer = setTimeout(() => {
        readyCloseTimer = null
        callbacks?.closePermissionWindow()
        stopPermissionPolling()
      }, 1200)
    }
    return
  }

  if (readyCloseTimer) {
    clearTimeout(readyCloseTimer)
    readyCloseTimer = null
  }
}

export function getPermissionSnapshot(): PermissionSnapshot {
  const screen = readStatus('screen')
  const microphone = readStatus('microphone')
  const camera = readStatus('camera')
  const accessibility = readStatus('accessibility')
  const permissions: Record<MacPermissionKind, MacPermissionState> = {
    screen,
    microphone,
    camera,
    accessibility,
    systemAudio: screen,
  }
  const missing = REQUIRED_PERMISSIONS.filter((kind) => permissions[kind] !== 'granted')

  return {
    permissions,
    required: REQUIRED_PERMISSIONS,
    missing,
    allGranted: missing.length === 0,
    checkedAt: Date.now(),
  }
}

export function refreshPermissions(reason = 'refresh', force = false): PermissionSnapshot {
  const snapshot = getPermissionSnapshot()
  if (force || snapshotChanged(lastSnapshot, snapshot)) {
    emitPermissionChange(snapshot, reason)
  }
  lastSnapshot = snapshot
  handleSnapshot(snapshot)
  return snapshot
}

export function hasRequiredPermissions(): boolean {
  return getPermissionSnapshot().allGranted
}

export function startPermissionPolling(): void {
  if (pollTimer) return
  refreshPermissions('poll:start', true)
  pollTimer = setInterval(() => {
    refreshPermissions('poll')
  }, 1000)
}

export function stopPermissionPolling(): void {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

async function requestPermission(kind: MacPermissionKind): Promise<PermissionSnapshot> {
  const requestedKind = kind === 'systemAudio' ? 'screen' : kind

  try {
    if (requestedKind === 'screen') {
      askForScreenCaptureAccess(true)
    } else if (requestedKind === 'camera') {
      await askForCameraAccess()
    } else if (requestedKind === 'microphone') {
      await askForMicrophoneAccess()
    } else if (requestedKind === 'accessibility') {
      askForAccessibilityAccess()
    }
  } finally {
    startPermissionPolling()
  }

  return refreshPermissions(`request:${requestedKind}`, true)
}

async function requestAllPermissions(): Promise<PermissionSnapshot> {
  for (const kind of REQUIRED_PERMISSIONS) {
    const snapshot = getPermissionSnapshot()
    if (snapshot.permissions[kind] !== 'granted') {
      await requestPermission(kind)
    }
  }
  return refreshPermissions('request:all', true)
}

export function registerPermissionHandlers(options: PermissionHandlerOptions): void {
  callbacks = options

  ipcMain.handle('permissions:getStatus', () => refreshPermissions('ipc:getStatus', true))
  ipcMain.handle('permissions:request', (_event, kind: MacPermissionKind) =>
    requestPermission(kind),
  )
  ipcMain.handle('permissions:requestAll', () => requestAllPermissions())
  ipcMain.handle('permissions:openWindow', () => {
    options.openPermissionWindow()
    startPermissionPolling()
    return refreshPermissions('ipc:openWindow', true)
  })
  ipcMain.handle('permissions:closeWindow', () => {
    options.closePermissionWindow()
  })
}
