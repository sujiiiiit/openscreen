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
import { subscribeActiveSpaceChange } from '../mac-spaces'
import { windowConfigs } from '../windowConfigs'
import type { RecorderPickerMode } from './recorder'

export interface PickerOverlayTarget {
  mode: RecorderPickerMode
  title: string
  sizeLabel: string
  modeLabel: string
  bounds: Rectangle
  iconDataUrl?: string
  locked?: boolean
  target: CaptureTarget
}

export interface WindowPickerSession {
  mode: RecorderPickerMode | null
  minRegionWidth: number
  minRegionHeight: number
  locked: boolean
}

export interface RegionSelectionBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface RegionSelectionResult {
  target: PickerOverlayTarget | null
  message: string | null
}

interface RegisterWindowPickerOptions {
  webPreferences: BrowserWindowConstructorOptions['webPreferences']
  loadAppRoute: (window: BrowserWindow, route: string) => void
  showRecorderWindow: () => void
  startRecordingForTarget: (target: CaptureTarget) => Promise<void>
  // Claim the recorder's start slot before the picker tears down its overlay
  // so a concurrent generic recorder:start can't race past us and start a
  // default-display recording behind the picker's back.
  reservePickerStart: () => void
  onPickerFinished: () => void
}

interface ActivePickerTarget extends PickerOverlayTarget {
  displayId: number
}

const CONTROL_ZONE_WIDTH = 420
const CONTROL_ZONE_TOP_OFFSET = 18
const CONTROL_ZONE_HEIGHT = 205
const PICKER_POLL_INTERVAL_MS = 32
const STATIONARY_REVALIDATE_MS = 450
const WINDOW_SNAPSHOT_REFRESH_MS = 250
const MIN_REGION_WIDTH = 160
const MIN_REGION_HEIGHT = 90

let options: RegisterWindowPickerOptions | null = null
let overlayWin: BrowserWindow | null = null
let pickerMode: RecorderPickerMode | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let activeTarget: ActivePickerTarget | null = null
let lastTargetKey = ''
let lastCursorKey = ''
let lastResolvedAt = 0
let windowSnapshot: WindowSource[] = []
let windowSnapshotUpdatedAt = 0
let cachedVirtualBounds: Rectangle | null = null
let overlayBoundsDirty = true
let overlayIgnoresMouse: boolean | null = null
let confirming = false
let regionOverlayLocked = false
let displayListenersRegistered = false
let spaceChangeRegistered = false
let unsubscribeSpaceChange: (() => void) | null = null

// Bounded LRU. Keyed by `${processId}|${bundleId}` rather than processId
// alone — macOS reuses PIDs, so a stale icon for a long-killed app would
// otherwise be served (kilobytes of base64 PNG) for an unrelated new
// process. Map preserves insertion order, so we evict the oldest on
// overflow. The cache is also cleared on disposeWindowPicker.
const WINDOW_ICON_CACHE_MAX = 64
const windowIconCache = new Map<string, string | null>()
const pendingWindowIconFetches = new Set<string>()

function iconCacheKey(source: WindowSource): string | null {
  if (!source.processId) return null
  return `${source.processId}|${source.bundleId ?? ''}`
}

function readIconCache(source: WindowSource): string | null | undefined {
  const key = iconCacheKey(source)
  if (!key) return undefined
  if (!windowIconCache.has(key)) return undefined
  const value = windowIconCache.get(key) ?? null
  // Bump to most-recently-used by re-inserting.
  windowIconCache.delete(key)
  windowIconCache.set(key, value)
  return value
}

function writeIconCache(source: WindowSource, icon: string | null): void {
  const key = iconCacheKey(source)
  if (!key) return
  if (windowIconCache.has(key)) windowIconCache.delete(key)
  windowIconCache.set(key, icon)
  while (windowIconCache.size > WINDOW_ICON_CACHE_MAX) {
    const oldest = windowIconCache.keys().next().value
    if (oldest === undefined) break
    windowIconCache.delete(oldest)
  }
}

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

