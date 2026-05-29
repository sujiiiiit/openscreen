import type { CursorTrackData } from "@/types/api"
import type { CursorMotionBlurBackend } from "@/types/editor-canvas"
import type { CursorSetId } from "@/lib/cursors/cursor-manifest"
import type { MotionBlurOptions } from "@/lib/motion-blur/types"
import { resolveCursorAsset } from "@/lib/cursors/cursor-set"
import {
  buildRawTrack,
  buildSmoothedTrack,
  rawSamplesFromMoves,
  sampleCursorAtTime,
  type SmoothedCursorTrack,
} from "@/lib/cursors/cursor-track"

import { getVideoCoverCrop } from "./video-cover-crop"

// Cursor set + size. `macos` per the chosen default; the box height is the
// rendered SVG height in *display points* (the cursor coordinate space) before
// it is scaled into artboard pixels — purely cosmetic, tune to taste. Position
// and hotspot alignment are exact regardless of this value.
//
// These constants live here (not in the overlay component) so the export
// pipeline composes the cursor with byte-for-byte the same set, size, and
// smoothing as the live editor preview — the cursor is part of the output
// video, so the two paths must agree. Same single-source-of-truth rationale as
// `video-scene-draw.ts` for the video appearance stack.
export const CURSOR_SET: CursorSetId = "macos"
export const CURSOR_BOX_HEIGHT_POINTS = 52
export const CURSOR_SCALE = 1

// User-adjustable cursor size, expressed as a multiplier over the base render
// height (`CURSOR_BOX_HEIGHT_POINTS * CURSOR_SCALE`). The base size is the
// MINIMUM: `1` reproduces the recorded-accurate cursor exactly, larger values
// magnify it for emphasis. Bounds are shared by the sidebar control, the
// provider clamp, the persistence validator, and the export pipeline so the
// editor preview and the encoded video always agree. Size scales the render
// box only — the hotspot offset scales with it (see `placeCursor`), so the
// pointer stays pinned to the exact recorded position and the timing is
// untouched. Accuracy is preserved at every size.
export const CURSOR_SIZE_MIN = 1
export const CURSOR_SIZE_MAX = 4
// New projects (and legacy project.json files that predate the setting) open at
// 270% — a comfortable emphasis size. `CURSOR_SIZE_MIN` is still the recorded-
// accurate 1:1 floor the slider can be dragged down to.
export const CURSOR_SIZE_DEFAULT = 2.7

/** Clamp any externally-supplied size multiplier into the supported range,
 * falling back to the default for non-finite input. */
export function clampCursorSize(multiplier: number): number {
  if (!Number.isFinite(multiplier)) return CURSOR_SIZE_DEFAULT
  return Math.min(CURSOR_SIZE_MAX, Math.max(CURSOR_SIZE_MIN, multiplier))
}
// Spring easing of the cursor path. OFF = the cursor lands exactly on every
// captured sample (no transition/lag) so you can judge raw capture accuracy;
// flip to true to re-enable Screen Studio-style smoothing.
export const CURSOR_SMOOTHING = false

// --- Cursor motion blur ---------------------------------------------------
// Screen-Studio-style directional blur on the moving cursor. A single user
// "intensity" (0..1) is the only exposed knob; the blur *velocity* is derived
// from how fast the cursor actually moves, so it "inherits" the motion. The
// derivation lives here (not in the overlay) so the export pipeline produces
// byte-for-byte the same blur as the live preview — same single-source-of-truth
// rationale as `placeCursor` and `video-scene-draw.ts`.
//
// New projects (and legacy project.json files that predate the setting) open at
// 0.6 — a tasteful, clearly-visible amount.
export const CURSOR_MOTION_BLUR_DEFAULT = 0.6

// GPU keeps the interactive Konva preview responsive; CPU is available as an
// explicit fallback/comparison mode and uses the same Pixi-derived math.
export const CURSOR_MOTION_BLUR_BACKEND_DEFAULT: CursorMotionBlurBackend = "gpu"

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

/** Clamp the user motion-blur intensity into [0, 1], defaulting on bad input. */
export function clampCursorMotionBlur(value: number): number {
  if (!Number.isFinite(value)) return CURSOR_MOTION_BLUR_DEFAULT
  return Math.min(1, Math.max(0, value))
}

