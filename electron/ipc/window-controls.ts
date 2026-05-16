import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'

// IMPORTANT: renderer-facing payloads are mirrored in `types/api.d.ts`.
// Edits here MUST be reflected there.
export interface WindowStateSnapshot {
  platform: NodeJS.Platform
  isMaximized: boolean
  isFullScreen: boolean
}

export interface WindowStateChange {
  isMaximized: boolean
  isFullScreen: boolean
}

function winOf(
  event: IpcMainEvent | IpcMainInvokeEvent,
  fallback: () => BrowserWindow | null,
): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender) ?? fallback()
}

export function registerWindowControlHandlers(
  getMainWindow: () => BrowserWindow | null,
): void {
  ipcMain.on('window:minimize', (event) => {
    winOf(event, getMainWindow)?.minimize()
  })
  ipcMain.on('window:maximize', (event) => {
    const win = winOf(event, getMainWindow)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (event) => {
    winOf(event, getMainWindow)?.close()
  })
  ipcMain.handle('window:getState', (event): WindowStateSnapshot => {
    const win = winOf(event, getMainWindow)
    return {
      platform: process.platform,
      isMaximized: win?.isMaximized() ?? false,
      isFullScreen: win?.isFullScreen() ?? false,
    }
  })
}

export function watchMainWindowState(win: BrowserWindow): void {
  const emit = () => {
    if (win.isDestroyed()) return
    const payload: WindowStateChange = {
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen(),
    }
    win.webContents.send('window:stateChanged', payload)
  }
  win.on('maximize', emit)
  win.on('unmaximize', emit)
  win.on('enter-full-screen', emit)
  win.on('leave-full-screen', emit)
}
