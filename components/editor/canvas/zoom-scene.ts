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
  // Directional motion blur for a cursor-follow REFRAME (a sideways pan). The
  // smear vector is a signed fraction of the artboard (x of width, y of height)
  // so it is resolution-independent; the renderer multiplies by the filter-input
  // size. Zero except during a reframe — a plain zoom (scale change) uses the
  // radial blur above, not this.
  panBlurX: number
  panBlurY: number
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
  panBlurX: 0,
  panBlurY: 0,
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

// --- Cursor follow (hold + reframe-on-exit) ------------------------------
//
// While a clip is held zoomed, the camera keeps the recorded cursor in the
// visible window WITHOUT sliding continuously with it (the "scene + cursor both
// move" churn is exactly what we are avoiding). Instead the frame HOLDS still
// and only REFRAMES — one eased move that recentres on the cursor — when the
// cursor is about to leave a generous inner "safe box". Between reframes the
// camera does not move at all.
//
// "Hold then reframe" is STATEFUL (it remembers where it settled), which would
// break the pure per-frame sampler that keeps preview == export. So we
// PRECOMPUTE a follow path per clip from the recorded cursor (deterministic:
// fixed-rate sampling of a fixed track) — timed focus anchors with eased moves
// between them. `sampleZoomCameraAtTime` then just reads the path, so the
// sampler stays pure and replayable and the editor preview, hover, and export
// all follow identically. A clip whose cursor never leaves the safe box gets no
// path and renders byte-identically to a plain fixed-focus zoom.

export type ZoomFollowParams = {
  /** Cursor sampling rate (Hz) for the precompute walk. */
  sampleHz: number
  /**
   * The cursor may roam this fraction of the window's half-extent away from the
   * frame centre before a reframe triggers. Larger = holds longer / fewer
   * reframes (more stable); smaller = reframes sooner (cursor stays more
   * centred). A reframe recentres the cursor, so this is also the roam budget
   * before the *next* reframe — the hysteresis that prevents thrashing.
   */
  safeFraction: number
  /** Eased duration (seconds) of a single reframe move. */
  transitionSec: number
}

export const ZOOM_FOLLOW_DEFAULTS: ZoomFollowParams = {
  sampleHz: 30,
  // A generous dead zone: the camera holds still through small cursor wanders and
  // only reframes on a real excursion (calmer motion; fewer reframes). The hybrid
  // detector also ships a stable gen-time focus anchor, so within a hold the
  // cursor usually stays inside this box and no reframe path is built at all.
  safeFraction: 0.84,
  // A gentler, longer reframe glide when one is needed.
  transitionSec: 0.65,
}

// --- Reframe motion blur (directional) -----------------------------------
//
// A reframe pans the camera sideways (scale held). We smear the zoomed content
// along the travel direction with a directional motion blur — the same look the
// cursor sprite uses — proportional to the focus pan velocity. It is computed
// from the follow path (a central difference on the eased focus), so it ramps in
// and out on its own: the `smootherstep` reframe has zero slope at both ends, so
// the blur fades up to a mid-reframe peak and back to zero. SUBTLE by default;
// the cursor layer is excluded from it (it keeps only its own velocity blur).

/** Shutter window (s): focus velocity × this = the per-shutter smear length. */
const ZOOM_PAN_BLUR_SHUTTER_SECONDS = 1 / 30
/** Overall strength. Lower = subtler. Tuned so a typical reframe peaks ~3-4%. */
const ZOOM_PAN_BLUR_GAIN = 0.3
/** Hard cap on the smear as a fraction of the artboard (bounds the worst case). */
const ZOOM_PAN_BLUR_CAP = 0.05
/** Below this fraction the smear is dropped (filter off — avoids a 1-tap no-op). */
const ZOOM_PAN_BLUR_MIN = 1e-3
/** Velocity sample half-window (s) for the central-difference focus velocity. */
const ZOOM_PAN_BLUR_VELOCITY_DT = 1 / 240

/** One timed focus keyframe on a clip's follow path (`fx`/`fy` are stored focus). */
type ZoomFollowAnchor = { t: number; fx: number; fy: number }

/**
 * A precomputed cursor-follow path for one clip: the focus holds at each anchor
 * and eases to the next over `transitionSec`. Always ≥2 anchors (a single-anchor
 * path is indistinguishable from a fixed focus and is dropped to `null`).
 */
export type ZoomFollowPath = {
  transitionSec: number
  anchors: ZoomFollowAnchor[]
}

