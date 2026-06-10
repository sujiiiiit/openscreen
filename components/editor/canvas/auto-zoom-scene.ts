// Renderer-side adapter: turns captured cursor data (`CursorTrackData`) into the
// geometry-free inputs the pure auto-zoom detector consumes. This is the single
// place that ties the detector to the editor's coordinate/time spaces, so it
// lives alongside `cursor-scene.ts` / `zoom-scene.ts` and reuses the SAME shared
// `displayPointToArtboard` math the cursor overlay uses — a generated zoom's
// focus therefore lands on exactly the pixel the cursor sits on.
//
// Mappings performed here:
//   • time:  source seconds (processTimeMs − processTimeStartMs) → timeline
//            seconds, by inverting the screen clip's source↔timeline mapping
//            (the inverse of `CursorController.getSourceSeconds`). Samples whose
//            source time falls in a trimmed-out gap are dropped.
//   • space: display point → artboard pixels (shared cover-crop chain) →
//            artboard-normalized 0..1 focus. Off-video samples are dropped.

import type { CursorTrackData } from "@/types/api"
import { clampZoomFocus } from "@/lib/zoom-clips"
import type {
  AutoZoomClickSample,
  InteractionButton,
  InteractionEvent,
  InteractionTrack,
  MoveSample,
  NormRect,
} from "@/lib/auto-zoom/zoom-detect"
import type { CanvasZoomFocus } from "@/types/editor-canvas"

import { displayPointToArtboard, type CursorVideoGeometry } from "./cursor-scene"

/** Timeline placement of the screen recording (composition ↔ source seconds). */
export interface AutoZoomScreenClip {
  start: number
  end: number
  sourceIn: number
  sourceOut: number
}

/**
 * Invert the screen clip's source↔timeline mapping: a source instant maps onto
 * the first clip whose `[sourceIn, sourceOut)` covers it. Returns null when the
 * source time was trimmed out of every clip (so the sample is dropped). Mirrors
 * `CursorController.getSourceSeconds` run backwards.
 */
function sourceToTimelineSeconds(
  sourceSeconds: number,
  clips: readonly AutoZoomScreenClip[]
): number | null {
  for (const clip of clips) {
    if (sourceSeconds >= clip.sourceIn && sourceSeconds < clip.sourceOut) {
      return clip.start + (sourceSeconds - clip.sourceIn)
    }
  }
  return null
}

function normalizeClickType(type: string | undefined): "down" | "up" | null {
  const t = type?.toLowerCase()
  if (t === "mousedown" || t === "down") return "down"
  if (t === "mouseup" || t === "up") return "up"
  return null
}

function normalizeButton(button: number | string | undefined): InteractionButton {
  if (button === "right" || button === 1 || button === 2) return "right"
  if (button === "other") return "other"
  return "left"
}

/** Build the shared time + position mappers for a recording's geometry. */
function buildMappers(
  data: CursorTrackData,
  screenVideo: CursorVideoGeometry,
  screenClips: readonly AutoZoomScreenClip[],
  artboard: { width: number; height: number }
) {
  const aw = artboard.width > 0 ? artboard.width : 1
  const ah = artboard.height > 0 ? artboard.height : 1

  const mapTime = (processTimeMs: number): number | null => {
    const sourceSeconds = (processTimeMs - data.processTimeStartMs) / 1000
    if (!Number.isFinite(sourceSeconds) || sourceSeconds < 0) return null
    return sourceToTimelineSeconds(sourceSeconds, screenClips)
  }

  const mapPos = (x: number, y: number): CanvasZoomFocus | null => {
    const mapped = displayPointToArtboard(
      x,
      y,
      screenVideo,
      data.displayWidth,
      data.displayHeight
    )
    if (!mapped.onScreen) return null
    return clampZoomFocus({ x: mapped.x / aw, y: mapped.y / ah })
  }

  // Map a FRAME-normalized rect (frame-analysis output, [0,1] of the recording
  // frame) into artboard-normalized bounds. A frame-normalized fx corresponds to
  // source pixel fx·intrinsic, which `displayPointToArtboard` reaches when fed
  // displayX = fx·displayWidth; we map all four corners (handles rotation) and
  // take their bbox.
  const mapFrameRect = (rect: NormRect): NormRect | null => {
    const corners: ReadonlyArray<readonly [number, number]> = [
      [rect.x, rect.y],
      [rect.x + rect.width, rect.y],
      [rect.x, rect.y + rect.height],
      [rect.x + rect.width, rect.y + rect.height],
    ]
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const [fx, fy] of corners) {
      const mapped = displayPointToArtboard(
        fx * data.displayWidth,
        fy * data.displayHeight,
        screenVideo,
        data.displayWidth,
        data.displayHeight
      )
      const ax = clamp01(mapped.x / aw)
      const ay = clamp01(mapped.y / ah)
      if (ax < minX) minX = ax
      if (ay < minY) minY = ay
      if (ax > maxX) maxX = ax
      if (ay > maxY) maxY = ay
    }
    const x = minX
    const y = minY
    const width = maxX - minX
    const height = maxY - minY
    if (!(width > 0) || !(height > 0)) return null
    return { x, y, width, height }
  }

  return { mapTime, mapPos, mapFrameRect }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * Build legacy click samples from captured cursor data. Retained for callers /
 * tests that work with clicks only; {@link autoZoomTrackFromCursorData} is the
 * richer path that also carries the cursor-move stream for the attention model.
 */
