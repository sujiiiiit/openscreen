import type {
  CanvasZoomClip,
  CanvasZoomClipPatch,
  CanvasZoomEasePreset,
  CanvasZoomFocus,
  CanvasZoomRadialBlurSettings,
  CanvasZoomTransitionCurve,
  CanvasZoomTransitionSettings,
} from "@/types/editor-canvas"

// Floor on a manual Zoom-track clip's duration, in timeline (composition)
// seconds, enforced when **creating** (hover ghost / click-add) and
// **resizing**. Interaction-sized on purpose: a zoom clip is
// normal → zoom → hold → normal, so a sub-half-second clip cannot even express
// the minimum 150 ms in/out ramps — and it renders as a sub-pixel sliver that
// is impossible to grab, swallows the resize handles, and defeats guide-line
// snapping. (Was 1/60 s; that frame-sized floor produced exactly those
// slivers — see docs/editor-canvas.md → "Tiny Zoom Clips".)
export const MIN_ZOOM_CLIP_SECONDS = 0.5
// Absolute validity floor. Legacy projects can hold clips created under the
// old 1/60 s floor; hydration keeps any clip at least this long instead of
// silently dropping user data, and move preserves their real duration. They
// grow to MIN_ZOOM_CLIP_SECONDS the first time an edge is resized.
export const ZOOM_CLIP_DEGENERATE_SECONDS = 1 / 60
const ZOOM_CLIP_EPSILON_SECONDS = 1e-6
// Edges this close to a neighbour / timeline bound weld to it exactly. This is
// a float-residue eraser (pixel↔time round trips leave sub-millisecond noise),
// not a magnet: anything a user could perceive (one frame is ≥ 16.7 ms) is far
// above this threshold, so welding never overrides an intentional gap.
export const ZOOM_WELD_EPSILON_SECONDS = 1e-3
export const ZOOM_SCALE_MIN = 1
export const ZOOM_SCALE_MAX = 4
export const ZOOM_SCALE_DEFAULT = 2
export const ZOOM_RADIAL_BLUR_MIN = 0
export const ZOOM_RADIAL_BLUR_MAX = 1
export const ZOOM_RADIAL_BLUR_DEFAULT = 0.5
export const ZOOM_BLUR_STRENGTH_MIN = 0
export const ZOOM_BLUR_STRENGTH_MAX = 2
export const ZOOM_BLUR_STRENGTH_DEFAULT = 1
export const ZOOM_BLUR_FALLOFF_MIN = 0.05
export const ZOOM_BLUR_FALLOFF_MAX = 1
export const ZOOM_BLUR_FALLOFF_DEFAULT = 0.65
export const ZOOM_BLUR_CENTER_SIZE_MIN = 0.02
export const ZOOM_BLUR_CENTER_SIZE_MAX = 0.5
export const ZOOM_BLUR_CENTER_SIZE_DEFAULT = 0.02
export const ZOOM_BLUR_CENTER_SHARPNESS_MIN = 0
export const ZOOM_BLUR_CENTER_SHARPNESS_MAX = 1
export const ZOOM_BLUR_CENTER_SHARPNESS_DEFAULT = 1
export const ZOOM_RADIAL_BLUR_SETTINGS_DEFAULT: CanvasZoomRadialBlurSettings = {
  strength: ZOOM_BLUR_STRENGTH_DEFAULT,
  falloff: ZOOM_BLUR_FALLOFF_DEFAULT,
  centerSize: ZOOM_BLUR_CENTER_SIZE_DEFAULT,
  centerSharpness: ZOOM_BLUR_CENTER_SHARPNESS_DEFAULT,
}
// Baked Pixi ZoomBlurFilter-style tuning. The old per-clip zoom-blur controls
// were reduced to one good look, so every zoom clip renders with this strength
// multiplier, a 2% inner radius, and an infinite outer radius. `centerSize`,
// `falloff`, and `centerSharpness` remain in the runtime shape for legacy
// project hydration but are ignored by the shader.
export const ZOOM_RADIAL_BLUR_SHADER: CanvasZoomRadialBlurSettings = {
  strength: 1,
  falloff: 0.42,
  centerSize: ZOOM_BLUR_CENTER_SIZE_DEFAULT,
  centerSharpness: ZOOM_BLUR_CENTER_SHARPNESS_DEFAULT,
}
// Converts on-screen zoom velocity into a 0..1 zoom-blur amount: higher means
// more blur for the same zoom speed. Kept conservative so short/snappy clips —
// which have high zoom velocity — streak tastefully instead of smearing the
// whole frame. See sampleZoomCameraAtTime in zoom-scene.
//
// Retuned 0.14 → 0.05 (2026-06-06): at the old gain a default clip (Strength
// 0.5, scale 2, 600 ms ramps) peaked at ZoomBlurFilter strength ≈ 0.146 —
// every pixel smeared ~15 % of its distance to the focus, which averaged
// dark-mode screen recordings into a near-black frame for the middle of every
// ramp. 0.05 keeps the streak clearly visible while text-heavy dark content
// stays legible. See docs/editor-canvas.md → "Zoom Blur Reads As Black On
// Dark Recordings".
export const ZOOM_BLUR_MOTION_GAIN = 0.05
export const ZOOM_FOCUS_DEFAULT: CanvasZoomFocus = { x: 0.5, y: 0.5 }
export const ZOOM_EASE_PRESET_DEFAULT: CanvasZoomEasePreset = "smooth"
export const ZOOM_EASE_PRESETS: CanvasZoomEasePreset[] = [
  "smooth",
  "snappy",
  "slow",
]
export const ZOOM_TRANSITION_CURVES: CanvasZoomTransitionCurve[] = [
  "linear",
  "smoothstep",
  "smootherstep",
  "ease-out-cubic",
]
// Baked ease curve. The 4-way curve picker was removed; smootherstep gives the
// smoothest ease-in-out glide (zero velocity at both ends), which both reads as
// premium and makes the velocity-based zoom blur ramp on/off seamlessly.
export const ZOOM_TRANSITION_CURVE_DEFAULT: CanvasZoomTransitionCurve =
  "smootherstep"
