// Auto-zoom GENERATION — a port of Cap's click-clustering
// (`generate_zoom_segments_from_clicks_impl`, Cap recording.rs:3112). Auto-zoom
// is a *generator of ordinary zoom clips*: it runs on a finished recording and
// emits plain `CanvasZoomClip`s onto the existing Zoom track, choosing only WHEN
// (start/end) and HOW MUCH (scale). Every generated clip is `mode: "auto"`, so at
// render time its focus spring-follows the cursor (see `zoom-scene.ts`); the
// stored `focus` is just the ease-in anchor (the first click position).
//
// The algorithm: pad each click into a window, **merge overlapping/near windows**
// (interval-gap merge — a new window joins when it starts within MERGE_GAP_MS of
// the growing cluster's END, so a run of clicks chains into one long zoom), ignore
// trailing clicks, and emit at a fixed magnification. Pure + deterministic: the
// same clicks always yield the same clips (stable ids), so re-generating is
// idempotent.

import type { CanvasZoomClip, CanvasZoomFocus } from "@/types/editor-canvas"
import {
  MIN_ZOOM_CLIP_SECONDS,
  ZOOM_SCALE_MAX,
  normalizeZoomClips,
  withZoomClipDefaults,
} from "@/lib/zoom-clips"

/** A single captured click, mapped into editor space. */
export interface AutoZoomClickSample {
  /** Timeline (composition) seconds — the zoom-clip time base. */
  tSeconds: number
  /** Artboard-normalized focus point (0..1), clamped, on-screen. */
  focus: CanvasZoomFocus
  /** Normalized button transition. */
  type: "down" | "up"
  /** Semantic cursor shape at the event (`pointingHand`, `iBeam`, …); unused. */
  cursorId?: string
  button?: number | string
}

// Cap's tuning (recording.rs:3112), ported verbatim.
/** Lead-in before a click that the zoom window starts at. */
const CLICK_PRE_PADDING_MS = 300
/** Tail after a click that the zoom window extends to. */
const CLICK_POST_PADDING_MS = 2500
/** A window joins the previous cluster when it starts within this of its END. */
const MERGE_GAP_MS = 2500
/** Clicks in the final stretch of the recording are ignored (no time to land). */
const TRAILING_CLICK_IGNORE_MS = 1000
/** A clip never ends closer than this to the recording's end. */
const CLICK_END_CLAMP_PADDING_MS = 800
/** A clip never starts before this (1 ms). */
const START_MIN_MS = 1
/** Fixed magnification for a generated clip. */
const AUTO_ZOOM_AMOUNT = 2.0

/**
 * Generate auto-zoom clips by clustering recorded clicks (a verbatim port of
 * Cap's `generate_zoom_segments_from_clicks_impl`). Each down-click is padded into
 * a window; windows are **merged when the next starts within MERGE_GAP_MS of the
 * growing cluster's end** (so a run of clicks chains into one long zoom — far
 * fewer, longer clips than a per-click-gap merge); each surviving cluster becomes
 * an `auto` clip at {@link AUTO_ZOOM_AMOUNT}. Returns a single non-overlapping lane
 * (via {@link normalizeZoomClips}). Empty when there are no usable clicks.
 */
export function generateZoomClipsFromClicks(
  clicks: readonly AutoZoomClickSample[],
  durationSeconds: number
): CanvasZoomClip[] {
  if (!(durationSeconds > 0)) return []
  const durationMs = durationSeconds * 1000
  const clickCutoffMs = durationMs - TRAILING_CLICK_IGNORE_MS
  const endLimitMs = durationMs - CLICK_END_CLAMP_PADDING_MS
  if (clickCutoffMs <= 0 || endLimitMs <= START_MIN_MS) return []

  type Interval = { start: number; end: number; focus: CanvasZoomFocus }
  const intervals: Interval[] = clicks
    .filter((c) => c.type === "down" && Number.isFinite(c.tSeconds))
    .map((c) => ({ tMs: Math.floor(c.tSeconds * 1000), focus: c.focus }))
    .filter((c) => c.tMs < clickCutoffMs)
    .sort((a, b) => a.tMs - b.tMs)
    .map((c) => ({
      start: Math.max(c.tMs - CLICK_PRE_PADDING_MS, START_MIN_MS),
      end: Math.min(c.tMs + CLICK_POST_PADDING_MS, endLimitMs),
      focus: c.focus,
    }))
    .filter((iv) => iv.end > iv.start)
  if (intervals.length === 0) return []

  // Interval-gap merge: a window joins the current cluster when it starts within
  // MERGE_GAP_MS of the cluster's (growing) end. Keeps the first click's focus.
  const merged: Interval[] = []
  for (const iv of intervals) {
    const last = merged[merged.length - 1]
    if (last && iv.start <= last.end + MERGE_GAP_MS) {
      last.end = Math.max(last.end, iv.end)
    } else {
      merged.push({ ...iv })
    }
  }

  const clips: CanvasZoomClip[] = []
  for (const m of merged) {
    const startSec = Math.round(m.start) / 1000
    const endSec = Math.round(m.end) / 1000
    if (endSec - startSec < MIN_ZOOM_CLIP_SECONDS) continue
    // Deterministic id (excludes scale) so re-generating doesn't churn ids.
    const id = `auto-zoom-${Math.round(m.start)}-${Math.round(m.end)}`
    clips.push(
      withZoomClipDefaults({
        id,
        start: startSec,
        end: endSec,
        scale: Math.min(AUTO_ZOOM_AMOUNT, ZOOM_SCALE_MAX),
        mode: "auto",
        focus: m.focus,
      })
    )
  }

  return normalizeZoomClips(clips, durationSeconds)
}
