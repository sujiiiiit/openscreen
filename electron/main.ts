import { app, BrowserWindow, dialog, nativeTheme, net, protocol, screen, session, shell } from 'electron'
import addon from '@openscreen/mac-addon'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  startCameraPreview as startNativeCameraPreview,
  stopCameraPreview as stopNativeCameraPreview,
} from './ipc/camera-preview'
import { disposeMacAddon, registerMacAddonHandlers } from './ipc/mac-addon'
import {
  hasRequiredPermissions,
  refreshPermissions,
  registerPermissionHandlers,
  startPermissionPolling,
  stopPermissionPolling,
} from './ipc/permissions'
import {
  finishPickerMode,
  flushActiveRecording,
  getLatestRecordingDir,
  isRecordingActive,
  registerRecorderHandlers,
  reservePickerStart,
  startRecording,
} from './ipc/recorder'
import {
  projectsRoot,
  registerProjectsHandlers,
  setActiveProjectFromFolder,
} from './ipc/projects'
import {
  disposeExportPendingPayload,
  registerExportHandlers,
} from './ipc/export'
import {
  clearLockedRegionOverlay,
  disposeWindowPicker,
  registerWindowPickerHandlers,
  startWindowPicker,
  cancelWindowPicker,
} from './ipc/window-picker'
import {
  registerWindowControlHandlers,
  watchMainWindowState,
} from './ipc/window-controls'
import { subscribeActiveSpaceChange } from './mac-spaces'
import { windowConfigs } from './windowConfigs'

const isDev = !app.isPackaged
let mainWin: BrowserWindow | null = null
let recorderBarWin: BrowserWindow | null = null
let recordingControlsWin: BrowserWindow | null = null
let cameraWin: BrowserWindow | null = null
let permissionWin: BrowserWindow | null = null
let recordingSettingsWin: BrowserWindow | null = null
let exportWin: BrowserWindow | null = null
let activeCameraDeviceId: string | null = null
const fixedWindowSizeEnforcers = new WeakMap<BrowserWindow, () => void>()
const zoomLockedWindows = new WeakSet<BrowserWindow>()
const DEV_URL = 'http://localhost:3535'
const OUT_DIR = path.resolve(__dirname, '..', 'out')
type AlwaysOnTopLevel = NonNullable<Parameters<BrowserWindow['setAlwaysOnTop']>[1]>
interface WorkspacePinOptions {
  level?: AlwaysOnTopLevel
  relativeLevel?: number
}

const workspacePinnedWindows = new Map<BrowserWindow, WorkspacePinOptions>()
const workspacePinCleanups = new WeakMap<BrowserWindow, () => void>()
const workspacePinTimers = new WeakMap<BrowserWindow, ReturnType<typeof setTimeout>>()
let unsubscribeLiveWindowSpaceChange: (() => void) | null = null

const SHARED_WEB_PREFERENCES = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const
const CSP_BASE = [
  "default-src 'self' app:",
  "script-src 'self' app:",
  "style-src 'self' app: 'unsafe-inline'",
  "img-src 'self' app: file: data: blob:",
  "media-src 'self' app: file: blob:",
  "font-src 'self' app: data:",
  "connect-src 'self' app:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ')

// Relaxed CSP applied ONLY to the export window. Mediabunny's UrlSource
// uses `fetch(file://…)` under the hood to stream-decode local recording
// files (both video frame slices and audio). Every other window stays on
// the tighter CSP_BASE so this loosening doesn't widen the attack surface
// of the rest of the app. The renderer is still sandboxed + contextIsolated
// + nodeIntegration:false, and `file:` was already reachable via media-src
// for the editor's <video> elements — connect-src just lets Mediabunny's
// JS fetch the same URLs.
const CSP_EXPORT = CSP_BASE.replace(
  "connect-src 'self' app:",
  "connect-src 'self' app: file:",
)

if (!isDev) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ])
}

// Allowlist of static-asset extensions Next.js emits to `out/`. Restricting
// the app:// protocol to these prevents a renderer (or a navigation in one)
// from pulling anything else that may sit alongside the bundle — e.g. a
// stray map file, a packaged preload script, or an internal manifest.
const APP_PROTOCOL_ALLOWED_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.map',
  '.json',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.txt',
])

