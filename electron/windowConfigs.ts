import type { BrowserWindowConstructorOptions } from 'electron'

// webPreferences is excluded — it requires __dirname, so it's merged at creation time in main.ts.
export type WindowConfig = Omit<BrowserWindowConstructorOptions, 'x' | 'y' | 'webPreferences'>

// Shared options for the recorder bar across platforms.
const recorderBarBase: WindowConfig = {
  title: 'OpenScreen Recorder',
  width: 760,
  height: 52,
  minHeight: 52,
  maxHeight: 52,
  show: false,
  backgroundColor: '#00000000',
  alwaysOnTop: true,
  roundedCorners: true,
  hasShadow: true,
  fullscreen: false,
  fullscreenable: false,
  resizable: false,
  maximizable: false,
  minimizable: false,
  movable: true,
  acceptFirstMouse: true,
}

const permissionBase: WindowConfig = {
  title: 'OpenScreen Permissions',
  width: 380,
  height: 390,
  show: true,
  backgroundColor: '#00000000',
  alwaysOnTop: true,
  hasShadow: true,
  roundedCorners: true,
  fullscreen: false,
  fullscreenable: false,
  resizable: false,
  maximizable: false,
  minimizable: false,
  movable: true,
  acceptFirstMouse: true,
}

if (process.platform === 'darwin') {
  // titleBarStyle 'hidden' keeps a real titled NSWindow under the hood, so
  // AppKit draws the native rounded corners (system ~10pt), the hairline edge
  // border, and the native drop shadow. Traffic lights are hidden post-creation
  // via setWindowButtonVisibility(false). Do NOT set transparent:true or
  // frame:false here — both strip the native chrome.
  recorderBarBase.titleBarStyle = 'hidden'
  recorderBarBase.vibrancy = 'under-window'
  recorderBarBase.visualEffectState = 'active'
  permissionBase.titleBarStyle = 'hidden'
  permissionBase.vibrancy = 'under-window'
  permissionBase.visualEffectState = 'active'
} else {
  // Windows / Linux: no NSWindow chrome to inherit — go fully frameless and
  // transparent. backgroundMaterial 'acrylic' provides the native blur on
  // Windows 11 22H2+.
  recorderBarBase.frame = false
  recorderBarBase.transparent = true
  permissionBase.frame = false
  permissionBase.transparent = true
  if (process.platform === 'win32') {
    recorderBarBase.backgroundMaterial = 'acrylic'
    permissionBase.backgroundMaterial = 'acrylic'
  }
}

export const windowConfigs = {
  recorderBarWin: recorderBarBase,
  permissionWin: permissionBase,
}
