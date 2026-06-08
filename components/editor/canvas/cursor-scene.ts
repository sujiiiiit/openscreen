import type { CursorTrackData } from "@/types/api"
import type { CursorSmoothingMode } from "@/types/editor-canvas"
import type {
  CursorAssetEntry,
  CursorSetId,
} from "@/lib/cursors/cursor-manifest"
import type { MotionBlurOptions } from "@/lib/motion-blur/types"
import { isCursorSetId, resolveCursorAsset } from "@/lib/cursors/cursor-set"
import {
  buildSmoothedTrack,
  clickEventsFromClicks,
  rawSamplesFromMoves,
  sampleCursorAtTime,
  type CursorSmoothingParams,
  type SmoothedCursorTrack,
} from "@/lib/cursors/cursor-track"

import { getVideoCoverCrop } from "./video-cover-crop"

// Cursor set + size. `macos` per the chosen default; the box height is measured
// in captured display points, then converted to artboard/output pixels through a
// stable reference frame. It intentionally does not inherit the current
// screen-video transform: resizing the video changes where the cursor travels,
// not how large the overlay cursor is.
//
// These constants live here (not in the overlay component) so the export
// pipeline composes the cursor with byte-for-byte the same set, size, and
// smoothing as the live editor preview — the cursor is part of the output
// video, so the two paths must agree. Same single-source-of-truth rationale as
// `video-scene-draw.ts` for the video appearance stack.
export const CURSOR_SET_DEFAULT: CursorSetId = "macos"
export const CURSOR_SET: CursorSetId = CURSOR_SET_DEFAULT
export const CURSOR_POINTER_CURSOR_ID = "arrow"
export const CURSOR_BOX_HEIGHT_POINTS = 52
export const CURSOR_SCALE = 1
const CURSOR_OPTICAL_SCALE_MIN = 0.4
const CURSOR_OPTICAL_SCALE_MAX = 1.25

// User-adjustable cursor size, expressed as a multiplier over the base render
// height (`CURSOR_BOX_HEIGHT_POINTS * CURSOR_SCALE`). The base size is the
// MINIMUM: `1` keeps the cursor at its reference-frame size, larger values
// magnify it for emphasis. Bounds are shared by the sidebar control, the
// provider clamp, the persistence validator, and the export pipeline so the
// editor preview and the encoded video always agree. Size scales the render
// box only — never the recorded path or current video transform. The hotspot
// offset scales with the box (see `placeCursor`), so the pointer stays pinned to
// the exact recorded position and the timing is untouched.
export const CURSOR_SIZE_MIN = 1
export const CURSOR_SIZE_MAX = 4
// New projects (and legacy project.json files that predate the setting) open at
// 220% — a comfortable emphasis size. `CURSOR_SIZE_MIN` is still the reference-
// frame 1:1 floor the slider can be dragged down to.
export const CURSOR_SIZE_DEFAULT = 2.2

/** Clamp any externally-supplied size multiplier into the supported range,
 * falling back to the default for non-finite input. */
export function clampCursorSize(multiplier: number): number {
  if (!Number.isFinite(multiplier)) return CURSOR_SIZE_DEFAULT
  return Math.min(CURSOR_SIZE_MAX, Math.max(CURSOR_SIZE_MIN, multiplier))
}
// --- Cursor smoothing -----------------------------------------------------
// All user-facing modes smooth the recorded path. We precompute a zero-phase
// forward/backward filter from the complete recording, so smoothing does not
// require an explicit timeline delay. Rapid is still smoothed, just lightly.
export const CURSOR_SMOOTHING_MODE_DEFAULT: CursorSmoothingMode = "default"
export const CURSOR_SMOOTHING_MODES: CursorSmoothingMode[] = [
  "rapid",
  "quick",
  "default",
  "slow",
]

const CURSOR_SMOOTHING_PARAMS: Record<
  CursorSmoothingMode,
  CursorSmoothingParams