/** Clamp unknown persisted/UI backend input, defaulting to GPU. */
export function clampCursorMotionBlurBackend(
  value: unknown
): CursorMotionBlurBackend {
  return value === "cpu" ? "cpu" : CURSOR_MOTION_BLUR_BACKEND_DEFAULT
}

function oddKernel(value: number): number {
  let k = Math.round(value)
  if (k % 2 === 0) k += 1
  return Math.min(CURSOR_BLUR_KERNEL_MAX, Math.max(CURSOR_BLUR_KERNEL_MIN, k))
}

/** Build the time-indexed cursor track from raw IPC data, applying the shared
 * smoothing choice. Returns null when there's no usable cursor data. */
export function buildCursorTrack(
  data: CursorTrackData | null
): SmoothedCursorTrack | null {
  if (!data || data.moves.length === 0) return null
  const samples = rawSamplesFromMoves(data.moves, data.processTimeStartMs)
  if (samples.length === 0) return null
  return CURSOR_SMOOTHING
    ? buildSmoothedTrack(samples, data.displayWidth, data.displayHeight)
    : buildRawTrack(samples, data.displayWidth, data.displayHeight)
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
  /** False when the hotspot is cropped off the visible video (hide the node). */
  onScreen: boolean
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
  options: { sizeMultiplier?: number; cursorSet?: CursorSetId } = {}
): CursorPlacement | null {
  const { sizeMultiplier = CURSOR_SIZE_DEFAULT, cursorSet = CURSOR_SET } =
    options
  const sample = sampleCursorAtTime(track, sourceSeconds * 1000)
  if (!sample) return null

  const asset = resolveCursorAsset(sample.cursorId, cursorSet)
  if (!asset) return null

  const iw = video.intrinsicWidth || 1
  const ih = video.intrinsicHeight || 1
  const dw = track.displayWidth || iw
  const dh = track.displayHeight || ih

  // Display point → source pixel → cover-crop → node-local → artboard.
  const crop = getVideoCoverCrop(
    { width: iw, height: ih },
    { width: video.width, height: video.height }
  )
  const sx = (sample.x / dw) * iw
  const sy = (sample.y / dh) * ih
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
  const artboardX = video.x + localX * cos - localY * sin
  const artboardY = video.y + localX * sin + localY * cos

  // Uniform px-per-display-point scale (cover crop preserves aspect, so the
  // x and y scales coincide).
  const scale = (iw / dw) * (video.width / crop.cropWidth)
  const renderHeight =
    CURSOR_BOX_HEIGHT_POINTS *
    CURSOR_SCALE *
    clampCursorSize(sizeMultiplier) *
    scale
  const aspect = asset.size[1] > 0 ? asset.size[0] / asset.size[1] : 1
  const renderWidth = renderHeight * aspect

  return {
    url: asset.url,
    width: renderWidth,
    height: renderHeight,
    offsetX: asset.hotspot[0] * renderWidth,
    offsetY: asset.hotspot[1] * renderHeight,
    x: artboardX,
    y: artboardY,
    rotation: video.rotation,
    onScreen,
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
 * and rotated into the cursor's LOCAL frame (the Konva filter runs on the cached
 * bitmap before the node's rotation transform). `offset: 0` keeps the smear
 * centred on the pointer. The returned shape feeds `konvaMotionBlurFilter`
 * directly; the caller sizes the cache margin with `motionBlurPadding`.
 */
export function computeCursorBlur(
  track: SmoothedCursorTrack,
  video: CursorVideoGeometry,
  sourceSeconds: number,
  options: {
    intensity: number
    sizeMultiplier?: number
    cursorSet?: CursorSetId
  }
): MotionBlurOptions | null {
  const intensity = clampCursorMotionBlur(options.intensity)
  if (intensity <= 0) return null

  const placeOpts = {
    sizeMultiplier: options.sizeMultiplier,
    cursorSet: options.cursorSet,
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
  // frame so the directional blur points the right way under video rotation.
  const dxArt = cur.x - prev.x
  const dyArt = cur.y - prev.y
  const rad = (-video.rotation * Math.PI) / 180
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

/** Derive the project folder from a recording asset's file:// URL. Shared by
 * the editor overlay and the export pipeline to locate the cursor sidecar. */
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
