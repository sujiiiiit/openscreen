// Spring primitives ported verbatim from Cap (the screen-studio app) so the
// composition zoom feels identical: the zoom AMOUNT ramps on a closed-form
// mass-spring-damper step response, and the auto-mode FOCUS follows the cursor
// through a stateful spring integrated at a fixed step. Both share one set of
// physical constants (Cap's `ScreenMovementSpring`), so the in-ramp overshoot
// and the focus glide read as one coherent motion.
//
// Everything here is PURE and deterministic (no Date / Math.random / wall clock)
// so the editor preview and the offscreen exporter produce byte-identical
// frames. Sources: Cap `crates/rendering/src/zoom.rs` (spring_ease /
// spring_ease_out) and `crates/rendering/src/spring_mass_damper.rs`.

/** Cap `ScreenMovementSpring` defaults (configuration.rs:489). */
export const ZOOM_SPRING_STIFFNESS = 200
export const ZOOM_SPRING_DAMPING = 40
export const ZOOM_SPRING_MASS = 2.25

/**
 * Cap's `ZOOM_DURATION` (zoom.rs:5): the reference window, in seconds, over
 * which the amount spring rings out to its target. We fit the spring SHAPE into
 * each clip's own `transition.durationMs` window (so the duration knob still
 * works) — this constant documents the value the spring was tuned at (1.0 s).
 */
export const ZOOM_SPRING_DURATION_SECONDS = 1.0

/** Fixed precompute step for the focus follow (Cap `SAMPLE_INTERVAL_MS`). */
export const FOCUS_SAMPLE_INTERVAL_MS = 8

/**
 * Lag leash for the focus follow (Cap zoom_focus_interpolation.rs:505-519): the
 * smoothed focus may trail the live cursor target by at most
 * `clamp(viewportHalf * RATIO, MIN, MAX)` (fraction of the frame). Beyond that
 * the position is snapped back onto the leash and its velocity bled down, so a
 * fast flick never drags the cursor out of the zoomed window.
 */
export const FOCUS_LAG_RATIO = 0.65
export const FOCUS_LAG_MIN = 0.12
export const FOCUS_LAG_MAX = 0.28

/** Edge-snap dead-zone (Cap `edge_snap_ratio` default, zoom.rs:97-107). */
export const ZOOM_EDGE_SNAP_RATIO = 0.25

/**
 * Idle hold: when two cursor samples are farther apart in time than this, the
 * follow holds the previous position instead of interpolating across the gap
 * (Cap `IDLE_GAP_MS`, zoom_focus_interpolation.rs:420). ~15 fps.
 */
export const FOCUS_IDLE_GAP_MS = 66.67

/**
 * Predictive intent lookahead for auto-mode focus follow. The cursor track is
 * known before preview/export sampling, so the camera can blend each live target
 * slightly toward the near future. This turns L-shaped cursor moves (right, then
 * down) into a smoother diagonal camera intent instead of a visible right-then-
 * down chase.
 */
export const FOCUS_INTENT_LOOKAHEAD_MS = 280
export const FOCUS_INTENT_BLEND = 0.58

// --- Amount easing: closed-form mass-spring-damper step response -----------

function clamp01(value: number) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * Normalized unit-step response of a mass-spring-damper at normalized time `t`
 * (0→1), parameterized by undamped angular frequency `omega0` and damping ratio
 * `zeta`. `f(0)=0`, `f(1)→1` (rung out). Underdamped (`zeta<1`) overshoots
 * slightly near the end; otherwise the critically-damped form is used. This is
 * the exact body of Cap's `spring_ease` (zoom.rs:148-168).
 */
function springStepResponse(t: number, omega0: number, zeta: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  if (zeta < 1) {
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta)
    const decay = Math.exp(-zeta * omega0 * t)
    return (
      1 -
      decay *
        (Math.cos(omegaD * t) +
          ((zeta * omega0) / omegaD) * Math.sin(omegaD * t))
    )
  }
  const decay = Math.exp(-omega0 * t)
  return 1 - decay * (1 + omega0 * t)
}

const SPRING_OMEGA0 = Math.sqrt(ZOOM_SPRING_STIFFNESS / ZOOM_SPRING_MASS)
const SPRING_ZETA =
  ZOOM_SPRING_DAMPING /
  (2 * Math.sqrt(ZOOM_SPRING_STIFFNESS * ZOOM_SPRING_MASS))

/** Zoom-IN amount easing (Cap `spring_ease`): underdamped, slight overshoot. */
export function springEase(t: number): number {
  return springStepResponse(t, SPRING_OMEGA0, SPRING_ZETA)
}

/**
 * Zoom-OUT amount easing (Cap `spring_ease_out`, zoom.rs:170-191): the same
 * response softened (`omega0 * 0.9`, `zeta * 1.15`) so the zoom-out is gentler
 * and overshoot-free. Callers additionally multiply by a leading smoothstep
 * ramp to erase the spring's start discontinuity (see zoom-scene ease-out).
 */
export function springEaseOut(t: number): number {
  return springStepResponse(t, SPRING_OMEGA0 * 0.9, SPRING_ZETA * 1.15)
}

/**
 * Magnitude of d(springEase)/dt in normalized-t space (central difference) —
 * the velocity that drives the radial zoom blur. A single smooth bump: fast in
 * the middle of the ramp, ~flat at the ends. Mirrors zoom-scene's `curveSlope`.
 */
export function springSlope(ease: (t: number) => number, t: number): number {
  const dt = 1 / 240
  return Math.abs(ease(t + dt) - ease(t - dt)) / (dt * 2)
}

// --- Focus follow: stateful spring integrator ------------------------------

export type Vec2 = { x: number; y: number }

