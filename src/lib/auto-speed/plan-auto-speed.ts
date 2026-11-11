// Auto speed-up PLANNING — finds the stretches of a recording worth playing
// faster, from the captured input data (no frame analysis):
//
//   • TYPING — runs of typing keys (the keystroke sidecar). Watching every
//     character land is slow; 2× keeps it legible.
//   • IDLE — stretches with no input at all: no clicks, no keys, and the
//     pointer not travelling. Usually waiting for a page / build / upload.
//
// Output is SOURCE-time ranges (recording seconds) with a target speed; the
// editor turns them into split + sped-up timeline segments via
// `applySourceSpeedRanges` (`src/lib/timeline-edits.ts`), which leaves any
// segment the user already re-timed alone. Pure + deterministic.

import type { CursorTrackData } from "@/types/api"
import { buildTypingTrack, typingBursts } from "@/lib/cursors/typing-track"

export type AutoSpeedKind = "typing" | "idle"

export interface AutoSpeedRange {
  /** Source (recording) seconds. */
  startSeconds: number
  endSeconds: number
  speed: number
  kind: AutoSpeedKind
}

export interface AutoSpeedOptions {
  /** Speed for typing runs; `null` = don't speed up typing. */
  typingSpeed: number | null
  /** Speed for idle stretches; `null` = don't speed up idle time. */
  idleSpeed: number | null
}

export const AUTO_SPEED_TYPING_DEFAULT = 2
export const AUTO_SPEED_IDLE_DEFAULT = 4

/** Keys further apart than this split a typing run. */
const TYPING_MAX_GAP_MS = 1500
/** A run needs this many keys to be worth speeding up. */
const TYPING_MIN_KEYS = 6
/** Keep the last key's landing at normal speed for a beat. */
const TYPING_TAIL_MS = 250
/** Pointer travel (display points) that counts as activity. */
const IDLE_MOVE_PTS = 6
/** A gap between activity this long is idle. */
const IDLE_MIN_MS = 3000
/** Normal-speed margin kept on both sides of an idle stretch. */
const IDLE_MARGIN_MS = 500
/** Ranges shorter than this (source) are not worth a cut. */
const MIN_RANGE_MS = 1500

/**
 * Plan auto speed-up ranges from captured input. Returns ascending,
 * non-overlapping source-time ranges; empty when there is nothing to speed up
 * (or no data).
 */
export function planAutoSpeedRanges(
  data: CursorTrackData | null,
  options: AutoSpeedOptions
): AutoSpeedRange[] {
  if (!data) return []
  const origin = data.processTimeStartMs
  const ranges: AutoSpeedRange[] = []

  if (options.typingSpeed !== null) {
    const typing = buildTypingTrack(data)
    if (typing) {
      for (const burst of typingBursts(typing, {
        maxGapMs: TYPING_MAX_GAP_MS,
        minKeys: TYPING_MIN_KEYS,
      })) {
        ranges.push({
          startSeconds: burst.startMs / 1000,
          endSeconds: (burst.endMs + TYPING_TAIL_MS) / 1000,
          speed: options.typingSpeed,
          kind: "typing",
        })
      }
    }
  }

  if (options.idleSpeed !== null) {
    // Activity instants: travelling moves, clicks, keys. Shape-only cursor
    // events (same position) are not activity.
    const activity: number[] = [0]
    const moves = data.moves
      .map((m) => ({ t: m.processTimeMs - origin, x: m.x, y: m.y }))
      .filter((m) => Number.isFinite(m.t) && m.t >= 0)
      .sort((a, b) => a.t - b.t)
    let anchor = moves[0]
    for (const m of moves) {
      if (Math.hypot(m.x - anchor.x, m.y - anchor.y) > IDLE_MOVE_PTS) {
        activity.push(m.t)
        anchor = m
      }
    }
    for (const c of data.clicks) activity.push(c.processTimeMs - origin)
    for (const k of data.typing ?? []) activity.push(k.processTimeMs - origin)
    const sorted = activity
      .filter((t) => Number.isFinite(t) && t >= 0)
      .sort((a, b) => a - b)
    // Trailing idle (after the last activity) is left alone: the recording's
    // real end isn't known here, and it is usually the reach for Stop.
    for (let i = 0; i + 1 < sorted.length; i++) {
      if (sorted[i + 1] - sorted[i] < IDLE_MIN_MS) continue
      ranges.push({
        startSeconds: (sorted[i] + (i === 0 ? 0 : IDLE_MARGIN_MS)) / 1000,
        endSeconds: (sorted[i + 1] - IDLE_MARGIN_MS) / 1000,
        speed: options.idleSpeed,
        kind: "idle",
      })
    }
  }

  // Ascending, non-overlapping (an earlier range wins), long enough.
  const out: AutoSpeedRange[] = []
  for (const r of ranges.sort(
    (a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds
  )) {
    const last = out[out.length - 1]
    const start = last ? Math.max(r.startSeconds, last.endSeconds) : r.startSeconds
    if ((r.endSeconds - start) * 1000 < MIN_RANGE_MS) continue
    out.push({ ...r, startSeconds: start })
  }
  return out
}
