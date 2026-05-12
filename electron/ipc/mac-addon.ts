import { ipcMain } from 'electron'
import addon from '@openscreen/mac-addon'

export function registerMacAddonHandlers(): void {
  ipcMain.handle('macAddon:hello', () => addon.hello())
}
