import { ZoomBlurFilter } from "pixi-filters/zoom-blur"

import type { ZoomCamera } from "../zoom-scene"

/**
 * Cap on the zoom-blur strength — text-heavy screen content smears badly past
 * this. Strength is the fraction of each pixel's distance to the focus that it
 * smears across, so the absolute streak grows with artboard size; 0.10 bounds
 * the worst-case edge streak to ~5 % of the artboard width even when a high
 * per-clip Strength saturates the velocity bump (was 0.22, which let dark
 * recordings average to a black frame mid-ramp — see docs/editor-canvas.md →
 * "Zoom Blur Reads As Black On Dark Recordings").
 */
const ZOOM_BLUR_STRENGTH_CAP = 0.1
/** Fixed feather around the focus point that stays sharp (the "baked inner radius"). */
const ZOOM_BLUR_INNER_RADIUS_FRACTION = 0.02

export function createZoomBlurFilter(): ZoomBlurFilter {
  const filter = new ZoomBlurFilter()
  // Pixi filters default to `antialias: "off"`, which renders the filter input
  // into a non-multisampled texture. The zoom blur wraps the whole artboard
  // composite — including the squircle-masked videos — so without this the
  // rounded corners turn jagged the moment a zoom clip ramps. "inherit" keeps
  // the MSAA of the render target (the renderer inits with `antialias: true`).
  filter.antialias = "inherit"
  return filter
}

/**
 * Map a {@link ZoomCamera}'s radial-blur amount / center / settings onto a Pixi
 * `ZoomBlurFilter`, given the filter input size in px (the rendered composite:
 * artboard × viewport scale in the preview, the output size in the export).
 * Returns whether the blur is active (so the caller can attach/detach the filter).
 *
 * Mirrors the removed custom radial-zoom shader, which itself emulated
 * ZoomBlurFilter: `strength` is the fraction of the vector toward the center
 * (capped for text), `innerRadius` is a fixed 2% feather, `radius = -1` is
 * infinity, and `center` is in filter-input pixels (the shader divides by the
 * input size).
 */
export function applyZoomBlur(
  filter: ZoomBlurFilter,
  camera: ZoomCamera,
  inputWidth: number,
  inputHeight: number
): boolean {
  if (camera.radialBlur <= 0) return false
  filter.strength = Math.min(
    ZOOM_BLUR_STRENGTH_CAP,
    camera.radialBlur * (camera.radialBlurSettings.strength ?? 1)
  )
  filter.center = {
    x: camera.radialBlurCenterX * inputWidth,
    y: camera.radialBlurCenterY * inputHeight,
  }
  filter.innerRadius = ZOOM_BLUR_INNER_RADIUS_FRACTION * inputWidth
  filter.radius = -1
  return true
}
