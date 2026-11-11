// Timeline clip EDITS — split, ripple delete, speed — and the speed-aware
// timeline ↔ source mapping every consumer shares (preview playback, cursor,
// auto-zoom, export frames + audio). Pure: no React / DOM, so the editor and the
// exporter map time identically and every edit is unit-testable.
//
// Model: a `CanvasTimelineClip` plays source `[sourceIn, sourceOut)` across
// timeline `[start, end)` at `speed` (default 1), so
//   end − start = (sourceOut − sourceIn) / speed.
// Split / speed / delete act on a LINKED GROUP — every clip sharing the target's
// exact timeline span (a split cuts all tracks at the playhead, so a recording's
// screen + camera segments stay linked and stay in sync). Speed changes and
// deletes RIPPLE: later clips shift so no gap opens, and the returned
// `TimeRemap` carries the same old→new timeline mapping so timeline-anchored
// data (Zoom clips) can follow.

import { MIN_ZOOM_CLIP_SECONDS, normalizeZoomClips } from "@/lib/zoom-clips"
import {
  TYPING_FADE_IN_MS,
  TYPING_FADE_OUT_MS,
} from "@/lib/cursors/typing-track"
import type { CanvasTimelineClip, CanvasZoomClip } from "@/types/editor-canvas"

export const TIMELINE_SPEED_MIN = 0.25
export const TIMELINE_SPEED_MAX = 16
export const TIMELINE_SPEED_DEFAULT = 1
/** Speeds offered in the clip Speed menu. */
export const TIMELINE_SPEED_PRESETS = [0.5, 1, 1.5, 2, 3, 4, 8] as const
/** Shortest segment a split may leave on either side (timeline seconds). */
export const TIMELINE_SPLIT_MIN_SECONDS = 0.1
/** Clips whose edges agree within this are one linked group. */
const LINK_EPSILON_SECONDS = 1e-3

/** The fields the mapping needs (structural, so lighter clip shapes fit). */
export type TimelineClipTiming = {
  start: number
  end: number
  sourceIn: number
  sourceOut: number
  speed?: number
}

/** Old → new timeline time after an edit (monotonic non-decreasing). */
export type TimeRemap = (timelineSeconds: number) => number

export const IDENTITY_REMAP: TimeRemap = (t) => t

export function clampTimelineSpeed(speed: number | undefined): number {
  if (speed === undefined || !Number.isFinite(speed)) {
    return TIMELINE_SPEED_DEFAULT
  }
  return Math.min(TIMELINE_SPEED_MAX, Math.max(TIMELINE_SPEED_MIN, speed))
}

export function clipSpeed(clip: { speed?: number }): number {
  return clampTimelineSpeed(clip.speed)
}

/** Source seconds played at timeline `t` (not clamped to the clip). */
export function timelineToSourceSeconds(
  clip: TimelineClipTiming,
  t: number
): number {
  return clip.sourceIn + (t - clip.start) * clipSpeed(clip)
}

/** Timeline seconds at which source instant `s` plays (not clamped). */
export function sourceToTimelineSeconds(
  clip: TimelineClipTiming,
  s: number
): number {
  return clip.start + (s - clip.sourceIn) / clipSpeed(clip)
}

/** Every clip sharing `id`'s exact timeline span (including `id` itself). */
export function linkedClipIds(
  clips: readonly CanvasTimelineClip[],
  id: string
): string[] {
  const target = clips.find((c) => c.id === id)
  if (!target) return []
  return clips
    .filter(
      (c) =>
        Math.abs(c.start - target.start) <= LINK_EPSILON_SECONDS &&
        Math.abs(c.end - target.end) <= LINK_EPSILON_SECONDS
    )
    .map((c) => c.id)
}

/**
 * Split every clip that spans timeline `t` into two clips meeting at `t` (all
 * tracks, so linked recordings stay in sync). Segments shorter than
 * {@link TIMELINE_SPLIT_MIN_SECONDS} are not created. Both halves keep the
 * clip's speed + cursor flag; the right half gets `createId(clip)`. Returns the
 * original array when nothing spans `t`.
 */
export function splitTimelineClipsAt(
  clips: readonly CanvasTimelineClip[],
  t: number,
  createId: (clip: CanvasTimelineClip) => string
): CanvasTimelineClip[] {
  let changed = false
  const next: CanvasTimelineClip[] = []
  for (const clip of clips) {
    if (
      !(t - clip.start >= TIMELINE_SPLIT_MIN_SECONDS) ||
      !(clip.end - t >= TIMELINE_SPLIT_MIN_SECONDS)
    ) {
      next.push(clip)
      continue
    }
    const cut = Math.min(
      clip.sourceOut,
      Math.max(clip.sourceIn, timelineToSourceSeconds(clip, t))
    )
    next.push({ ...clip, end: t, sourceOut: cut })
    next.push({ ...clip, id: createId(clip), start: t, sourceIn: cut })
    changed = true
  }
  return changed ? next : (clips as CanvasTimelineClip[])
}

