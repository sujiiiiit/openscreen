// Stage: cinematography / pacing. Shared by both detectors. Turns raw zoom
// windows into the final track under the HIGH-RECALL model: every event keeps a
// zoom, and the only things that reduce the count are same-region merging and
// genuine idle.
//
//   1. merge   — fold same-region, near-in-time windows into one held zoom (so a
//                burst of clicks in one spot doesn't pump); the framed region is
//                their union and confidences add up.
//   2. tile    — extend a window's end to the next window's start across any gap
//                that ISN'T idle, so the camera moves region-to-region instead
//                of flashing wide between nearby events.
//   3. overlap — where windows still collide, clip the earlier end; if that would
//                drop it below the floor, MERGE it into the neighbour instead of
//                dropping it (nothing is lost).
//   4. cap     — a high per-minute safety cap; over it, the lowest-confidence
//                window is merged into its nearest neighbour (never dropped).
//
// Wide (identity) only happens where there is a real idle gap with no window.

import { focusDistance, rectCenter, rectUnion } from "./geometry"
import type { AutoZoomParams } from "./params"
import type { IdleSpan, ZoomWindow } from "./types"

function mergeSameRegion(
  windows: ZoomWindow[],
  params: AutoZoomParams
): ZoomWindow[] {
  const mergeGap = params.mergeGapMs / 1000
  const merged: ZoomWindow[] = []
  for (const win of windows) {
    const prev = merged[merged.length - 1]
    if (
      prev &&
      win.start - prev.end < mergeGap &&
      focusDistance(rectCenter(prev.region), rectCenter(win.region)) <
        params.mergeDist
    ) {
      prev.region = rectUnion(prev.region, win.region)
      prev.end = Math.max(prev.end, win.end)
      prev.score += win.score
      prev.typing = prev.typing || win.typing
      continue
    }
    merged.push({ ...win })
  }
  return merged
}

function idleBetween(
  aEnd: number,
  bStart: number,
  idleSpans: readonly IdleSpan[]
): boolean {
  for (const span of idleSpans) {
    if (span.t0 < bStart && span.t1 > aEnd) return true
  }
  return false
}

/**
 * Tile distinct windows: when two windows are separated by a non-idle gap below
 * `bridgeMaxGapMs`, hold the earlier zoom until the later one begins so the
 * camera moves between regions instead of dropping wide and back.
 */
function tile(
  windows: ZoomWindow[],
  idleSpans: readonly IdleSpan[],
  params: AutoZoomParams
): ZoomWindow[] {
  const bridgeMax = params.bridgeMaxGapMs / 1000
  for (let i = 0; i < windows.length - 1; i++) {
    const cur = windows[i]
    const next = windows[i + 1]
    const gap = next.start - cur.end
    if (gap > 0 && gap < bridgeMax && !idleBetween(cur.end, next.start, idleSpans)) {
      cur.end = next.start
    }
  }
  return windows
}

/**
 * Resolve residual overlaps by clipping the earlier window's end to the later
 * one's start. If clipping collapses it below the floor, the earlier window is
 * MERGED into the later one (its region + confidence are absorbed) rather than
 * dropped — recall is preserved.
 */
function resolveOverlaps(
  windows: ZoomWindow[],
  params: AutoZoomParams
): ZoomWindow[] {
  const out: ZoomWindow[] = []
  for (const win of windows) {
    const prev = out[out.length - 1]
    if (prev && prev.end > win.start) {
      const clippedPrevDuration = win.start - prev.start
      if (clippedPrevDuration < params.minZoomClipSeconds) {
        // The earlier window can't survive as its own clip — fold it forward.
        win.start = Math.min(prev.start, win.start)
        win.region = rectUnion(prev.region, win.region)
        win.score += prev.score
        win.typing = prev.typing || win.typing
        out.pop()
        out.push({ ...win })
        continue
      }
      prev.end = win.start
    }
    out.push({ ...win })
  }
  return out.filter((w) => w.end - w.start >= params.minZoomClipSeconds)
}

/**
 * Safety cap only. Over the per-minute limit, repeatedly fold the
 * lowest-confidence window into its nearest temporal neighbour (never dropped),
 * until under the cap.
 */
function enforceCap(
  windows: ZoomWindow[],
  durationSeconds: number,
  params: AutoZoomParams
): ZoomWindow[] {
  const cap = Math.max(1, Math.ceil((durationSeconds / 60) * params.maxZoomsPerMin))
  const out = windows.map((w) => ({ ...w }))
  while (out.length > cap) {
    // Lowest-confidence window (ties → earliest).
    let lo = 0
    for (let i = 1; i < out.length; i++) {
      if (out[i].score < out[lo].score) lo = i
    }
    const prev = out[lo - 1]
    const next = out[lo + 1]
    const target =
      prev && next
        ? next.start - out[lo].end <= out[lo].start - prev.end
          ? next
          : prev
        : (next ?? prev)
    if (!target) break
    target.start = Math.min(target.start, out[lo].start)
    target.end = Math.max(target.end, out[lo].end)
    target.region = rectUnion(target.region, out[lo].region)
    target.score += out[lo].score
    target.typing = target.typing || out[lo].typing
    out.splice(lo, 1)
  }
  return out
}

/** Apply the full high-recall pacing pass to a detector's raw windows. */
export function paceWindows(
  windows: ZoomWindow[],
  idleSpans: readonly IdleSpan[],
  durationSeconds: number,
  params: AutoZoomParams
): ZoomWindow[] {
  const sorted = [...windows].sort((a, b) => a.start - b.start || a.end - b.end)
  let out = mergeSameRegion(sorted, params)
  out = resolveOverlaps(out, params)
  out = tile(out, idleSpans, params)
  out = enforceCap(out, durationSeconds, params)
  return out
}
