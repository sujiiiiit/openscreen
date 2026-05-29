import {
  screen,
  type Display,
  type Point,
  type Rectangle,
} from 'electron'
import addon, { type DisplaySource } from '@openscreen/mac-addon'

export interface ResolvedDisplayTarget {
  display: Display
  displayId: number
  bounds: Rectangle
  pixelWidth: number
  pixelHeight: number
}

function roundedBounds(bounds: Rectangle): Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  }
}

function pointInBounds(point: Point, bounds: Rectangle): boolean {
  return point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
}

function electronDisplayAtPoint(point: Point): Display {
  const containingDisplay = screen
    .getAllDisplays()
    .find((display) => pointInBounds(point, display.bounds))
  return containingDisplay ?? screen.getDisplayNearestPoint(point)
}

function nativeDisplayUnderCursor(): DisplaySource | null {
  if (process.platform !== 'darwin') return null
  try {
    return addon.getDisplayUnderCursor()
  } catch {
    return null
  }
}

function electronDisplayForNativeDisplay(
  nativeDisplay: DisplaySource,
  cursor: Point,
): Display {
  const displays = screen.getAllDisplays()
  const matchingId = displays.find((display) => display.id === nativeDisplay.displayId)
  if (matchingId) return matchingId

  const matchingGeometry = displays.find((display) => {
    const bounds = roundedBounds(display.bounds)
    const scaleFactor = display.scaleFactor || 1
    return Math.round(bounds.x) === Math.round(nativeDisplay.x) &&
      Math.round(bounds.y) === Math.round(nativeDisplay.y) &&
      Math.round(bounds.width * scaleFactor) === Math.round(nativeDisplay.width) &&
      Math.round(bounds.height * scaleFactor) === Math.round(nativeDisplay.height)
  })
  return matchingGeometry ?? electronDisplayAtPoint(cursor)
}

export function resolveDisplayUnderCursor(
  cursor = screen.getCursorScreenPoint(),
): ResolvedDisplayTarget {
  const nativeDisplay = nativeDisplayUnderCursor()
  const display = nativeDisplay
    ? electronDisplayForNativeDisplay(nativeDisplay, cursor)
    : electronDisplayAtPoint(cursor)
  const bounds = roundedBounds(display.bounds)
  const scaleFactor = display.scaleFactor || 1

  return {
    display,
    displayId: nativeDisplay?.displayId ?? display.id,
    bounds,
    pixelWidth: Math.max(
      1,
      Math.round(nativeDisplay?.width ?? bounds.width * scaleFactor),
    ),
    pixelHeight: Math.max(
      1,
      Math.round(nativeDisplay?.height ?? bounds.height * scaleFactor),
    ),
  }
}
