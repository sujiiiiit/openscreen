import {
  clampSquircleRadius,
  computeSquircleCornerParams,
  type SquircleCornerParams,
} from "@/lib/squircle"

/**
 * Minimal style description for a video's appearance. Both the live editor
 * (`CanvasVideoItem`) and the export pipeline (`ProjectVideo`) conform to this
 * shape, so the `compute*Params` helpers below are the single source of truth for
 * the size-independent corner/border geometry — shared by the Pixi
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
  return computeSquircleCornerParams(
    safeRadius,
    source.cornerSmoothing,
    squircleBudget(source.width, source.height),
  )
}

/**
 * Per-corner rounding-and-smoothing budget of a box: how far a corner curve
 * may extend along each adjacent edge before opposite corners collide.
 */
function squircleBudget(width: number, height: number): number {
  return Math.min(width, height) / 2
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
      ? computeSquircleCornerParams(
          safeRadius,
          source.cornerSmoothing,
          squircleBudget(borderBoxWidth, borderBoxHeight),
        )
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