function spanOf(clips: readonly CanvasTimelineClip[], ids: ReadonlySet<string>) {
  let start = Infinity
  let end = -Infinity
  for (const c of clips) {
    if (!ids.has(c.id)) continue
    start = Math.min(start, c.start)
    end = Math.max(end, c.end)
  }
  return start < end ? { start, end } : null
}

/**
 * Remove `ids` (a linked group) and ripple: clips starting at/after the removed
 * span shift left by its length. When another (kept) clip still covers part of
 * the span, closing the gap would slide it out of sync, so the delete does not
 * ripple (a lift). Returns the new clips and the matching time remap.
 */
export function rippleDeleteTimelineClips(
  clips: readonly CanvasTimelineClip[],
  ids: readonly string[]
): { clips: CanvasTimelineClip[]; remap: TimeRemap } {
  const idSet = new Set(ids)
  const span = spanOf(clips, idSet)
  const kept = clips.filter((c) => !idSet.has(c.id))
  if (!span) return { clips: kept, remap: IDENTITY_REMAP }
  const { start: a, end: b } = span
  const covered = kept.some(
    (c) => c.start < b - LINK_EPSILON_SECONDS && c.end > a + LINK_EPSILON_SECONDS
  )
  if (covered) return { clips: kept, remap: IDENTITY_REMAP }
  const len = b - a
  const shift = (c: CanvasTimelineClip) =>
    c.start >= b - LINK_EPSILON_SECONDS
      ? { ...c, start: c.start - len, end: c.end - len }
      : c
  return {
    clips: kept.map(shift),
    remap: (t) => (t <= a ? t : t >= b ? t - len : a),
  }
}

/**
 * Set `speed` on `ids` (a linked group) and ripple: each clip keeps its source
 * range and its start, so its timeline length becomes
 * `(sourceOut − sourceIn) / speed`; clips starting at/after the group's old end
 * shift by the length change. Returns the original clips (identity remap) when
 * nothing changes.
 */
export function setTimelineClipsSpeed(
  clips: readonly CanvasTimelineClip[],
  ids: readonly string[],
  speed: number
): { clips: CanvasTimelineClip[]; remap: TimeRemap } {
  const nextSpeed = clampTimelineSpeed(speed)
  const idSet = new Set(ids)
  const group = clips.filter((c) => idSet.has(c.id))
  const span = spanOf(clips, idSet)
  if (!span || group.every((c) => Math.abs(clipSpeed(c) - nextSpeed) < 1e-9)) {
    return { clips: clips as CanvasTimelineClip[], remap: IDENTITY_REMAP }
  }
  const { start: a, end: b } = span
  // The linked group shares one span; its new length follows the first clip
  // (members of a group always share their speed, since every edit sets it on
  // the whole group).
  const ratio = clipSpeed(group[0]) / nextSpeed
  const newEnd = a + (b - a) * ratio
  const delta = newEnd - b
  const next = clips.map((c) => {
    if (idSet.has(c.id)) {
      return {
        ...c,
        speed: nextSpeed === TIMELINE_SPEED_DEFAULT ? undefined : nextSpeed,
        end: c.start + (c.sourceOut - c.sourceIn) / nextSpeed,
      }
    }
    if (c.start >= b - LINK_EPSILON_SECONDS) {
      return { ...c, start: c.start + delta, end: c.end + delta }
    }
    return c
  })
  return {
    clips: next,
    remap: (t) =>
      t <= a ? t : t >= b ? t + delta : a + (t - a) * ratio,
  }
}

/** Set (or clear) the per-clip hide-cursor flag on `ids`. */
export function setTimelineClipsHideCursor(
  clips: readonly CanvasTimelineClip[],
  ids: readonly string[],
  hide: boolean
): CanvasTimelineClip[] {
  const idSet = new Set(ids)
  let changed = false
  const next = clips.map((c) => {
    if (!idSet.has(c.id) || !!c.hideCursor === hide) return c
    changed = true
    return { ...c, hideCursor: hide ? true : undefined }
  })
  return changed ? next : (clips as CanvasTimelineClip[])
}

/**
 * Carry Zoom clips through a timeline edit: both edges go through `remap`
 * (so zooms over a sped-up stretch compress with it, zooms after it shift, and
 * zooms inside a deleted span collapse), clips left shorter than the Zoom
 * track's floor are dropped, and the lane is re-normalized.
 */
export function remapZoomClips(
  zoomClips: readonly CanvasZoomClip[],
  remap: TimeRemap,
  timelineDuration: number
): CanvasZoomClip[] {
  if (remap === IDENTITY_REMAP) return zoomClips as CanvasZoomClip[]
  const mapped = zoomClips
    .map((z) => ({ ...z, start: remap(z.start), end: remap(z.end) }))
    .filter((z) => z.end - z.start >= MIN_ZOOM_CLIP_SECONDS - 1e-9)
  return normalizeZoomClips(mapped, timelineDuration)
}

