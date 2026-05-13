import { contextBridge, ipcRenderer } from 'electron'
import type {
  CameraPreviewFrame,
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

let didLogFirstPreloadFrame = false

function subscribeToCameraPreview(
  callback: (frame: CameraPreviewFrame) => void,
): () => void {
  console.log('[cameraPreview/preload] subscribing to cameraPreview:frame')
  const listener = (_event: Electron.IpcRendererEvent, frame: CameraPreviewFrame) => {
    if (!didLogFirstPreloadFrame) {
      didLogFirstPreloadFrame = true
      const data = frame.data as unknown as { byteLength?: number; length?: number } | undefined
      console.log('[cameraPreview/preload] first frame arrived in renderer process', {
        width: frame.width,
        height: frame.height,
        dataKind: data?.constructor?.name ?? typeof data,
        byteLength: data?.byteLength ?? data?.length,
      })
    }
    callback(frame)
  }
  ipcRenderer.on('cameraPreview:frame', listener)
  return () => {
    didLogFirstPreloadFrame = false
    ipcRenderer.removeListener('cameraPreview:frame', listener)
  }
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
      subscribeToCameraPreview(callback),
    onError: (callback: (message: string) => void) =>
      subscribe<string>('cameraPreview:error', callback),
    signalReady: (): Promise<boolean> =>
      ipcRenderer.invoke('cameraPreview:rendererReady'),
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