> = {
  rapid: { timeConstantMs: 12, passes: 1 },
  quick: { timeConstantMs: 24, passes: 1 },
  default: { timeConstantMs: 48, passes: 2 },
  slow: { timeConstantMs: 84, passes: 2 },
}

const CURSOR_MOTION_ROTATION_SMOOTHING_PARAMS: Record<
  CursorSmoothingMode,
  { windowSec: number; samples: number }
> = {
  rapid: { windowSec: 0.1, samples: 3 },
  quick: { windowSec: 0.16, samples: 5 },
  default: { windowSec: 0.24, samples: 7 },
  slow: { windowSec: 0.36, samples: 9 },
}

// Click-press timing follows the same smoothing preset, so the cursor reads as
// one coherent motion personality: a Rapid path glides snappily AND clicks
// crisply, while Slow cushions both. Only the press/release *durations* and the
// release *overshoot* scale here — the press depth stays the user's Click
// downscale slider (`cursorClickPressScale`). `default` is pinned to the
// previously-shipped 70 / 220 / 0.09 so existing projects look identical.
const CURSOR_CLICK_PRESS_PARAMS: Record<
  CursorSmoothingMode,
  { pressInMs: number; releaseMs: number; overshoot: number }
> = {
  rapid: { pressInMs: 45, releaseMs: 150, overshoot: 0.06 },
  quick: { pressInMs: 58, releaseMs: 185, overshoot: 0.075 },
  default: { pressInMs: 70, releaseMs: 220, overshoot: 0.09 },
  slow: { pressInMs: 95, releaseMs: 300, overshoot: 0.12 },
}

export function clampCursorSmoothingMode(value: unknown): CursorSmoothingMode {
  return CURSOR_SMOOTHING_MODES.includes(value as CursorSmoothingMode)
    ? (value as CursorSmoothingMode)
    : CURSOR_SMOOTHING_MODE_DEFAULT
}

export function clampCursorSetId(value: unknown): CursorSetId {
  return typeof value === "string" && isCursorSetId(value)
    ? value
    : CURSOR_SET_DEFAULT
}

function cursorOpticalScale(asset: CursorAssetEntry): number {
  const scale = asset.opticalScale
  if (!Number.isFinite(scale) || scale <= 0) return 1
  return Math.min(
    CURSOR_OPTICAL_SCALE_MAX,
    Math.max(CURSOR_OPTICAL_SCALE_MIN, scale)
  )
}

// --- Cursor motion rotation (side lean) -----------------------------------
// Subtle Screen-Studio-style horizontal lean derived from recent velocity. The
// amount is a single persisted 0..1 slider. The velocity estimate is
// deterministic: no per-frame state, no easing timers, and the same result
// while scrubbing or exporting. (The full direction-follow "rotation" mode was
// removed 2026-06-06 — side lean is the only behavior; the legacy persisted
// `cursorMotionRotationMode` field is ignored.)
export const CURSOR_MOTION_ROTATION_DEFAULT = 0.35
export const CURSOR_MOTION_ROTATION_SIDE_LEAN_MAX_DEG = 10
export const CURSOR_MOTION_ROTATION_WINDOW_SEC = 0.08
export const CURSOR_MOTION_ROTATION_SATURATION_PX_PER_SEC = 900

// --- Cursor motion blur ---------------------------------------------------
// Screen-Studio-style directional blur on the moving cursor. A single user
// "intensity" (0..1) is the only exposed knob; the blur *velocity* is derived
// from how fast the cursor actually moves, so it "inherits" the motion. The
// derivation lives here (not in the overlay) so the export pipeline produces
// byte-for-byte the same blur as the live preview — same single-source-of-truth
// rationale as `placeCursor` and `video-scene-draw.ts`.
//
// New projects (and legacy project.json files that predate the setting) open at
// 0.2 — a subtle smear that reads as motion without softening the pointer.
export const CURSOR_MOTION_BLUR_DEFAULT = 0.2