function resolveAppFile(requestUrl: string): string | null {
  // new URL() throws on malformed input; decodeURIComponent throws on bad
  // percent-encoding. Return null so the protocol handler maps it to a 400
  // rather than letting Electron surface an opaque 500.
  try {
    const pathname = decodeURIComponent(new URL(requestUrl).pathname)
    const rel = pathname.replace(/^\/+/, '') || 'index.html'
    const resolved = path.resolve(OUT_DIR, rel)
    if (resolved !== OUT_DIR && !resolved.startsWith(OUT_DIR + path.sep)) return null
    const ext = path.extname(resolved).toLowerCase()
    if (ext && !APP_PROTOCOL_ALLOWED_EXTENSIONS.has(ext)) return null
    return resolved
  } catch {
    return null
  }
}

function hardenWebContents(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith('app://')
    if (!allowed) event.preventDefault()
  })
}

function lockWindowZoom(win: BrowserWindow): void {
  if (zoomLockedWindows.has(win)) return
  zoomLockedWindows.add(win)

  const contents = win.webContents
  const resetZoom = () => {
    if (contents.isDestroyed()) return
    contents.setZoomLevel(0)
    contents.setZoomFactor(1)
  }

  resetZoom()
  void contents.setVisualZoomLevelLimits(1, 1).catch(() => {})
  contents.on('did-finish-load', resetZoom)
  contents.on('zoom-changed', (event) => {
    event.preventDefault()
    resetZoom()
  })
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || (!input.control && !input.meta)) return
    const key = input.key.toLowerCase()
    const isZoomShortcut =
      key === '+' ||
      key === '=' ||
      key === '-' ||
      key === '_' ||
      key === '0' ||
      input.code === 'NumpadAdd' ||
      input.code === 'NumpadSubtract' ||
      input.code === 'Numpad0'

    if (isZoomShortcut) {
      event.preventDefault()
      resetZoom()
    }
  })
}

function createMainWindow(): void {
  if (!hasRequiredPermissions()) {
    createPermissionWindow()
    return
  }

  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show()
    mainWin.focus()
    return
  }

  const isMac = process.platform === 'darwin'
  mainWin = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#000000',
    // webSecurity is relaxed on the editor window only so <video> tags can
    // play local recording assets via file:// URLs. The renderer keeps
    // sandbox/contextIsolation/nodeIntegration locked down, so even with
    // same-origin relaxed it cannot reach Node APIs. Other windows (recorder
    // bar, controls, camera preview, permission gate) keep the default
    // hardened SHARED_WEB_PREFERENCES.
    webPreferences: { ...SHARED_WEB_PREFERENCES, webSecurity: false },
    // Custom titlebar: macOS keeps native traffic lights (hidden chrome,
    // repositioned to align with the 40px React header), Windows/Linux drop
    // the frame entirely and render min/maximize/close buttons in React.
    ...(isMac
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 14 } }
      : { frame: false }),
  })
  watchMainWindowState(mainWin)

  mainWin.once('ready-to-show', () => {
    if (hasRequiredPermissions()) {
      mainWin?.show()
    }
  })
  mainWin.on('closed', () => { mainWin = null })
  hardenWebContents(mainWin)

  if (isDev) {
    void mainWin.loadURL(DEV_URL)
    mainWin.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWin.loadURL('app://./index.html')
  }
}

function hideMainWindow(): void {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.hide()
  }
}

