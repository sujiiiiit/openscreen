import {
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  type BrowserWindowConstructorOptions,
  type Display,
  type Point,
  type Rectangle,
  type WebContents,
} from 'electron'
import addon, {
  type CaptureTarget,
  type WindowSource,
} from '@openscreen/mac-addon'
import { windowConfigs } from '../windowConfigs'
import type { RecorderPickerMode } from './recorder'

export interface PickerOverlayTarget {
  mode: RecorderPickerMode
  title: string
  sizeLabel: string
  modeLabel: string
  bounds: Rectangle
  iconDataUrl?: string
  target: CaptureTarget
}

interface RegisterWindowPickerOptions {
  webPreferences: BrowserWindowConstructorOptions['webPreferences']
  loadAppRoute: (window: BrowserWindow, route: string) => void
  showRecorderWindow: () => void
  startRecordingForTarget: (target: CaptureTarget) => Promise<void>
  onPickerFinished: () => void
}

interface ActivePickerTarget extends PickerOverlayTarget {
  displayId: number
}

const CONTROL_ZONE_WIDTH = 420
const CONTROL_ZONE_TOP_OFFSET = 18
const CONTROL_ZONE_HEIGHT = 205
const PICKER_POLL_INTERVAL_MS = 32
const STATIONARY_REVALIDATE_MS = 300

let options: RegisterWindowPickerOptions | null = null
let overlayWin: BrowserWindow | null = null
let pickerMode: RecorderPickerMode | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let activeTarget: ActivePickerTarget | null = null
let lastTargetKey = ''
let lastCursorKey = ''
let lastResolvedAt = 0
let cachedVirtualBounds: Rectangle | null = null
let overlayBoundsDirty = true
let overlayIgnoresMouse: boolean | null = null
let confirming = false
let displayListenersRegistered = false
let spaceChangeRegistered = false

const windowIconCache = new Map<number, string | null>()

function roundedBounds(bounds: Rectangle): Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  }
}

function boundsKey(bounds: Rectangle): string {
  return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
}

function pointForBounds(bounds: Rectangle): Point {
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  }
}

function displayForBounds(bounds: Rectangle): Display {
  return screen.getDisplayNearestPoint(pointForBounds(bounds))
}

function virtualDesktopBounds(): Rectangle {
  if (cachedVirtualBounds) return cachedVirtualBounds

  const displays = screen.getAllDisplays()
  if (displays.length === 0) {
    cachedVirtualBounds = roundedBounds(screen.getPrimaryDisplay().bounds)
    return cachedVirtualBounds
  }

  let minX = displays[0].bounds.x
  let minY = displays[0].bounds.y
  let maxX = displays[0].bounds.x + displays[0].bounds.width
  let maxY = displays[0].bounds.y + displays[0].bounds.height

  for (const display of displays.slice(1)) {
    minX = Math.min(minX, display.bounds.x)
    minY = Math.min(minY, display.bounds.y)
    maxX = Math.max(maxX, display.bounds.x + display.bounds.width)
    maxY = Math.max(maxY, display.bounds.y + display.bounds.height)
  }

  cachedVirtualBounds = roundedBounds({
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  })
  return cachedVirtualBounds
}

function windowBounds(source: WindowSource): Rectangle {
  return roundedBounds({
    x: source.x,
    y: source.y,
    width: source.width,
    height: source.height,
  })
}

function displayBounds(display: Display): Rectangle {
  return roundedBounds(display.bounds)
}

function windowPickerTarget(source: WindowSource): ActivePickerTarget {
  const bounds = windowBounds(source)
  const display = displayForBounds(bounds)
  const title = source.applicationName || source.title || 'Window'
  return {
    mode: 'window',
    title,
    sizeLabel: `${Math.round(source.width)} × ${Math.round(source.height)}`,
    modeLabel: 'Resize',
    iconDataUrl: source.iconDataUrl,
    bounds,
    displayId: display.id,
    target: {
      type: 'window',
      windowId: source.windowId,
      title: source.title,
      applicationName: source.applicationName,
      bundleId: source.bundleId,
      processId: source.processId,
      x: source.x,
      y: source.y,
      width: source.width,
      height: source.height,
    },
  }
}