// Tuning knobs (not user-facing):
// - finite-difference window for estimating cursor speed; small + fixed so the
//   estimate is identical in the editor preview and any export fps.
const CURSOR_BLUR_SAMPLE_DT_SEC = 1 / 120
// - intensity 1.0 ⇒ smear ≈ the distance the cursor travels in one 30fps frame
//   (a "full shutter" exposure). Scales linearly with intensity.
const CURSOR_BLUR_SHUTTER_SEC = 1 / 30
// - cap the smear length (px). Bounds both the look (no screen-long streaks) and
//   the per-frame cache size / cost.
const CURSOR_BLUR_MAX_SMEAR_PX = 200
// - below this the cursor is drawn sharp (no cache/filter): nearly-still pointer.
const CURSOR_BLUR_MIN_SMEAR_PX = 1.5
const CURSOR_BLUR_KERNEL_MIN = 5
const CURSOR_BLUR_KERNEL_MAX = 25

// Click press scale. Non-linear beats linear here: a quick ease into a user-
// controlled press plus a damped release/rebound reads like a physical click,
// while the hotspot remains pinned because `placeCursor` scales offset with the
// sprite. `1` disables the shrink; the current shipped value stays the default.
export const CURSOR_CLICK_PRESS_SCALE_MIN = 0.5
export const CURSOR_CLICK_PRESS_SCALE_MAX = 1
export const CURSOR_CLICK_PRESS_SCALE_DEFAULT = 0.78

/** Clamp the user motion-blur intensity into [0, 1], defaulting on bad input. */
export function clampCursorMotionBlur(value: number): number {
  if (!Number.isFinite(value)) return CURSOR_MOTION_BLUR_DEFAULT
  return Math.min(1, Math.max(0, value))
}

/** Clamp cursor motion-rotation amount into [0, 1], defaulting on bad input. */
export function clampCursorMotionRotation(value: number): number {
  if (!Number.isFinite(value)) return CURSOR_MOTION_ROTATION_DEFAULT
  return Math.min(1, Math.max(0, value))
}

/** Clamp the clicked cursor's target scale; 1 means no press shrink. */
export function clampCursorClickPressScale(value: number): number {
  if (!Number.isFinite(value)) return CURSOR_CLICK_PRESS_SCALE_DEFAULT
  return Math.min(
    CURSOR_CLICK_PRESS_SCALE_MAX,
    Math.max(CURSOR_CLICK_PRESS_SCALE_MIN, value)
  )
}

function oddKernel(value: number): number {
  let k = Math.round(value)
  if (k % 2 === 0) k += 1
  return Math.min(CURSOR_BLUR_KERNEL_MAX, Math.max(CURSOR_BLUR_KERNEL_MIN, k))
}

function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t))
  return 1 - Math.pow(1 - clamped, 3)
}

function cursorClickScaleAt(
  track: SmoothedCursorTrack,
  tMs: number,
  pressScale?: number,
  smoothingMode?: CursorSmoothingMode
): number {
  const clicks = track.clicks
  if (!clicks || clicks.length === 0) return 1

  const targetScale =
    typeof pressScale === "number"
      ? clampCursorClickPressScale(pressScale)
      : CURSOR_CLICK_PRESS_SCALE_DEFAULT
  // Press/release timing + overshoot follow the same smoothing preset as the
  // path glide; `clampCursorSmoothingMode` defaults to "default" for omitted or
  // bad input, so callers that don't pass a mode keep the previous feel.
  const timing = CURSOR_CLICK_PRESS_PARAMS[clampCursorSmoothingMode(smoothingMode)]
  let lo = 0
  let hi = clicks.length - 1
  if (tMs < clicks[0].t) return 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (clicks[mid].t <= tMs) lo = mid
    else hi = mid
  }
  const event = clicks[hi].t <= tMs ? clicks[hi] : clicks[lo]
  const dt = tMs - event.t
  const depth = 1 - targetScale
  if (depth <= 0) return 1

  if (event.type === "down") {
    const p = dt / timing.pressInMs
    if (p < 1) return 1 - depth * easeOutCubic(p)
    return targetScale
  }

  if (dt > timing.releaseMs) return 1
  const p = Math.min(1, Math.max(0, dt / timing.releaseMs))
  const base = targetScale + depth * easeOutCubic(p)
  const rebound =
    Math.min(timing.overshoot, depth * 0.75) *
    Math.sin(Math.PI * p) *
    (1 - p)
  return base + rebound
}

