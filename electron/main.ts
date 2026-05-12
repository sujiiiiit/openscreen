import { app, BrowserWindow, net, protocol, session, shell } from 'electron'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerMacAddonHandlers } from './ipc/mac-addon'

const isDev = !app.isPackaged
const DEV_URL = 'http://localhost:3000'
const OUT_DIR = path.resolve(__dirname, '..', 'out')
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
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())
  hardenWebContents(win)

  if (isDev) {
    void win.loadURL(DEV_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadURL('app://./index.html')
  }
}

app.whenReady().then(() => {
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
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
