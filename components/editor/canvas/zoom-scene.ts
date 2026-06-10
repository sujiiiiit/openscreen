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

// --- Cursor follow (predictive hold + anticipatory reframe) --------------
//
// While a clip is held zoomed, the camera keeps the *engaged content* in the
// visible window WITHOUT sliding continuously with the cursor (the "scene +
// cursor both move" churn is exactly what we are avoiding). The follow is
// PREDICTIVE, not reactive: generation is fully offline, so the whole cursor
// track is known up front. We segment the hold into DWELLS (where the cursor
// settles — its attention) and TRANSITS (between them), then:
//   • HOLD rock-steady while the next dwell still sits inside a generous inner
//     "safe box" — small in-frame wanders move the camera not at all.
//   • COMMIT one eased move only when the next dwell (the engaged region) falls
//     outside the safe box. The move is ANTICIPATORY: it begins as the cursor
//     sets off and arrives as the cursor settles (velocity-matched ramp), and
//     it targets the DESTINATION dwell, not the cursor's transient position, so
//     a fast flick is one clean move instead of a chasing series of reframes.
//   • REVEAL mode is AUTO: PAN (focus only) when a slide brings the engaged
//     region into frame at the held zoom; ZOOM OUT to fit (then return to the
//     tighter zoom) when it cannot — the Screen-Studio submenu reveal. The
//     engaged region is the dwell extent, widened by any frame-analysis /
//     Accessibility content rect (see `landmarks.engagedRects`).
//
// The walk is STATEFUL (it remembers where it settled), which would break the
// pure per-frame sampler that keeps preview == export. So we PRECOMPUTE a follow
// path per clip (deterministic: fixed-rate sampling of a fixed track + persisted
// rects) — timed (focus, scale) anchors with eased moves between them.
// `sampleZoomCameraAtTime` then just reads the path, so the sampler stays pure
// and replayable and the editor preview, hover, and export all follow
// identically. A clip whose cursor never leaves the safe box gets no path and
// renders byte-identically to a plain fixed-focus zoom.

export type ZoomFollowParams = {
  /** Cursor sampling rate (Hz) for the precompute walk (back-compat alias). */
  sampleHz: number
  /** Lookahead sampling rate (Hz) for dwell derivation. */
  predictionHz: number
  /**
   * The engaged region may sit this fraction of the window's half-extent away
   * from the frame centre before a reframe triggers. Larger = holds longer /
   * fewer reframes (more stable); smaller = reframes sooner. The committed move
   * recentres the region, so this is also the roam budget before the *next*
   * move — part of the hysteresis that prevents thrashing.
   */
  safeFraction: number
  /** Cluster radius (normalized) for a settle vs transit — mirrors fixationMaxRadius. */
  dwellRadius: number
  /** Minimum dwell duration (s) to count as a park — mirrors fixationMinMs. */
  dwellMinSec: number
  /** Outer hysteresis: the destination must exceed the safe box by this before committing. */
  commitMargin: number
  /** Fastest anticipatory ramp (s) — a snappy flick. */
  minMoveSec: number
  /** Slowest anticipatory ramp (s) — a gentle drift. */
  maxMoveSec: number
  /** How far ahead of the cursor's arrival the move lands (fraction of the ramp). */
  anticipationLeadFraction: number
  /** Padding when fitting an engaged region into the frame for zoom-out-to-fit. */
  fitMargin: number
  /** Floor for zoom-out-to-fit (never below identity). */
  minRevealScale: number
  /** How long to hold a zoomed-out reveal before returning to the tighter zoom (s). */
  revealHoldSec: number
  /** Default eased duration (s) of a reframe move when an anchor has no override. */
  transitionSec: number
}

export const ZOOM_FOLLOW_DEFAULTS: ZoomFollowParams = {
  sampleHz: 30,
  predictionHz: 60,
  // A generous dead zone: the camera holds still through small cursor wanders and
  // only commits on a real excursion (calmer motion; fewer reframes).
  safeFraction: 0.84,
  dwellRadius: 0.035,
  dwellMinSec: 0.18,
  commitMargin: 0.06,
  minMoveSec: 0.28,
  maxMoveSec: 0.75,
  anticipationLeadFraction: 0.15,
  fitMargin: 0.16,
  minRevealScale: 1.0,
  revealHoldSec: 0.6,
  // A gentler, longer reframe glide when one is needed.
  transitionSec: 0.65,
}