/** Build the time-indexed cursor track from raw IPC data, applying the shared
 * smoothing choice. Returns null when there's no usable cursor data. */
export function buildCursorTrack(
  data: CursorTrackData | null,
  options: { smoothingMode?: CursorSmoothingMode } = {}
): SmoothedCursorTrack | null {
  if (!data || data.moves.length === 0) return null
  const samples = rawSamplesFromMoves(data.moves, data.processTimeStartMs)
  if (samples.length === 0) return null
  const clicks = clickEventsFromClicks(
    data.clicks ?? [],
    data.processTimeStartMs
  )
  const mode = clampCursorSmoothingMode(options.smoothingMode)
  const params = CURSOR_SMOOTHING_PARAMS[mode]
  return buildSmoothedTrack(
    samples,
    data.displayWidth,
    data.displayHeight,
    params,
    clicks
  )
}

/** Minimal screen-video geometry the cursor placement needs. Both the editor's
 * `CanvasVideoItem` and the export's `ProjectVideo` conform to this. */
export interface CursorVideoGeometry {
  x: number
  y: number
  width: number
  height: number
  rotation: number
  intrinsicWidth: number
  intrinsicHeight: number
}

export interface CursorReferenceSize {
  width: number
  height: number
}

type CursorSample = NonNullable<ReturnType<typeof sampleCursorAtTime>>

export interface MappedCursorPoint {
  x: number
  y: number
  onScreen: boolean
}

/**
 * Map a captured display point (display-relative logical points, top-left
 * origin) into artboard pixels, through the screen video's object-fit:cover
 * crop and its placement/rotation on the artboard.
 *
 * Pure and SHARED: the cursor overlay (`placeCursor`) and the auto-zoom detector
 * both run points through this exact chain, so a generated zoom's focus lands on
 * precisely the pixel the cursor sits on. Do not duplicate this math elsewhere.
 *
 * `onScreen` is false when the point falls outside the visible (cropped) video
 * rect — callers hide the cursor, or drop the auto-zoom focus, in that case.
 *
 * To turn the result into a `CanvasZoomClip.focus`, divide by the artboard
 * width/height (focus is artboard-normalized, see `zoom-scene.ts`).
 */
export function displayPointToArtboard(
  displayX: number,
  displayY: number,
  video: CursorVideoGeometry,
  displayWidth: number,
  displayHeight: number
): MappedCursorPoint {
  const iw = video.intrinsicWidth || 1
  const ih = video.intrinsicHeight || 1
  const dw = displayWidth || iw
  const dh = displayHeight || ih

  // Display point → source pixel → cover-crop → node-local → artboard.
  const crop = getVideoCoverCrop(
    { width: iw, height: ih },
    { width: video.width, height: video.height }
  )
  const sx = (displayX / dw) * iw
  const sy = (displayY / dh) * ih
  const localX = ((sx - crop.cropX) / crop.cropWidth) * video.width
  const localY = ((sy - crop.cropY) / crop.cropHeight) * video.height
  const onScreen =
    localX >= 0 &&
    localX <= video.width &&
    localY >= 0 &&
    localY <= video.height

  const rad = (video.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    x: video.x + localX * cos - localY * sin,
    y: video.y + localX * sin + localY * cos,
    onScreen,
  }
}

