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
import { sourceToTimelineSeconds as clipSourceToTimeline } from "@/lib/timeline-edits"
import {
  TYPING_BURST_MAX_GAP_MS,
  TYPING_BURST_MIN_KEYS,
  type AutoZoomBox,
  type AutoZoomClickSample,
  type AutoZoomTypingBurst,
} from "@/lib/auto-zoom/generate-from-clicks"
import {
  buildTypingTrack,
  sampleTypingCaretAt,
  typingBursts,
} from "@/lib/cursors/typing-track"
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
  speed?: number
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
      return clipSourceToTimeline(clip, sourceSeconds)
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

/**
 * Build the typing bursts the auto-zoom generator consumes (keystroke capture).
 * Each burst's anchor is the caret at its first key when the recording has a
 * caret read for it, else the pointer's last position before it. Bursts whose
 * start or end falls in a trimmed-out gap, or whose anchor is off-video, are
 * dropped. Pure + deterministic, like {@link autoZoomClicksFromCursorData}.
 */
export function autoZoomTypingFromCursorData(
  data: CursorTrackData,
  screenVideo: CursorVideoGeometry,
  screenClips: readonly AutoZoomScreenClip[],
  artboard: { width: number; height: number }
): AutoZoomTypingBurst[] {
  const typing = buildTypingTrack(data)
  if (!typing) return []
  const { mapTime, mapPos } = buildMappers(
    data,
    screenVideo,
    screenClips,
    artboard
  )
  const moves = [...data.moves].sort(
    (a, b) => a.processTimeMs - b.processTimeMs
  )
  // Last move at/before the time (binary search — moves run ~120 Hz).
  const pointerAt = (processTimeMs: number) => {
    let lo = 0
    let hi = moves.length - 1
    let found = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (moves[mid].processTimeMs <= processTimeMs) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return moves[found] ?? null
  }

  const bursts: AutoZoomTypingBurst[] = []
  for (const burst of typingBursts(typing, {
    maxGapMs: TYPING_BURST_MAX_GAP_MS,
    minKeys: TYPING_BURST_MIN_KEYS,
  })) {
    const startProcessMs = burst.startMs + data.processTimeStartMs
    const startSeconds = mapTime(startProcessMs)
    const endSeconds = mapTime(burst.endMs + data.processTimeStartMs)
    if (startSeconds === null || endSeconds === null) continue
    const caret = sampleTypingCaretAt(typing, burst.startMs, 0)
    const pointer = caret ? null : pointerAt(startProcessMs)
    const anchor = caret ?? pointer
    if (!anchor) continue
    const focus = mapPos(anchor.x, anchor.y)
    if (!focus) continue
    // Extent of the caret reads the burst produced (the line(s) being typed),
    // so the shot planner can frame the whole edit, not just its first key.
    let bounds: AutoZoomBox | undefined
    for (let i = 0; i < typing.caretT.length; i++) {
      const t = typing.caretT[i]
      if (t < burst.startMs) continue
      if (t > burst.endMs) break
      const p = mapPos(typing.caretX[i], typing.caretY[i])
      if (!p) continue
      bounds = bounds
        ? {
            minX: Math.min(bounds.minX, p.x),
            minY: Math.min(bounds.minY, p.y),
            maxX: Math.max(bounds.maxX, p.x),
            maxY: Math.max(bounds.maxY, p.y),
          }
        : { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }
    }
    bursts.push({ startSeconds, endSeconds, focus, bounds })
  }
  return bursts
}