export const ZOOM_TRANSITION_FRACTION_MIN = 0
export const ZOOM_TRANSITION_FRACTION_MAX = 0.75
export const ZOOM_TRANSITION_DURATION_MS_MIN = 150
export const ZOOM_TRANSITION_DURATION_MS_MAX = 2000
export const ZOOM_TRANSITION_DURATION_MS_DEFAULT = 600
export const ZOOM_TRANSITION_DEFAULT: CanvasZoomTransitionSettings = {
  easeIn: 0.3,
  easeOut: 0.3,
  speed: 1,
  durationMs: ZOOM_TRANSITION_DURATION_MS_DEFAULT,
  curve: ZOOM_TRANSITION_CURVE_DEFAULT,
}
// Legacy speed constants are kept for loading old project files. New UI writes
// transition.durationMs instead.
export const ZOOM_TRANSITION_SPEED_MIN = 0.25
export const ZOOM_TRANSITION_SPEED_MAX = 4
export const ZOOM_TRANSITION_SPEED_DEFAULT = ZOOM_TRANSITION_DEFAULT.speed
export const ZOOM_EASE_PRESET_TRANSITIONS: Record<
  CanvasZoomEasePreset,
  CanvasZoomTransitionSettings
> = {
  smooth: ZOOM_TRANSITION_DEFAULT,
  snappy: {
    easeIn: 0.16,
    easeOut: 0.18,
    speed: ZOOM_TRANSITION_SPEED_DEFAULT,
    durationMs: 450,
    curve: "smoothstep",
  },
  slow: {
    easeIn: 0.34,
    easeOut: 0.36,
    speed: ZOOM_TRANSITION_SPEED_DEFAULT,
    durationMs: 850,
    curve: "smoothstep",
  },
}