export interface CursorPlacement {
  /** SVG asset URL for the current cursor shape. */
  url: string
  /** Rendered cursor box size, in artboard px. */
  width: number
  height: number
  /** Konva offset so the hotspot pixel lands on (x, y), in box px. */
  offsetX: number
  offsetY: number
  /** Artboard position of the cursor hotspot. */
  x: number
  y: number
  /** Rotation in degrees — pivots around the hotspot, matching the video. */
  rotation: number
  /** Velocity-derived tilt added to the video's base rotation, in degrees. */
  motionRotationDeg: number
  /** False when the hotspot is cropped off the visible video (hide the node). */
  onScreen: boolean
  /** Cursor sprite scale from click press/release animation. */
  clickScale: number
}

function mapCursorSampleToArtboard(
  sample: CursorSample,
  track: SmoothedCursorTrack,
  video: CursorVideoGeometry
): MappedCursorPoint {
  return displayPointToArtboard(
    sample.x,
    sample.y,
    video,
    track.displayWidth,
    track.displayHeight
  )
}

function cursorMotionRotationAt(
  track: SmoothedCursorTrack,
  video: CursorVideoGeometry,
  sourceSeconds: number,
  amount: number,
  smoothingMode: CursorSmoothingMode
): number {
  const params =
    CURSOR_MOTION_ROTATION_SMOOTHING_PARAMS[
      clampCursorSmoothingMode(smoothingMode)
    ]
  const sampleCount = Math.max(1, params.samples | 0)
  if (sampleCount <= 1 || params.windowSec <= 0) {
    return rawCursorMotionRotationAt(track, video, sourceSeconds, amount)
  }

  let weightedRotation = 0
  let totalWeight = 0
  const firstTrackSec = (track.t[0] ?? 0) / 1000
  const lastTrackSec = (track.t[track.t.length - 1] ?? 0) / 1000
  for (let index = 0; index < sampleCount; index++) {
    const centered =
      sampleCount === 1 ? 0 : index / Math.max(1, sampleCount - 1) - 0.5
    const sampleSeconds = sourceSeconds + centered * params.windowSec
    if (
      sampleSeconds < firstTrackSec + CURSOR_MOTION_ROTATION_WINDOW_SEC ||
      sampleSeconds > lastTrackSec
    ) {
      continue
    }
    const weight = 1 - Math.abs(centered)
    weightedRotation +=
      rawCursorMotionRotationAt(track, video, sampleSeconds, amount) * weight
    totalWeight += weight
  }

  return totalWeight > 0 ? weightedRotation / totalWeight : 0
}

