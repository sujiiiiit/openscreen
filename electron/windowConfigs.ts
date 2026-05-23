import type { BrowserWindowConstructorOptions } from 'electron'

// webPreferences is excluded — it requires __dirname, so it's merged at creation time in main.ts.
export type WindowConfig = Omit<BrowserWindowConstructorOptions, 'x' | 'y' | 'webPreferences'>

// Shared options for the recorder bar across platforms.
const recorderBarBase: WindowConfig = {
  title: 'OpenScreen Recorder',
  width: 665,
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

// Compact floating panel shown while a recording is in progress. Replaces
// the full recorder bar; has Stop, Pause/Resume, and a live timer.
const recordingControlsBase: WindowConfig = {
  title: 'OpenScreen Recording',
  width: 240,
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
  skipTaskbar: true,
}

const cameraBase: WindowConfig = {
  title: 'OpenScreen Camera',
  width: 240,
  height: 240,
  minWidth: 140,
  minHeight: 140,
  show: false,
  backgroundColor: '#00000000',
  alwaysOnTop: true,
  roundedCorners: true,
  hasShadow: true,
  fullscreen: false,
  fullscreenable: false,
  resizable: true,
  maximizable: false,
  minimizable: false,
  movable: true,
  acceptFirstMouse: true,
  skipTaskbar: true,
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

// Recording Quality settings window. Triggered from the recorder bar's
// settings menu ("Recording quality…"). Modal-ish floating panel large
// enough for codec / quality / container / HDR / alpha controls + a live
// bitrate preview.
const recordingSettingsBase: WindowConfig = {
  title: 'Recording Quality',
  width: 480,
  height: 640,
  show: false,
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

// Export window. Triggered from the editor titlebar's Export button. Hosts
// the settings form (resolution / format / fps) and swaps to a progress +
// cancel view during encode. Same vibrancy panel chrome as the permission
// and Recording Quality windows so the three feel like one family of
// utility surfaces — but unlike those, the export window is NOT
// alwaysOnTop: a long export shouldn't sit over the user's other work
// while they wait, and the window is a regular minimisable surface.
const exportBase: WindowConfig = {
  title: 'Export',
  width: 560,
  height: 280,
  show: false,
  backgroundColor: '#00000000',
  alwaysOnTop: false,
  hasShadow: true,
  roundedCorners: true,
  fullscreen: false,
  fullscreenable: false,
  resizable: false,
  maximizable: false,
  minimizable: true,
  movable: true,
  acceptFirstMouse: true,
}

const windowPickerBase: WindowConfig = {
  title: 'OpenScreen Picker',
  width: 1,
  height: 1,
  show: false,
  backgroundColor: '#00000000',
  alwaysOnTop: true,
  roundedCorners: false,
  hasShadow: false,
  fullscreen: false,
  fullscreenable: false,
  resizable: false,
  maximizable: false,
  minimizable: false,
  movable: false,
  acceptFirstMouse: true,
  skipTaskbar: true,
  frame: false,
  transparent: true,
}

if (process.platform === 'darwin') {
  // NSPanel doesn't become the main window and reliably honors
  // NSWindowCollectionBehaviorCanJoinAllSpaces, so the overlay follows the
  // user across Spaces and fullscreen apps instead of staying behind on the
  // Space where it was first shown. window-picker.ts also drives the full
  // collectionBehavior mask via addon.pinWindowAcrossSpaces() after
  // setAlwaysOnTop, since AppKit clears that mask on level changes,
  // setBounds, and some show/hide transitions. Leaving these panels focusable
  // matters: a non-focusable NSPanel doesn't always get full Space-routing
  // treatment from AppKit. The picker gates clicks via setIgnoreMouseEvents;
  // recorder, recording controls, and camera keep normal click handling.
  recorderBarBase.type = 'panel'
  recordingControlsBase.type = 'panel'
  cameraBase.type = 'panel'
  windowPickerBase.type = 'panel'
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
  recordingControlsBase.titleBarStyle = 'hidden'
  recordingControlsBase.vibrancy = 'under-window'
  recordingControlsBase.visualEffectState = 'active'
  permissionBase.titleBarStyle = 'hidden'
  permissionBase.vibrancy = 'under-window'
  permissionBase.visualEffectState = 'active'
  cameraBase.titleBarStyle = 'hidden'
  cameraBase.vibrancy = 'under-window'
  cameraBase.visualEffectState = 'active'
  recordingSettingsBase.titleBarStyle = 'hidden'
  recordingSettingsBase.vibrancy = 'under-window'
  recordingSettingsBase.visualEffectState = 'active'
  exportBase.titleBarStyle = 'hidden'
  exportBase.vibrancy = 'under-window'
  exportBase.visualEffectState = 'active'
} else {
  // Windows / Linux: no NSWindow chrome to inherit — go fully frameless and
  // transparent. backgroundMaterial 'acrylic' provides the native blur on
  // Windows 11 22H2+.
  recorderBarBase.frame = false
  recorderBarBase.transparent = true
  recordingControlsBase.frame = false
  recordingControlsBase.transparent = true
  permissionBase.frame = false
  permissionBase.transparent = true
  cameraBase.frame = false
  cameraBase.transparent = true
  recordingSettingsBase.frame = false
  recordingSettingsBase.transparent = true
  exportBase.frame = false
  exportBase.transparent = true
  if (process.platform === 'win32') {
    recorderBarBase.backgroundMaterial = 'acrylic'
    recordingControlsBase.backgroundMaterial = 'acrylic'
    permissionBase.backgroundMaterial = 'acrylic'
    cameraBase.backgroundMaterial = 'acrylic'
    recordingSettingsBase.backgroundMaterial = 'acrylic'
    exportBase.backgroundMaterial = 'acrylic'
  }
}

export const windowConfigs = {
  recorderBarWin: recorderBarBase,
  recordingControlsWin: recordingControlsBase,
  permissionWin: permissionBase,
  cameraWin: cameraBase,
  windowPickerWin: windowPickerBase,
  recordingSettingsWin: recordingSettingsBase,
  exportWin: exportBase,
}
