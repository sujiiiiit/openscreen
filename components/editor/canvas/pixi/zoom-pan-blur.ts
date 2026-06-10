import { MotionBlurFilter } from "pixi-filters/motion-blur"

import type { ZoomCamera } from "../zoom-scene"

/** MotionBlurFilter requires an odd kernel size ≥ 5. */
function toOddKernelSize(kernelSize: number): number {
  const n = Math.max(5, Math.trunc(kernelSize))
  return n % 2 === 0 ? n + 1 : n
}

/**
 * Cap on the kernel taps. The filter samples `kernelSize` points along the
 * velocity vector, so it tracks the smear length to stay well-sampled, but a
 * long smear is bounded here so a worst-case reframe (a big pan at deep zoom on
 * a 4K export) can't blow up the per-pixel cost of the whole-composite pass. The
 * pan blur is only ever active for the ~0.3-0.5 s of a reframe. Raised from 51 so
 * the high-ceiling pan smear (a fast flick now reaches ~14% of the artboard, up
 * from ~5%) stays smooth instead of banding at the top end.
 */
const ZOOM_PAN_BLUR_MAX_KERNEL = 81

export function createZoomPanBlurFilter(): MotionBlurFilter {
  const filter = new MotionBlurFilter()
  // Same MSAA reasoning as the radial zoom blur (see `zoom-blur.ts`): the pan
  // blur wraps the squircle-masked composite, so without inherited multisampling
  // the rounded video corners turn jagged while a reframe is smearing.
  filter.antialias = "inherit"
  return filter
}

/**
 * Map a {@link ZoomCamera}'s directional reframe smear (a signed fraction of the
 * artboard) onto a Pixi `MotionBlurFilter`, given the filter-input size in px
 * (the rendered composite: artboard × viewport scale in the preview, the output
 * size in the export). Returns whether the blur is active so the caller can
 * attach/detach the filter. The fraction-based input keeps the smear the same
 * proportion of the frame in preview and export — the mirror of `applyZoomBlur`.
 */
export function applyZoomPanBlur(
  filter: MotionBlurFilter,
  camera: ZoomCamera,
  inputWidth: number,
  inputHeight: number
): boolean {
  const vx = camera.panBlurX * inputWidth
  const vy = camera.panBlurY * inputHeight
  const speed = Math.hypot(vx, vy)
  if (speed <= 0) return false
  filter.velocity = { x: vx, y: vy }
  filter.kernelSize = toOddKernelSize(Math.min(ZOOM_PAN_BLUR_MAX_KERNEL, speed))
  filter.offset = 0
  return true
}