export function autoZoomClicksFromCursorData(
  data: CursorTrackData,
  screenVideo: CursorVideoGeometry,
  screenClips: readonly AutoZoomScreenClip[],
  artboard: { width: number; height: number }
): AutoZoomClickSample[] {
  const { mapTime, mapPos } = buildMappers(data, screenVideo, screenClips, artboard)
  const samples: AutoZoomClickSample[] = []

  for (const click of data.clicks) {
    const type = normalizeClickType(click.type)
    if (!type) continue
    const tSeconds = mapTime(click.processTimeMs)
    if (tSeconds === null) continue
    const focus = mapPos(click.x, click.y)
    if (!focus) continue
    samples.push({
      tSeconds,
      focus,
      type,
      cursorId: click.cursorId,
      button: click.button,
    })
  }

  return samples
}

/**
 * Build the full {@link InteractionTrack} (cursor moves + clicks) the staged
 * detector consumes. Pure: the same inputs always yield the same track, so
 * detection is reproducible.
 *
 * @param data            Captured cursor track (moves + clicks + display size).
 * @param screenVideo     The screen recording's placement on the artboard.
 * @param screenClips     The screen video's timeline clips (sorted by start).
 * @param artboard        The artboard size (positions are normalized against it).
 * @param durationSeconds The composition duration (clip times clamp to it).
 */
export function autoZoomTrackFromCursorData(
  data: CursorTrackData,
  screenVideo: CursorVideoGeometry,
  screenClips: readonly AutoZoomScreenClip[],
  artboard: { width: number; height: number },
  durationSeconds: number,
  // Optional frame-analysis output: FRAME-normalized content rects keyed by the
  // click's `processTimeMs`. Attached (mapped to artboard space) to the matching
  // click-down event's `rect`, which drives the zoom-out-to-fit reveal.
  frameRects?: ReadonlyMap<number, NormRect>
): InteractionTrack {
  const { mapTime, mapPos, mapFrameRect } = buildMappers(
    data,
    screenVideo,
    screenClips,
    artboard
  )

  const events: InteractionEvent[] = []
  for (const click of data.clicks) {
    const type = normalizeClickType(click.type)
    if (!type) continue
    const t = mapTime(click.processTimeMs)
    if (t === null) continue
    const pos = mapPos(click.x, click.y)
    if (!pos) continue
    let rect: NormRect | undefined
    if (type === "down" && frameRects) {
      const frameRect = frameRects.get(click.processTimeMs)
      if (frameRect) rect = mapFrameRect(frameRect) ?? undefined
    }
    events.push({
      t,
      kind: type === "down" ? "click-down" : "click-up",
      pos,
      cursorId: click.cursorId,
      button: normalizeButton(click.button),
      ...(rect ? { rect } : {}),
    })
  }

  const moves: MoveSample[] = []
  for (const move of data.moves) {
    const t = mapTime(move.processTimeMs)
    if (t === null) continue
    const pos = mapPos(move.x, move.y)
    if (!pos) continue
    moves.push({ t, pos, cursorId: move.cursorId })
  }

  return { moves, events, durationSeconds }
}