/** Per-clip follow paths, keyed by clip id. */
export type ZoomFollowPaths = ReadonlyMap<string, ZoomFollowPath>

/** Samples the recorded cursor's artboard-normalized focus at a timeline time. */
export type CursorFocusSampler = (
  timelineSeconds: number
) => { x: number; y: number } | null

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
function cameraFromState(state: ZoomState, artboard: ArtboardSize): ZoomCamera {
  if (state.scale <= 1 + ZOOM_IDENTITY_EPSILON) return IDENTITY_ZOOM_CAMERA
  return {
    scale: state.scale,
    offsetX: state.fx * artboard.width * (1 - state.scale),
    offsetY: state.fy * artboard.height * (1 - state.scale),
    radialBlur: clampUnit(state.radialBlur),
    radialBlurCenterX: state.fx,
    radialBlurCenterY: state.fy,
    radialBlurSettings: ZOOM_RADIAL_BLUR_SHADER,
    panBlurX: state.panBlurX,
    panBlurY: state.panBlurY,
    clipId: state.clipId,
  }
}

// Intermediate camera state (scale + focus + blur) before the transform is built.
// `panBlurX/Y` are the directional reframe smear; `null` means identity.
type ZoomState = {
  scale: number
  fx: number
  fy: number
  radialBlur: number
  panBlurX: number
  panBlurY: number
  clipId: string
}

/**
 * A clip's own ease ramp from/to identity — the scale ramps (radial zoom around
 * the anchor) while the focus is held FIXED at `fx`/`fy`. Ease-in anchors on the
 * clip's own focus; ease-out anchors on wherever the follow path settled, so the
 * camera glides out from its final held frame rather than snapping back.
 */
function easeState(
  clip: ResolvedZoomClip,
  progress: number,
  velocity: number,
  fx: number,
  fy: number
): ZoomState | null {
  const scale = 1 + (clip.scale - 1) * progress
  if (scale <= 1 + ZOOM_IDENTITY_EPSILON) return null
  const scaleVelocity = (clip.scale - 1) * velocity
  const motion = clampUnit((scaleVelocity / scale) * ZOOM_BLUR_MOTION_GAIN)
  // Ease ramps are zooms → radial blur only; no directional pan blur.
  return {
    scale,
    fx,
    fy,
    radialBlur: clip.blur * motion,
    panBlurX: 0,
    panBlurY: 0,
    clipId: clip.id,
  }
}

function clampRange(value: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, value))
}

/**
 * Precompute the hold + reframe-on-exit follow path for one resolved clip.
 * Greedy walk over the clip's hold interval: hold the current frame until the
 * cursor leaves its safe box, then drop a new anchor that recentres on the
 * cursor and skip past the reframe so the catch-up frames can't immediately
 * re-trigger. Returns `null` when there is no zoom, no usable cursor data, or
 * the cursor never left the safe box (→ a plain fixed-focus zoom).
 */
function computeFollowPath(
  clip: ResolvedZoomClip,
  sampleCursor: CursorFocusSampler,
  params: ZoomFollowParams
): ZoomFollowPath | null {
  if (clip.scale <= 1 + ZOOM_IDENTITY_EPSILON) return null
  const inv = 1 - 1 / clip.scale
  if (inv <= 0) return null
  const span = clip.holdEnd - clip.holdStart
  if (span <= 0) return null

  const half = 1 / (2 * clip.scale)
  const safeHalf = clampUnit(params.safeFraction) * half
  // Centre range that keeps the window fully inside the artboard [0,1].
  const minCenter = half
  const maxCenter = 1 - half
  const dt = 1 / Math.max(1, params.sampleHz)
  const transition = Math.max(0, params.transitionSec)

  const fx0 = clampUnit(clip.fx)
  const fy0 = clampUnit(clip.fy)
  const anchors: ZoomFollowAnchor[] = [{ t: clip.holdStart, fx: fx0, fy: fy0 }]
  let centerX = fx0 * inv + half
  let centerY = fy0 * inv + half

  for (let t = clip.holdStart; t <= clip.holdEnd + 1e-9; t += dt) {
    const c = sampleCursor(t)
    if (!c) continue
    const cx = clampUnit(c.x)
    const cy = clampUnit(c.y)
    // Inside the safe box → keep holding, camera perfectly still.
    if (
      Math.abs(cx - centerX) <= safeHalf &&
      Math.abs(cy - centerY) <= safeHalf
    ) {
      continue
    }
    const nextCenterX = clampRange(cx, minCenter, maxCenter)
    const nextCenterY = clampRange(cy, minCenter, maxCenter)
    // Already as centred as the window can get (cursor near the artboard edge) —
    // don't drop a no-op anchor that would just thrash in place.
    if (
      Math.abs(nextCenterX - centerX) < ZOOM_IDENTITY_EPSILON &&
      Math.abs(nextCenterY - centerY) < ZOOM_IDENTITY_EPSILON
    ) {
      continue
    }
    centerX = nextCenterX
    centerY = nextCenterY
    anchors.push({
      t,
      fx: clampUnit((nextCenterX - half) / inv),
      fy: clampUnit((nextCenterY - half) / inv),
    })
    // Skip past the reframe so its catch-up frames don't re-trigger a reframe.
    t += transition
  }

  if (anchors.length < 2) return null
  return { transitionSec: transition, anchors }
}