function easeInOut(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

/**
 * Cursor opacity (0..1) at timeline `t` from per-clip "Hide cursor". Uses the
 * SAME fade as hide-while-typing (`TYPING_FADE_OUT_MS` / `TYPING_FADE_IN_MS`,
 * smoothstep): it fades out from the start of a run of contiguous hidden clips
 * and back in after the run ends, the fade-in starting from wherever the
 * fade-out reached. Measured in timeline (on-screen) time, so the fade keeps
 * its length on sped-up clips. Pass the screen video's clips.
 */
export function clipCursorAlphaAt(
  screenClips: readonly { start: number; end: number; hideCursor?: boolean }[],
  t: number
): number {
  // Merge contiguous hidden clips into runs (sorted, small list).
  const runs: Array<{ start: number; end: number }> = []
  for (const c of [...screenClips].sort((x, y) => x.start - y.start)) {
    if (!c.hideCursor) continue
    const last = runs[runs.length - 1]
    if (last && c.start <= last.end + LINK_EPSILON_SECONDS) {
      last.end = Math.max(last.end, c.end)
    } else {
      runs.push({ start: c.start, end: c.end })
    }
  }
  const fadeOutS = TYPING_FADE_OUT_MS / 1000
  const fadeInS = TYPING_FADE_IN_MS / 1000
  let alpha = 1
  for (const run of runs) {
    if (t < run.start) break
    const fadeOut = (x: number) => 1 - easeInOut((x - run.start) / fadeOutS)
    if (t < run.end) {
      alpha = fadeOut(t)
      continue
    }
    const sinceEnd = t - run.end
    if (sinceEnd >= fadeInS) {
      alpha = 1
      continue
    }
    const from = fadeOut(run.end)
    alpha = from + (1 - from) * easeInOut(sinceEnd / fadeInS)
  }
  return alpha
}

/** Timeline seconds a sped-up stretch must cover to be worth a cut. */
const SPEED_RANGE_MIN_TIMELINE_SECONDS = 0.5

/**
 * Apply SOURCE-time speed ranges (e.g. from `planAutoSpeedRanges`) to the
 * screen recording: each range is mapped through every screen clip it overlaps,
 * the timeline is split at the mapped edges (all tracks, so the camera stays
 * linked), and the resulting linked segment is re-timed with ripple. Segments
 * the user already re-timed (speed ≠ 1) are left alone. Edits run latest-first,
 * so a ripple never moves a stretch that is still to be processed. Returns the
 * new clips and the composed time remap (apply it to Zoom clips).
 */
export function applySourceSpeedRanges(
  clips: readonly CanvasTimelineClip[],
  screenVideoId: string,
  ranges: readonly { startSeconds: number; endSeconds: number; speed: number }[],
  createId: (clip: CanvasTimelineClip) => string
): { clips: CanvasTimelineClip[]; remap: TimeRemap; applied: number } {
  type Segment = { t0: number; t1: number; speed: number }
  const segments: Segment[] = []
  for (const clip of clips) {
    if (clip.videoId !== screenVideoId || clipSpeed(clip) !== 1) continue
    for (const r of ranges) {
      const s0 = Math.max(r.startSeconds, clip.sourceIn)
      const s1 = Math.min(r.endSeconds, clip.sourceOut)
      if (!(s1 > s0)) continue
      const t0 = sourceToTimelineSeconds(clip, s0)
      const t1 = sourceToTimelineSeconds(clip, s1)
      if (t1 - t0 < SPEED_RANGE_MIN_TIMELINE_SECONDS) continue
      if (Math.abs(clampTimelineSpeed(r.speed) - 1) < 1e-9) continue
      segments.push({ t0, t1, speed: r.speed })
    }
  }
  segments.sort((a, b) => b.t0 - a.t0)

  let next = clips as CanvasTimelineClip[]
  const remaps: TimeRemap[] = []
  let applied = 0
  for (const seg of segments) {
    next = splitTimelineClipsAt(next, seg.t1, createId)
    next = splitTimelineClipsAt(next, seg.t0, createId)
    const target = next.find(
      (c) =>
        c.videoId === screenVideoId &&
        Math.abs(c.start - seg.t0) <= LINK_EPSILON_SECONDS &&
        Math.abs(c.end - seg.t1) <= LINK_EPSILON_SECONDS
    )
    if (!target) continue
    const result = setTimelineClipsSpeed(
      next,
      linkedClipIds(next, target.id),
      seg.speed
    )
    next = result.clips
    remaps.push(result.remap)
    applied++
  }
  const remap: TimeRemap =
    remaps.length === 0
      ? IDENTITY_REMAP
      : (t) => remaps.reduce((acc, r) => r(acc), t)
  return { clips: next, remap, applied }
}
