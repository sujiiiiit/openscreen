import { app, BrowserWindow, nativeTheme, net, protocol, screen, session, shell } from 'electron'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerMacAddonHandlers } from './ipc/mac-addon'
import {
  hasRequiredPermissions,
  refreshPermissions,
  registerPermissionHandlers,
  startPermissionPolling,
  stopPermissionPolling,
} from './ipc/permissions'
import { registerRecorderHandlers } from './ipc/recorder'
import { windowConfigs } from './windowConfigs'

const isDev = !app.isPackaged
let mainWin: BrowserWindow | null = null
let recorderBarWin: BrowserWindow | null = null
let permissionWin: BrowserWindow | null = null
const DEV_URL = 'http://localhost:3000'
const OUT_DIR = path.resolve(__dirname, '..', 'out')
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

function resolveAppFile(requestUrl: string): string | null {
  const pathname = decodeURIComponent(new URL(requestUrl).pathname)
  const rel = pathname.replace(/^\/+/, '') || 'index.html'
  const resolved = path.resolve(OUT_DIR, rel)
  if (resolved !== OUT_DIR && !resolved.startsWith(OUT_DIR + path.sep)) return null
  return resolved
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

function loadAppRoute(win: BrowserWindow, route: string): void {
  if (isDev) {
    void win.loadURL(`${DEV_URL}${route}`)
    return
  }

  const routePath = route.replace(/^\/+/, '')
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

  permissionWin.setAlwaysOnTop(true, 'modal-panel')
  permissionWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (process.platform === 'darwin') {
    permissionWin.setWindowButtonVisibility(false)
  }
  hardenWebContents(permissionWin)
  permissionWin.once('ready-to-show', () => {
    if (permissionWin) focusWindow(permissionWin)
  })
  permissionWin.webContents.on('did-finish-load', () => {
    console.log('[permissions] permission window loaded', {
      visible: permissionWin?.isVisible(),
      focused: permissionWin?.isFocused(),
      bounds: permissionWin?.getBounds(),
    })
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

  loadAppRoute(permissionWin, '/permissions')
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
  console.log('[permissions] gate snapshot', {
    reason,
    allGranted: snapshot.allGranted,
    permissions: snapshot.permissions,
    missing: snapshot.missing,
  })

  if (snapshot.allGranted) {
    closePermissionWindow()
    showRecorderWindowOnly()
  } else {
    hideMainWindow()
    hideRecorderBarWindow()
    hideNonPermissionWindows()
    createPermissionWindow()
  }
}

function showRecorderWindowOnly(): void {
  hideMainWindow()
  createRecorderBarWindow()
}

function createRecorderBarWindow(): void {
  if (!hasRequiredPermissions()) {
    createPermissionWindow()
    return
  }

  if (recorderBarWin && !recorderBarWin.isDestroyed()) {
    recorderBarWin.show()
    recorderBarWin.focus()
    return
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const winW = windowConfigs.recorderBarWin.width ?? 660
  const winH = windowConfigs.recorderBarWin.height ?? 52
  const x = Math.round((screenW - winW) / 2)
  const y = screenH - winH - 80

  recorderBarWin = new BrowserWindow({
    x,
    y,
    ...windowConfigs.recorderBarWin,
    webPreferences: SHARED_WEB_PREFERENCES,
  })

  recorderBarWin.setAlwaysOnTop(true, 'pop-up-menu')
  recorderBarWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (process.platform === 'darwin') {
    recorderBarWin.setWindowButtonVisibility(false)
  }
  hardenWebContents(recorderBarWin)
  recorderBarWin.once('ready-to-show', () => recorderBarWin?.show())
  recorderBarWin.on('closed', () => { recorderBarWin = null })

  loadAppRoute(recorderBarWin, '/recorder')
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
      if (!filePath) return new Response('Not Found', { status: 404 })
      return net.fetch(pathToFileURL(filePath).toString())
    })
  }

  registerMacAddonHandlers()
  registerPermissionHandlers({
    openPermissionWindow: createPermissionWindow,
    closePermissionWindow,
    ensureRecorderBarWindow: showRecorderWindowOnly,
  })
  registerRecorderHandlers({
    getRecorderWindow: () => recorderBarWin,
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