// Engaged-content rects (a menu/popover's bounds from frame-analysis or, later,
// Accessibility) ride along on each clip as `engagedRects` and are persisted in
// project.json. The planner widens a dwell's engaged region by the rect active
// around it, which is what triggers a zoom-out-to-fit reveal for content larger
// than the frame. They reach export only via project.json, so preview == export.

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
 * One timed keyframe on a clip's follow path. `fx`/`fy` are stored focus and
 * `scale` is the settled magnification at this anchor (lets the camera zoom out
 * to reveal a large engaged region, then a later anchor restores the tight zoom).
 * `enterSec` is the eased duration of the move INTO this anchor (velocity-matched
 * / anticipatory); it falls back to the path's `defaultTransitionSec`. `reveal`
 * classifies the move (drives docs/telemetry only).
 */
type ZoomFollowAnchor = {
  t: number
  fx: number
  fy: number
  scale: number
  enterSec?: number
  reveal: "pan" | "zoom-out"
}

/**
 * A precomputed cursor-follow path for one clip: (focus, scale) holds at each
 * anchor and eases to the next over the anchor's `enterSec` (or
 * `defaultTransitionSec`). Always ≥2 anchors (a single-anchor path is
 * indistinguishable from a fixed focus and is dropped to `null`).
 */
export type ZoomFollowPath = {
  defaultTransitionSec: number
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

// --- Follow geometry helpers ---------------------------------------------
//
// The "window centre" is the artboard-normalized centre of the visible window;
// the "focus" is the stored 0..1 point a clip zooms around. They relate through
// the scale: a window at scale s spans 1/s of the artboard.

/** Window centre that frames `focus` at `scale`. */
function centerForFocus(focus: number, scale: number): number {
  return focus * (1 - 1 / scale) + 1 / (2 * scale)
}

/** Inverse of {@link centerForFocus}: the stored focus that yields `center`. */
function focusForCenter(center: number, scale: number): number {
  const inv = 1 - 1 / scale
  if (inv <= 0) return 0.5
  return clampUnit((center - 1 / (2 * scale)) / inv)
}

/** Clamp a window centre so the window stays fully inside the artboard [0,1]. */
function clampCenter(center: number, scale: number): number {
  const half = 1 / (2 * scale)
  return clampRange(center, half, 1 - half)
}

/** A settled cursor cluster within a clip's hold — its attention "park". */
type FollowDwell = { t0: number; t1: number; cx: number; cy: number; radius: number }

/** The engaged region around a dwell: its centre + half-extents (normalized). */
type EngagedRegion = { cx: number; cy: number; halfX: number; halfY: number }

/**
 * Segment the sampled cursor into dwells: spans where the cursor stayed within
 * `dwellRadius` for at least `dwellMinSec`. Transit intervals between dwells are
 * implicit. Mirrors the kinematics-stage fixation model
 * (`lib/auto-zoom/kinematics.ts`) but runs on the already-focus-normalized
 * sampler output so it is identical in preview and export. A constantly-moving
 * cursor yields no dwell, so the camera simply waits (holds) rather than chasing.
 */
function deriveDwells(
  samples: readonly { t: number; x: number; y: number }[],
  params: ZoomFollowParams
): FollowDwell[] {
  const dwells: FollowDwell[] = []
  const gapBreakSec = Math.max(3 / Math.max(1, params.predictionHz), 0.1)
  let n = 0
  let sumX = 0
  let sumY = 0
  let cx = 0
  let cy = 0
  let t0 = 0
  let t1 = 0
  let maxR = 0

  const flush = () => {
    if (n >= 2 && t1 - t0 >= params.dwellMinSec) {
      dwells.push({ t0, t1, cx, cy, radius: maxR })
    }
  }
  const start = (s: { t: number; x: number; y: number }) => {
    n = 1
    sumX = s.x
    sumY = s.y
    cx = s.x
    cy = s.y
    t0 = s.t
    t1 = s.t
    maxR = 0
  }

  for (const s of samples) {
    if (n === 0) {
      start(s)
      continue
    }
    const dist = Math.hypot(s.x - cx, s.y - cy)
    const gap = s.t - t1
    if (dist <= params.dwellRadius && gap <= gapBreakSec) {
      n += 1
      sumX += s.x
      sumY += s.y
      cx = sumX / n
      cy = sumY / n
      t1 = s.t
      if (dist > maxR) maxR = dist
      continue
    }
    flush()
    start(s)
  }
  flush()
  return dwells
}

/**
 * The region a dwell engages: the dwell extent, widened by any content rect
 * (frame-analysis / Accessibility) active around the dwell's time. A bare dwell
 * is a tiny region (always fits → PAN); a menu/popover rect makes it large
 * enough to force a zoom-out-to-fit reveal.
 */
function engagedRegionFor(
  d: FollowDwell,
  engagedRects: ReadonlyArray<{ t: number; rect: ZoomVisibleWindow }> | undefined,
  params: ZoomFollowParams
): EngagedRegion {
  let minX = d.cx - d.radius
  let maxX = d.cx + d.radius
  let minY = d.cy - d.radius
  let maxY = d.cy + d.radius
  if (engagedRects && engagedRects.length > 0) {
    // A rect counts when its interaction time sits within (or just before) the
    // dwell — the menu that opened as the cursor settled here.
    const lo = d.t0 - Math.max(params.dwellMinSec, 0.3)
    const hi = d.t1 + params.revealHoldSec
    for (const r of engagedRects) {
      if (r.t < lo || r.t > hi) continue
      minX = Math.min(minX, r.rect.x)
      maxX = Math.max(maxX, r.rect.x + r.rect.width)
      minY = Math.min(minY, r.rect.y)
      maxY = Math.max(maxY, r.rect.y + r.rect.height)
    }
  }
  minX = clampUnit(minX)
  maxX = clampUnit(maxX)
  minY = clampUnit(minY)
  maxY = clampUnit(maxY)
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    halfX: (maxX - minX) / 2,
    halfY: (maxY - minY) / 2,
  }
}

