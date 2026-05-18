// iOS / macOS-style continuous corners (squircle), implemented via Figma's
// reverse-engineering of Apple's algorithm. Each rounded corner is composed of
// three subsegments:
//
//   1. A cubic Bézier ramping off the straight edge.
//   2. A circular arc (radius = `cornerRadius`) covering the middle of the
//      corner. At `cornerSmoothing = 0` this arc is the full 90° fillet —
//      identical to CSS `border-radius`. At `cornerSmoothing = 1` it shrinks
//      to zero degrees and the corner is entirely bezier.
//   3. A second cubic Bézier easing back onto the adjacent straight edge.
//
// `cornerSmoothing` is a single 0..1 knob:
//   0   → circular arc only (CSS `border-radius`).
//   0.6 → macOS / iOS look (default).
//   1   → fully continuous curvature.
//
// Tracing is allocation-free and pure-Canvas2D: only `moveTo`, `lineTo`,
// `bezierCurveTo`, and `arc` calls. The per-corner constants depend only on
// `(radius, smoothing)`, so callers should memoize them and pass the same
// object across every redraw at a given configuration.
//
// References:
//   - Figma blog, "Desperately Seeking Squircles":
//     https://www.figma.com/blog/desperately-seeking-squircles/
//   - Apple HIG (continuous corners): macOS/iOS app icons use the same
//     superellipse approximation.

export type SquircleCornerParams = {
  /** Effective corner radius after smoothing-aware geometry. */
  radius: number
  /** Distance from each corner along a straight edge to where the curve begins. */
  p: number
  /** First bezier handle offset, along the straight edge. */
  a: number
  /** Second bezier handle offset, along the straight edge. */
  b: number
  /** First perpendicular offset (parallel to the adjacent edge) at the arc-join point. */
  c: number
  /** Second perpendicular offset at the arc-join point. */
  d: number
  /** Angle (radians) between the straight edge and the line from corner to arc-join. */
  angleAlpha: number
  /** Angle (radians) the circular arc sweeps. */
  arcSweep: number
}

const HALF_PI = Math.PI / 2

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value
}

/**
 * Clamp a requested radius to half of the shorter side. Anything larger would
 * cause overlapping corners and self-intersecting paths.
 */
export function clampSquircleRadius(
  width: number,
  height: number,
  radius: number
): number {
  if (!Number.isFinite(radius) || radius <= 0) return 0
  if (width <= 0 || height <= 0) return 0
  return Math.min(radius, Math.min(width, height) / 2)
}

/**
 * Compute the per-corner squircle constants. Independent of width/height, so
 * a single object can be reused across draws while the node is being resized.
 */
export function computeSquircleCornerParams(
  radius: number,
  smoothing: number
): SquircleCornerParams {
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 0
  const s = clamp(smoothing, 0, 1)

  if (safeRadius <= 0) {
    return {
      radius: 0,
      p: 0,
      a: 0,
      b: 0,
      c: 0,
      d: 0,
      angleAlpha: 0,
      arcSweep: 0,
    }
  }

  // "Soft" radius — the curve extends `p` units along each adjacent edge.
  // When smoothing = 0 this collapses to the classic radius.
  const p = (1 + s) * safeRadius
  // Middle arc sweep: 90° at smoothing 0, shrinking linearly to 0° at smoothing 1.
  const arcSweep = HALF_PI * (1 - s)
  // Length of the chord across the middle arc — used by the Figma derivation
  // to express the remaining straight-edge budget split between bezier
  // handles (a, b, c, d). The chord runs at 45° from the corner.
  const arcSectionLength = Math.sin(arcSweep / 2) * safeRadius * Math.sqrt(2)
  // angleAlpha: where the arc joins the bezier ramp, measured from the
  // straight edge. Equals 0 when arc is a full quarter circle (smoothing=0).
  const angleAlpha = (HALF_PI - arcSweep) / 2
  const p3ToP4Distance = safeRadius * Math.tan(angleAlpha / 2)
  // angleBeta controls how the perpendicular handles c, d distribute. Empirically
  // tuned by Figma to match Apple's algorithm.
  const angleBeta = (HALF_PI / 2) * s
  const c = p3ToP4Distance * Math.cos(angleBeta)
  const d = c * Math.tan(angleBeta)
  // Remaining straight-edge length, split 2:1 between the two bezier handles.
  const remaining = p - arcSectionLength - c - d
  const b = remaining / 3
  const a = 2 * b

  return {
    radius: safeRadius,
    p,
    a,
    b,
    c,
    d,
    angleAlpha,
    arcSweep,
  }
}

