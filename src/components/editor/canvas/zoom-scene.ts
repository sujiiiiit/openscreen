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
} from "@/types/editor-canvas"
import {
  FOCUS_IDLE_GAP_MS,
  FOCUS_INTENT_BLEND,
  FOCUS_INTENT_LOOKAHEAD_MS,
  FOCUS_LAG_MAX,
  FOCUS_LAG_MIN,
  FOCUS_LAG_RATIO,
  FOCUS_SAMPLE_INTERVAL_MS,
  SpringMassDamperSimulation,
  ZOOM_EDGE_SNAP_RATIO,
  ZOOM_FOCUS_SPRING_CONFIG,
  snapToEdges,
  springEase,
  springEaseOut,
  springSlope,
} from "./pixi/zoom-spring"

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

// Zoom-OUT progress, 0→1, over a normalized ramp `value`. Cap's softened spring
// (springEaseOut) multiplied by a leading smoothstep over the first 20% of the
// ramp, which erases the spring's start discontinuity so the first frames of a
// zoom-out are smooth (Cap zoom.rs:261-263). The zoom-IN ramp uses `springEase`
// directly; both come from the shared spring module (`./pixi/zoom-spring`).
function springEaseOutRamped(value: number) {
  const t = clampUnit(value)
  const ramp = Math.min(t * 5, 1)
  const rampSmooth = ramp * ramp * (3 - 2 * ramp)
  return springEaseOut(t) * rampSmooth
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

// --- Auto-mode cursor follow (spring) ------------------------------------
//
// For an `auto` clip, the focus point is NOT stored — the camera continuously
// spring-follows the recorded cursor (a port of Cap's zoom-focus model). The
// follow is computed OFFLINE (the whole cursor track is known up front), which
// also keeps it a pure function of (clip, cursor track) so preview == export:
//   • At a fixed 8 ms step over the hold, read the cursor's artboard focus and
//     drive a mass-spring-damper toward it (`ZOOM_FOCUS_SPRING_CONFIG`). The
//     spring gives the cinematic lag + settle — the camera trails the cursor and
//     eases in rather than sticking to the pointer.
//   • A LAG LEASH caps how far the smoothed focus may trail the live cursor
//     (`clamp(viewportHalf · FOCUS_LAG_RATIO, FOCUS_LAG_MIN, FOCUS_LAG_MAX)`),
//     snapping it back and bleeding velocity so a fast flick never drags the
//     cursor out of the zoomed window.
//   • EDGE SNAP (`ZOOM_EDGE_SNAP_RATIO`) pins the view to a frame edge when the
//     cursor nears it; storing the snapped focus in [0,1] also keeps the visible
//     window fully inside the artboard (no off-frame reveal), so no separate
//     centre clamp is needed.
//   • On an IDLE gap between cursor samples (> FOCUS_IDLE_GAP_MS) the target
//     holds its previous position instead of interpolating across the gap.
// The smoothed focus is baked into 8 ms keyframes; `sampleZoomCameraAtTime` then
// just lerps between them, so the sampler stays pure and replayable. A `manual`
// clip gets no path and renders as a plain fixed-focus zoom around its `focus`.

export type ZoomFollowParams = {
  /** Fixed precompute step (ms) for the spring integration. */
  sampleIntervalMs: number
  /** Lag-leash ratio of the viewport half-extent. */
  lagRatio: number
  /** Lag-leash floor (fraction of frame). */
  lagMin: number
  /** Lag-leash ceiling (fraction of frame). */
  lagMax: number
  /** Edge-snap dead-zone ratio. */
  edgeSnapRatio: number
  /** Hold the previous target when cursor samples are farther apart than this (ms). */
  idleGapMs: number
  /** Short future lookahead (ms) used to infer gesture intent. */
  intentLookaheadMs: number
  /** Blend toward the future cursor target, 0 = live only, 1 = future only. */
  intentBlend: number
}

export const ZOOM_FOLLOW_DEFAULTS: ZoomFollowParams = {
  sampleIntervalMs: FOCUS_SAMPLE_INTERVAL_MS,
  lagRatio: FOCUS_LAG_RATIO,
  lagMin: FOCUS_LAG_MIN,
  lagMax: FOCUS_LAG_MAX,
  edgeSnapRatio: ZOOM_EDGE_SNAP_RATIO,
  idleGapMs: FOCUS_IDLE_GAP_MS,
  intentLookaheadMs: FOCUS_INTENT_LOOKAHEAD_MS,
  intentBlend: FOCUS_INTENT_BLEND,
}

// --- Reframe motion blur (directional) -----------------------------------
//
// As the auto-mode camera pans to follow the cursor (scale held), we smear the
// zoomed content along the travel direction with a directional motion blur — the
// same look the cursor sprite uses — proportional to the focus pan velocity. It
// is a central difference on the spring-smoothed focus, so it ramps up and down
// on its own: the blur grows with the follow speed and falls to zero when the
// camera settles. SUBTLE by default; the cursor layer is excluded from it (it
// keeps only its own velocity blur).

/** Shutter window (s): focus velocity × this = the per-shutter smear length. */
const ZOOM_PAN_BLUR_SHUTTER_SECONDS = 1 / 30
/** Overall strength. Lower = subtler. Tuned so a typical reframe peaks ~3-4%. */
const ZOOM_PAN_BLUR_GAIN = 0.3
/**
 * Hard cap on the smear as a fraction of the artboard. Velocity-scaled with a
 * HIGH ceiling: the smear is proportional to the focus pan velocity (so a gentle
 * reframe stays ~3-4% — unchanged), and only the fastest flicks climb toward this
 * cap, producing a strong Screen-Studio-style directional smear that masks the
 * fast move. Active only during the ~0.3-0.5 s of a reframe.
 */
const ZOOM_PAN_BLUR_CAP = 0.14
/** Below this fraction the smear is dropped (filter off — avoids a 1-tap no-op). */
const ZOOM_PAN_BLUR_MIN = 1e-3
/** Velocity sample half-window (s) for the central-difference focus velocity. */
const ZOOM_PAN_BLUR_VELOCITY_DT = 1 / 240

/**
 * One spring-smoothed focus keyframe at time `t` (timeline seconds). `fx`/`fy`
 * are the stored focus the camera scales around (already edge-snapped). Sampled
 * at a fixed step, so consecutive keyframes are ~`sampleIntervalMs` apart.
 */
type ZoomFocusKeyframe = {
  t: number
  fx: number
  fy: number
}

/**
 * A precomputed auto-mode follow path for one clip: the spring-smoothed focus at
 * each fixed-step keyframe, plus the clip's constant hold scale (auto follow is
 * focus-only — it never changes magnification). `sampleZoomCameraAtTime` lerps
 * between keyframes. Only `auto` clips get a path; `manual` clips are `null`.
 */
export type ZoomFollowPath = {
  scale: number
  keyframes: ZoomFocusKeyframe[]
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
  mode: "auto" | "manual"
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
    mode: clip.mode,
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
  fy: number,
  settledScale: number = clip.scale
): ZoomState | null {
  const scale = 1 + (settledScale - 1) * progress
  if (scale <= 1 + ZOOM_IDENTITY_EPSILON) return null
  const scaleVelocity = (settledScale - 1) * velocity
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

function capTargetLead(
  current: CanvasZoomFocus,
  predicted: CanvasZoomFocus,
  maxLead: number
): CanvasZoomFocus {
  const dx = predicted.x - current.x
  const dy = predicted.y - current.y
  const dist = Math.hypot(dx, dy)
  if (dist <= maxLead || dist <= 1e-9) return predicted
  const scale = maxLead / dist
  return {
    x: current.x + dx * scale,
    y: current.y + dy * scale,
  }
}

/**
 * Precompute the auto-mode spring follow path for one resolved clip. Integrates a
 * mass-spring-damper toward the recorded cursor's focus at a fixed step across
 * the whole hold (offline — the cursor track is fully known), applies a lag leash
 * + edge-snap, and bakes the result into focus keyframes. Returns `null` for a
 * `manual` clip, a clip with no zoom, or one with no usable cursor data (→ a
 * plain fixed-focus zoom around `clip.fx/fy`).
 *
 * The stored focus is `snapToEdges(springPosition)`. Because that lands in [0,1]
 * and the focus→window-centre map keeps any focus in [0,1] inside the artboard,
 * this is equivalent to Cap's `calculate_follow_center` (snap → centre →
 * clamp) — no separate centre clamp is needed.
 */
function computeFollowPath(
  clip: ResolvedZoomClip,
  sampleCursor: CursorFocusSampler,
  params: ZoomFollowParams
): ZoomFollowPath | null {
  if (clip.mode !== "auto") return null
  if (clip.scale <= 1 + ZOOM_IDENTITY_EPSILON) return null
  if (clip.end - clip.start <= 0) return null

  const stepMs = Math.max(1, params.sampleIntervalMs)
  const stepSec = stepMs / 1000

  // Follow the cursor across the WHOLE clip span (ease-in, hold, ease-out) — like
  // Cap, the focus tracks the cursor throughout the segment, not only the hold.
  // This also means every auto clip gets a path (so a short clip still follows).
  //
  // Seed the spring ON THE CURSOR — at the clip start, or (if the cursor is
  // off-screen exactly there) the first on-screen sample in the clip. The
  // fallback is screen CENTRE (Cap's fallback), NEVER the clip's stored `focus`:
  // in auto mode that focus is meaningless and may be a leftover from manual
  // editing, so seeding from it would make the follow start at / drift from a
  // stale point instead of the cursor.
  let seedPos = sampleCursor(clip.start)
  if (!seedPos) {
    for (let t = clip.start + stepSec; t <= clip.end + 1e-9; t += stepSec) {
      const c = sampleCursor(t)
      if (c) {
        seedPos = c
        break
      }
    }
  }
  const seed = seedPos ?? { x: 0.5, y: 0.5 }
  let target = { x: clampUnit(seed.x), y: clampUnit(seed.y) }

  const sim = new SpringMassDamperSimulation(ZOOM_FOCUS_SPRING_CONFIG)
  sim.setPosition(target)
  sim.setVelocity({ x: 0, y: 0 })
  sim.setTarget(target)

  const viewportHalf = 0.5 / clip.scale
  const maxLag = clampRange(
    viewportHalf * params.lagRatio,
    params.lagMin,
    params.lagMax
  )
  const maxLead = maxLag
  const lookaheadSec = Math.max(0, params.intentLookaheadMs) / 1000
  const intentBlend = clampUnit(params.intentBlend)
  const snap = (v: number) => snapToEdges(clampUnit(v), params.edgeSnapRatio)
  const targetForTime = (t: number, current: CanvasZoomFocus) => {
    if (lookaheadSec <= 0 || intentBlend <= 0) return current
    const future = sampleCursor(Math.min(clip.end, t + lookaheadSec))
    if (!future) return current
    const predicted = {
      x: clampUnit(current.x + (clampUnit(future.x) - current.x) * intentBlend),
      y: clampUnit(current.y + (clampUnit(future.y) - current.y) * intentBlend),
    }
    return capTargetLead(current, predicted, maxLead)
  }

  const keyframes: ZoomFocusKeyframe[] = [
    { t: clip.start, fx: snap(target.x), fy: snap(target.y) },
  ]

  for (let t = clip.start + stepSec; t <= clip.end + 1e-9; t += stepSec) {
    // A null sample (cursor off-screen / no data) holds the previous target
    // rather than interpolating phantom motion across the gap.
    const c = sampleCursor(t)
    if (c) {
      const current = { x: clampUnit(c.x), y: clampUnit(c.y) }
      target = targetForTime(t, current)
    }
    sim.setTarget(target)
    sim.run(stepMs)

    // Lag leash: never let the smoothed focus trail the live cursor by more than
    // `maxLag` of the frame; snap it back and bleed velocity if it does.
    const dx = sim.position.x - target.x
    const dy = sim.position.y - target.y
    const distSq = dx * dx + dy * dy
    if (distSq > maxLag * maxLag) {
      const dist = Math.sqrt(distSq)
      const s = maxLag / dist
      sim.setPosition({ x: target.x + dx * s, y: target.y + dy * s })
      sim.setVelocity({ x: sim.velocity.x * s, y: sim.velocity.y * s })
    }

    keyframes.push({ t, fx: snap(sim.position.x), fy: snap(sim.position.y) })
  }

  if (keyframes.length < 2) return null
  return { scale: clip.scale, keyframes }
}

/**
 * Precompute cursor-follow paths for every enabled `auto` clip. Call this OFF the
 * hot path (only when clips / cursor track / artboard change) and pass the result
 * to {@link sampleZoomCameraAtTime}. The editor preview and the exporter build it
 * the same way from the same cursor mapping, so the two follow identically.
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

/**
 * Spring-smoothed (focus, scale) at time `t`: binary-search the keyframes and
 * lerp the focus between the two surrounding samples. Scale is constant across an
 * auto follow (focus-only), so it is read straight off the path.
 */
function sampleFollowState(
  path: ZoomFollowPath,
  t: number
): { fx: number; fy: number; scale: number } {
  const { keyframes, scale } = path
  if (keyframes.length === 0) return { fx: 0.5, fy: 0.5, scale }
  const first = keyframes[0]
  if (t <= first.t) return { fx: first.fx, fy: first.fy, scale }
  const last = keyframes[keyframes.length - 1]
  if (t >= last.t) return { fx: last.fx, fy: last.fy, scale }

  let lo = 0
  let hi = keyframes.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (keyframes[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = keyframes[lo]
  const b = keyframes[hi]
  const span = b.t - a.t
  const u = span > 0 ? clampUnit((t - a.t) / span) : 0
  return {
    fx: a.fx + (b.fx - a.fx) * u,
    fy: a.fy + (b.fy - a.fy) * u,
    scale,
  }
}

/** The clip's (focus, scale) at `t`, following the precomputed path when one exists. */
function followStateFor(
  clip: ResolvedZoomClip,
  t: number,
  paths: ZoomFollowPaths | null
): { fx: number; fy: number; scale: number } {
  const path = paths?.get(clip.id)
  if (!path) return { fx: clip.fx, fy: clip.fy, scale: clip.scale }
  return sampleFollowState(path, t)
}

/**
 * Directional reframe blur at `t`: a signed smear vector (artboard fraction)
 * from the follow path's focus velocity. Zero while holding (velocity ~0) and at
 * both ends of a reframe; peaks mid-reframe. Returns `{0,0}` when the clip has no
 * follow path. The content shifts by `Δfocus·(scale−1)` of the artboard, so the
 * smear scales with both the pan speed and the (possibly reduced) zoom depth.
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
  const before = sampleFollowState(path, t - dt)
  const after = sampleFollowState(path, t + dt)
  const k =
    (depth * ZOOM_PAN_BLUR_SHUTTER_SECONDS * ZOOM_PAN_BLUR_GAIN) / (2 * dt)
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
 * branches read the per-clip spring follow path (via {@link followStateFor}) so
 * an `auto` clip's focus tracks the cursor; a `manual` clip (no path) uses its
 * fixed focus and behaves exactly as a plain zoom. The amount ramps on the shared
 * mass-spring-damper curve (`springEase` / `springEaseOutRamped`).
 */
function computeZoomState(
  resolved: readonly ResolvedZoomClip[],
  t: number,
  paths: ZoomFollowPaths | null
): ZoomState | null {
  // 1. Held inside a clip's settle interval → full settled zoom. An `auto` clip's
  //    focus spring-follows the cursor; the sideways pan adds a directional blur.
  //    The scale is steady through the hold, so there is no radial (zoom) blur.
  for (const c of resolved) {
    if (t >= c.holdStart && t <= c.holdEnd && t < c.end) {
      if (c.scale <= 1 + ZOOM_IDENTITY_EPSILON) return null
      const st = followStateFor(c, t, paths)
      const pan = panBlurFor(c, t, st.scale, paths)
      return {
        scale: st.scale,
        fx: st.fx,
        fy: st.fy,
        radialBlur: 0,
        panBlurX: pan.x,
        panBlurY: pan.y,
        clipId: c.id,
      }
    }
  }

  // 2. Continuous weld between two near-adjacent clips: blend settled state
  //    A → B (scale AND focus) directly across A's ease-out, the gap, and B's
  //    ease-in — never returning to 1x — on the spring curve.
  for (let i = 0; i < resolved.length - 1; i++) {
    const a = resolved[i]
    const b = resolved[i + 1]
    if (t < a.holdEnd || t >= b.holdStart) continue
    if (!shouldWeldClips(a, b)) continue
    const windowDur = b.holdStart - a.holdEnd
    if (windowDur <= 0) continue
    const raw = (t - a.holdEnd) / windowDur
    const u = springEase(raw)
    // Weld between A's FINAL held frame and B's INITIAL frame, so a follow that
    // moved A's focus carries through the glide.
    const fa = followStateFor(a, a.holdEnd, paths)
    const fb = followStateFor(b, b.holdStart, paths)
    const scale = fa.scale + (fb.scale - fa.scale) * u
    // Blur tracks how fast the magnification is changing across the weld — a
    // smaller swing (2.5→1.7) blurs gentler than a full zoom from 1x.
    const slope = springSlope(springEase, raw) / windowDur
    const scaleVelocity = Math.abs(fb.scale - fa.scale) * slope
    const motion = clampUnit(
      (scaleVelocity / Math.max(scale, 1e-6)) * ZOOM_BLUR_MOTION_GAIN
    )
    return {
      scale,
      fx: fa.fx + (fb.fx - fa.fx) * u,
      fy: fa.fy + (fb.fy - fa.fy) * u,
      radialBlur: (a.blur + (b.blur - a.blur) * u) * motion,
      // Welds keep their radial (zoom) blur; the follow pan blur is hold-only.
      panBlurX: 0,
      panBlurY: 0,
      clipId: u < 0.5 ? a.id : b.id,
    }
  }

  // 3. A clip's own (non-welded) spring ease-in from identity — scale ramps while
  //    the focus is anchored on where the follow begins (the path's seed), so the
  //    zoom-in lands exactly where the cursor follow takes over.
  for (const c of resolved) {
    if (t >= c.start && t < c.holdStart) {
      const easeIn = c.holdStart - c.start
      if (easeIn <= 0) continue
      const raw = (t - c.start) / easeIn
      // Focus follows the cursor LIVE during the zoom-in (auto clips have a path
      // spanning the whole clip); a manual clip's path is null → its fixed focus.
      const f = followStateFor(c, t, paths)
      return easeState(
        c,
        springEase(raw),
        springSlope(springEase, raw) / easeIn,
        f.fx,
        f.fy
      )
    }
  }

  // 4. A clip's own (non-welded) spring ease-out to identity — focus keeps
  //    following the cursor while the scale ramps back down. The leading
  //    smoothstep in `springEaseOutRamped` keeps the first frames smooth.
  for (const c of resolved) {
    if (t > c.holdEnd && t < c.end) {
      const easeOut = c.end - c.holdEnd
      if (easeOut <= 0) continue
      const raw = (t - c.holdEnd) / easeOut
      const f = followStateFor(c, t, paths)
      return easeState(
        c,
        1 - springEaseOutRamped(raw),
        springSlope(springEaseOutRamped, raw) / easeOut,
        f.fx,
        f.fy,
        f.scale
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

  const state = computeZoomState(
    resolved,
    compositionSeconds,
    followPaths ?? null
  )
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
