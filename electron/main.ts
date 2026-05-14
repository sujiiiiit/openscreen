import { app, BrowserWindow, nativeTheme, net, protocol, screen, session, shell } from 'electron'
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
  registerRecorderHandlers,
  startRecording,
} from './ipc/recorder'
import {
  clearLockedRegionOverlay,
  disposeWindowPicker,
  registerWindowPickerHandlers,
  startWindowPicker,
  cancelWindowPicker,
} from './ipc/window-picker'
import { subscribeActiveSpaceChange } from './mac-spaces'
import { windowConfigs } from './windowConfigs'

const isDev = !app.isPackaged
let mainWin: BrowserWindow | null = null
let recorderBarWin: BrowserWindow | null = null
let recordingControlsWin: BrowserWindow | null = null
let cameraWin: BrowserWindow | null = null
let permissionWin: BrowserWindow | null = null
let activeCameraDeviceId: string | null = null
const fixedWindowSizeEnforcers = new WeakMap<BrowserWindow, () => void>()
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
const CSP = [
  "default-src 'self' app:",
  "script-src 'self' app:",
  "style-src 'self' app: 'unsafe-inline'",
  "img-src 'self' app: data:",
  "font-src 'self' app: data:",
  "connect-src 'self' app:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ')

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

  mainWin = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#000000',
    webPreferences: SHARED_WEB_PREFERENCES,
  })

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

function hideRecorderBarWindow(): void {
  if (recorderBarWin && !recorderBarWin.isDestroyed()) {
    recorderBarWin.hide()
  }
}

function hideCameraWindow(): void {
  closeCameraWindow()
}

function closeCameraWindow(): void {
  activeCameraDeviceId = null
  stopNativeCameraPreview()
  if (cameraWin && !cameraWin.isDestroyed()) {
    cameraWin.close()
  }
  cameraWin = null
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

  cameraWin = new BrowserWindow({
    x,
    y,
    ...windowConfigs.cameraWin,
    webPreferences: SHARED_WEB_PREFERENCES,
  })

  keepWindowOnEveryWorkspace(cameraWin, { level: 'screen-saver', relativeLevel: 2 })
  cameraWin.setAspectRatio(1)
  if (process.platform === 'darwin') {
    cameraWin.setWindowButtonVisibility(false)
  }
  hardenWebContents(cameraWin)
  cameraWin.once('ready-to-show', () => {
    cameraWin?.show()
  })
  cameraWin.webContents.once('did-finish-load', () => {
    if (isDev) {
      console.log('[cameraPreview/main] camera window loaded, starting preview', {
        deviceId: activeCameraDeviceId,
      })
    }
    if (activeCameraDeviceId) {
      startCameraPreviewForCurrentWindow(activeCameraDeviceId)
    }
  })
  cameraWin.webContents.on('did-fail-load', (_event, errorCode, errorDescription, url) => {
    console.error('[cameraPreview/main] camera window did-fail-load', {
      errorCode,
      errorDescription,
      url,
    })
  })
  cameraWin.on('closed', () => {
    cameraWin = null
    activeCameraDeviceId = null
    stopNativeCameraPreview()
  })

  if (isDev) {
    cameraWin.webContents.openDevTools({ mode: 'detach' })
  }

  loadAppRoute(cameraWin, '/camera/')
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
    webPreferences: SHARED_WEB_PREFERENCES,
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
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] },
      })
    })

    protocol.handle('app', async (req) => {
      const filePath = resolveAppFile(req.url)
      if (!filePath) return new Response('Bad Request', { status: 400 })
      return net.fetch(pathToFileURL(filePath).toString())
    })
  }

  registerMacAddonHandlers({ getRecorderWindow: () => recorderBarWin })
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
    onStatusChanged: (status) => {
      if (status === 'recording' || status === 'paused') {
        hideRecorderBarWindow()
        showRecordingControlsWindow()
      } else if (status === 'idle') {
        clearLockedRegionOverlay()
        hideRecordingControlsWindow()
        showRecorderWindowOnly()
      }
      // 'starting' and 'stopping' are transitional — leave window state as-is
      // so we don't blink the bar in and out of existence.
    },
  })
  registerWindowPickerHandlers({
    webPreferences: SHARED_WEB_PREFERENCES,
    loadAppRoute,
    showRecorderWindow: showRecorderWindowOnly,
    onPickerFinished: finishPickerMode,
    startRecordingForTarget: async (target) => {
      await startRecording(target)
    },
  })
  showPermissionGate('startup')

  app.on('activate', () => {
    const snapshot = refreshPermissions('app:activate', true)
    if (snapshot.allGranted) {
      showRecorderWindowOnly()
    } else {
      createPermissionWindow()
    }
  })
})

app.on('before-quit', () => {
  disposeWindowPicker()
  stopNativeCameraPreview()
  disposeMacAddon()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
