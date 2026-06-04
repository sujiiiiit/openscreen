import type Konva from "konva"

import {
  clampSquircleRadius,
  computeSquircleCornerParams,
  tracePathOrRect,
  type SquircleCornerParams,
} from "@/lib/squircle"
import { parseRgba } from "@/lib/rgba-color"

/**
 * Minimal style description consumed by the canvas-video sceneFunc. Both the
 * live editor (`CanvasVideoItem`) and the export pipeline (`ProjectVideo`)
 * conform to this shape, so this module is the single source of truth for
 * how a video is rasterised — keeping the editor preview and the export
 * frame pixel-identical.
 */
export interface VideoStyleSource {
  width: number
  height: number
  cornerRadius: number
  cornerSmoothing: number
  borderWidth: number
  borderColor: string
  borderOffset: number
  borderAlignment: "inside" | "center" | "outside"
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
  shadowSpread: number
}

export interface BorderRenderParams {
  strokeWidth: number
  color: string
  originX: number
  originY: number
  width: number
  height: number
  params: SquircleCornerParams | null
}

export interface ShadowRenderParams {
  color: string
  blur: number
  offsetX: number
  offsetY: number
  originX: number
  originY: number
  width: number
  height: number
  params: SquircleCornerParams | null
}

export function computeSquircleParams(
  source: Pick<
    VideoStyleSource,
    "width" | "height" | "cornerRadius" | "cornerSmoothing"
  >,
): SquircleCornerParams | null {
  if (source.cornerRadius <= 0) return null
  const safeRadius = clampSquircleRadius(
    source.width,
    source.height,
    source.cornerRadius,
  )
  if (safeRadius <= 0) return null
  return computeSquircleCornerParams(safeRadius, source.cornerSmoothing)
}

export function computeBorderParams(
  source: Pick<
    VideoStyleSource,
    | "width"
    | "height"
    | "cornerRadius"
    | "cornerSmoothing"
    | "borderWidth"
    | "borderColor"
    | "borderOffset"
    | "borderAlignment"
  >,
): BorderRenderParams | null {
  const strokeWidth = Math.max(0, source.borderWidth)
  if (strokeWidth <= 0) return null
  const alignmentDelta =
    source.borderAlignment === "outside"
      ? strokeWidth / 2
      : source.borderAlignment === "inside"
        ? -strokeWidth / 2
        : 0
  const signedDistance = source.borderOffset + alignmentDelta
  const borderBoxWidth = source.width + 2 * signedDistance
  const borderBoxHeight = source.height + 2 * signedDistance
  if (borderBoxWidth <= 0 || borderBoxHeight <= 0) return null

  const requestedRadius =
    source.cornerRadius > 0
      ? Math.max(0, source.cornerRadius + signedDistance)
      : 0
  const safeRadius = clampSquircleRadius(
    borderBoxWidth,
    borderBoxHeight,
    requestedRadius,
  )
  const params =
    safeRadius > 0
      ? computeSquircleCornerParams(safeRadius, source.cornerSmoothing)
      : null

  return {
    strokeWidth,
    color: source.borderColor,
    originX: -signedDistance,
    originY: -signedDistance,
    width: borderBoxWidth,
    height: borderBoxHeight,
    params,
  }
}