/** Largest scale at which the region (+ fitMargin) fits in the frame; ∞ if tiny. */
function fitScaleForRegion(region: EngagedRegion, params: ZoomFollowParams): number {
  const maxHalf = Math.max(region.halfX, region.halfY)
  if (maxHalf <= ZOOM_IDENTITY_EPSILON) return Number.POSITIVE_INFINITY
  return 1 / (2 * maxHalf * (1 + Math.max(0, params.fitMargin)))
}

/**
 * Precompute the PREDICTIVE follow path for one resolved clip. Samples the whole
 * hold (offline lookahead), segments it into dwells, then walks them: hold
 * rock-steady while the engaged region stays in frame, and commit ONE
 * anticipatory move per excursion — targeting the destination dwell, timed to
 * arrive as the cursor settles, PANning when a slide fits or ZOOMing OUT to fit
 * (then returning) when it cannot. Returns `null` when there is no zoom, no
 * usable cursor data, or no committed move (→ a plain fixed-focus zoom).
 */
function computeFollowPath(
  clip: ResolvedZoomClip,
  sampleCursor: CursorFocusSampler,
  params: ZoomFollowParams,
  engagedRects?: ReadonlyArray<{ t: number; rect: ZoomVisibleWindow }>
): ZoomFollowPath | null {
  if (clip.scale <= 1 + ZOOM_IDENTITY_EPSILON) return null
  const span = clip.holdEnd - clip.holdStart
  if (span <= 0) return null

  const transition = Math.max(0, params.transitionSec)
  const dt = 1 / Math.max(1, params.predictionHz)

  // 1. Offline lookahead: sample the cursor across the whole hold.
  const samples: { t: number; x: number; y: number }[] = []
  for (let t = clip.holdStart; t <= clip.holdEnd + 1e-9; t += dt) {
    const c = sampleCursor(t)
    if (!c) continue
    samples.push({ t, x: clampUnit(c.x), y: clampUnit(c.y) })
  }
  if (samples.length < 2) return null

  // 2. Segment into dwells (the cursor's settle points / attention).
  const dwells = deriveDwells(samples, params)
  if (dwells.length === 0) return null

  // 3. Walk dwells; emit anchors only when the engaged region leaves the frame.
  const fx0 = clampUnit(clip.fx)
  const fy0 = clampUnit(clip.fy)
  const anchors: ZoomFollowAnchor[] = [
    { t: clip.holdStart, fx: fx0, fy: fy0, scale: clip.scale, reveal: "pan" },
  ]
  let curScale = clip.scale
  let centerX = centerForFocus(fx0, clip.scale)
  let centerY = centerForFocus(fy0, clip.scale)
  let prevDwellEnd = clip.holdStart
  let lastAnchorT = clip.holdStart

  for (const d of dwells) {
    const tSettle = d.t0
    const tDepart = prevDwellEnd
    prevDwellEnd = d.t1

    const region = engagedRegionFor(d, engagedRects, params)

    // Does the engaged region poke beyond the safe box (with hysteresis)?
    const safeHalf = clampUnit(params.safeFraction) * (1 / (2 * curScale))
    const dxOut = Math.abs(region.cx - centerX) + region.halfX - safeHalf
    const dyOut = Math.abs(region.cy - centerY) + region.halfY - safeHalf
    const needsMove =
      dxOut > params.commitMargin || dyOut > params.commitMargin

    // Smallest move that fits: only a region that can't fit at the held zoom
    // forces a zoom-out; a bare dwell always fits, so PAN is the default.
    const fitScale = fitScaleForRegion(region, params)
    const wantZoomOut = fitScale < curScale - ZOOM_IDENTITY_EPSILON

    if (!needsMove && !wantZoomOut) continue // rock-steady: region is in frame.

    const nextScale = wantZoomOut
      ? Math.max(params.minRevealScale, Math.min(curScale, fitScale))
      : curScale
    const nextCenterX = clampCenter(region.cx, nextScale)
    const nextCenterY = clampCenter(region.cy, nextScale)

    // Near the artboard edge the window can't recentre further — skip the no-op.
    if (
      Math.abs(nextCenterX - centerX) < ZOOM_IDENTITY_EPSILON &&
      Math.abs(nextCenterY - centerY) < ZOOM_IDENTITY_EPSILON &&
      Math.abs(nextScale - curScale) < ZOOM_IDENTITY_EPSILON
    ) {
      continue
    }

    // Anticipatory timing: the ramp matches the transit speed and lands a hair
    // before the cursor settles, but never sets off before the cursor departs.
    // Normal moves run in lockstep with the cursor's travel ([depart, settle]);
    // a fast flick gets the snappy `minMoveSec` floor (a slight catch-up); a slow
    // drift gets a late `maxMoveSec` glide that still arrives as the cursor lands.
    const transit = Math.max(0, tSettle - tDepart)
    const enterSec = clampRange(transit, params.minMoveSec, params.maxMoveSec)
    const lead = params.anticipationLeadFraction * enterSec
    let tStart = Math.max(tDepart - lead, tSettle - lead - enterSec)
    if (tStart < lastAnchorT + dt) tStart = lastAnchorT + dt
    if (tStart > clip.holdEnd) tStart = clip.holdEnd

    anchors.push({
      t: tStart,
      fx: focusForCenter(nextCenterX, nextScale),
      fy: focusForCenter(nextCenterY, nextScale),
      scale: nextScale,
      enterSec,
      reveal: wantZoomOut ? "zoom-out" : "pan",
    })
    lastAnchorT = tStart
    centerX = nextCenterX
    centerY = nextCenterY
    curScale = nextScale

    // After a zoom-out reveal, return to the tighter zoom once it's been read.
    if (wantZoomOut && clip.scale > nextScale + ZOOM_IDENTITY_EPSILON) {
      const tReturn = Math.min(
        clip.holdEnd,
        Math.max(tStart + enterSec, d.t1) + params.revealHoldSec
      )
      if (tReturn > lastAnchorT + dt) {
        const returnCenterX = clampCenter(region.cx, clip.scale)
        const returnCenterY = clampCenter(region.cy, clip.scale)
        const returnEnter = clampRange(
          transition,
          params.minMoveSec,
          params.maxMoveSec
        )
        anchors.push({
          t: tReturn,
          fx: focusForCenter(returnCenterX, clip.scale),
          fy: focusForCenter(returnCenterY, clip.scale),
          scale: clip.scale,
          enterSec: returnEnter,
          reveal: "zoom-out",
        })
        lastAnchorT = tReturn
        centerX = returnCenterX
        centerY = returnCenterY
        curScale = clip.scale
      }
    }
  }

  if (anchors.length < 2) return null
  return { defaultTransitionSec: transition, anchors }
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
    // Engaged-content rects (frame-analysis / AX) ride along on the clip itself
    // and are persisted in project.json, so preview and export see the same
    // input and follow identically — no separate plumbing to the callers.
    const path = computeFollowPath(clip, sampleCursor, params, clipEngagedRects(input))
    if (path) paths.set(clip.id, path)
  }
  return paths
}

