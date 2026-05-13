import { BrowserWindow, ipcMain } from 'electron'
import addon, {
  type PermissionKind,
  type RecordingEvent,
  type StartRecordingOptions,
} from '@openscreen/mac-addon'

interface RegisterMacAddonHandlersOptions {
  // Only the recorder bar surfaces recording events. Every other window we
  // own (camera, permission) ignores them, so broadcasting wakes context
  // isolation up for nothing on each frameDropped/error tick.
  getRecorderWindow: () => BrowserWindow | null
}

let unsubscribeNativeEvents: (() => void) | null = null
let getRecorderWindowRef: (() => BrowserWindow | null) | null = null
let didLogRecordingEventDeliveryError = false

function sendRecordingEvent(event: RecordingEvent): void {
  const target = getRecorderWindowRef?.()
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return

  try {
    target.webContents.send('macAddon:recordingEvent', event)
  } catch (error) {
    if (didLogRecordingEventDeliveryError) return
    didLogRecordingEventDeliveryError = true
    console.error('[macAddon] failed to deliver recording event', error)
  }
}

export function registerMacAddonHandlers(options: RegisterMacAddonHandlersOptions): void {
  getRecorderWindowRef = options.getRecorderWindow

  if (!unsubscribeNativeEvents) {
    unsubscribeNativeEvents = addon.onRecordingEvent(sendRecordingEvent)
  }

  ipcMain.handle('macAddon:hello', () => addon.hello())
  ipcMain.handle('macAddon:getCapabilities', () => addon.getCapabilities())
  ipcMain.handle('macAddon:getPermissions', () => addon.getPermissions())
  ipcMain.handle('macAddon:requestPermissions', (_event, kinds: PermissionKind[]) =>
    addon.requestPermissions(kinds),
  )
  ipcMain.handle('macAddon:listShareableContent', () => addon.listShareableContent())
  ipcMain.handle('macAddon:listCameras', () => addon.listCameras())
  ipcMain.handle('macAddon:listMicrophones', () => addon.listMicrophones())
  ipcMain.handle('macAddon:startRecording', (_event, options: StartRecordingOptions) =>
    addon.startRecording(options),
  )
  ipcMain.handle('macAddon:stopRecording', (_event, sessionId: string) =>
    addon.stopRecording(sessionId),
  )
  ipcMain.handle('macAddon:cancelRecording', (_event, sessionId: string) =>
    addon.cancelRecording(sessionId),
  )
}

// Release the native ThreadSafeFunction so its underlying worker thread exits
// cleanly. Without this, on macOS the process can sit for a beat at shutdown
// waiting for libuv to drain the TSFN.
export function disposeMacAddon(): void {
  if (unsubscribeNativeEvents) {
    unsubscribeNativeEvents()
    unsubscribeNativeEvents = null
  }
  getRecorderWindowRef = null
}