export type SpringConfig = {
  /** Spring constant k. */
  tension: number
  /** Mass m. */
  mass: number
  /** Damping coefficient c. */
  friction: number
}

export const ZOOM_FOCUS_SPRING_CONFIG: SpringConfig = {
  tension: ZOOM_SPRING_STIFFNESS,
  mass: ZOOM_SPRING_MASS,
  friction: ZOOM_SPRING_DAMPING,
}

const REST_VELOCITY_THRESHOLD = 0.0001
const REST_DISPLACEMENT_THRESHOLD = 0.00001
const CRITICAL_EPSILON = 0.01

/**
 * One-dimensional analytic spring step (Cap `solve_spring_1d`,
 * spring_mass_damper.rs:22-76). Advances both displacement (from rest target)
 * and velocity by `t` seconds. Handles under / critical / over-damped cases.
 */
function solveSpring1d(
  displacement: number,
  velocity: number,
  t: number,
  omega0: number,
  zeta: number
): [number, number] {
  if (zeta < 1 - CRITICAL_EPSILON) {
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta)
    const decay = Math.exp(-zeta * omega0 * t)
    const cosTerm = Math.cos(omegaD * t)
    const sinTerm = Math.sin(omegaD * t)
    const a = displacement
    const b = (velocity + displacement * zeta * omega0) / Math.max(omegaD, 1e-4)
    const newDisp = decay * (a * cosTerm + b * sinTerm)
    const newVel =
      decay *
      ((b * omegaD - a * zeta * omega0) * cosTerm -
        (a * omegaD + b * zeta * omega0) * sinTerm)
    return [newDisp, newVel]
  }
  if (zeta > 1 + CRITICAL_EPSILON) {
    const sqrtTerm = Math.sqrt(zeta * zeta - 1)
    const s1 = -omega0 * (zeta - sqrtTerm)
    const s2 = -omega0 * (zeta + sqrtTerm)
    const denom = s1 - s2
    if (Math.abs(denom) < 1e-10) {
      const sAvg = 0.5 * (s1 + s2)
      const decay = Math.exp(sAvg * t)
      const newDisp =
        decay * (displacement + (velocity - displacement * sAvg) * t)
      const newVel =
        decay *
        (velocity -
          displacement * sAvg +
          sAvg * (displacement + (velocity - displacement * sAvg) * t))
      return [newDisp, newVel]
    }
    const c1 = (velocity - displacement * s2) / denom
    const c2 = displacement - c1
    const e1 = Math.exp(s1 * t)
    const e2 = Math.exp(s2 * t)
    return [c1 * e1 + c2 * e2, c1 * s1 * e1 + c2 * s2 * e2]
  }
  const decay = Math.exp(-omega0 * t)
  const a = displacement
  const b = velocity + displacement * omega0
  const newDisp = decay * (a + b * t)
  const newVel = decay * (b - omega0 * (a + b * t))
  return [newDisp, newVel]
}

/**
 * Stateful 2D mass-spring-damper used for the auto-mode focus follow (Cap
 * `SpringMassDamperSimulation`). Drive it by setting a target each step and
 * calling {@link run} with the elapsed milliseconds; read {@link position}.
 */
export class SpringMassDamperSimulation {
  private tension: number
  private mass: number
  private friction: number
  position: Vec2 = { x: 0, y: 0 }
  velocity: Vec2 = { x: 0, y: 0 }
  target: Vec2 = { x: 0, y: 0 }

  constructor(config: SpringConfig) {
    this.tension = config.tension
    this.mass = config.mass
    this.friction = config.friction
  }

  setPosition(p: Vec2) {
    this.position = { x: p.x, y: p.y }
  }
  setVelocity(v: Vec2) {
    this.velocity = { x: v.x, y: v.y }
  }
  setTarget(p: Vec2) {
    this.target = { x: p.x, y: p.y }
  }

  /** Advance by `dtMs` milliseconds toward the current target. */
  run(dtMs: number): Vec2 {
    if (dtMs <= 0) return this.position
    const t = dtMs / 1000
    const mass = Math.max(this.mass, 0.001)
    const omega0 = Math.sqrt(this.tension / mass)
    const zeta = this.friction / (2 * Math.sqrt(this.tension * mass))

    const dispX = this.position.x - this.target.x
    const dispY = this.position.y - this.target.y
    const [newDispX, newVelX] = solveSpring1d(
      dispX,
      this.velocity.x,
      t,
      omega0,
      zeta
    )
    const [newDispY, newVelY] = solveSpring1d(
      dispY,
      this.velocity.y,
      t,
      omega0,
      zeta
    )

    this.position = {
      x: this.target.x + newDispX,
      y: this.target.y + newDispY,
    }
    this.velocity = { x: newVelX, y: newVelY }

    const dispMag = Math.hypot(newDispX, newDispY)
    const velMag = Math.hypot(newVelX, newVelY)
    if (
      dispMag < REST_DISPLACEMENT_THRESHOLD &&
      velMag < REST_VELOCITY_THRESHOLD
    ) {
      this.position = { x: this.target.x, y: this.target.y }
      this.velocity = { x: 0, y: 0 }
    }
    return this.position
  }
}

/**
 * Edge-snap remap (Cap `snap_to_edges`, zoom.rs:97-107). Maps the middle
 * `[ratio, 1-ratio]` band of an axis onto the full `[0,1]` pan range and clamps
 * outside it, so a focus near an edge pins fully to that edge instead of
 * trying to centre on it (which would reveal off-frame area).
 */
export function snapToEdges(scalar: number, snapRatio: number): number {
  if (snapRatio <= 0) return scalar
  const lo = snapRatio
  const hi = 1 - snapRatio + 0.0001
  if (hi <= lo) return 0.5
  return clamp01((scalar - lo) / (hi - lo))
}