/** The per-clip engaged content rects (frame-analysis / AX), if any. */
function clipEngagedRects(
  input: CanvasZoomClipInput
): ReadonlyArray<{ t: number; rect: ZoomVisibleWindow }> | undefined {
  const rects = input.engagedRects
  if (!rects || rects.length === 0) return undefined
  return rects
}

/**
 * (focus, scale) at time `t` along a follow path: hold each anchor, ease to the
 * next over the anchor's `enterSec` (or `defaultTransitionSec`). Focus AND scale
 * share the one eased transition, so a zoom-out reveal and its recentre move
 * stay perfectly synchronized.
 */
function sampleFollowState(
  path: ZoomFollowPath,
  t: number
): { fx: number; fy: number; scale: number } {
  const { anchors } = path
  let i = 0
  for (let k = 0; k < anchors.length; k++) {
    if (anchors[k].t <= t) i = k
    else break
  }
  const cur = anchors[i]
  if (i === 0) return { fx: cur.fx, fy: cur.fy, scale: cur.scale }
  const prev = anchors[i - 1]
  const dur = cur.enterSec ?? path.defaultTransitionSec
  const u = dur > 0 ? clampUnit((t - cur.t) / dur) : 1
  const e = smootherstep(u)
  return {
    fx: prev.fx + (cur.fx - prev.fx) * e,
    fy: prev.fy + (cur.fy - prev.fy) * e,
    scale: prev.scale + (cur.scale - prev.scale) * e,
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

/** Scale velocity (per second) along a follow path — drives in-hold radial blur. */
function followScaleVelocity(path: ZoomFollowPath, t: number): number {
  const dt = ZOOM_PAN_BLUR_VELOCITY_DT
  const before = sampleFollowState(path, t - dt).scale
  const after = sampleFollowState(path, t + dt).scale
  return (after - before) / (2 * dt)
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
 * branches read the per-clip follow path (via {@link followStateFor}) so the
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
      const st = followStateFor(c, t, paths)
      const pan = panBlurFor(c, t, st.scale, paths)
      // An in-hold zoom-out reveal changes scale → radial blur from the scale
      // velocity (same model as easeState). A steady hold (and any pan-only or
      // no-path clip) has zero scale velocity, so this stays 0 and renders
      // byte-identically to before.
      let radialBlur = 0
      const path = paths?.get(c.id)
      if (path) {
        const sv = followScaleVelocity(path, t)
        if (sv !== 0) {
          radialBlur = clampUnit(
            c.blur *
              clampUnit(
                (Math.abs(sv) / Math.max(st.scale, 1e-6)) * ZOOM_BLUR_MOTION_GAIN
              )
          )
        }
      }
      return {
        scale: st.scale,
        fx: st.fx,
        fy: st.fy,
        radialBlur,
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
    // Weld between A's FINAL held frame and B's INITIAL frame, so a reframe or
    // zoom-out reveal that moved A's focus/scale carries through the glide.
    const fa = followStateFor(a, a.holdEnd, paths)
    const fb = followStateFor(b, b.holdStart, paths)
    const scale = fa.scale + (fb.scale - fa.scale) * u
    // Blur tracks how fast the magnification is changing across the weld — a
    // smaller swing (2.5→1.7) blurs gentler than a full zoom from 1x.
    const slope = curveSlope(ZOOM_WELD_CURVE, raw) / windowDur
    const scaleVelocity = Math.abs(fb.scale - fa.scale) * slope
    const motion = clampUnit((scaleVelocity / Math.max(scale, 1e-6)) * ZOOM_BLUR_MOTION_GAIN)
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
      const f = followStateFor(c, c.holdEnd, paths)
      return easeState(
        c,
        1 - transitionCurveValue(c.curve, raw),
        curveSlope(c.curve, raw) / easeOut,
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
