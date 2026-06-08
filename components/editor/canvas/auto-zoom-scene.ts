// Renderer-side adapter: turns captured cursor data (`CursorTrackData`) into the
// geometry-free click samples the pure auto-zoom detector consumes. This is the
// single place that ties the detector to the editor's coordinate/time spaces, so
// it lives alongside `cursor-scene.ts` / `zoom-scene.ts` and reuses the SAME
// shared `displayPointToArtboard` math the cursor overlay uses — a generated
// zoom's focus therefore lands on exactly the pixel the cursor sits on.
//
// Mappings performed here:
//   • time:  source seconds (processTimeMs − processTimeStartMs) → timeline
//            seconds, by inverting the screen clip's source↔timeline mapping
//            (the inverse of `CursorController.getSourceSeconds`). Clicks whose
//            source time falls in a trimmed-out gap are dropped.
//   • space: display point → artboard pixels (shared cover-crop chain) →
//            artboard-normalized 0..1 focus. Off-video clicks are dropped.

import type { CursorTrackData } from "@/types/api"
import { clampZoomFocus } from "@/lib/zoom-clips"
import type { AutoZoomClickSample } from "@/lib/auto-zoom/zoom-detect"

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
 * source time was trimmed out of every clip (so the click is dropped). Mirrors
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

/**
 * Build auto-zoom detector input from captured cursor data. Pure: the same
 * inputs always yield the same samples, so detection is reproducible.
 *
 * @param data        Captured cursor track (moves + clicks + display size).
 * @param screenVideo The screen recording's placement on the artboard.
 * @param screenClips The screen video's timeline clips (sorted by start).
 * @param artboard    The artboard size (focus is normalized against it).
 */
export function autoZoomClicksFromCursorData(
  data: CursorTrackData,
  screenVideo: CursorVideoGeometry,
  screenClips: readonly AutoZoomScreenClip[],
  artboard: { width: number; height: number }
): AutoZoomClickSample[] {
  const aw = artboard.width > 0 ? artboard.width : 1
  const ah = artboard.height > 0 ? artboard.height : 1
  const samples: AutoZoomClickSample[] = []

  for (const click of data.clicks) {
    const type = normalizeClickType(click.type)
    if (!type) continue

    const sourceSeconds = (click.processTimeMs - data.processTimeStartMs) / 1000
    if (!Number.isFinite(sourceSeconds) || sourceSeconds < 0) continue

    const tSeconds = sourceToTimelineSeconds(sourceSeconds, screenClips)
    if (tSeconds === null) continue

    const mapped = displayPointToArtboard(
      click.x,
      click.y,
      screenVideo,
      data.displayWidth,
      data.displayHeight
    )
    if (!mapped.onScreen) continue

    samples.push({
      tSeconds,
      focus: clampZoomFocus({ x: mapped.x / aw, y: mapped.y / ah }),
      type,
      cursorId: click.cursorId,
      button: click.button,
    })
  }

  return samples
}
