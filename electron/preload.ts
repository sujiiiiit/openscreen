import { contextBridge, ipcRenderer } from 'electron'
import type { CameraPreviewFrame } from '@openscreen/mac-addon'
import type { MacPermissionKind, PermissionChangeEvent } from './ipc/permissions'
import type {
  RecorderInputKind,
  RecorderMenuAnchor,
  RecorderState,
} from './ipc/recorder'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  recorder: {
    getState: (): Promise<RecorderState> => ipcRenderer.invoke('recorder:getState'),
    showInputMenu: (kind: RecorderInputKind, anchor: RecorderMenuAnchor) =>
      ipcRenderer.invoke('recorder:showInputMenu', kind, anchor),
    start: (): Promise<RecorderState> => ipcRenderer.invoke('recorder:start'),
    stop: (): Promise<RecorderState> => ipcRenderer.invoke('recorder:stop'),
    close: (): Promise<void> => ipcRenderer.invoke('recorder:close'),
    onChanged: (callback: (state: RecorderState) => void) =>
      subscribe<RecorderState>('recorder:changed', callback),
  },
  permissions: {
    getStatus: () => ipcRenderer.invoke('permissions:getStatus'),
    request: (kind: MacPermissionKind) => ipcRenderer.invoke('permissions:request', kind),
    requestAll: () => ipcRenderer.invoke('permissions:requestAll'),
    openWindow: () => ipcRenderer.invoke('permissions:openWindow'),
    closeWindow: (): Promise<void> => ipcRenderer.invoke('permissions:closeWindow'),
    onChanged: (callback: (event: PermissionChangeEvent) => void) =>
      subscribe<PermissionChangeEvent>('permissions:changed', callback),
  },
  cameraPreview: {
    onFrame: (callback: (frame: CameraPreviewFrame) => void) =>
      subscribe<CameraPreviewFrame>('cameraPreview:frame', callback),
    onError: (callback: (message: string) => void) =>
      subscribe<string>('cameraPreview:error', callback),
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
