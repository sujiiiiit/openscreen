import { BrowserWindow, ipcMain } from 'electron'
import addon, {
  type PermissionKind,
  type RecordingEvent,
  type StartRecordingOptions,
} from '@openscreen/mac-addon'

let unsubscribeNativeEvents: (() => void) | null = null

function broadcastRecordingEvent(event: RecordingEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('macAddon:recordingEvent', event)
    }
  }
}

export function registerMacAddonHandlers(): void {
  if (!unsubscribeNativeEvents) {
    unsubscribeNativeEvents = addon.onRecordingEvent(broadcastRecordingEvent)
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
