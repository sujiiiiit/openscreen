import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  macAddon: {
    hello: (): Promise<string> => ipcRenderer.invoke('macAddon:hello'),
  },
})