function displayPickerTarget(): ActivePickerTarget {
  const cursor = screen.getCursorScreenPoint()
  const electronDisplay = screen.getDisplayNearestPoint(cursor)
  const bounds = displayBounds(electronDisplay)
  const width = Math.round(bounds.width * electronDisplay.scaleFactor)
  const height = Math.round(bounds.height * electronDisplay.scaleFactor)
  return {
    mode: 'display',
    title: 'Display',
    sizeLabel: `${Math.round(width)} × ${Math.round(height)}`,
    modeLabel: 'Full screen',
    bounds,
    displayId: electronDisplay.id,
    target: {
      type: 'display',
      displayId: electronDisplay.id,
      title: 'Display',
      applicationName: 'Display',
      x: bounds.x,
      y: bounds.y,
      width,
      height,
    },
  }
}

function targetKey(target: ActivePickerTarget): string {
  const id = target.target.type === 'window'
    ? target.target.windowId
    : target.target.displayId
  return `${target.mode}:${id}:${boundsKey(target.bounds)}:${target.sizeLabel}`
}

function targetPayload(target: ActivePickerTarget): PickerOverlayTarget {
  const overlayBounds = overlayWin && !overlayWin.isDestroyed()
    ? overlayWin.getBounds()
    : virtualDesktopBounds()
  return {
    mode: target.mode,
    title: target.title,
    sizeLabel: target.sizeLabel,
    modeLabel: target.modeLabel,
    bounds: roundedBounds({
      x: target.bounds.x - overlayBounds.x,
      y: target.bounds.y - overlayBounds.y,
      width: target.bounds.width,
      height: target.bounds.height,
    }),
    iconDataUrl: target.iconDataUrl,
    target: target.target,
  }
}

function cursorIsInControlZone(target: ActivePickerTarget): boolean {
  const cursor = screen.getCursorScreenPoint()
  const centerX = target.bounds.x + target.bounds.width / 2
  const centerY = target.bounds.y + target.bounds.height / 2
  const left = centerX - CONTROL_ZONE_WIDTH / 2
  const top = centerY + CONTROL_ZONE_TOP_OFFSET
  return cursor.x >= left &&
    cursor.x <= left + CONTROL_ZONE_WIDTH &&
    cursor.y >= top &&
    cursor.y <= top + CONTROL_ZONE_HEIGHT
}

function setOverlayIgnoresMouse(overlay: BrowserWindow, ignore: boolean): void {
  if (overlayIgnoresMouse === ignore) return
  overlayIgnoresMouse = ignore
  overlay.setIgnoreMouseEvents(ignore, { forward: true })
}

function updateOverlayInteractivity(
  overlay: BrowserWindow,
  target: ActivePickerTarget,
): void {
  setOverlayIgnoresMouse(overlay, !cursorIsInControlZone(target))
}

function syncOverlayBounds(overlay: BrowserWindow): void {
  if (!overlayBoundsDirty) return

  const nextBounds = virtualDesktopBounds()
  if (boundsKey(overlay.getBounds()) !== boundsKey(nextBounds)) {
    overlay.setBounds(nextBounds, false)
  }
  overlayBoundsDirty = false
}

function markOverlayBoundsDirty(): void {
  cachedVirtualBounds = null
  overlayBoundsDirty = true
  const overlay = overlayWin
  if (!overlay || overlay.isDestroyed()) return

  syncOverlayBounds(overlay)
  if (activeTarget) {
    overlay.webContents.send('windowPicker:targetChanged', targetPayload(activeTarget))
  }
}

function registerDisplayListeners(): void {
  if (displayListenersRegistered) return
  displayListenersRegistered = true
  screen.on('display-added', markOverlayBoundsDirty)
  screen.on('display-removed', markOverlayBoundsDirty)
  screen.on('display-metrics-changed', markOverlayBoundsDirty)
}

function unregisterDisplayListeners(): void {
  if (!displayListenersRegistered) return
  displayListenersRegistered = false
  screen.off('display-added', markOverlayBoundsDirty)
  screen.off('display-removed', markOverlayBoundsDirty)
  screen.off('display-metrics-changed', markOverlayBoundsDirty)
}

function pinOverlayAcrossSpaces(overlay: BrowserWindow): void {
  if (overlay.isDestroyed()) return
  // Order matters on macOS: raising the level resets NSWindowCollectionBehavior,
  // so apply the level first, then re-apply the collection-behavior mask.
  overlay.setAlwaysOnTop(true, 'screen-saver', 1)
  // skipTransformProcessType: true is critical — without it, every call to
  // setVisibleOnAllWorkspaces flips the macOS process type between
  // UIElementApplication and ForegroundApplication, briefly hiding the window
  // and the dock. We call this on show + Space change + session start, so the
  // flapping was visible as "picker sometimes appears, sometimes doesn't."
  // See https://github.com/electron/electron/issues/26350
  overlay.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })
  if (process.platform === 'darwin') {
    try {
      addon.pinWindowAcrossSpaces(overlay.getNativeWindowHandle())
    } catch {
      // Native handle may be unavailable mid-teardown — fall back to Electron's API.
    }
  }
}