export function computeShadowParams(
  source: Pick<
    VideoStyleSource,
    | "width"
    | "height"
    | "cornerRadius"
    | "cornerSmoothing"
    | "shadowColor"
    | "shadowBlur"
    | "shadowOffsetX"
    | "shadowOffsetY"
    | "shadowSpread"
  >,
): ShadowRenderParams | null {
  const parsedColor = parseRgba(source.shadowColor)
  if (parsedColor === null || parsedColor.a <= 0) return null

  const blur = Math.max(0, source.shadowBlur)
  const offsetX = source.shadowOffsetX
  const offsetY = source.shadowOffsetY
  const spread = source.shadowSpread

  if (blur === 0 && offsetX === 0 && offsetY === 0 && spread === 0) {
    return null
  }

  const casterWidth = source.width + 2 * spread
  const casterHeight = source.height + 2 * spread
  if (casterWidth <= 0 || casterHeight <= 0) return null

  const requestedRadius =
    source.cornerRadius > 0
      ? Math.max(0, source.cornerRadius + spread)
      : 0
  const safeRadius = clampSquircleRadius(
    casterWidth,
    casterHeight,
    requestedRadius,
  )
  const params =
    safeRadius > 0
      ? computeSquircleCornerParams(safeRadius, source.cornerSmoothing)
      : null

  return {
    color: source.shadowColor,
    blur,
    offsetX,
    offsetY,
    originX: -spread,
    originY: -spread,
    width: casterWidth,
    height: casterHeight,
    params,
  }
}

/**
 * Render a single video bitmap with the editor's full appearance stack
 * (drop shadow, squircle clip, image draw with high-quality smoothing,
 * stroked border). Same code path runs in the live editor and in the
 * exporter so the on-screen preview matches the encoded frame.
 *
 * The shadow pass uses an in-place fill + `destination-out` mask trick:
 * Konva clipping at the layer level would otherwise cull a far-offscreen
 * shadow cast (see commentary in canvas-video-node.tsx). The same caveat
 * applies here — overlapping shadows on the same layer can chip pixels.
 */
export function drawCanvasVideoFrame(
  context: Konva.Context,
  image: CanvasImageSource,
  width: number,
  height: number,
  crop: {
    x: number
    y: number
    width: number
    height: number
  } | null,
  squircleParams: SquircleCornerParams | null,
  borderParams: BorderRenderParams | null,
  shadowParams: ShadowRenderParams | null,
): void {
  if (width <= 0 || height <= 0) return

  if (shadowParams !== null) {
    context.save()
    context.shadowColor = shadowParams.color
    context.shadowBlur = shadowParams.blur
    context.shadowOffsetX = shadowParams.offsetX
    context.shadowOffsetY = shadowParams.offsetY
    context.translate(shadowParams.originX, shadowParams.originY)
    context.beginPath()
    tracePathOrRect(
      context,
      shadowParams.width,
      shadowParams.height,
      shadowParams.params,
    )
    context.closePath()
    context.fillStyle = "#000"
    context.fill()
    context.restore()

    context.save()
    context.globalCompositeOperation = "destination-out"
    context.translate(shadowParams.originX, shadowParams.originY)
    context.beginPath()
    tracePathOrRect(
      context,
      shadowParams.width,
      shadowParams.height,
      shadowParams.params,
    )
    context.closePath()
    context.fillStyle = "#000"
    context.fill()
    context.restore()
  }

  context.save()
  // Konva's public Context doesn't expose imageSmoothingQuality directly;
  // reach into the underlying 2D context. Wrapped in save/restore via the
  // Konva context so it doesn't leak to subsequent shapes on the same layer.
  const ctx2d = (
    context as unknown as { _context: CanvasRenderingContext2D }
  )._context
  ctx2d.imageSmoothingEnabled = true
  ctx2d.imageSmoothingQuality = "high"

  context.beginPath()
  tracePathOrRect(context, width, height, squircleParams)
  context.closePath()
  if (squircleParams !== null) {
    context.clip()
  }

  if (crop && crop.width > 0 && crop.height > 0) {
    context.drawImage(
      image,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      width,
      height,
    )
  } else {
    context.drawImage(image, 0, 0, width, height)
  }
  context.restore()

  if (borderParams !== null) {
    context.save()
    context.translate(borderParams.originX, borderParams.originY)
    context.beginPath()
    tracePathOrRect(
      context,
      borderParams.width,
      borderParams.height,
      borderParams.params,
    )
    context.closePath()
    context.lineWidth = borderParams.strokeWidth
    context.strokeStyle = borderParams.color
    context.lineJoin = "round"
    context.stroke()
    context.restore()
  }
}