function rawCursorMotionRotationAt(
  track: SmoothedCursorTrack,
  video: CursorVideoGeometry,
  sourceSeconds: number,
  amount: number
): number {
  const intensity = clampCursorMotionRotation(amount)
  if (intensity <= 0) return 0

  const currentSample = sampleCursorAtTime(track, sourceSeconds * 1000)
  if (!currentSample) return 0
  const previousSample = sampleCursorAtTime(
    track,
    (sourceSeconds - CURSOR_MOTION_ROTATION_WINDOW_SEC) * 1000
  )
  if (!previousSample) return 0

  const current = mapCursorSampleToArtboard(currentSample, track, video)
  const previous = mapCursorSampleToArtboard(previousSample, track, video)
  const dxArt = current.x - previous.x
  const dyArt = current.y - previous.y

  // Convert artboard displacement back into the screen video's local frame so
  // the lean reacts to the cursor's motion relative to the recorded screen,
  // even when the video node itself is rotated on the artboard.
  const rad = (-video.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dxLocal = dxArt * cos - dyArt * sin
  const velocityX = dxLocal / CURSOR_MOTION_ROTATION_WINDOW_SEC

  const normalizedVelocity = Math.min(
    1,
    Math.max(-1, velocityX / CURSOR_MOTION_ROTATION_SATURATION_PX_PER_SEC)
  )
  return (
    normalizedVelocity * CURSOR_MOTION_ROTATION_SIDE_LEAN_MAX_DEG * intensity
  )
}

/**
 * Map a recorded cursor sample at `sourceSeconds` (the screen recording's
 * source time) into artboard space, through the screen video's cover-crop and
 * transform. Pure: identical result whether called from the live editor's
 * per-tick placement or the exporter's per-frame loop, so the encoded cursor
 * matches the on-screen preview pixel-for-pixel.
 *
 * Returns null only when the track yields no sample or the cursor id resolves
 * to no asset; otherwise returns a placement whose `onScreen` flag carries the
 * crop test (the caller hides the node when false).
 */
export function placeCursor(
  track: SmoothedCursorTrack,
  video: CursorVideoGeometry,
  sourceSeconds: number,
  options: {
    sizeMultiplier?: number
    clickPressScale?: number
    cursorSet?: CursorSetId
    referenceSize?: CursorReferenceSize
    alwaysUsePointer?: boolean
    motionRotation?: number
    smoothingMode?: CursorSmoothingMode
  } = {}
): CursorPlacement | null {
  const {
    sizeMultiplier = CURSOR_SIZE_DEFAULT,
    clickPressScale,
    cursorSet = CURSOR_SET_DEFAULT,
    referenceSize,
    alwaysUsePointer = false,
    motionRotation = CURSOR_MOTION_ROTATION_DEFAULT,
    smoothingMode = CURSOR_SMOOTHING_MODE_DEFAULT,
  } = options
  const sample = sampleCursorAtTime(track, sourceSeconds * 1000)
  if (!sample) return null

  const cursorId = alwaysUsePointer ? CURSOR_POINTER_CURSOR_ID : sample.cursorId
  const asset = resolveCursorAsset(cursorId, cursorSet, CURSOR_SET_DEFAULT)
  if (!asset) return null

  const iw = video.intrinsicWidth || 1
  const ih = video.intrinsicHeight || 1
  const dw = track.displayWidth || iw
  const mapped = mapCursorSampleToArtboard(sample, track, video)
  const motionRotationDeg = cursorMotionRotationAt(
    track,
    video,
    sourceSeconds,
    motionRotation,
    smoothingMode
  )

  const targetSize = referenceSize ?? {
    width: video.width,
    height: video.height,
  }
  const refWidth =
    Number.isFinite(targetSize.width) && targetSize.width > 0
      ? targetSize.width
      : video.width
  const refHeight =
    Number.isFinite(targetSize.height) && targetSize.height > 0
      ? targetSize.height
      : video.height
  const referenceCrop = getVideoCoverCrop(
    { width: iw, height: ih },
    { width: refWidth, height: refHeight }
  )
  // Stable px-per-display-point scale. Use an artboard-sized reference target in
  // preview/export so default/min/max keep their original fitted-video look while
  // manual screen-video resizing no longer changes the cursor sprite size.
  const referenceScale =
    (iw / dw) * (refWidth / Math.max(1, referenceCrop.cropWidth))
  const renderScale =
    Number.isFinite(referenceScale) && referenceScale > 0 ? referenceScale : 1

  const clickScale = cursorClickScaleAt(
    track,
    sourceSeconds * 1000,
    clickPressScale,
    smoothingMode
  )
  const renderHeight =
    CURSOR_BOX_HEIGHT_POINTS *
    CURSOR_SCALE *
    clampCursorSize(sizeMultiplier) *
    cursorOpticalScale(asset) *
    renderScale *
    clickScale
  const aspect = asset.size[1] > 0 ? asset.size[0] / asset.size[1] : 1
  const renderWidth = renderHeight * aspect

  return {
    url: asset.url,
    width: renderWidth,
    height: renderHeight,
    offsetX: asset.hotspot[0] * renderWidth,
    offsetY: asset.hotspot[1] * renderHeight,
    x: mapped.x,
    y: mapped.y,
    rotation: video.rotation + motionRotationDeg,
    motionRotationDeg,
    onScreen: mapped.onScreen,
    clickScale,
  }
}

/**
 * Derive the motion-blur options for the cursor at `sourceSeconds` from how fast
 * it is moving, or null when no blur should be drawn (intensity 0, cursor still,
 * or no placement). Pure + shared, so the editor preview and the exporter blur
 * the cursor identically.
 *
 * The velocity is the cursor's displacement over a fixed finite-difference
 * window, converted to a smear length via a fixed shutter scaled by `intensity`,
 * and rotated into the cursor's LOCAL frame (the filter runs on the sprite's
 * texture before the node's rotation transform). `offset: 0` keeps the smear
 * centred on the pointer. The returned `{velocityX, velocityY, kernelSize,
 * offset}` maps 1:1 onto a Pixi `MotionBlurFilter` (see `pixi/cursor-sprite.ts`).
 */
export function computeCursorBlur(
  track: SmoothedCursorTrack,
  video: CursorVideoGeometry,
  sourceSeconds: number,
  options: {
    intensity: number
    sizeMultiplier?: number
    clickPressScale?: number
    cursorSet?: CursorSetId
    referenceSize?: CursorReferenceSize
    alwaysUsePointer?: boolean
    motionRotation?: number
    smoothingMode?: CursorSmoothingMode
  }
): MotionBlurOptions | null {
  const intensity = clampCursorMotionBlur(options.intensity)
  if (intensity <= 0) return null

  const placeOpts = {
    sizeMultiplier: options.sizeMultiplier,
    clickPressScale: options.clickPressScale,
    cursorSet: options.cursorSet,
    referenceSize: options.referenceSize,
    alwaysUsePointer: options.alwaysUsePointer,
    motionRotation: options.motionRotation,
    smoothingMode: options.smoothingMode,
  }
  const cur = placeCursor(track, video, sourceSeconds, placeOpts)
  const prev = placeCursor(
    track,
    video,
    sourceSeconds - CURSOR_BLUR_SAMPLE_DT_SEC,
    placeOpts
  )
  if (!cur || !prev) return null

  // Displacement in artboard px, rotated into the cursor's local (unrotated)
  // frame so the directional blur points the right way under video rotation
  // and under the velocity-derived cursor lean.
  const dxArt = cur.x - prev.x
  const dyArt = cur.y - prev.y
  const rad = (-cur.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dxL = dxArt * cos - dyArt * sin
  const dyL = dxArt * sin + dyArt * cos

  const dist = Math.hypot(dxL, dyL)
  if (dist <= 0) return null
  const speed = dist / CURSOR_BLUR_SAMPLE_DT_SEC // px/s
  const smear = Math.min(
    speed * CURSOR_BLUR_SHUTTER_SEC * intensity,
    CURSOR_BLUR_MAX_SMEAR_PX
  )
  if (smear < CURSOR_BLUR_MIN_SMEAR_PX) return null

  const ux = dxL / dist
  const uy = dyL / dist
  return {
    velocityX: ux * smear,
    velocityY: uy * smear,
    kernelSize: oddKernel(smear / 2),
    offset: 0,
  }
}

/** Derive the project folder from a recording asset's file:// URL.
 *
 * FALLBACK ONLY: the editor overlay and the export pipeline both prefer the
 * explicit project path (`project.path` / `ExportStartPayload.projectPath`)
 * to locate cursor sidecars; this URL derivation covers payloads and
 * sessions that predate the explicit path. */
export function projectFolderFromObjectUrl(objectUrl: string): string | null {
  if (!objectUrl.startsWith("file:")) return null
  try {
    const pathname = decodeURIComponent(new URL(objectUrl).pathname)
    const slash = pathname.lastIndexOf("/")
    return slash > 0 ? pathname.slice(0, slash) : null
  } catch {
    return null
  }
}
