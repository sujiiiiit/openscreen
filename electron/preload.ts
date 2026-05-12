import { contextBridge, ipcRenderer } from 'electron'
import type {
  PermissionKind,
  RecordingEvent,
  StartRecordingOptions,
} from '@openscreen/mac-addon'
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
  macAddon: {
    hello: (): Promise<string> => ipcRenderer.invoke('macAddon:hello'),
    getCapabilities: () => ipcRenderer.invoke('macAddon:getCapabilities'),
    getPermissions: () => ipcRenderer.invoke('macAddon:getPermissions'),
    requestPermissions: (kinds: PermissionKind[]) =>
      ipcRenderer.invoke('macAddon:requestPermissions', kinds),
    listShareableContent: () => ipcRenderer.invoke('macAddon:listShareableContent'),
    listCameras: () => ipcRenderer.invoke('macAddon:listCameras'),
    listMicrophones: () => ipcRenderer.invoke('macAddon:listMicrophones'),
    startRecording: (options: StartRecordingOptions) =>
      ipcRenderer.invoke('macAddon:startRecording', options),
    stopRecording: (sessionId: string) =>
      ipcRenderer.invoke('macAddon:stopRecording', sessionId),
    cancelRecording: (sessionId: string) =>
      ipcRenderer.invoke('macAddon:cancelRecording', sessionId),
    onRecordingEvent: (callback: (event: RecordingEvent) => void) =>
      subscribe<RecordingEvent>('macAddon:recordingEvent', callback),
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
