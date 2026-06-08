import {
  ZOOM_BLUR_MOTION_GAIN,
  ZOOM_RADIAL_BLUR_SHADER,
  clampZoomFocus,
  clampZoomScale,
  clampZoomTransitionSettings,
  withZoomClipDefaults,
  zoomRadialBlurSettingsEqual,
  type CanvasZoomClipInput,
} from "@/lib/zoom-clips"
import type {
  CanvasZoomClip,
  CanvasZoomFocus,
  CanvasZoomRadialBlurSettings,
  CanvasZoomTransitionCurve,
} from "@/types/editor-canvas"

const ZOOM_IDENTITY_EPSILON = 1e-4

type ArtboardSize = { width: number; height: number }

const ZOOM_FOCUS_CENTER: CanvasZoomFocus = { x: 0.5, y: 0.5 }

export type ZoomCamera = {
  scale: number
  offsetX: number
  offsetY: number
  radialBlur: number
  radialBlurCenterX: number
  radialBlurCenterY: number
  radialBlurSettings: CanvasZoomRadialBlurSettings
  clipId: string | null
}

export type ZoomVisibleWindow = {
  x: number
  y: number
  width: number
  height: number
}

export const IDENTITY_ZOOM_CAMERA: ZoomCamera = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  radialBlur: 0,
  radialBlurCenterX: 0.5,
  radialBlurCenterY: 0.5,
  radialBlurSettings: ZOOM_RADIAL_BLUR_SHADER,
  clipId: null,
}

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value))
}

function smoothstep(value: number) {
  const t = clampUnit(value)
  return t * t * (3 - 2 * t)
}

