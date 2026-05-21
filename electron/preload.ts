import { contextBridge, ipcRenderer } from 'electron'
import type { CameraPreviewFrame } from '@openscreen/mac-addon'
import type { MacPermissionKind, PermissionChangeEvent } from './ipc/permissions'
import type {
  RecorderInputKind,
  RecorderMenuAnchor,
  RecorderPickerMode,
  RecorderState,
  RecordingQualitySettings,
} from './ipc/recorder'
import type {
  PickerOverlayTarget,
  RegionSelectionBounds,
  RegionSelectionResult,
  WindowPickerSession,
} from './ipc/window-picker'
import type { ProjectSummary } from './ipc/projects'
import type {
  WindowStateChange,
  WindowStateSnapshot,
} from './ipc/window-controls'

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
    showSettingsMenu: (anchor: RecorderMenuAnchor): Promise<RecorderState> =>
      ipcRenderer.invoke('recorder:showSettingsMenu', anchor),
    startPicker: (mode: RecorderPickerMode): Promise<RecorderState> =>
      ipcRenderer.invoke('recorder:startPicker', mode),
    cancelPicker: (): Promise<RecorderState> => ipcRenderer.invoke('recorder:cancelPicker'),
    start: (): Promise<RecorderState> => ipcRenderer.invoke('recorder:start'),
    stop: (): Promise<RecorderState> => ipcRenderer.invoke('recorder:stop'),
    pause: (): Promise<RecorderState> => ipcRenderer.invoke('recorder:pause'),
    resume: (): Promise<RecorderState> => ipcRenderer.invoke('recorder:resume'),
    restart: (): Promise<RecorderState> => ipcRenderer.invoke('recorder:restart'),
    delete: (): Promise<RecorderState> => ipcRenderer.invoke('recorder:delete'),
    close: (): Promise<void> => ipcRenderer.invoke('recorder:close'),
    onChanged: (callback: (state: RecorderState) => void) =>
      subscribe<RecorderState>('recorder:changed', callback),
    getRecordingSettings: (): Promise<RecordingQualitySettings> =>
      ipcRenderer.invoke('recorder:getRecordingSettings'),
    setRecordingSettings: (
      patch: Partial<RecordingQualitySettings>,
    ): Promise<RecordingQualitySettings> =>
      ipcRenderer.invoke('recorder:setRecordingSettings', patch),
    openRecordingSettings: (): Promise<void> =>
      ipcRenderer.invoke('recorder:openRecordingSettings'),
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
  platform: process.platform as NodeJS.Platform,
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    maximize: (): void => ipcRenderer.send('window:maximize'),
    close: (): void => ipcRenderer.send('window:close'),
    getState: (): Promise<WindowStateSnapshot> => ipcRenderer.invoke('window:getState'),
    onStateChanged: (callback: (state: WindowStateChange) => void) =>
      subscribe<WindowStateChange>('window:stateChanged', callback),
  },
  projects: {
    getLatest: (): Promise<ProjectSummary | null> =>
      ipcRenderer.invoke('projects:getLatest'),
    open: (folderPath: string): Promise<ProjectSummary | null> =>
      ipcRenderer.invoke('projects:open', folderPath),
    pickAndOpen: (): Promise<ProjectSummary | null> =>
      ipcRenderer.invoke('projects:pickAndOpen'),
  },
  windowPicker: {
    confirm: (): Promise<void> => ipcRenderer.invoke('windowPicker:confirm'),
    cancel: (): Promise<void> => ipcRenderer.invoke('windowPicker:cancel'),
    setInteractive: (interactive: boolean): Promise<void> =>
      ipcRenderer.invoke('windowPicker:setInteractive', interactive),
    getCurrentTarget: (): Promise<PickerOverlayTarget | null> =>
      ipcRenderer.invoke('windowPicker:getCurrentTarget'),
    getSession: (): Promise<WindowPickerSession> =>
      ipcRenderer.invoke('windowPicker:getSession'),
    setRegionSelection: (
      bounds: RegionSelectionBounds | null,
    ): Promise<RegionSelectionResult> =>
      ipcRenderer.invoke('windowPicker:setRegionSelection', bounds),
    onTargetChanged: (callback: (target: PickerOverlayTarget | null) => void) =>
      subscribe<PickerOverlayTarget | null>('windowPicker:targetChanged', callback),
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
