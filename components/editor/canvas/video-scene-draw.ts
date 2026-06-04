import {
  clampSquircleRadius,
  computeSquircleCornerParams,
  type SquircleCornerParams,
} from "@/lib/squircle"
import { parseRgba } from "@/lib/rgba-color"

/**
 * Minimal style description for a video's appearance. Both the live editor
 * (`CanvasVideoItem`) and the export pipeline (`ProjectVideo`) conform to this
 * shape, so the `compute*Params` helpers below are the single source of truth for
 * the size-independent corner/border/shadow geometry — shared by the Pixi
 * preview appearance (`pixi/video-appearance.ts`) and the offscreen export
 * (`export/build-stage.ts`), keeping preview and encoded frame pixel-identical.
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