export type CanvasZoomClipInput = Pick<CanvasZoomClip, "id" | "start" | "end"> &
  Partial<
    Pick<
      CanvasZoomClip,
      "enabled" | "focus" | "scale" | "radialBlur" | "easePreset"
    >
  > & {
    radialBlurSettings?: Partial<CanvasZoomRadialBlurSettings>
    transition?: Partial<CanvasZoomTransitionSettings>
  }

let zoomClipIdCounter = 0
// Persisted ids that must stay unique across reloads. The counter resets to 0
// each session, so the timestamp prefix prevents a fresh "zoom-…" colliding
// with a restored one.
export function createZoomClipId() {
  zoomClipIdCounter += 1
  return `zoom-${Date.now()}-${zoomClipIdCounter}`
}

export function zoomRangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
) {
  return (
    aStart < bEnd - ZOOM_CLIP_EPSILON_SECONDS &&
    bStart < aEnd - ZOOM_CLIP_EPSILON_SECONDS
  )
}

/**
 * Does the half-open span [start, end) overlap any clip other than `ignoreId`?
 * Used for real-time move/resize blocking (the "snap to neighbor" feel).
 */
export function zoomSpanOverlaps(
  clips: readonly CanvasZoomClip[],
  start: number,
  end: number,
  ignoreId: string | null
) {
  return clips.some(
    (clip) =>
      clip.id !== ignoreId &&
      zoomRangesOverlap(start, end, clip.start, clip.end)
  )
}

