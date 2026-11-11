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
// Tracing is allocation-free and pure-Canvas2D: only `moveTo`, `lineTo`, and
// `bezierCurveTo` calls (the middle arc is emitted as cubic béziers — see
// `traceArcAsBeziers`). The per-corner constants depend only on
// `(radius, smoothing, budget)`, so callers can reuse the same object across
// every redraw at a given configuration + size.
//
// References:
//   - Figma blog, "Desperately Seeking Squircles":
//     https://www.figma.com/blog/desperately-seeking-squircles/
//   - figma-squircle (the reference implementation of the budget clamp +
//     preserveSmoothing redistribution): https://github.com/phamfoo/figma-squircle
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
 * Compute the per-corner squircle constants.
 *
 * `budget` is the per-corner rounding-and-smoothing budget — the maximum
 * distance the curve may extend from the corner along each adjacent edge,
 * i.e. `min(width, height) / 2` of the box being traced. Without it the
 * smoothing extension `p = (1 + smoothing) · radius` can overrun half the
 * edge and the traced outline self-intersects (backwards edges, overlapping
 * corner curves), which PixiJS triangulation renders as notches/spikes.
 *
 * When `p` overruns the budget we keep the requested smoothing (the curvature
 * profile of the arc + perpendicular handles stays intact) and redistribute
 * the straight-edge bezier handles `a`/`b` inside the remaining room — the
 * `preserveSmoothing` behavior of the figma-squircle reference implementation.
 */
export function computeSquircleCornerParams(
  radius: number,
  smoothing: number,
  budget: number
): SquircleCornerParams {
  const safeBudget = Number.isFinite(budget) && budget > 0 ? budget : 0
  const safeRadius =
    Number.isFinite(radius) && radius > 0 ? Math.min(radius, safeBudget) : 0
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
  let p = (1 + s) * safeRadius
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
  let b = remaining / 3
  let a = 2 * b

  // Not enough straight edge for the full smoothing extension: cap `p` at the
  // budget and squeeze the in-edge handles (P1/P2) into the room left after
  // the arc and the perpendicular handles. Keeps `a + b + c + d +
  // arcSectionLength ≤ budget`, so the path can never self-intersect.
  // (figma-squircle's `preserveSmoothing` branch.)
  if (p > safeBudget) {
    const p1ToP3MaxDistance = Math.max(
      0,
      safeBudget - d - arcSectionLength - c
    )
    // Keep some distance between P1 and P2 so the ramp does not kink.
    const minA = p1ToP3MaxDistance / 6
    const maxB = p1ToP3MaxDistance - minA
    b = Math.min(b, maxB)
    a = p1ToP3MaxDistance - b
    p = safeBudget
  }

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

/**
 * Minimal subset of Canvas2D used for tracing. Both `CanvasRenderingContext2D`
 * and PixiJS `Graphics` / `GraphicsContext` implement this structurally.
 *
 * The optional `smoothness` trailing argument on `bezierCurveTo` is the PixiJS
 * adaptive-tessellation fidelity hint (0..1, higher = finer subdivision);
 * Canvas2D implementations simply ignore the extra argument.
 */
type SquircleContext = {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
    smoothness?: number
  ): void
  rect(x: number, y: number, w: number, h: number): void
}

/**
 * Tessellation fidelity passed to PixiJS `bezierCurveTo`. Pixi's adaptive
 * subdivision tolerance is `(1 - smoothness)²` in *local* (artboard) pixels;
 * the default 0.5 leaves ~0.25 px deviations that become visible 1 px+ facets
 * once the composition zoom camera (≤4×) and viewport zoom magnify the
 * artboard. 0.98 keeps deviation ≈ 0.02 local px — sub-pixel at any zoom the
 * editor reaches — while the recursion limit (8) still bounds worst-case
 * vertex counts. Geometry is rebuilt only on appearance/size changes, never
 * per frame, so the extra vertices do not affect the render loop.
 */
const CURVE_FIDELITY = 0.98