async function pickAndOpenProjectInEditor(): Promise<void> {
  const parent =
    recorderBarWin && !recorderBarWin.isDestroyed() ? recorderBarWin : null
  const dialogOptions: Electron.OpenDialogOptions = {
    title: 'Open project',
    defaultPath: projectsRoot(),
    properties: ['openDirectory'],
    buttonLabel: 'Open',
  }
  const result = parent
    ? await dialog.showOpenDialog(parent, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  if (result.canceled || result.filePaths.length === 0) return

  const folder = result.filePaths[0]
  const opened = await setActiveProjectFromFolder(folder)
  if (!opened) {
    const message: Electron.MessageBoxOptions = {
      type: 'error',
      message: 'That folder is not an OpenScreen project.',
      detail:
        'A project folder must contain a recording.json manifest. Pick the folder created when you stopped a recording.',
      buttons: ['OK'],
    }
    if (parent) {
      await dialog.showMessageBox(parent, message)
    } else {
      await dialog.showMessageBox(message)
    }
    return
  }

  // Switching into the editor mirrors the post-recording transition:
  // tear down the recorder bar (and camera preview) and hand the user the
  // main window, which will boot via projects:getLatest and pick up the
  // override we just set.
  closeRecorderBarWindow()
  createMainWindow()
}

function hideRecorderBarWindow(): void {
  if (recorderBarWin && !recorderBarWin.isDestroyed()) {
    recorderBarWin.hide()
  }
}

function hideCameraWindow(): void {
  closeCameraWindow()
}

function closeRecorderBarWindow(): void {
  const win = recorderBarWin
  // Drop the module ref synchronously — the 'closed' listener also nulls it
  // and closes the camera window, but a follow-up showRecorderWindowOnly
  // call must not see a stale, closing reference.
  recorderBarWin = null
  if (win && !win.isDestroyed()) {
    win.close()
  }
}

function closeCameraWindow(): void {
  activeCameraDeviceId = null
  stopNativeCameraPreview()
  const win = cameraWin
  // Drop the module reference synchronously so a follow-up showCameraWindow
  // call doesn't try to reuse the closing window. The captured `win` is what
  // we actually wait on closing.
  cameraWin = null
  if (win && !win.isDestroyed()) {
    win.close()
  }
}

function startCameraPreviewForCurrentWindow(deviceId: string): void {
  startNativeCameraPreview(deviceId, {
    getCameraWindow: () => cameraWin,
    onStartError: (message) => {
      const win = cameraWin
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('cameraPreview:error', message)
      }
    },
  })
}

function showCameraWindow(deviceId: string): void {
  if (!hasRequiredPermissions()) return
  activeCameraDeviceId = deviceId
  if (!cameraWin || cameraWin.isDestroyed()) {
    createCameraWindow(deviceId)
    return
  }
  if (!cameraWin.isVisible()) {
    cameraWin.show()
  }
  startCameraPreviewForCurrentWindow(deviceId)
}

function createCameraWindow(deviceId: string): void {
  if (cameraWin && !cameraWin.isDestroyed()) {
    keepWindowOnEveryWorkspace(cameraWin, { level: 'screen-saver', relativeLevel: 2 })
    if (!cameraWin.isVisible()) cameraWin.show()
    startCameraPreviewForCurrentWindow(deviceId)
    return
  }

  const { x: workX, y: workY, height: workH } = screen.getPrimaryDisplay().workArea
  const winH = windowConfigs.cameraWin.height ?? 240
  const margin = 20
  const x = workX + margin
  const y = workY + workH - winH - margin

  const win = new BrowserWindow({
    x,
    y,
    ...windowConfigs.cameraWin,
    webPreferences: { ...SHARED_WEB_PREFERENCES, devTools: false },
  })
  cameraWin = win

  keepWindowOnEveryWorkspace(win, { level: 'screen-saver', relativeLevel: 2 })
  win.setAspectRatio(1)
  if (process.platform === 'darwin') {
    win.setWindowButtonVisibility(false)
  }
  hardenWebContents(win)
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })
  win.webContents.once('did-finish-load', () => {
    if (isDev) {
      console.log('[cameraPreview/main] camera window loaded, starting preview', {
        deviceId: activeCameraDeviceId,
      })
    }
    // Only start the preview if this is still the active window. A rapid
    // camera off→on cycle creates a new window before the old one's load
    // completes; the old finish-load callback must not start a preview tied
    // to the new window's device id.
    if (cameraWin === win && activeCameraDeviceId) {
      startCameraPreviewForCurrentWindow(activeCameraDeviceId)
    }
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, url) => {
    console.error('[cameraPreview/main] camera window did-fail-load', {
      errorCode,
      errorDescription,
      url,
    })
  })
  win.on('closed', () => {
    // Guard against clobbering a successor window. closeCameraWindow drops
    // the module reference synchronously, then close() runs async — by the
    // time this 'closed' fires, cameraWin may already point at a newer
    // BrowserWindow with its own active preview that we must not touch.
    if (cameraWin === win) {
      cameraWin = null
      activeCameraDeviceId = null
      stopNativeCameraPreview()
    }
  })

  loadAppRoute(win, '/camera/')
}