function pointInBounds(point: Point, bounds: Rectangle): boolean {
  return point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
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

function evenDimension(value: number): number {
  const rounded = Math.round(value)
  const even = rounded % 2 === 0 ? rounded : rounded - 1
  return Math.max(2, even)
}

function intersectionArea(a: Rectangle, b: Rectangle): number {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return Math.max(0, right - left) * Math.max(0, bottom - top)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeRegionBounds(bounds: RegionSelectionBounds): Rectangle {
  const x1 = bounds.x
  const y1 = bounds.y
  const x2 = bounds.x + bounds.width
  const y2 = bounds.y + bounds.height
  return roundedBounds({
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  })
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

function regionPickerTarget(bounds: Rectangle, display: Display): ActivePickerTarget {
  const scaleFactor = display.scaleFactor || 1
  const displayBoundsValue = displayBounds(display)
  const sourceX = bounds.x - displayBoundsValue.x
  const sourceY = bounds.y - displayBoundsValue.y
  const outputWidth = evenDimension(bounds.width * scaleFactor)
  const outputHeight = evenDimension(bounds.height * scaleFactor)
  return {
    mode: 'region',
    title: 'Region',
    sizeLabel: `${outputWidth} × ${outputHeight}`,
    modeLabel: 'Region',
    bounds,
    displayId: display.id,
    target: {
      type: 'region',
      displayId: display.id,
      title: 'Region',
      applicationName: 'Region',
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      sourceX,
      sourceY,
      sourceWidth: bounds.width,
      sourceHeight: bounds.height,
      scaleFactor,
    },
  }
}

function displayPickerTarget(cursor = screen.getCursorScreenPoint()): ActivePickerTarget {
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

function sameWindowTarget(
  target: ActivePickerTarget | null,
  source: WindowSource,
): boolean {
  return target?.target.type === 'window' &&
    target.target.windowId === source.windowId &&
    target.target.processId === source.processId
}

function sameWindowSource(source: WindowSource, candidate: WindowSource): boolean {
  return source.windowId === candidate.windowId &&
    source.processId === candidate.processId
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
    locked: regionOverlayLocked && target.mode === 'region',
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
  invalidateWindowSnapshot()
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

function clearOverlayTarget(): void {
  activeTarget = null
  lastTargetKey = ''
  const overlay = overlayWin
  if (!overlay || overlay.isDestroyed()) return
  setOverlayIgnoresMouse(overlay, pickerMode === 'region' ? false : true)
  overlay.webContents.send('windowPicker:targetChanged', null)
}

function resetPickerTracking({ resetCursor = true } = {}): void {
  activeTarget = null
  lastTargetKey = ''
  invalidateWindowSnapshot()
  if (resetCursor) {
    lastCursorKey = ''
    lastResolvedAt = 0
  }
}

function destroyOverlay(): void {
  const overlay = overlayWin
  overlayWin = null
  overlayIgnoresMouse = null
  regionOverlayLocked = false
  resetPickerTracking()
  if (!overlay || overlay.isDestroyed()) return

  setOverlayIgnoresMouse(overlay, true)
  overlay.destroy()
  overlayIgnoresMouse = null
}

function showTarget(target: ActivePickerTarget): void {
  const overlay = pickerOverlay()
  syncOverlayBounds(overlay)
  if (target.mode === 'region') {
    setOverlayIgnoresMouse(overlay, false)
  } else {
    updateOverlayInteractivity(overlay, target)
  }
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
  const iconChanged = activeTarget?.iconDataUrl !== target.iconDataUrl
  activeTarget = target
  if (nextKey !== lastTargetKey || iconChanged) {
    lastTargetKey = nextKey
    overlay.webContents.send('windowPicker:targetChanged', targetPayload(target))
  }
}

function handleActiveSpaceChanged(): void {
  if (!pickerMode && !regionOverlayLocked) return
  const overlay = overlayWin
  if (!overlay || overlay.isDestroyed()) return
  // AppKit may have cleared the collection behavior during the Space
  // transition; re-pin before forcing a re-resolve so the overlay shows up on
  // the new Space immediately rather than waiting for the next revalidate tick.
  pinOverlayAcrossSpaces(overlay)
  if (!overlay.isVisible()) overlay.showInactive()
  if (overlay.isVisible()) overlay.moveTop()
  if (regionOverlayLocked) {
    if (activeTarget) {
      overlay.webContents.send('windowPicker:targetChanged', targetPayload(activeTarget))
    }
    return
  }
  if (pickerMode === 'region') {
    if (activeTarget) {
      overlay.webContents.send('windowPicker:targetChanged', targetPayload(activeTarget))
    }
    return
  }
  clearOverlayTarget()
  invalidateWindowSnapshot()
  // Bypass the stationary-cursor cache — same screen coordinates on a new
  // Space resolve to entirely different windows.
  lastCursorKey = ''
  lastResolvedAt = 0
  pollPickerTarget()
}

function registerSpaceChangeListener(): void {
  if (spaceChangeRegistered) return
  if (process.platform !== 'darwin') return
  spaceChangeRegistered = true
  unsubscribeSpaceChange = subscribeActiveSpaceChange(handleActiveSpaceChanged)
}

function unregisterSpaceChangeListener(): void {
  if (!spaceChangeRegistered) return
  spaceChangeRegistered = false
  unsubscribeSpaceChange?.()
  unsubscribeSpaceChange = null
}

function sourceWithCachedIcon(source: WindowSource): WindowSource {
  const iconDataUrl = readIconCache(source)
  return iconDataUrl ? { ...source, iconDataUrl } : source
}

function refreshWindowSnapshot({ force = false } = {}): void {
  if (pickerMode !== 'window') return

  const now = Date.now()
  if (!force && now - windowSnapshotUpdatedAt < WINDOW_SNAPSHOT_REFRESH_MS) return

  try {
    windowSnapshot = addon.listVisibleWindows(false).map(sourceWithCachedIcon)
  } catch {
    windowSnapshot = []
  }
  windowSnapshotUpdatedAt = now
}

function invalidateWindowSnapshot(): void {
  windowSnapshot = []
  windowSnapshotUpdatedAt = 0
}

function hitTestWindowSnapshot(cursor: Point): WindowSource | null {
  for (const source of windowSnapshot) {
    if (pointInBounds(cursor, windowBounds(source))) return source
  }
  return null
}

function scheduleWindowIconFetch(source: WindowSource): void {
  const cacheKey = iconCacheKey(source)
  if (!cacheKey) return
  if (windowIconCache.has(cacheKey)) return
  if (pendingWindowIconFetches.has(cacheKey)) return

  pendingWindowIconFetches.add(cacheKey)
  setTimeout(() => {
    pendingWindowIconFetches.delete(cacheKey)

    const currentTarget = activeTarget
    if (!pickerMode || confirming || !sameWindowTarget(currentTarget, source)) {
      return
    }

    let sourceWithIcon: WindowSource | undefined
    try {
      sourceWithIcon = addon
        .listVisibleWindows(true)
        .find((candidate) => sameWindowSource(source, candidate))
    } catch {
      sourceWithIcon = undefined
    }
    const iconDataUrl = sourceWithIcon && sameWindowTarget(currentTarget, sourceWithIcon)
      ? sourceWithIcon.iconDataUrl
      : undefined
    writeIconCache(source, iconDataUrl ?? null)

    const latestTarget = activeTarget
    if (!iconDataUrl || !latestTarget || !sameWindowTarget(latestTarget, source)) return
    const nextTarget: ActivePickerTarget = {
      ...latestTarget,
      iconDataUrl,
    }
    activeTarget = nextTarget

    const overlay = overlayWin
    if (!overlay || overlay.isDestroyed()) return
    overlay.webContents.send('windowPicker:targetChanged', targetPayload(nextTarget))
  }, 0)
}

function windowSourceUnderCursor(cursor = screen.getCursorScreenPoint()): WindowSource | null {
  refreshWindowSnapshot()

  let source = hitTestWindowSnapshot(cursor)
  if (!source && Date.now() - windowSnapshotUpdatedAt >= WINDOW_SNAPSHOT_REFRESH_MS) {
    refreshWindowSnapshot({ force: true })
    source = hitTestWindowSnapshot(cursor)
  }

  if (!source) return null
  if (!source.processId) return source

  const cached = readIconCache(source)
  if (cached !== undefined) {
    return cached ? { ...source, iconDataUrl: cached } : source
  }

  scheduleWindowIconFetch(source)
  return source
}

function resolvePickerTarget(cursor = screen.getCursorScreenPoint()): ActivePickerTarget | null {
  if (pickerMode === 'window') {
    const source = windowSourceUnderCursor(cursor)
    return source ? windowPickerTarget(source) : null
  }
  if (pickerMode === 'display') {
    return displayPickerTarget(cursor)
  }
  return null
}

function updateActiveTargetInteractivity(): void {
  if (!activeTarget || !overlayWin || overlayWin.isDestroyed()) return
  if (activeTarget.mode === 'region') {
    setOverlayIgnoresMouse(overlayWin, false)
    return
  }
  updateOverlayInteractivity(overlayWin, activeTarget)
}

function pollPickerTarget(): void {
  if (!pickerMode || confirming) return

  const cursor = screen.getCursorScreenPoint()
  const cursorKey = `${pickerMode}:${cursor.x}:${cursor.y}`
  const now = Date.now()
  const cursorMoved = cursorKey !== lastCursorKey

  if (!cursorMoved && now - lastResolvedAt < STATIONARY_REVALIDATE_MS) {
    updateActiveTargetInteractivity()
    return
  }
  lastCursorKey = cursorKey
  lastResolvedAt = now

  const target = resolvePickerTarget(cursor)
  if (!target) {
    // Don't hide the overlay here — on macOS, hide+show can re-anchor the
    // window to the Space where it was first shown, which makes the window
    // picker stop following the user across Spaces. Just clear the highlight.
    clearOverlayTarget()
    return
  }
  showTarget(target)
}

function showRegionOverlay(overlay: BrowserWindow): void {
  clearOverlayTarget()
  setOverlayIgnoresMouse(overlay, false)
  if (!overlay.isVisible()) {
    overlay.showInactive()
    pinOverlayAcrossSpaces(overlay)
    overlay.moveTop()
  }
}

function regionSelectionFromRenderer(
  sender: WebContents,
  bounds: RegionSelectionBounds | null,
): RegionSelectionResult {
  if (pickerMode !== 'region') {
    return { target: null, message: 'Region selection is not active.' }
  }

  const overlay = BrowserWindow.fromWebContents(sender)
  if (!overlay || overlay.isDestroyed()) {
    return { target: null, message: 'Region picker is not available.' }
  }

  if (!bounds) {
    clearOverlayTarget()
    return { target: null, message: null }
  }

  const overlayBounds = overlay.getBounds()
  const normalized = normalizeRegionBounds(bounds)
  const left = clamp(normalized.x, 0, overlayBounds.width)
  const top = clamp(normalized.y, 0, overlayBounds.height)
  const right = clamp(normalized.x + normalized.width, 0, overlayBounds.width)
  const bottom = clamp(normalized.y + normalized.height, 0, overlayBounds.height)
  const globalBounds = roundedBounds({
    x: overlayBounds.x + Math.min(left, right),
    y: overlayBounds.y + Math.min(top, bottom),
    width: Math.abs(right - left),
    height: Math.abs(bottom - top),
  })

  if (globalBounds.width < MIN_REGION_WIDTH || globalBounds.height < MIN_REGION_HEIGHT) {
    clearOverlayTarget()
    return {
      target: null,
      message: `Draw a region at least ${MIN_REGION_WIDTH} × ${MIN_REGION_HEIGHT}.`,
    }
  }

  const touchedDisplays = screen.getAllDisplays().filter((display) =>
    intersectionArea(globalBounds, displayBounds(display)) > 0,
  )
  if (touchedDisplays.length === 0) {
    clearOverlayTarget()
    return { target: null, message: 'Draw the region on a display.' }
  }
  if (touchedDisplays.length > 1) {
    clearOverlayTarget()
    return {
      target: null,
      message: 'Keep the region on one display, then drag again.',
    }
  }

  const nextTarget = regionPickerTarget(globalBounds, touchedDisplays[0])
  showTarget(nextTarget)
  return { target: targetPayload(nextTarget), message: null }
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

function finishPicker({
  restoreRecorder,
  notifyFinished = true,
}: {
  restoreRecorder: boolean
  notifyFinished?: boolean
}): void {
  stopPolling()
  unregisterEscape()
  pickerMode = null
  confirming = false
  destroyOverlay()
  if (notifyFinished) {
    options?.onPickerFinished()
  }
  if (restoreRecorder) {
    options?.showRecorderWindow()
  }
}

function lockRegionOverlayForRecording(target: ActivePickerTarget): void {
  stopPolling()
  unregisterEscape()
  pickerMode = null
  confirming = false
  regionOverlayLocked = true
  activeTarget = target
  const overlay = pickerOverlay()
  syncOverlayBounds(overlay)
  pinOverlayAcrossSpaces(overlay)
  setOverlayIgnoresMouse(overlay, true)
  if (!overlay.isVisible()) {
    overlay.showInactive()
  }
  overlay.moveTop()
  overlay.webContents.send('windowPicker:targetChanged', targetPayload(target))
  options?.onPickerFinished()
}

export function clearLockedRegionOverlay(): void {
  if (!regionOverlayLocked) return
  finishPicker({ restoreRecorder: false, notifyFinished: false })
}

export function startWindowPicker(mode: RecorderPickerMode): void {
  if (!options) {
    throw new Error('Window picker has not been registered.')
  }

  if (pickerMode) {
    finishPicker({ restoreRecorder: false, notifyFinished: false })
  }

  // Refresh the SCShareableContent prewarm cache now while the user is
  // still picking. By the time they click Start, the result is sitting in
  // the cache and the native start path skips the 500ms–1s cold call.
  if (process.platform === 'darwin' && typeof addon.prewarmShareableContent === 'function') {
    try {
      addon.prewarmShareableContent()
    } catch {
      // Older addon build — non-fatal.
    }
  }

  pickerMode = mode
  confirming = false
  lastCursorKey = ''
  lastResolvedAt = 0
  invalidateWindowSnapshot()
  overlayBoundsDirty = true
  const overlay = pickerOverlay()
  // Re-pin every session in case the overlay was first created on a different
  // Space and AppKit dropped CanJoinAllSpaces in the meantime.
  pinOverlayAcrossSpaces(overlay)
  syncOverlayBounds(overlay)
  if (mode === 'region') {
    showRegionOverlay(overlay)
  } else {
    pollPickerTarget()
    pollTimer = setInterval(pollPickerTarget, PICKER_POLL_INTERVAL_MS)
  }
  // globalShortcut.register returns false if Escape is already held by
  // another app or the OS — without this guard the picker would offer no
  // way to cancel except clicking through. The renderer also wires a
  // window-level Escape keydown handler as a secondary escape hatch, but
  // it only fires when the overlay has keyboard focus.
  const escapeRegistered = globalShortcut.register('Escape', () => {
    cancelWindowPicker()
  })
  if (!escapeRegistered) {
    console.warn('[picker] could not register global Escape shortcut; rely on overlay keydown fallback')
  }
}

export function cancelWindowPicker(): void {
  if (!pickerMode) return
  finishPicker({ restoreRecorder: true })
}

// Freeze the picker overlay so it stops following the cursor but stays
// on-screen with the user's selection highlighted and the renderer's
// "confirming" spinner visible. Used for display/window picker mode while
// awaiting native start — without this hold, the overlay tears down the
// instant the user clicks Start and they see nothing for the ~1s native
// startup latency. The overlay is destroyed by the caller after start
// resolves (success or failure).
function freezePickerOverlayForStart(): void {
  stopPolling()
  unregisterEscape()
  pickerMode = null
  const overlay = overlayWin
  if (!overlay || overlay.isDestroyed()) return
  // forward:true keeps clicks reaching whatever's underneath (e.g. the
  // recording controls window the moment it appears) so the brief overlap
  // between native completing and our teardown isn't a dead zone.
  setOverlayIgnoresMouse(overlay, true)
}

async function confirmWindowPicker(): Promise<void> {
  if (!pickerMode || !activeTarget || confirming) return

  const pickerTarget = activeTarget
  const target = activeTarget.target
  confirming = true
  // Reserve before any teardown so a recorder:start fired between
  // lockRegionOverlayForRecording / finishPicker (both of which clear
  // state.pickerMode via onPickerFinished) and the await below cannot win.
  options?.reservePickerStart()
  if (pickerTarget.mode === 'region') {
    lockRegionOverlayForRecording(pickerTarget)
    await options?.startRecordingForTarget(target)
    return
  }
  // Keep the picker overlay visible during the native start so the spinner
  // the renderer is already showing stays on screen until the recording
  // controls window appears. main.ts subscribes to recorder status changes
  // and shows the controls window when status flips to 'recording'; on
  // error it bounces back to 'idle' and shows the recorder bar again.
  freezePickerOverlayForStart()
  try {
    await options?.startRecordingForTarget(target)
  } finally {
    finishPicker({ restoreRecorder: false })
  }
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
  ipcMain.handle('windowPicker:getSession', () => ({
    mode: pickerMode,
    minRegionWidth: MIN_REGION_WIDTH,
    minRegionHeight: MIN_REGION_HEIGHT,
    locked: regionOverlayLocked,
  } satisfies WindowPickerSession))
  ipcMain.handle('windowPicker:setRegionSelection', (event, bounds: RegionSelectionBounds | null) =>
    regionSelectionFromRenderer(event.sender, bounds),
  )
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
  destroyOverlay()
  unregisterSpaceChangeListener()
  unregisterDisplayListeners()
  windowIconCache.clear()
  pendingWindowIconFetches.clear()
  options = null
}