/**
 * Precompute cursor-follow paths for every enabled clip. Call this OFF the hot
 * path (only when clips / cursor track / artboard change) and pass the result
 * to {@link sampleZoomCameraAtTime}. The editor preview and the exporter build
 * it the same way from the same cursor mapping, so the two follow identically.
 */
export function computeZoomFollowPaths(
  clips: readonly CanvasZoomClipInput[],
  sampleCursor: CursorFocusSampler,
  overrides?: Partial<ZoomFollowParams>
): Map<string, ZoomFollowPath> {
  const params = { ...ZOOM_FOLLOW_DEFAULTS, ...overrides }
  const paths = new Map<string, ZoomFollowPath>()
  for (const input of clips) {
    if (input.enabled === false || input.end <= input.start) continue
    const clip = resolveZoomClip(input)
    const path = computeFollowPath(clip, sampleCursor, params)
    if (path) paths.set(clip.id, path)
  }
  return paths
}

/** Focus at time `t` along a follow path: hold each anchor, ease to the next. */
function sampleFollowFocus(
  path: ZoomFollowPath,
  t: number
): { fx: number; fy: number } {
  const { anchors } = path
  let i = 0
  for (let k = 0; k < anchors.length; k++) {
    if (anchors[k].t <= t) i = k
    else break
  }
  const cur = anchors[i]
  if (i === 0) return { fx: cur.fx, fy: cur.fy }
  const prev = anchors[i - 1]
  const u =
    path.transitionSec > 0 ? clampUnit((t - cur.t) / path.transitionSec) : 1
  const e = smootherstep(u)
  return {
    fx: prev.fx + (cur.fx - prev.fx) * e,
    fy: prev.fy + (cur.fy - prev.fy) * e,
  }
}

/** The clip's focus at `t`, following the precomputed path when one exists. */
function followFocusFor(
  clip: ResolvedZoomClip,
  t: number,
  paths: ZoomFollowPaths | null
): { fx: number; fy: number } {
  const path = paths?.get(clip.id)
  if (!path) return { fx: clip.fx, fy: clip.fy }
  return sampleFollowFocus(path, t)
}

/**
 * Directional reframe blur at `t`: a signed smear vector (artboard fraction)
 * from the follow path's focus velocity. Zero while holding (velocity ~0) and at
 * both ends of a reframe; peaks mid-reframe. Returns `{0,0}` when the clip has no
 * follow path. The content shifts by `Δfocus·(scale−1)` of the artboard, so the
 * smear scales with both the pan speed and the zoom depth.
 */
function panBlurFor(
  clip: ResolvedZoomClip,
  t: number,
  scale: number,
  paths: ZoomFollowPaths | null
): { x: number; y: number } {
  const path = paths?.get(clip.id)
  const depth = scale - 1
  if (!path || depth <= 0) return { x: 0, y: 0 }
  const dt = ZOOM_PAN_BLUR_VELOCITY_DT
  const before = sampleFollowFocus(path, t - dt)
  const after = sampleFollowFocus(path, t + dt)
  const k = (depth * ZOOM_PAN_BLUR_SHUTTER_SECONDS * ZOOM_PAN_BLUR_GAIN) / (2 * dt)
  return {
    x: clampPanSmear((after.fx - before.fx) * k),
    y: clampPanSmear((after.fy - before.fy) * k),
  }
}