function hideNonPermissionWindows(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (permissionWin && win.id === permissionWin.id) continue
    win.hide()
  }
}

function focusWindow(win: BrowserWindow): void {
  if (process.platform === 'darwin') {
    app.dock?.show()
    app.focus({ steal: true })
  }
  win.show()
  win.focus()
  win.moveTop()
}

function applyWindowWorkspacePin(
  win: BrowserWindow,
  options: WorkspacePinOptions,
): void {
  if (win.isDestroyed()) return

  if (options.level) {
    win.setAlwaysOnTop(true, options.level, options.relativeLevel ?? 0)
  }
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })
  if (process.platform === 'darwin' && typeof addon.pinWindowAcrossSpaces === 'function') {
    try {
      addon.pinWindowAcrossSpaces(win.getNativeWindowHandle())
    } catch {
      // Native handles can disappear while Electron is tearing a window down.
    }
  }
  if (win.isVisible()) {
    win.moveTop()
  }
}

function scheduleWindowWorkspacePin(win: BrowserWindow): void {
  const options = workspacePinnedWindows.get(win)
  if (!options || win.isDestroyed()) return

  const existingTimer = workspacePinTimers.get(win)
  if (existingTimer) clearTimeout(existingTimer)

  const timer = setTimeout(() => {
    workspacePinTimers.delete(win)
    const latestOptions = workspacePinnedWindows.get(win)
    if (latestOptions) applyWindowWorkspacePin(win, latestOptions)
  }, 0)
  workspacePinTimers.set(win, timer)
}

function ensureLiveWindowSpaceTracking(): void {
  if (unsubscribeLiveWindowSpaceChange || process.platform !== 'darwin') return
  unsubscribeLiveWindowSpaceChange = subscribeActiveSpaceChange(() => {
    for (const win of workspacePinnedWindows.keys()) {
      if (win.isDestroyed()) {
        workspacePinnedWindows.delete(win)
        continue
      }
      scheduleWindowWorkspacePin(win)
    }
    releaseLiveWindowSpaceTrackingIfIdle()
  })
}

function releaseLiveWindowSpaceTrackingIfIdle(): void {
  if (workspacePinnedWindows.size > 0) return
  unsubscribeLiveWindowSpaceChange?.()
  unsubscribeLiveWindowSpaceChange = null
}

function watchWorkspacePinnedWindow(win: BrowserWindow): void {
  if (workspacePinCleanups.has(win)) return

  const contents = win.webContents
  const reapply = () => scheduleWindowWorkspacePin(win)
  const cleanup = () => {
    win.off('show', reapply)
    win.off('move', reapply)
    win.off('resize', reapply)
    if (!contents.isDestroyed()) {
      contents.off('did-finish-load', reapply)
    }
    workspacePinnedWindows.delete(win)
    const timer = workspacePinTimers.get(win)
    if (timer) clearTimeout(timer)
    workspacePinTimers.delete(win)
    workspacePinCleanups.delete(win)
    releaseLiveWindowSpaceTrackingIfIdle()
  }

  workspacePinCleanups.set(win, cleanup)
  win.on('show', reapply)
  win.on('move', reapply)
  win.on('resize', reapply)
  contents.on('did-finish-load', reapply)
  win.once('closed', cleanup)
}

function keepWindowOnEveryWorkspace(
  win: BrowserWindow,
  options: WorkspacePinOptions = {},
): void {
  workspacePinnedWindows.set(win, options)
  watchWorkspacePinnedWindow(win)
  ensureLiveWindowSpaceTracking()
  applyWindowWorkspacePin(win, options)
}

function keepRecorderBarOnTop(win: BrowserWindow): void {
  keepWindowOnEveryWorkspace(win, { level: 'screen-saver', relativeLevel: 3 })
}

