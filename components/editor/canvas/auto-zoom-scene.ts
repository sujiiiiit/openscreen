// Renderer-side adapter: turns captured cursor data (`CursorTrackData`) into the
// geometry-free click samples the auto-zoom generator consumes. This is the
// single place that ties generation to the editor's coordinate/time spaces, so it
// lives alongside `cursor-scene.ts` / `zoom-scene.ts` and reuses the SAME shared
// `displayPointToArtboard` math the cursor overlay uses — a generated zoom's
// ease-in anchor therefore lands on exactly the pixel the cursor sat on.
//
// Mappings performed here:
//   • time:  source seconds (processTimeMs − processTimeStartMs) → timeline
//            seconds, by inverting the screen clip's source↔timeline mapping.
//            Samples whose source time falls in a trimmed-out gap are dropped.
//   • space: display point → artboard pixels (shared cover-crop chain) →
//            artboard-normalized 0..1 focus. Off-video samples are dropped.

import type { CursorTrackData } from "@/types/api"
import { clampZoomFocus } from "@/lib/zoom-clips"
import type { AutoZoomClickSample } from "@/lib/auto-zoom/generate-from-clicks"
import type { CanvasZoomFocus } from "@/types/editor-canvas"

import {
  displayPointToArtboard,
  type CursorVideoGeometry,
} from "./cursor-scene"

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

  return { mapTime, mapPos }
}

/**
 * Build the click samples the auto-zoom generator consumes from captured cursor
 * data. Pure: the same inputs always yield the same samples, so generation is
 * reproducible.
 *
 * @param data        Captured cursor track (moves + clicks + display size).
 * @param screenVideo The screen recording's placement on the artboard.
 * @param screenClips The screen video's timeline clips (sorted by start).
 * @param artboard    The artboard size (positions are normalized against it).
 */
export function autoZoomClicksFromCursorData(
  data: CursorTrackData,
  screenVideo: CursorVideoGeometry,
  screenClips: readonly AutoZoomScreenClip[],
  artboard: { width: number; height: number }
): AutoZoomClickSample[] {
  const { mapTime, mapPos } = buildMappers(
    data,
    screenVideo,
    screenClips,
    artboard
  )
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
