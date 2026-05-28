import type { CursorTrackData } from "@/types/api"
import type { CursorSetId } from "@/lib/cursors/cursor-manifest"
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
// Spring easing of the cursor path. OFF = the cursor lands exactly on every
// captured sample (no transition/lag) so you can judge raw capture accuracy;
// flip to true to re-enable Screen Studio-style smoothing.
export const CURSOR_SMOOTHING = false

/** Build the time-indexed cursor track from raw IPC data, applying the shared
 * smoothing choice. Returns null when there's no usable cursor data. */
export function buildCursorTrack(
  data: CursorTrackData | null,
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
  cursorSet: CursorSetId = CURSOR_SET,
): CursorPlacement | null {
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
    { width: video.width, height: video.height },
  )
  const sx = (sample.x / dw) * iw
  const sy = (sample.y / dh) * ih
  const localX = ((sx - crop.cropX) / crop.cropWidth) * video.width
  const localY = ((sy - crop.cropY) / crop.cropHeight) * video.height
  const onScreen =
    localX >= 0 && localX <= video.width && localY >= 0 && localY <= video.height

  const rad = (video.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const artboardX = video.x + localX * cos - localY * sin
  const artboardY = video.y + localX * sin + localY * cos

  // Uniform px-per-display-point scale (cover crop preserves aspect, so the
  // x and y scales coincide).
  const scale = (iw / dw) * (video.width / crop.cropWidth)
  const renderHeight = CURSOR_BOX_HEIGHT_POINTS * CURSOR_SCALE * scale
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