function enforceFixedWindowSize(win: BrowserWindow, width: number, height: number): void {
  const existingEnforcer = fixedWindowSizeEnforcers.get(win)
  if (existingEnforcer) {
    existingEnforcer()
    return
  }

  const enforce = () => {
    if (win.isDestroyed()) return
    const [currentWidth, currentHeight] = win.getSize()
    if (currentWidth !== width || currentHeight !== height) {
      win.setSize(width, height, false)
    }
  }

  win.setMinimumSize(width, height)
  win.setMaximumSize(width, height)
  win.setResizable(false)
  fixedWindowSizeEnforcers.set(win, enforce)
  enforce()
  win.on('resize', enforce)
  win.on('show', enforce)
  win.webContents.on('did-finish-load', enforce)
}

function loadAppRoute(win: BrowserWindow, route: string): void {
  lockWindowZoom(win)

  if (isDev) {
    void win.loadURL(`${DEV_URL}${route}`)
    return
  }

  // Normalize route: strip leading/trailing slashes for consistent path construction
  const routePath = route.replace(/^\/+|\/+$/g, '')
  const target = routePath ? `app://./${routePath}/index.html` : 'app://./index.html'
  void win.loadURL(target)
}

function createPermissionWindow(): void {
  hideMainWindow()
  hideRecorderBarWindow()

  if (permissionWin && !permissionWin.isDestroyed()) {
    focusWindow(permissionWin)
    startPermissionPolling()
    return
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const winW = windowConfigs.permissionWin.width ?? 560
  const winH = windowConfigs.permissionWin.height ?? 640
  const x = Math.round((screenW - winW) / 2)
  const y = Math.round((screenH - winH) / 2)

  permissionWin = new BrowserWindow({
    x,
    y,
    ...windowConfigs.permissionWin,
    show: true,
    webPreferences: SHARED_WEB_PREFERENCES,
  })

  keepWindowOnEveryWorkspace(permissionWin, { level: 'modal-panel' })
  if (process.platform === 'darwin') {
    permissionWin.setWindowButtonVisibility(false)
  }
  hardenWebContents(permissionWin)
  permissionWin.once('ready-to-show', () => {
    if (permissionWin) focusWindow(permissionWin)
  })
  permissionWin.webContents.on('did-finish-load', () => {
    if (isDev) {
      console.log('[permissions] permission window loaded', {
        visible: permissionWin?.isVisible(),
        focused: permissionWin?.isFocused(),
        bounds: permissionWin?.getBounds(),
      })
    }
    if (permissionWin) focusWindow(permissionWin)
  })
  permissionWin.webContents.on('did-fail-load', (_event, errorCode, errorDescription, url) => {
    console.error('[permissions] permission window failed to load', {
      errorCode,
      errorDescription,
      url,
    })
  })
  permissionWin.on('closed', () => {
    permissionWin = null
    stopPermissionPolling()
  })

  loadAppRoute(permissionWin, '/permissions/')
  focusWindow(permissionWin)
  hideNonPermissionWindows()
  startPermissionPolling()
}

function closePermissionWindow(): void {
  if (permissionWin && !permissionWin.isDestroyed()) {
    permissionWin.close()
  }
  permissionWin = null
  stopPermissionPolling()
}

function createExportWindow(): void {
  if (exportWin && !exportWin.isDestroyed()) {
    if (exportWin.isMinimized()) exportWin.restore()
    exportWin.show()
    exportWin.focus()
    return
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const winW = windowConfigs.exportWin.width ?? 480
  const winH = windowConfigs.exportWin.height ?? 560
  const x = Math.round((screenW - winW) / 2)
  const y = Math.round((screenH - winH) / 2)

  exportWin = new BrowserWindow({
    x,
    y,
    ...windowConfigs.exportWin,
    // Same relaxation as the editor: <video> elements need to load the
    // project's recording assets from file:// URLs cross-origin (the page
    // itself is served from app:// in prod, http://localhost:3535 in dev).
    // Without webSecurity:false the load fails with a SecurityError and
    // any later canvas.drawImage(video, …) would taint the canvas, killing
    // Mediabunny's `new VideoFrame(canvas, …)` call. Sandbox /
    // contextIsolation / nodeIntegration stay locked down via
    // SHARED_WEB_PREFERENCES.
    webPreferences: { ...SHARED_WEB_PREFERENCES, webSecurity: false },
  })
  if (process.platform === 'darwin') {
    exportWin.setWindowButtonVisibility(false)
  }
  hardenWebContents(exportWin)
  // Intentionally NOT calling keepWindowOnEveryWorkspace — the export
  // window behaves like a normal app window: minimisable, ordinary z-order,
  // doesn't float over the user's other apps during a long encode.

  exportWin.once('ready-to-show', () => {
    if (exportWin) focusWindow(exportWin)
  })
  exportWin.on('closed', () => {
    exportWin = null
    disposeExportPendingPayload()
    // Editor window must always come back when the export window goes away,
    // even on an unexpected close (OS quit, devtools), so the user is never
    // stranded without a visible window.
    if (mainWin && !mainWin.isDestroyed() && !mainWin.isVisible()) {
      mainWin.show()
      mainWin.focus()
    }
  })

  loadAppRoute(exportWin, '/export/')
}

function closeExportWindow(): void {
  if (exportWin && !exportWin.isDestroyed()) {
    exportWin.close()
  }
  exportWin = null
}

function showEditorWindow(): void {
  if (mainWin && !mainWin.isDestroyed() && !mainWin.isVisible()) {
    mainWin.show()
    mainWin.focus()
  }
}

function createRecordingSettingsWindow(): void {
  if (recordingSettingsWin && !recordingSettingsWin.isDestroyed()) {
    if (recordingSettingsWin.isMinimized()) recordingSettingsWin.restore()
    recordingSettingsWin.show()
    recordingSettingsWin.focus()
    return
  }

  // Center over the workspace, slightly above the recorder bar so the
  // settings panel feels anchored to its trigger.
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const winW = windowConfigs.recordingSettingsWin.width ?? 480
  const winH = windowConfigs.recordingSettingsWin.height ?? 640
  const x = Math.round((screenW - winW) / 2)
  const y = Math.round((screenH - winH) / 2)

  recordingSettingsWin = new BrowserWindow({
    x,
    y,
    ...windowConfigs.recordingSettingsWin,
    webPreferences: SHARED_WEB_PREFERENCES,
  })
  if (process.platform === 'darwin') {
    recordingSettingsWin.setWindowButtonVisibility(false)
  }
  hardenWebContents(recordingSettingsWin)
  // Keep on top across Spaces; recording-quality is a transient utility window
  // and shouldn't get lost behind the recorder bar / picker.
  keepWindowOnEveryWorkspace(recordingSettingsWin, { level: 'modal-panel' })

  recordingSettingsWin.once('ready-to-show', () => {
    if (recordingSettingsWin) focusWindow(recordingSettingsWin)
  })
  recordingSettingsWin.on('closed', () => {
    recordingSettingsWin = null
  })

  loadAppRoute(recordingSettingsWin, '/recording-settings/')
}

function showPermissionGate(reason: string): void {
  const snapshot = refreshPermissions(reason, true)
  if (isDev) {
    console.log('[permissions] gate snapshot', {
      reason,
      allGranted: snapshot.allGranted,
      permissions: snapshot.permissions,
      missing: snapshot.missing,
    })
  }

  if (snapshot.allGranted) {
    closePermissionWindow()
    showRecorderWindowOnly()
  } else {
    hideMainWindow()
    hideRecorderBarWindow()
    hideCameraWindow()
    hideNonPermissionWindows()
    createPermissionWindow()
  }
}

function showRecorderWindowOnly(): void {
  hideMainWindow()
  createRecorderBarWindow()
}

function showRecordingControlsWindow(): void {
  const winW = windowConfigs.recordingControlsWin.width ?? 240
  const winH = windowConfigs.recordingControlsWin.height ?? 52

  if (recordingControlsWin && !recordingControlsWin.isDestroyed()) {
    enforceFixedWindowSize(recordingControlsWin, winW, winH)
    if (!recordingControlsWin.isVisible()) recordingControlsWin.show()
    keepRecorderBarOnTop(recordingControlsWin)
    enforceFixedWindowSize(recordingControlsWin, winW, winH)
    return
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const x = Math.round((screenW - winW) / 2)
  const y = screenH - winH - 80

  recordingControlsWin = new BrowserWindow({
    x,
    y,
    ...windowConfigs.recordingControlsWin,
    webPreferences: SHARED_WEB_PREFERENCES,
  })

  keepRecorderBarOnTop(recordingControlsWin)
  enforceFixedWindowSize(recordingControlsWin, winW, winH)
  if (process.platform === 'darwin') {
    recordingControlsWin.setWindowButtonVisibility(false)
  }
  hardenWebContents(recordingControlsWin)
  recordingControlsWin.once('ready-to-show', () => {
    if (recordingControlsWin) {
      enforceFixedWindowSize(recordingControlsWin, winW, winH)
      recordingControlsWin.showInactive()
    }
  })
  recordingControlsWin.on('closed', () => {
    recordingControlsWin = null
  })

  loadAppRoute(recordingControlsWin, '/recording-controls/')
}

function hideRecordingControlsWindow(): void {
  if (!recordingControlsWin || recordingControlsWin.isDestroyed()) return
  recordingControlsWin.close()
  recordingControlsWin = null
}

function createRecorderBarWindow(): void {
  if (!hasRequiredPermissions()) {
    createPermissionWindow()
    return
  }

  // Kick off an async SCShareableContent fetch now so the user's eventual
  // click on "Start recording" doesn't pay the 500ms–1s cold-call wait. The
  // native cache is short-TTL and gracefully re-fetches if a freshly-opened
  // window misses, so prewarming is always safe.
  if (process.platform === 'darwin') {
    try {
      addon.prewarmShareableContent()
    } catch {
      // Older addon builds won't have this export — non-fatal.
    }
  }

  const winW = windowConfigs.recorderBarWin.width ?? 660
  const winH = windowConfigs.recorderBarWin.height ?? 52

  if (recorderBarWin && !recorderBarWin.isDestroyed()) {
    enforceFixedWindowSize(recorderBarWin, winW, winH)
    keepRecorderBarOnTop(recorderBarWin)
    enforceFixedWindowSize(recorderBarWin, winW, winH)
    focusWindow(recorderBarWin)
    enforceFixedWindowSize(recorderBarWin, winW, winH)
    return
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const x = Math.round((screenW - winW) / 2)
  const y = screenH - winH - 80

  recorderBarWin = new BrowserWindow({
    x,
    y,
    ...windowConfigs.recorderBarWin,
    webPreferences: { ...SHARED_WEB_PREFERENCES, devTools: false },
  })

  keepRecorderBarOnTop(recorderBarWin)
  enforceFixedWindowSize(recorderBarWin, winW, winH)
  if (process.platform === 'darwin') {
    recorderBarWin.setWindowButtonVisibility(false)
  }
  hardenWebContents(recorderBarWin)
  recorderBarWin.once('ready-to-show', () => {
    if (recorderBarWin) focusWindow(recorderBarWin)
  })
  recorderBarWin.on('closed', () => {
    recorderBarWin = null
    closeCameraWindow()
  })

  loadAppRoute(recorderBarWin, '/recorder/')
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'

  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // Per-window CSP: only the export window gets the file:-permitted
      // policy; everything else stays on the base CSP. `webContentsId` is
      // present on requests originating from a renderer; protocol-handler
      // requests that happen before any renderer attaches simply hit the
      // base policy.
      const fromExport =
        typeof details.webContentsId === 'number' &&
        exportWin !== null &&
        !exportWin.isDestroyed() &&
        exportWin.webContents.id === details.webContentsId
      const csp = fromExport ? CSP_EXPORT : CSP_BASE
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
      })
    })

    protocol.handle('app', async (req) => {
      const filePath = resolveAppFile(req.url)
      if (!filePath) return new Response('Bad Request', { status: 400 })
      return net.fetch(pathToFileURL(filePath).toString())
    })
  }

  registerMacAddonHandlers({ getRecorderWindow: () => recorderBarWin })
  registerWindowControlHandlers(() => mainWin)
  registerPermissionHandlers({
    openPermissionWindow: createPermissionWindow,
    closePermissionWindow,
    ensureRecorderBarWindow: showRecorderWindowOnly,
    getPermissionWindow: () => permissionWin,
  })
  registerRecorderHandlers({
    getRecorderWindow: () => recorderBarWin,
    getControlsWindow: () => recordingControlsWin,
    onCameraPreviewChanged: (deviceId) => {
      if (deviceId) {
        showCameraWindow(deviceId)
      } else {
        hideCameraWindow()
      }
    },
    startPicker: startWindowPicker,
    cancelPicker: cancelWindowPicker,
    openRecordingSettingsWindow: createRecordingSettingsWindow,
    openProjectFromDialog: () => {
      void pickAndOpenProjectInEditor()
    },
    onStatusChanged: (status, snapshot) => {
      if (status === 'recording' || status === 'paused') {
        hideRecorderBarWindow()
        showRecordingControlsWindow()
      } else if (status === 'idle') {
        clearLockedRegionOverlay()
        hideRecordingControlsWindow()
        // A non-null lastResult marks a successful stop (discard / cancel paths
        // null it out via resetDiscardedRecording). On success, tear the
        // recorder + camera windows down and surface the main window so the
        // user lands on their recordings instead of another empty bar.
        if (snapshot.lastResult) {
          // Pin the just-recorded folder as the sticky active project so a
          // window refresh after recording still lands on it (instead of
          // an older project the user previously chose via "Open project…").
          if (snapshot.outputDir) {
            void setActiveProjectFromFolder(snapshot.outputDir)
          }
          closeRecorderBarWindow()
          createMainWindow()
        } else {
          showRecorderWindowOnly()
        }
      }
      // 'starting' and 'stopping' are transitional — leave window state as-is
      // so we don't blink the bar in and out of existence.
    },
  })
  registerProjectsHandlers({
    getMainWindow: () => mainWin,
    getLatestRecordingDir,
  })
  registerWindowPickerHandlers({
    webPreferences: SHARED_WEB_PREFERENCES,
    loadAppRoute,
    showRecorderWindow: showRecorderWindowOnly,
    onPickerFinished: finishPickerMode,
    reservePickerStart,
    startRecordingForTarget: async (target) => {
      await startRecording(target)
    },
  })
  registerExportHandlers({
    getExportWindow: () => exportWin,
    getEditorWindow: () => mainWin,
    openExportWindow: createExportWindow,
    closeExportWindow,
    hideEditorWindow: hideMainWindow,
    showEditorWindow,
  })
  showPermissionGate('startup')

  app.on('activate', () => {
    const snapshot = refreshPermissions('app:activate', true)
    if (!snapshot.allGranted) {
      createPermissionWindow()
      return
    }
    // Dock activation should re-surface whatever window the user was already
    // looking at — it's a "bring app forward" gesture, not a "reset the UI"
    // gesture. A live main window (post-recording) wins; otherwise the
    // recorder bar if it's still alive; otherwise cold-start the recorder bar.
    if (mainWin && !mainWin.isDestroyed()) {
      if (!mainWin.isVisible()) mainWin.show()
      mainWin.focus()
      return
    }
    if (recorderBarWin && !recorderBarWin.isDestroyed()) {
      focusWindow(recorderBarWin)
      return
    }
    showRecorderWindowOnly()
  })
})

// Two-phase quit: when a recording is active, prevent the immediate exit,
// drive the recorder to a clean stop (so AVAssetWriter writes its moov atom
// and the .mov / .m4a files are playable), then re-issue app.quit() which
// fires before-quit again with quitInProgress=true to bypass this guard.
let quitInProgress = false
app.on('before-quit', (event) => {
  if (quitInProgress || !isRecordingActive()) {
    disposeWindowPicker()
    stopNativeCameraPreview()
    disposeMacAddon()
    return
  }
  event.preventDefault()
  quitInProgress = true
  void flushActiveRecording()
    .catch((error) => {
      console.error('[main] failed to flush recording on quit', error)
    })
    .finally(() => {
      app.quit()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