function createOverlay(): BrowserWindow {
  const bounds = virtualDesktopBounds()
  const overlay = new BrowserWindow({
    ...windowConfigs.windowPickerWin,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    webPreferences: options?.webPreferences,
  })

  pinOverlayAcrossSpaces(overlay)
  overlayIgnoresMouse = null
  setOverlayIgnoresMouse(overlay, true)
  overlay.on('closed', () => {
    if (overlayWin === overlay) {
      overlayWin = null
      overlayIgnoresMouse = null
    }
  })
  overlay.webContents.on('did-finish-load', () => {
    if (activeTarget) {
      overlay.webContents.send('windowPicker:targetChanged', targetPayload(activeTarget))
    }
  })
  options?.loadAppRoute(overlay, '/window-picker/')
  overlayWin = overlay
  overlayBoundsDirty = false
  return overlay
}

function pickerOverlay(): BrowserWindow {
  const existing = overlayWin
  if (existing && !existing.isDestroyed()) return existing
  return createOverlay()
}

function hideOverlay(overlay: BrowserWindow): void {
  if (overlay.isDestroyed()) return
  setOverlayIgnoresMouse(overlay, true)
  if (overlay.isVisible()) overlay.hide()
}

function clearOverlayTarget(): void {
  activeTarget = null
  lastTargetKey = ''
  const overlay = overlayWin
  if (!overlay || overlay.isDestroyed()) return
  setOverlayIgnoresMouse(overlay, true)
  overlay.webContents.send('windowPicker:targetChanged', null)
}

function hideAllOverlays({ resetTracking = true } = {}): void {
  activeTarget = null
  lastTargetKey = ''
  if (resetTracking) {
    lastCursorKey = ''
    lastResolvedAt = 0
  }
  if (overlayWin) hideOverlay(overlayWin)
}

function showTarget(target: ActivePickerTarget): void {
  const overlay = pickerOverlay()
  syncOverlayBounds(overlay)
  updateOverlayInteractivity(overlay, target)
  if (!overlay.isVisible()) {
    overlay.showInactive()
    // Showing an NSPanel can drop the CanJoinAllSpaces bit; reassert it.
    pinOverlayAcrossSpaces(overlay)
    // electron#36364: setAlwaysOnTop + visibleOnAllWorkspaces doesn't always
    // surface the panel on the current Space until something forces it.
    // moveTop nudges AppKit into placing the panel on the active Space.
    overlay.moveTop()
  }

  const nextKey = targetKey(target)
  activeTarget = target
  if (nextKey !== lastTargetKey) {
    lastTargetKey = nextKey
    overlay.webContents.send('windowPicker:targetChanged', targetPayload(target))
  }
}

function handleActiveSpaceChanged(): void {
  if (!pickerMode) return
  const overlay = overlayWin
  if (!overlay || overlay.isDestroyed()) return
  // AppKit may have cleared the collection behavior during the Space
  // transition; re-pin before forcing a re-resolve so the overlay shows up on
  // the new Space immediately rather than waiting for the next 300ms tick.
  pinOverlayAcrossSpaces(overlay)
  if (overlay.isVisible()) overlay.moveTop()
  // Bypass the stationary-cursor cache — same screen coordinates on a new
  // Space resolve to entirely different windows.
  lastCursorKey = ''
  lastResolvedAt = 0
  pollPickerTarget()
}

function registerSpaceChangeListener(): void {
  if (spaceChangeRegistered) return
  if (process.platform !== 'darwin') return
  if (typeof addon.onActiveSpaceChange !== 'function') return
  spaceChangeRegistered = true
  addon.onActiveSpaceChange(handleActiveSpaceChanged)
}

function windowSourceUnderCursor(): WindowSource | null {
  const source = addon.getWindowUnderCursor(false)
  if (!source) return null
  if (!source.processId) return source

  if (windowIconCache.has(source.processId)) {
    const iconDataUrl = windowIconCache.get(source.processId)
    return iconDataUrl ? { ...source, iconDataUrl } : source
  }

  const sourceWithIcon = addon.getWindowUnderCursor(true)
  const iconDataUrl = sourceWithIcon?.windowId === source.windowId
    ? sourceWithIcon.iconDataUrl
    : undefined
  windowIconCache.set(source.processId, iconDataUrl ?? null)
  return iconDataUrl ? { ...source, iconDataUrl } : source
}

