// Stage: framing. The "always keep the subject in frame" solver. Given a
// subject region (a point for a click, a span for a selection/cluster), it
// chooses the focus + scale so the WHOLE region stays inside the zoomed view:
//
//   • A point subject gets the base scale (the renderer keeps an edge focus
//     visible, so the point is always in frame).
//   • A large subject (a selection / spread cluster) scales DOWN until the
//     region — plus padding — fits inside the visible window (size 1/scale of
//     the artboard). This is the in-frame guarantee for spans.
//
// Pure and deterministic. Full pan/follow-cam (a moving focus inside one hold)
// is intentionally deferred.

import { clampZoomFocus } from "@/lib/zoom-clips"
import type { CanvasZoomFocus } from "@/types/editor-canvas"

import { rectCenter } from "./geometry"
import type { AutoZoomParams } from "./params"
import type { NormRect } from "./types"

/** Quantize to 0.05 steps so adjacent clips don't ping-pong on float noise. */
function quantizeScale(scale: number, max: number): number {
  const capped = Math.min(max, Math.max(1, scale))
  return Math.round(capped / 0.05) * 0.05
}

export interface Framing {
  focus: CanvasZoomFocus
  scale: number
}

/**
 * Resolve the focus + scale that keeps `region` fully framed.
 *
 * @param region    Subject region (artboard-normalized; zero-size for a point).
 * @param baseScale The desired magnification when the region is small.
 * @param params    Thresholds (`zoomMax`, `framePadding`).
 */
export function solveFraming(
  region: NormRect,
  baseScale: number,
  params: AutoZoomParams
): Framing {
  const maxDim = Math.max(region.width, region.height) * (1 + params.framePadding)
  // Largest scale whose visible window (1/scale) still contains the padded
  // region. Unbounded for a point → capped at zoomMax.
  const fitScale = maxDim > 0 ? 1 / maxDim : params.zoomMax
  const scale = quantizeScale(
    Math.min(baseScale, fitScale, params.zoomMax),
    params.zoomMax
  )
  return { focus: clampZoomFocus(rectCenter(region)), scale }
}

/**
 * Base magnification for a window from its CONFIDENCE — the "everything zooms,
 * the difference is how much" rule. A plain (confidence 1) click gets the base
 * scale; higher confidence (a click on a target, typing, a double-click, or a
 * dense cluster whose scores accumulate) zooms further, up to `zoomMax`. This is
 * the desired magnification before {@link solveFraming} shrinks it to fit a
 * large region.
 */
export function baseScaleForConfidence(
  confidence: number,
  typing: boolean,
  params: AutoZoomParams
): number {
  const base = typing ? params.zoomTyping : params.zoomScale
  const scaled = base + Math.max(0, confidence - 1) * params.confidenceGain
  return Math.min(params.zoomMax, Math.max(1, scaled))
}