function isFiniteTime(value: number) {
  return Number.isFinite(value)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function clampZoomScale(scale: number): number {
  if (!Number.isFinite(scale)) return ZOOM_SCALE_DEFAULT
  return clamp(scale, ZOOM_SCALE_MIN, ZOOM_SCALE_MAX)
}

export function clampZoomRadialBlur(radialBlur: number): number {
  if (!Number.isFinite(radialBlur)) return ZOOM_RADIAL_BLUR_DEFAULT
  return clamp(radialBlur, ZOOM_RADIAL_BLUR_MIN, ZOOM_RADIAL_BLUR_MAX)
}

export function clampZoomFocus(focus: CanvasZoomFocus): CanvasZoomFocus {
  return {
    x: clamp(Number.isFinite(focus.x) ? focus.x : ZOOM_FOCUS_DEFAULT.x, 0, 1),
    y: clamp(Number.isFinite(focus.y) ? focus.y : ZOOM_FOCUS_DEFAULT.y, 0, 1),
  }
}

export function clampZoomEasePreset(preset: unknown): CanvasZoomEasePreset {
  return ZOOM_EASE_PRESETS.includes(preset as CanvasZoomEasePreset)
    ? (preset as CanvasZoomEasePreset)
    : ZOOM_EASE_PRESET_DEFAULT
}

export function clampZoomTransitionCurve(
  curve: unknown
): CanvasZoomTransitionCurve {
  return ZOOM_TRANSITION_CURVES.includes(curve as CanvasZoomTransitionCurve)
    ? (curve as CanvasZoomTransitionCurve)
    : ZOOM_TRANSITION_CURVE_DEFAULT
}

export function transitionForZoomEasePreset(
  preset: unknown
): CanvasZoomTransitionSettings {
  return {
    ...ZOOM_EASE_PRESET_TRANSITIONS[clampZoomEasePreset(preset)],
  }
}

export function clampZoomTransitionSettings(
  transition: Partial<CanvasZoomTransitionSettings> | undefined,
  clipDurationSeconds?: number
): CanvasZoomTransitionSettings {
  const easeIn = clamp(
    Number.isFinite(transition?.easeIn)
      ? (transition?.easeIn as number)
      : ZOOM_TRANSITION_DEFAULT.easeIn,
    ZOOM_TRANSITION_FRACTION_MIN,
    ZOOM_TRANSITION_FRACTION_MAX
  )
  const easeOut = clamp(
    Number.isFinite(transition?.easeOut)
      ? (transition?.easeOut as number)
      : ZOOM_TRANSITION_DEFAULT.easeOut,
    ZOOM_TRANSITION_FRACTION_MIN,
    ZOOM_TRANSITION_FRACTION_MAX
  )
  const durationMs = (() => {
    if (Number.isFinite(transition?.durationMs)) {
      return clamp(
        transition?.durationMs as number,
        ZOOM_TRANSITION_DURATION_MS_MIN,
        ZOOM_TRANSITION_DURATION_MS_MAX
      )
    }
    if (
      (Number.isFinite(transition?.speed) ||
        Number.isFinite(transition?.easeIn) ||
        Number.isFinite(transition?.easeOut)) &&
      Number.isFinite(clipDurationSeconds) &&
      (clipDurationSeconds as number) > 0
    ) {
      const legacySpeed = clamp(
        Number.isFinite(transition?.speed)
          ? (transition?.speed as number)
          : ZOOM_TRANSITION_SPEED_DEFAULT,
        ZOOM_TRANSITION_SPEED_MIN,
        ZOOM_TRANSITION_SPEED_MAX
      )
      return clamp(
        (((clipDurationSeconds as number) * Math.max(easeIn, easeOut)) /
          legacySpeed) *
          1000,
        ZOOM_TRANSITION_DURATION_MS_MIN,
        ZOOM_TRANSITION_DURATION_MS_MAX
      )
    }
    return ZOOM_TRANSITION_DURATION_MS_DEFAULT
  })()
  return {
    easeIn,
    easeOut,
    speed: ZOOM_TRANSITION_SPEED_DEFAULT,
    durationMs,
    curve: clampZoomTransitionCurve(transition?.curve),
  }
}

export function clampZoomRadialBlurSettings(
  settings: Partial<CanvasZoomRadialBlurSettings> | undefined
): CanvasZoomRadialBlurSettings {
  return {
    strength: clamp(
      Number.isFinite(settings?.strength)
        ? (settings?.strength as number)
        : ZOOM_RADIAL_BLUR_SETTINGS_DEFAULT.strength,
      ZOOM_BLUR_STRENGTH_MIN,
      ZOOM_BLUR_STRENGTH_MAX
    ),
    falloff: clamp(
      Number.isFinite(settings?.falloff)
        ? (settings?.falloff as number)
        : ZOOM_RADIAL_BLUR_SETTINGS_DEFAULT.falloff,
      ZOOM_BLUR_FALLOFF_MIN,
      ZOOM_BLUR_FALLOFF_MAX
    ),
    centerSize: ZOOM_RADIAL_BLUR_SETTINGS_DEFAULT.centerSize,
    centerSharpness: clamp(
      Number.isFinite(settings?.centerSharpness)
        ? (settings?.centerSharpness as number)
        : ZOOM_RADIAL_BLUR_SETTINGS_DEFAULT.centerSharpness,
      ZOOM_BLUR_CENTER_SHARPNESS_MIN,
      ZOOM_BLUR_CENTER_SHARPNESS_MAX
    ),
  }
}

export function zoomTransitionSettingsEqual(
  a: CanvasZoomTransitionSettings,
  b: CanvasZoomTransitionSettings
) {
  return (
    a.easeIn === b.easeIn &&
    a.easeOut === b.easeOut &&
    a.speed === b.speed &&
    a.durationMs === b.durationMs &&
    a.curve === b.curve
  )
}

export function zoomRadialBlurSettingsEqual(
  a: CanvasZoomRadialBlurSettings,
  b: CanvasZoomRadialBlurSettings
) {
  return (
    a.strength === b.strength &&
    a.falloff === b.falloff &&
    a.centerSize === b.centerSize &&
    a.centerSharpness === b.centerSharpness
  )
}

export function withZoomClipDefaults(
  clip: CanvasZoomClipInput
): CanvasZoomClip {
  const legacyPreset = clampZoomEasePreset(clip.easePreset)
  const transition = clip.transition
    ? clampZoomTransitionSettings(
        clip.transition,
        Math.max(0, clip.end - clip.start)
      )
    : transitionForZoomEasePreset(legacyPreset)
  return {
    id: clip.id,
    start: clip.start,
    end: clip.end,
    enabled: clip.enabled ?? true,
    focus: clampZoomFocus(clip.focus ?? ZOOM_FOCUS_DEFAULT),
    scale: clampZoomScale(clip.scale ?? ZOOM_SCALE_DEFAULT),
    radialBlur: clampZoomRadialBlur(
      clip.radialBlur ?? ZOOM_RADIAL_BLUR_DEFAULT
    ),
    radialBlurSettings: clampZoomRadialBlurSettings(clip.radialBlurSettings),
    transition,
    easePreset: legacyPreset,
  }
}

export function sanitizeZoomClipPatch(
  patch: CanvasZoomClipPatch
): CanvasZoomClipPatch {
  const next: CanvasZoomClipPatch = {}
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled
  if (patch.focus) next.focus = clampZoomFocus(patch.focus)
  if (typeof patch.scale === "number") next.scale = clampZoomScale(patch.scale)
  if (typeof patch.radialBlur === "number") {
    next.radialBlur = clampZoomRadialBlur(patch.radialBlur)
  }
  if (patch.radialBlurSettings) {
    next.radialBlurSettings = clampZoomRadialBlurSettings(
      patch.radialBlurSettings
    )
  }
  if (patch.easePreset) {
    const easePreset = clampZoomEasePreset(patch.easePreset)
    next.easePreset = easePreset
    next.transition = transitionForZoomEasePreset(easePreset)
  }
  if (patch.transition) {
    next.transition = clampZoomTransitionSettings(patch.transition)
  }
  return next
}

function byStartThenEnd(a: CanvasZoomClip, b: CanvasZoomClip) {
  return a.start - b.start || a.end - b.end || a.id.localeCompare(b.id)
}

function isUsableZoomClip(clip: CanvasZoomClipInput, ignoreId: string | null) {
  if (clip.id === ignoreId) return false
  if (!clip.id) return false
  if (!isFiniteTime(clip.start) || !isFiniteTime(clip.end)) return false
  // Any positive span counts. Deliberately NOT gated on a duration floor: a
  // clip that drifted below the floor (float residue from a resize-to-minimum
  // — `(start + MIN) - start` can land one ulp short — or legacy data) must
  // still block placement and clamping, or the hover ghost and drags silently
  // overlap it. Duration floors are enforced where spans are created/kept,
  // not here.
  if (clip.end - clip.start <= 0) return false
  return true
}

function getSortedUsableZoomClips(clips: readonly CanvasZoomClip[]) {
  const seen = new Set<string>()
  return clips
    .filter((clip) => {
      if (!isUsableZoomClip(clip, null) || seen.has(clip.id)) return false
      seen.add(clip.id)
      return true
    })
    .sort(byStartThenEnd)
}

/**
 * Sort and trim persisted/restored zoom clips into a single non-overlapping
 * lane. Earlier clips win; later clips that collide are trimmed to the previous
 * end. The keep threshold is `ZOOM_CLIP_DEGENERATE_SECONDS`, not the larger
 * creation floor, so legacy clips created under the old 1/60 s minimum survive
 * hydration instead of silently vanishing from the user's project.
 */
export function normalizeZoomClips(
  clips: readonly CanvasZoomClip[],
  timelineDuration: number
): CanvasZoomClip[] {
  const safeTimelineDuration = Math.max(
    0,
    Number.isFinite(timelineDuration) ? timelineDuration : 0
  )
  if (safeTimelineDuration <= 0) return []

  const normalized: CanvasZoomClip[] = []
  let occupiedUntil = 0

  for (const clip of getSortedUsableZoomClips(clips)) {
    const end = clamp(clip.end, 0, safeTimelineDuration)
    const start = Math.max(
      clamp(clip.start, 0, safeTimelineDuration),
      occupiedUntil
    )

    if (end - start < ZOOM_CLIP_DEGENERATE_SECONDS) continue

    normalized.push({ ...withZoomClipDefaults(clip), start, end })
    occupiedUntil = end
  }

  return normalized
}

/**
 * Resolve a valid placement for a fresh/added zoom span. The requested `start`
 * is the committed start; if the requested duration would cross the next
 * neighbour or timeline end, the span shrinks on the right. Returns `null` when
 * the pointer is inside an existing clip or the right-side room is below the
 * minimum. `ignoreId` excludes one clip from the test (unused for add; reserved
 * for callers that re-place an existing clip).
 *
 * `snapSeconds` (optional) magnetizes the placement to its gap: an anchor
 * within that distance after the previous clip's end (or the timeline start)
 * snaps back flush to it, and an end stopping within that distance of the next
 * clip's start (or the timeline end) extends flush to it — so click-adds near
 * a neighbour land exactly adjacent instead of leaving an unfillable
 * micro-gap. Snapping only ever moves the span to positions that re-validate
 * identically with `snapSeconds = 0`, so a snapped ghost preview and its
 * snapless `addZoomClip` re-check always agree.
 *
 * This is the single source of truth shared by the provider's `addZoomClip`
 * commit and the timeline panel's hover-ghost preview, so the previewed block
 * and the committed clip are always identical.
 */
export function placeZoomSpan(
  clips: readonly CanvasZoomClip[],
  timelineDuration: number,
  start: number,
  end: number,
  ignoreId: string | null = null,
  snapSeconds = 0
): { start: number; end: number } | null {
  const safeTimelineDuration = Math.max(
    0,
    Number.isFinite(timelineDuration) ? timelineDuration : 0
  )
  if (safeTimelineDuration <= 0 || !isFiniteTime(start)) return null

  const requestedDuration =
    isFiniteTime(end) && end > start ? end - start : MIN_ZOOM_CLIP_SECONDS
  const desiredDuration = Math.max(MIN_ZOOM_CLIP_SECONDS, requestedDuration)
  const rawAnchor = clamp(start, 0, safeTimelineDuration)

  let gapEnd = safeTimelineDuration
  // End of the nearest clip at or before the anchor; 0 doubles as the
  // timeline start so the anchor snap also magnetizes to t = 0.
  let previousEnd = 0

  for (const clip of clips) {
    if (!isUsableZoomClip(clip, ignoreId)) continue

    if (
      rawAnchor >= clip.start - ZOOM_CLIP_EPSILON_SECONDS &&
      rawAnchor < clip.end - ZOOM_CLIP_EPSILON_SECONDS
    ) {
      return null
    }

    if (clip.start >= rawAnchor - ZOOM_CLIP_EPSILON_SECONDS) {
      gapEnd = Math.min(gapEnd, clip.start)
    }
    if (clip.end <= rawAnchor + ZOOM_CLIP_EPSILON_SECONDS) {
      previousEnd = Math.max(previousEnd, clip.end)
    }
  }

  const anchor =
    snapSeconds > 0 && rawAnchor - previousEnd < snapSeconds
      ? previousEnd
      : rawAnchor

  const availableDuration = gapEnd - anchor
  if (availableDuration < MIN_ZOOM_CLIP_SECONDS) return null

  const placedDuration = Math.min(desiredDuration, availableDuration)
  const placedStart = anchor
  let placedEnd = placedStart + placedDuration
  if (snapSeconds > 0 && gapEnd - placedEnd < snapSeconds) {
    placedEnd = gapEnd
  }

  if (placedEnd - placedStart < MIN_ZOOM_CLIP_SECONDS) return null
  return { start: placedStart, end: placedEnd }
}

/**
 * The open gap `[lo, hi]` that the reference span occupies: bounded by the
 * nearest neighbour edges (excluding `ignoreId`) and the timeline `[0, end]`.
 * The reference span is normally non-overlapping (a committed clip position);
 * a clip that nevertheless overlaps it (legacy/corrupt state) is treated as a
 * wall on the side where most of it lies, so dragging the reference resolves
 * the overlap instead of preserving it.
 */
export function getZoomGapBounds(
  clips: readonly CanvasZoomClip[],
  timelineDuration: number,
  refStart: number,
  refEnd: number,
  ignoreId: string | null
): { lo: number; hi: number } {
  const safeTimelineDuration = Math.max(
    0,
    Number.isFinite(timelineDuration) ? timelineDuration : 0
  )
  let lo = 0
  let hi = safeTimelineDuration

  for (const clip of clips) {
    if (!isUsableZoomClip(clip, ignoreId)) continue
    if (clip.end <= refStart + ZOOM_CLIP_EPSILON_SECONDS) {
      lo = Math.max(lo, clip.end)
    } else if (clip.start >= refEnd - ZOOM_CLIP_EPSILON_SECONDS) {
      hi = Math.min(hi, clip.start)
    } else if (
      clip.start + clip.end <= refStart + refEnd // midpoint comparison ×2
    ) {
      lo = Math.max(lo, clip.end)
    } else {
      hi = Math.min(hi, clip.start)
    }
  }

  return { lo, hi }
}

/**
 * Clamp a move of `reference` (its committed span) to `requestedStart` so the
 * clip slides flush against its neighbours / the timeline bounds instead of
 * the step being rejected. Duration is preserved; edges within
 * `ZOOM_WELD_EPSILON_SECONDS` of a gap bound weld to it exactly so "flush" is
 * exact in the data, not float-approximate.
 *
 * Shared by the timeline panel's real-time `onActionMoving` clamp and the
 * provider's `moveZoomClip` commit so the dragged preview and the persisted
 * span are always identical.
 */
export function clampZoomMove(
  clips: readonly CanvasZoomClip[],
  timelineDuration: number,
  reference: Pick<CanvasZoomClip, "id" | "start" | "end">,
  requestedStart: number
): { start: number; end: number } {
  // Preserve the clip's real duration — legacy clips shorter than the
  // creation floor must not silently grow on move (only the degenerate floor
  // guards corrupt zero/negative spans).
  const duration = Math.max(
    ZOOM_CLIP_DEGENERATE_SECONDS,
    reference.end - reference.start
  )
  const { lo, hi } = getZoomGapBounds(
    clips,
    timelineDuration,
    reference.start,
    reference.end,
    reference.id
  )
  const maxStart = Math.max(lo, hi - duration)
  let start = clamp(
    isFiniteTime(requestedStart) ? requestedStart : reference.start,
    lo,
    maxStart
  )
  if (Math.abs(start - lo) < ZOOM_WELD_EPSILON_SECONDS) start = lo
  else if (Math.abs(start - maxStart) < ZOOM_WELD_EPSILON_SECONDS) {
    start = maxStart
  }
  return { start, end: start + duration }
}

/**
 * Clamp a resize of `reference` so the moving edge stops flush at the
 * neighbour / timeline bound and never crosses the minimum duration, instead
 * of the step being rejected. The anchored edge is returned exactly as
 * committed (no pixel↔time float drift). Same weld rule as `clampZoomMove`.
 */
export function clampZoomResize(
  clips: readonly CanvasZoomClip[],
  timelineDuration: number,
  reference: Pick<CanvasZoomClip, "id" | "start" | "end">,
  requested: { start: number; end: number },
  dir: "left" | "right"
): { start: number; end: number } {
  const { lo, hi } = getZoomGapBounds(
    clips,
    timelineDuration,
    reference.start,
    reference.end,
    reference.id
  )

  if (dir === "left") {
    const maxStart = reference.end - MIN_ZOOM_CLIP_SECONDS
    let start = clamp(
      isFiniteTime(requested.start) ? requested.start : reference.start,
      lo,
      Math.max(lo, maxStart)
    )
    if (Math.abs(start - lo) < ZOOM_WELD_EPSILON_SECONDS) start = lo
    return { start, end: reference.end }
  }

  // The wall beats the duration floor: when the available gap is smaller
  // than the minimum (legacy short clip boxed in by its neighbour), the edge
  // fills the gap instead of crossing into the neighbour.
  const minEnd = reference.start + MIN_ZOOM_CLIP_SECONDS
  let end = clamp(
    isFiniteTime(requested.end) ? requested.end : reference.end,
    Math.min(minEnd, hi),
    hi
  )
  if (Math.abs(end - hi) < ZOOM_WELD_EPSILON_SECONDS) end = hi
  return { start: reference.start, end }
}
