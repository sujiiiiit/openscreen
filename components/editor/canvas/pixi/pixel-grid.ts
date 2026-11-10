import type { Graphics } from "pixi.js"

import { PIXEL_GRID_SETTINGS } from "@/lib/editor-canvas"
import type { CanvasSize, ViewTransform } from "@/types/editor-canvas"

type DrawPixelGridOptions = {
  artboard: CanvasSize
  viewTransform: ViewTransform
  viewportSize: CanvasSize
  /** Base grid color (a CSS color string); per-line alpha comes from settings. */
  color: string
}

/**
 * Draw a 1-device-pixel grid over the artboard, but only once the view is
 * zoomed in past `PIXEL_GRID_SETTINGS.visibleFromScale`. The grid is a child of
 * the (scaled) artboard container, so strokes are authored in artboard-local
 * units of `1 / scale`, which the world scale renders back to 1px on screen.
 *
 * Only the lines covering the visible region are emitted — clamped to the
 * artboard bounds — so the cost stays bounded no matter how far you zoom.
 * Ported from openscreen's Konva `ArtboardPixelGrid` sceneFunc.
 */
export function drawPixelGrid(gfx: Graphics, options: DrawPixelGridOptions) {
  gfx.clear()

  const { artboard, viewTransform, viewportSize, color } = options
  const { scale, x: panX, y: panY } = viewTransform

  if (scale < PIXEL_GRID_SETTINGS.visibleFromScale) return

  const visibleLeft = Math.max(0, -panX / scale)
  const visibleTop = Math.max(0, -panY / scale)
  const visibleRight = Math.min(artboard.width, (viewportSize.width - panX) / scale)
  const visibleBottom = Math.min(
    artboard.height,
    (viewportSize.height - panY) / scale
  )

  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return

  const region = { visibleLeft, visibleTop, visibleRight, visibleBottom }

  drawGridLines(gfx, {
    ...region,
    unit: PIXEL_GRID_SETTINGS.unit,
    color,
    alpha: PIXEL_GRID_SETTINGS.opacity,
    lineWidth: 1 / scale,
  })

  drawGridLines(gfx, {
    ...region,
    unit: PIXEL_GRID_SETTINGS.majorUnit,
    color,
    alpha: PIXEL_GRID_SETTINGS.majorOpacity,
    lineWidth: 1.25 / scale,
  })
}

function drawGridLines(
  gfx: Graphics,
  {
    visibleLeft,
    visibleTop,
    visibleRight,
    visibleBottom,
    unit,
    color,
    alpha,
    lineWidth,
  }: {
    visibleLeft: number
    visibleTop: number
    visibleRight: number
    visibleBottom: number
    unit: number
    color: string
    alpha: number
    lineWidth: number
  }
) {
  const startX = Math.floor(visibleLeft / unit) * unit
  const endX = Math.ceil(visibleRight / unit) * unit
  const startY = Math.floor(visibleTop / unit) * unit
  const endY = Math.ceil(visibleBottom / unit) * unit

  for (let x = startX; x <= endX; x += unit) {
    gfx.moveTo(x, visibleTop).lineTo(x, visibleBottom)
  }

  for (let y = startY; y <= endY; y += unit) {
    gfx.moveTo(visibleLeft, y).lineTo(visibleRight, y)
  }

  gfx.stroke({ color, alpha, width: lineWidth })
}