function resolvePickerTarget(): ActivePickerTarget | null {
  if (pickerMode === 'window') {
    const source = windowSourceUnderCursor()
    return source ? windowPickerTarget(source) : null
  }
  if (pickerMode === 'display') {
    return displayPickerTarget()
  }
  return null
}

function pollPickerTarget(): void {
  if (!pickerMode || confirming) return

  const cursor = screen.getCursorScreenPoint()
  const cursorKey = `${pickerMode}:${cursor.x}:${cursor.y}`
  const now = Date.now()
  const cursorMoved = cursorKey !== lastCursorKey
  if (!cursorMoved && now - lastResolvedAt < STATIONARY_REVALIDATE_MS) {
    if (activeTarget && overlayWin && !overlayWin.isDestroyed()) {
      updateOverlayInteractivity(overlayWin, activeTarget)
    }
    return
  }
  lastCursorKey = cursorKey
  lastResolvedAt = now

  const target = resolvePickerTarget()
  if (!target) {
    // Don't hide the overlay here — on macOS, hide+show can re-anchor the
    // window to the Space where it was first shown, which makes the window
    // picker stop following the user across Spaces. Just clear the highlight.
    clearOverlayTarget()
    return
  }
  showTarget(target)
}

function stopPolling(): void {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

function unregisterEscape(): void {
  if (globalShortcut.isRegistered('Escape')) {
    globalShortcut.unregister('Escape')
  }
}

function finishPicker({ restoreRecorder }: { restoreRecorder: boolean }): void {
  stopPolling()
  unregisterEscape()
  pickerMode = null
  confirming = false
  hideAllOverlays()
  options?.onPickerFinished()
  if (restoreRecorder) {
    options?.showRecorderWindow()
  }
}

export function startWindowPicker(mode: RecorderPickerMode): void {
  if (!options) {
    throw new Error('Window picker has not been registered.')
  }

  if (pickerMode) {
    finishPicker({ restoreRecorder: false })
  }

  pickerMode = mode
  confirming = false
  lastCursorKey = ''
  lastResolvedAt = 0
  overlayBoundsDirty = true
  const overlay = pickerOverlay()
  // Re-pin every session in case the overlay was first created on a different
  // Space and AppKit dropped CanJoinAllSpaces in the meantime.
  pinOverlayAcrossSpaces(overlay)
  syncOverlayBounds(overlay)
  pollPickerTarget()
  pollTimer = setInterval(pollPickerTarget, PICKER_POLL_INTERVAL_MS)
  globalShortcut.register('Escape', () => {
    cancelWindowPicker()
  })
}

export function cancelWindowPicker(): void {
  if (!pickerMode) return
  finishPicker({ restoreRecorder: true })
}

async function confirmWindowPicker(): Promise<void> {
  if (!pickerMode || !activeTarget || confirming) return

  const target = activeTarget.target
  confirming = true
  finishPicker({ restoreRecorder: false })
  // Don't unconditionally show the recorder bar here — main.ts subscribes to
  // recorder status changes and decides which window to show: the recording
  // controls window if startRecordingForTarget succeeded, the recorder bar
  // again if it bounced back to idle on error.
  await options?.startRecordingForTarget(target)
}

function setInteractive(sender: WebContents, interactive: boolean): void {
  const overlay = BrowserWindow.fromWebContents(sender)
  if (!overlay || overlay.isDestroyed()) return
  setOverlayIgnoresMouse(overlay, !interactive)
}

export function registerWindowPickerHandlers(
  nextOptions: RegisterWindowPickerOptions,
): void {
  options = nextOptions
  registerDisplayListeners()
  registerSpaceChangeListener()
  ipcMain.handle('windowPicker:confirm', () => confirmWindowPicker())
  ipcMain.handle('windowPicker:cancel', () => {
    cancelWindowPicker()
  })
  ipcMain.handle('windowPicker:setInteractive', (event, interactive: boolean) => {
    setInteractive(event.sender, Boolean(interactive))
  })
  // Pull-based handshake. The push channel (windowPicker:targetChanged) only
  // fires when the target key changes — display mode resolves the same target
  // every poll, so its single initial push races the renderer's useEffect
  // and gets dropped before any listener exists. Renderer calls this on mount
  // to grab the current target regardless of whether a push has been emitted.
  ipcMain.handle('windowPicker:getCurrentTarget', () =>
    activeTarget ? targetPayload(activeTarget) : null,
  )
}

export function disposeWindowPicker(): void {
  finishPicker({ restoreRecorder: false })
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close()
  overlayWin = null
  overlayIgnoresMouse = null
  unregisterDisplayListeners()
  options = null
}