function clampPanSmear(value: number) {
  const v = Math.max(-ZOOM_PAN_BLUR_CAP, Math.min(ZOOM_PAN_BLUR_CAP, value))
  return Math.abs(v) < ZOOM_PAN_BLUR_MIN ? 0 : v
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

/**
 * The settled / transitioning camera state at `t`. The held + ease-out + weld
 * branches read the per-clip follow path (via {@link followFocusFor}) so the
 * focus tracks the cursor's hold + reframe motion; with no path they use the
 * clip's fixed focus and behave exactly as a plain zoom.
 */
function computeZoomState(
  resolved: readonly ResolvedZoomClip[],
  t: number,
  paths: ZoomFollowPaths | null
): ZoomState | null {
  // 1. Held inside a clip's settle interval → full settled zoom. The focus
  //    follows the precomputed path (held still, eased reframes); a reframe pan
  //    adds a directional motion blur (no radial blur — the scale is steady).
  for (const c of resolved) {
    if (t >= c.holdStart && t <= c.holdEnd && t < c.end) {
      if (c.scale <= 1 + ZOOM_IDENTITY_EPSILON) return null
      const f = followFocusFor(c, t, paths)
      const pan = panBlurFor(c, t, c.scale, paths)
      return {
        scale: c.scale,
        fx: f.fx,
        fy: f.fy,
        radialBlur: 0,
        panBlurX: pan.x,
        panBlurY: pan.y,
        clipId: c.id,
      }
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
    // Weld between A's FINAL held frame and B's INITIAL frame, so a reframe that
    // moved A's focus carries through the cross-clip glide.
    const fa = followFocusFor(a, a.holdEnd, paths)
    const fb = followFocusFor(b, b.holdStart, paths)
    return {
      scale,
      fx: fa.fx + (fb.fx - fa.fx) * u,
      fy: fa.fy + (fb.fy - fa.fy) * u,
      radialBlur: (a.blur + (b.blur - a.blur) * u) * motion,
      // Welds keep their radial (zoom) blur; reframe pan blur is reframes-only.
      panBlurX: 0,
      panBlurY: 0,
      clipId: u < 0.5 ? a.id : b.id,
    }
  }

  // 3. A clip's own (non-welded) ease-in from identity — focus anchored on the
  //    clip's own point (the follow path's first anchor), scale ramping.
  for (const c of resolved) {
    if (t >= c.start && t < c.holdStart) {
      const easeIn = c.holdStart - c.start
      if (easeIn <= 0) continue
      const raw = (t - c.start) / easeIn
      return easeState(
        c,
        transitionCurveValue(c.curve, raw),
        curveSlope(c.curve, raw) / easeIn,
        c.fx,
        c.fy
      )
    }
  }

  // 4. A clip's own (non-welded) ease-out to identity — focus anchored on the
  //    final held frame the follow path settled on, scale ramping back down.
  for (const c of resolved) {
    if (t > c.holdEnd && t < c.end) {
      const easeOut = c.end - c.holdEnd
      if (easeOut <= 0) continue
      const raw = (t - c.holdEnd) / easeOut
      const f = followFocusFor(c, c.holdEnd, paths)
      return easeState(
        c,
        1 - transitionCurveValue(c.curve, raw),
        curveSlope(c.curve, raw) / easeOut,
        f.fx,
        f.fy
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
 * `followPaths` are the precomputed per-clip cursor-follow paths (see
 * {@link computeZoomFollowPaths}); when present the camera holds a stable frame
 * and reframes only when the cursor is about to leave the window. Pass `null` /
 * omit to render plain fixed-focus zooms (identical to no follow).
 */
export function sampleZoomCameraAtTime(
  clips: readonly CanvasZoomClipInput[],
  artboard: ArtboardSize,
  compositionSeconds: number,
  followPaths?: ZoomFollowPaths | null
): ZoomCamera {
  // Resolve + sort enabled clips: welding needs neighbor order. Zoom tracks hold
  // a handful of clips, so this per-frame pass is cheap; if the track ever grows
  // large, precompute the resolved list per camera-timeline change instead.
  const resolved = clips
    .filter((c) => c.enabled !== false && c.end > c.start)
    .map(resolveZoomClip)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  if (resolved.length === 0) return IDENTITY_ZOOM_CAMERA

  const state = computeZoomState(resolved, compositionSeconds, followPaths ?? null)
  if (!state) return IDENTITY_ZOOM_CAMERA

  return cameraFromState(state, artboard)
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
    Math.abs(a.panBlurX - b.panBlurX) < ZOOM_IDENTITY_EPSILON &&
    Math.abs(a.panBlurY - b.panBlurY) < ZOOM_IDENTITY_EPSILON &&
    a.clipId === b.clipId
  )
}
