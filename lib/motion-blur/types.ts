/** Parameters for the motion-blur filter, shared by the Pixi, WebGL, and CPU paths. */
export interface MotionBlurOptions {
  /** Horizontal motion, in pixels. */
  velocityX: number
  /** Vertical motion, in pixels. */
  velocityY: number
  /** Number of samples averaged along the velocity vector. Odd, >= 5. */
  kernelSize: number
  /** Shifts the sampling window along the velocity vector. */
  offset: number
}

export const DEFAULT_MOTION_BLUR_OPTIONS: MotionBlurOptions = {
  velocityX: 40,
  velocityY: 40,
  kernelSize: 15,
  offset: 0,
}

/**
 * Mirrors Pixi's behaviour: a zero velocity collapses to a passthrough
 * (Pixi forces `uKernelSize = 0` in that case — see `MotionBlurFilter._updateDirty`).
 */
export function effectiveKernelSize(options: MotionBlurOptions): number {
  if (options.velocityX === 0 && options.velocityY === 0) return 0
  return Math.trunc(options.kernelSize)
}

/**
 * The transparent margin (px, per side) the blur needs so the smear can spill
 * beyond the sprite instead of being clipped to its rectangle. This is exactly
 * Pixi's `MotionBlurFilter` padding (`max(|vx|,|vy|) >> 0) + 1`), which the Pixi
 * filter system uses to expand the render target. Konva gets the same margin via
 * `node.cache({ offset })`; the WebGL path expands its source canvas by this much.
 */
export function motionBlurPadding(options: MotionBlurOptions): number {
  if (options.velocityX === 0 && options.velocityY === 0) return 0
  return Math.trunc(Math.max(Math.abs(options.velocityX), Math.abs(options.velocityY))) + 1
}