/**
 * Emit a circular arc as cubic bézier segments (≤ 45° each, standard
 * `k = 4/3 · tan(Δ/4)` construction — max radial error ~0.002 % of the
 * radius). PixiJS's `arc()` tessellates with a fixed step count that ignores
 * tessellation fidelity and facets visibly under zoom magnification; routing
 * the corner arc through `bezierCurveTo` keeps the whole squircle outline on
 * the adaptive (fidelity-controlled) code path. Assumes the current path
 * point already sits at the arc's start angle, which the squircle
 * construction guarantees.
 */
function traceArcAsBeziers(
  context: SquircleContext,
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number
): void {
  const sweep = endAngle - startAngle
  if (!(Math.abs(sweep) > 1e-9) || radius <= 0) return

  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 4)))
  const delta = sweep / segments
  const k = (4 / 3) * Math.tan(delta / 4)

  let angle = startAngle
  for (let i = 0; i < segments; i++) {
    const next = angle + delta
    const cos1 = Math.cos(angle)
    const sin1 = Math.sin(angle)
    const cos2 = Math.cos(next)
    const sin2 = Math.sin(next)
    context.bezierCurveTo(
      cx + radius * (cos1 - k * sin1),
      cy + radius * (sin1 + k * cos1),
      cx + radius * (cos2 + k * sin2),
      cy + radius * (sin2 - k * cos2),
      cx + radius * cos2,
      cy + radius * sin2,
      CURVE_FIDELITY
    )
    angle = next
  }
}

/**
 * Trace a squircle outline at (0,0)–(width,height). The caller owns
 * `beginPath()` / `closePath()` / `fill()` / `clip()`.
 *
 * Allocation-free hot path: 4 corners × (2 ramp béziers + ≤2 arc béziers) +
 * 4 line segments. Each draw issues ~20 canvas calls, no garbage, no
 * temporary objects. Every curve carries the `CURVE_FIDELITY` tessellation
 * hint so PixiJS subdivides finely enough to stay smooth under zoom.
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
    d,
    CURVE_FIDELITY
  )
  // Top-right corner arc: centered at (width - radius, radius), radius r.
  // Sweeps from angle (-π/2 + α) to (-α). When smoothing = 0 the arc is the
  // full quarter.
  traceArcAsBeziers(
    context,
    width - radius,
    radius,
    radius,
    -HALF_PI + angleAlpha,
    -angleAlpha
  )
  context.bezierCurveTo(
    width,
    p - a - b,
    width,
    p - a,
    width,
    p,
    CURVE_FIDELITY
  )

  // ── Right edge → bottom-right corner ──
  context.lineTo(width, height - p)
  context.bezierCurveTo(
    width,
    height - p + a,
    width,
    height - p + a + b,
    width - d,
    height - p + a + b + c,
    CURVE_FIDELITY
  )
  traceArcAsBeziers(
    context,
    width - radius,
    height - radius,
    radius,
    angleAlpha,
    HALF_PI - angleAlpha
  )
  context.bezierCurveTo(
    width - p + a + b,
    height,
    width - p + a,
    height,
    width - p,
    height,
    CURVE_FIDELITY
  )

  // ── Bottom edge → bottom-left corner ──
  context.lineTo(p, height)
  context.bezierCurveTo(
    p - a,
    height,
    p - a - b,
    height,
    p - a - b - c,
    height - d,
    CURVE_FIDELITY
  )
  traceArcAsBeziers(
    context,
    radius,
    height - radius,
    radius,
    HALF_PI + angleAlpha,
    Math.PI - angleAlpha
  )
  context.bezierCurveTo(
    0,
    height - p + a + b,
    0,
    height - p + a,
    0,
    height - p,
    CURVE_FIDELITY
  )

  // ── Left edge → top-left corner ──
  context.lineTo(0, p)
  context.bezierCurveTo(
    0,
    p - a,
    0,
    p - a - b,
    d,
    p - a - b - c,
    CURVE_FIDELITY
  )
  traceArcAsBeziers(
    context,
    radius,
    radius,
    radius,
    Math.PI + angleAlpha,
    3 * HALF_PI - angleAlpha
  )
  context.bezierCurveTo(
    p - a - b,
    0,
    p - a,
    0,
    p,
    0,
    CURVE_FIDELITY
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