function smootherstep(value: number) {
  const t = clampUnit(value)
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function easeOutCubic(value: number) {
  const t = clampUnit(value)
  return 1 - Math.pow(1 - t, 3)
}

function transitionCurveValue(curve: CanvasZoomTransitionCurve, value: number) {
  switch (curve) {
    case "linear":
      return clampUnit(value)
    case "smootherstep":
      return smootherstep(value)
    case "ease-out-cubic":
      return easeOutCubic(value)
    case "smoothstep":
    default:
      return smoothstep(value)
  }
}

// Magnitude of d(curve)/dt in normalized-t space (central difference). The eased
// progress moves fastest mid-transition and is ~flat at both ends, so this is a
// single smooth bump — exactly the shape a zoom blur should follow.
function curveSlope(curve: CanvasZoomTransitionCurve, value: number) {
  const dt = 1 / 240
  const before = transitionCurveValue(curve, value - dt)
  const after = transitionCurveValue(curve, value + dt)
  return Math.abs(after - before) / (dt * 2)
}

function easeTiming(clip: CanvasZoomClip): {
  easeInSeconds: number
  easeOutSeconds: number
} {
  const duration = Math.max(0, clip.end - clip.start)
  const transition = clampZoomTransitionSettings(clip.transition)
  const rampSeconds = Math.max(0, transition.durationMs) / 1000
  const easeInSeconds = Math.min(duration, rampSeconds)
  const easeOutSeconds = Math.min(duration, rampSeconds)
  const total = easeInSeconds + easeOutSeconds
  if (total <= duration) return { easeInSeconds, easeOutSeconds }
  const scale = duration / Math.max(total, 1e-6)
  return {
    easeInSeconds: easeInSeconds * scale,
    easeOutSeconds: easeOutSeconds * scale,
  }
}

// --- Continuous zoom (welding) -------------------------------------------
//
// Adjacent / near-adjacent zoom clips transition the camera DIRECTLY from one
// settled zoom to the next (e.g. 2.5x@A → 1.7x@B) instead of dropping to 1x and
// back — the "pump" between back-to-back clips. The weld engages when the gap
// between two clips is small *relative to their durations*, computed
// dynamically. Clips with a real gap are untouched (identical to before), so a
// single clip and well-separated clips render exactly as they used to.

// Weld when the inter-clip gap is below this fraction of the shorter clip's
// duration, clamped to [min, max] seconds. Bigger gaps keep their wide beat.
const ZOOM_WELD_GAP_FRACTION = 0.25
const ZOOM_WELD_GAP_MIN_SECONDS = 0.12
const ZOOM_WELD_GAP_MAX_SECONDS = 0.6
// Weld transitions use the baked smootherstep glide regardless of either clip's
// own curve, so the cross-clip pan/zoom reads consistently.
const ZOOM_WELD_CURVE: CanvasZoomTransitionCurve = "smootherstep"

// --- Cursor follow -------------------------------------------------------
//
// While zoomed, the recorded cursor must never leave the visible window. The
// camera keeps the cursor inside an inner "dead zone" of the window and only
// pans (shifting the focus) once the cursor crosses that boundary — pinning it
// at the edge of the dead zone. This is STATELESS (depends only on focus, scale,
// and the cursor position at the sampled time), so it stays deterministic for
// export and arbitrary seeking. A larger fraction = follow only near the very
// edge (fixed framing for normal pointer movement); smaller = the camera tracks
// the cursor more eagerly.
const ZOOM_FOLLOW_DEAD_FRACTION = 0.8

// A clip resolved to its sampling-ready form: settled scale/focus, ease ramp
// lengths, and the hold interval [holdStart, holdEnd] where it sits fully zoomed.
type ResolvedZoomClip = {
  start: number
  end: number
  scale: number
  fx: number
  fy: number
  blur: number
  curve: CanvasZoomTransitionCurve
  holdStart: number
  holdEnd: number
  id: string
}

function resolveZoomClip(input: CanvasZoomClipInput): ResolvedZoomClip {
  const clip = withZoomClipDefaults(input)
  const { easeInSeconds, easeOutSeconds } = easeTiming(clip)
  const focus = clampZoomFocus(clip.focus)
  return {
    start: clip.start,
    end: clip.end,
    scale: clampZoomScale(clip.scale),
    fx: focus.x,
    fy: focus.y,
    blur: clampUnit(clip.radialBlur),
    curve: clampZoomTransitionSettings(clip.transition).curve,
    holdStart: clip.start + easeInSeconds,
    holdEnd: clip.end - easeOutSeconds,
    id: clip.id,
  }
}

/** Build the camera transform from a resolved (scale, focus) state. */
function cameraFromState(
  scale: number,
  fx: number,
  fy: number,
  radialBlur: number,
  clipId: string,
  artboard: ArtboardSize
): ZoomCamera {
  if (scale <= 1 + ZOOM_IDENTITY_EPSILON) return IDENTITY_ZOOM_CAMERA
  return {
    scale,
    offsetX: fx * artboard.width * (1 - scale),
    offsetY: fy * artboard.height * (1 - scale),
    radialBlur: clampUnit(radialBlur),
    radialBlurCenterX: fx,
    radialBlurCenterY: fy,
    radialBlurSettings: ZOOM_RADIAL_BLUR_SHADER,
    clipId,
  }
}

// Intermediate camera state (scale + focus + blur amount) before the cursor
// follow nudges the focus and the transform is built. `null` means identity.
type ZoomState = {
  scale: number
  fx: number
  fy: number
  radialBlur: number
  clipId: string
}

/**
 * A clip's own ease ramp from/to identity — focus stays FIXED at the clip's
 * point while only the scale ramps (radial zoom around the anchor). This is the
 * single-clip behavior, unchanged.
 */
function easeState(
  clip: ResolvedZoomClip,
  progress: number,
  velocity: number
): ZoomState | null {
  const scale = 1 + (clip.scale - 1) * progress
  if (scale <= 1 + ZOOM_IDENTITY_EPSILON) return null
  const scaleVelocity = (clip.scale - 1) * velocity
  const motion = clampUnit((scaleVelocity / scale) * ZOOM_BLUR_MOTION_GAIN)
  return { scale, fx: clip.fx, fy: clip.fy, radialBlur: clip.blur * motion, clipId: clip.id }
}

/**
 * Shift one axis of the focus so the cursor stays inside the window's dead zone.
 * Returns the focus unchanged while the cursor is comfortably inside; once it
 * crosses the dead-zone boundary the focus moves to pin the cursor there. `inv`
 * is `1 - 1/scale` (> 0), `half` the window half-width `1/(2·scale)`.
 */
function followAxis(
  focus: number,
  cursor: number,
  inv: number,
  half: number,
  deadHalf: number
): number {
  const center = focus * inv + half
  let desired = center
  if (cursor < center - deadHalf) desired = cursor + deadHalf
  else if (cursor > center + deadHalf) desired = cursor - deadHalf
  else return focus
  return clampUnit((desired - half) / inv)
}

/** Keep the cursor inside the zoom window by nudging the focus (both axes). */
function applyCursorFollow(
  fx: number,
  fy: number,
  scale: number,
  cursor: { x: number; y: number }
): { x: number; y: number } {
  const inv = 1 - 1 / scale
  if (inv <= 0) return { x: fx, y: fy }
  const half = 1 / (2 * scale)
  const deadHalf = half * ZOOM_FOLLOW_DEAD_FRACTION
  return {
    x: followAxis(fx, clampUnit(cursor.x), inv, half, deadHalf),
    y: followAxis(fy, clampUnit(cursor.y), inv, half, deadHalf),
  }
}

/** Whether two adjacent clips should weld into a continuous transition. */
function shouldWeldClips(a: ResolvedZoomClip, b: ResolvedZoomClip): boolean {
  if (a.scale <= 1 + ZOOM_IDENTITY_EPSILON) return false
  if (b.scale <= 1 + ZOOM_IDENTITY_EPSILON) return false
  const gap = Math.max(0, b.start - a.end)
  const durMin = Math.min(a.end - a.start, b.end - b.start)
  const threshold = Math.min(
    ZOOM_WELD_GAP_MAX_SECONDS,
    Math.max(ZOOM_WELD_GAP_MIN_SECONDS, ZOOM_WELD_GAP_FRACTION * durMin)
  )
  return gap <= threshold
}

export function getZoomCameraCenterForTarget(
  target: CanvasZoomFocus,
  scale: number,
  artboard: ArtboardSize
): CanvasZoomFocus {
  const safeTarget = clampZoomFocus(target)
  const safeScale = clampZoomScale(scale)
  if (
    safeScale <= 1 + ZOOM_IDENTITY_EPSILON ||
    artboard.width <= 0 ||
    artboard.height <= 0
  ) {
    return ZOOM_FOCUS_CENTER
  }

  const width = 1 / safeScale
  const height = 1 / safeScale
  return {
    x: safeTarget.x * (1 - width) + width / 2,
    y: safeTarget.y * (1 - height) + height / 2,
  }
}

// Legacy name kept for older call sites/tests. The returned value is the camera
// center of the focus-anchored visible window, not the stored focus point.
export function clampZoomFocusForScale(
  focus: CanvasZoomFocus,
  scale: number,
  artboard: ArtboardSize
): CanvasZoomFocus {
  return getZoomCameraCenterForTarget(focus, scale, artboard)
}

export function getZoomVisibleWindow(
  target: CanvasZoomFocus,
  scale: number,
  artboard: ArtboardSize
): ZoomVisibleWindow {
  const safeScale = clampZoomScale(scale)
  const safeTarget = clampZoomFocus(target)
  const width = 1 / safeScale
  const height = 1 / safeScale
  return {
    x: artboard.width > 0 ? safeTarget.x * (1 - width) : 0,
    y: artboard.height > 0 ? safeTarget.y * (1 - height) : 0,
    width,
    height,
  }
}

/** The settled / transitioning camera state at `t`, before the cursor follow. */
function computeZoomState(
  resolved: readonly ResolvedZoomClip[],
  t: number
): ZoomState | null {
  // 1. Held inside a clip's settle interval → full settled zoom, no blur.
  for (const c of resolved) {
    if (t >= c.holdStart && t <= c.holdEnd && t < c.end) {
      if (c.scale <= 1 + ZOOM_IDENTITY_EPSILON) return null
      return { scale: c.scale, fx: c.fx, fy: c.fy, radialBlur: 0, clipId: c.id }
    }
  }

  // 2. Continuous weld between two near-adjacent clips: blend settled state
  //    A → B (scale AND focus) directly across A's ease-out, the gap, and B's
  //    ease-in — never returning to 1x.
  for (let i = 0; i < resolved.length - 1; i++) {
    const a = resolved[i]
    const b = resolved[i + 1]
    if (t < a.holdEnd || t >= b.holdStart) continue
    if (!shouldWeldClips(a, b)) continue
    const windowDur = b.holdStart - a.holdEnd
    if (windowDur <= 0) continue
    const raw = (t - a.holdEnd) / windowDur
    const u = transitionCurveValue(ZOOM_WELD_CURVE, raw)
    const scale = a.scale + (b.scale - a.scale) * u
    // Blur tracks how fast the magnification is changing across the weld — a
    // smaller swing (2.5→1.7) blurs gentler than a full zoom from 1x.
    const slope = curveSlope(ZOOM_WELD_CURVE, raw) / windowDur
    const scaleVelocity = Math.abs(b.scale - a.scale) * slope
    const motion = clampUnit((scaleVelocity / Math.max(scale, 1e-6)) * ZOOM_BLUR_MOTION_GAIN)
    return {
      scale,
      fx: a.fx + (b.fx - a.fx) * u,
      fy: a.fy + (b.fy - a.fy) * u,
      radialBlur: (a.blur + (b.blur - a.blur) * u) * motion,
      clipId: u < 0.5 ? a.id : b.id,
    }
  }

  // 3. A clip's own (non-welded) ease-in from identity, focus fixed.
  for (const c of resolved) {
    if (t >= c.start && t < c.holdStart) {
      const easeIn = c.holdStart - c.start
      if (easeIn <= 0) continue
      const raw = (t - c.start) / easeIn
      return easeState(c, transitionCurveValue(c.curve, raw), curveSlope(c.curve, raw) / easeIn)
    }
  }

  // 4. A clip's own (non-welded) ease-out to identity, focus fixed.
  for (const c of resolved) {
    if (t > c.holdEnd && t < c.end) {
      const easeOut = c.end - c.holdEnd
      if (easeOut <= 0) continue
      const raw = (t - c.holdEnd) / easeOut
      return easeState(
        c,
        1 - transitionCurveValue(c.curve, raw),
        curveSlope(c.curve, raw) / easeOut
      )
    }
  }

  // 5. In a real gap (or outside every clip) → fully wide.
  return null
}

/**
 * Sample the composition zoom camera at `compositionSeconds`. Shared by editor
 * preview, hover preview, and export.
 *
 * When `cursor` (the recorded cursor's artboard-normalized position at this
 * time) is provided, the camera follows it so the pointer never leaves the
 * zoomed window — a stateless dead-zone clamp on the focus. Pass `null` /
 * omit to disable following (identical to the prior behavior).
 */
export function sampleZoomCameraAtTime(
  clips: readonly CanvasZoomClipInput[],
  artboard: ArtboardSize,
  compositionSeconds: number,
  cursor?: { x: number; y: number } | null
): ZoomCamera {
  // Resolve + sort enabled clips: welding needs neighbor order. Zoom tracks hold
  // a handful of clips, so this per-frame pass is cheap; if the track ever grows
  // large, precompute the resolved list per camera-timeline change instead.
  const resolved = clips
    .filter((c) => c.enabled !== false && c.end > c.start)
    .map(resolveZoomClip)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  if (resolved.length === 0) return IDENTITY_ZOOM_CAMERA

  const state = computeZoomState(resolved, compositionSeconds)
  if (!state) return IDENTITY_ZOOM_CAMERA

  let { fx, fy } = state
  if (cursor && state.scale > 1 + ZOOM_IDENTITY_EPSILON) {
    const followed = applyCursorFollow(fx, fy, state.scale, cursor)
    fx = followed.x
    fy = followed.y
  }
  return cameraFromState(state.scale, fx, fy, state.radialBlur, state.clipId, artboard)
}

export function zoomCamerasEqual(a: ZoomCamera, b: ZoomCamera) {
  return (
    Math.abs(a.scale - b.scale) < ZOOM_IDENTITY_EPSILON &&
    Math.abs(a.offsetX - b.offsetX) < ZOOM_IDENTITY_EPSILON &&
    Math.abs(a.offsetY - b.offsetY) < ZOOM_IDENTITY_EPSILON &&
    Math.abs(a.radialBlur - b.radialBlur) < ZOOM_IDENTITY_EPSILON &&
    Math.abs(a.radialBlurCenterX - b.radialBlurCenterX) <
      ZOOM_IDENTITY_EPSILON &&
    Math.abs(a.radialBlurCenterY - b.radialBlurCenterY) <
      ZOOM_IDENTITY_EPSILON &&
    zoomRadialBlurSettingsEqual(a.radialBlurSettings, b.radialBlurSettings) &&
    a.clipId === b.clipId
  )
}