/** Minimal subset of Canvas2D used for tracing. Konva.Context implements this. */
type SquircleContext = {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number
  ): void
  arc(
    cx: number,
    cy: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean
  ): void
  rect(x: number, y: number, w: number, h: number): void
}

/**
 * Trace a squircle outline at (0,0)–(width,height). The caller owns
 * `beginPath()` / `closePath()` / `fill()` / `clip()`.
 *
 * Allocation-free hot path: 4 corners × (2 bezier curves + 1 arc) + 4 line
 * segments. Each draw issues ~16 canvas calls, no garbage, no temporary
 * objects.
 */
export function traceSquirclePath(
  context: SquircleContext,
  width: number,
  height: number,
  params: SquircleCornerParams
): void {
  const { radius, p, a, b, c, d, angleAlpha } = params

  if (radius <= 0 || width <= 0 || height <= 0) {
    context.rect(0, 0, width, height)
    return
  }

  // Start on the top edge just past the top-left corner zone, then trace
  // clockwise around the rect. Each corner is: bezier in → arc → bezier out.

  // ── Top-left corner ──
  // (We enter the top edge here.)
  context.moveTo(p, 0)

  // ── Top edge → top-right corner ──
  context.lineTo(width - p, 0)
  context.bezierCurveTo(
    width - p + a,
    0,
    width - p + a + b,
    0,
    width - p + a + b + c,
    d
  )
  // Top-right corner arc: centered at (width - radius, radius), radius r.
  // Sweep clockwise (Canvas2D `counterclockwise = false`) from angle
  // (-π/2 + α) to (-α). When smoothing = 0 the arc is the full quarter.
  context.arc(
    width - radius,
    radius,
    radius,
    -HALF_PI + angleAlpha,
    -angleAlpha,
    false
  )
  context.bezierCurveTo(
    width,
    p - a - b,
    width,
    p - a,
    width,
    p
  )

  // ── Right edge → bottom-right corner ──
  context.lineTo(width, height - p)
  context.bezierCurveTo(
    width,
    height - p + a,
    width,
    height - p + a + b,
    width - d,
    height - p + a + b + c
  )
  context.arc(
    width - radius,
    height - radius,
    radius,
    angleAlpha,
    HALF_PI - angleAlpha,
    false
  )
  context.bezierCurveTo(
    width - p + a + b,
    height,
    width - p + a,
    height,
    width - p,
    height
  )

  // ── Bottom edge → bottom-left corner ──
  context.lineTo(p, height)
  context.bezierCurveTo(
    p - a,
    height,
    p - a - b,
    height,
    p - a - b - c,
    height - d
  )
  context.arc(
    radius,
    height - radius,
    radius,
    HALF_PI + angleAlpha,
    Math.PI - angleAlpha,
    false
  )
  context.bezierCurveTo(
    0,
    height - p + a + b,
    0,
    height - p + a,
    0,
    height - p
  )

  // ── Left edge → top-left corner ──
  context.lineTo(0, p)
  context.bezierCurveTo(
    0,
    p - a,
    0,
    p - a - b,
    d,
    p - a - b - c
  )
  context.arc(
    radius,
    radius,
    radius,
    Math.PI + angleAlpha,
    -HALF_PI - angleAlpha + 2 * Math.PI,
    false
  )
  context.bezierCurveTo(
    p - a - b,
    0,
    p - a,
    0,
    p,
    0
  )
}

/**
 * Trace either a squircle or plain rectangle, depending on whether the params
 * carry a positive radius. Useful as a single call site for the sceneFunc.
 */
export function tracePathOrRect(
  context: SquircleContext,
  width: number,
  height: number,
  params: SquircleCornerParams | null
): void {
  if (params === null || params.radius <= 0) {
    context.rect(0, 0, width, height)
    return
  }
  traceSquirclePath(context, width, height, params)
}
