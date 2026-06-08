// Pure, deterministic auto-zoom detector.
//
// Auto-zoom is a *generator of ordinary manual zoom clips* (see
// `docs/auto-zoom-plan.md`). It runs once, when a finished recording first
// opens, analyses the captured clicks, and emits plain `CanvasZoomClip`s onto
// the existing manual Zoom track — choosing only WHEN (start/end, timeline
// seconds), WHERE (focus, artboard-normalized 0..1), and HOW MUCH (scale). The
// renderer, export, persistence, and Zoom panel are the manual system,
// unchanged; a generated clip is indistinguishable in kind from a hand-made one.
//
// This module is intentionally geometry-free: it consumes click samples whose
// coordinates are ALREADY mapped to artboard-normalized focus and whose times
// are ALREADY mapped to timeline seconds (the provider does that mapping with
// the shared `displayPointToArtboard` + the screen clip's source↔timeline
// conversion). That keeps the detector a pure function of its inputs — no
// React/DOM, no `Date.now()`/`Math.random()` — so the same input always yields
// byte-identical clips (deterministic ids included) and it can be exhaustively
// unit-tested on synthetic samples.

import {
  ZOOM_TRANSITION_CURVE_DEFAULT,
  clampZoomFocus,
  normalizeZoomClips,
  withZoomClipDefaults,
} from "@/lib/zoom-clips"
import type { CanvasZoomClip, CanvasZoomFocus } from "@/types/editor-canvas"

/** A captured click already mapped into the editor's coordinate/time spaces. */
export interface AutoZoomClickSample {
  /** Timeline (composition) seconds — the zoom-clip time base. */
  tSeconds: number
  /** Artboard-normalized focus point (0..1), clamped, on-screen. */
  focus: CanvasZoomFocus
  /** Normalized button transition. */
  type: "down" | "up"
  /** Semantic cursor shape at the event (`pointingHand`, `iBeam`, …). */
  cursorId?: string
  button?: number | string
}

export interface AutoZoomParams {
  /** Magnification on a normal click cluster. */
  zoomScale: number
  /** Magnification on a text-entry (iBeam) cluster. */
  zoomTyping: number
  /** Hard cap on generated scale (source-sharpness ceiling). */
  zoomMax: number
  /** Each ease-in / ease-out ramp length (ms). The manual sampler is symmetric. */
  easeMs: number
  /** Push-in starts this long before the first action so it lands on the click. */
  leadInMs: number
  /** Minimum total clip duration (ms) so a zoom reads as a deliberate hold. */
  minHoldMs: number
  /** New segment when the gap to the previous action exceeds this (ms). */
  segmentGapMs: number
  /** New segment when the focus jumps farther than this (normalized). */
  segmentFocusJump: number
  /** Merge two segments closer than this in time (ms) … */
  mergeGapMs: number
  /** … and whose focuses are within this normalized distance. */
  mergeDist: number
  /** Absolute clip-duration floor shared with the manual track (seconds). */
  minZoomClipSeconds: number
  /** A segment below this accumulated weight is dropped. */
  minSegmentWeight: number
  /** Rate limit on generated zooms. */
  maxZoomsPerMin: number
  /** down→up travel above this (normalized) is treated as a drag gesture. */
  dragMinTravel: number
  /** Clip every clip's end this far before the timeline end (ignore Stop click). */
  tailGuardMs: number
  /** Recordings shorter than this generate zero zooms. */
  minRecordingMs: number
}

// Calm & sparse defaults. Every threshold biases toward NOT zooming; the merge
// step is the biggest anti-pump lever. Taste lives here — tune freely.
export const AUTO_ZOOM_DEFAULTS: AutoZoomParams = {
  zoomScale: 1.8,
  zoomTyping: 2.0,
  zoomMax: 2.5,
  easeMs: 600,
  leadInMs: 350,
  minHoldMs: 1200,
  segmentGapMs: 1200,
  segmentFocusJump: 0.22,
  mergeGapMs: 2500,
  mergeDist: 0.18,
  minZoomClipSeconds: 0.5,
  minSegmentWeight: 1,
  maxZoomsPerMin: 4,
  dragMinTravel: 0.04,
  tailGuardMs: 800,
  minRecordingMs: 3000,
}

// Per-action intent weight multipliers by cursor shape: a click on a link/button
// (`pointingHand`) or a text field (`iBeam`) is a stronger "meaningful target"
// signal than a click on empty chrome.
const CURSOR_WEIGHT: Record<string, number> = {
  pointingHand: 1.15,
  iBeam: 1.1,
}
const DRAG_WEIGHT = 1.2

interface Action {
  /** Action start in timeline seconds (the down moment — when intent lands). */
  startSeconds: number
  /** Action end in timeline seconds (== start for a click; the up for a drag). */
  endSeconds: number
  focus: CanvasZoomFocus
  weight: number
  typing: boolean
}

interface Segment {
  startSeconds: number
  endSeconds: number
  focusX: number
  focusY: number
  weight: number
  typing: boolean
  count: number
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function focusDistance(a: CanvasZoomFocus, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function quantizeScale(scale: number, max: number): number {
  const capped = Math.min(max, Math.max(1, scale))
  return Math.round(capped / 0.05) * 0.05
}

/**
 * Deterministic clip id from the rounded start time + focus. Identical inputs
 * yield the identical id, so re-running the detector never churns the autosave
 * fingerprint (unlike `createZoomClipId`, which is time+counter based).
 */
function deterministicClipId(startSeconds: number, focus: CanvasZoomFocus): string {
  const s = Math.round(startSeconds * 1000)
  const fx = Math.round(clampUnit(focus.x) * 1000)
  const fy = Math.round(clampUnit(focus.y) * 1000)
  return `auto-zoom-${s}-${fx}-${fy}`
}

/**
 * Pair down→up clicks into press gestures and classify each as a click or a
 * drag. A click anchors at the press position; a drag (travel beyond
 * `dragMinTravel`) anchors at the release/settle position and spans the gesture.
 * Out-of-order / unmatched ups are ignored; an unmatched down becomes a
 * zero-length click. Stable: stable-sorted by time, then down-before-up.
 */
function actionsFromClicks(
  clicks: readonly AutoZoomClickSample[],
  params: AutoZoomParams
): Action[] {
  const sorted = clicks
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => Number.isFinite(c.tSeconds))
    .sort(
      (a, b) =>
        a.c.tSeconds - b.c.tSeconds ||
        (a.c.type === b.c.type ? 0 : a.c.type === "down" ? -1 : 1) ||
        a.index - b.index
    )
    .map(({ c }) => c)

  const actions: Action[] = []
  let pendingDown: AutoZoomClickSample | null = null

  const pushClick = (down: AutoZoomClickSample, up: AutoZoomClickSample | null) => {
    const downFocus = clampZoomFocus(down.focus)
    const upFocus = up ? clampZoomFocus(up.focus) : downFocus
    const travel = up ? focusDistance(downFocus, upFocus) : 0
    const isDrag = travel > params.dragMinTravel
    const typing = down.cursorId === "iBeam" || up?.cursorId === "iBeam"
    const cursorWeight =
      CURSOR_WEIGHT[down.cursorId ?? ""] ?? CURSOR_WEIGHT[up?.cursorId ?? ""] ?? 1
    actions.push({
      startSeconds: down.tSeconds,
      endSeconds: isDrag && up ? up.tSeconds : down.tSeconds,
      // Frame the result: a drag settles where it ends; a click is its point.
      focus: isDrag ? upFocus : downFocus,
      weight: cursorWeight * (isDrag ? DRAG_WEIGHT : 1),
      typing,
    })
  }

  for (const click of sorted) {
    if (click.type === "down") {
      if (pendingDown) pushClick(pendingDown, null)
      pendingDown = click
    } else if (pendingDown) {
      pushClick(pendingDown, click)
      pendingDown = null
    }
  }
  if (pendingDown) pushClick(pendingDown, null)

  return actions
}

/** Group actions into activity segments by time-gap and focus-jump. */
function segmentActions(actions: Action[], params: AutoZoomParams): Segment[] {
  const segments: Segment[] = []
  const gapSeconds = params.segmentGapMs / 1000

  for (const action of actions) {
    const current = segments[segments.length - 1]
    const newSegment =
      !current ||
      action.startSeconds - current.endSeconds > gapSeconds ||
      focusDistance(action.focus, {
        x: current.focusX / current.weight,
        y: current.focusY / current.weight,
      }) > params.segmentFocusJump

    if (newSegment) {
      segments.push({
        startSeconds: action.startSeconds,
        endSeconds: action.endSeconds,
        focusX: action.focus.x * action.weight,
        focusY: action.focus.y * action.weight,
        weight: action.weight,
        typing: action.typing,
        count: 1,
      })
      continue
    }

    current.endSeconds = Math.max(current.endSeconds, action.endSeconds)
    current.focusX += action.focus.x * action.weight
    current.focusY += action.focus.y * action.weight
    current.weight += action.weight
    current.typing = current.typing || action.typing
    current.count += 1
  }

  return segments
}

interface ZoomWindow {
  start: number
  end: number
  focus: CanvasZoomFocus
  scale: number
  weight: number
  typing: boolean
}

/** Resolve each segment into a clamped zoom window (lead-in + hold + tail). */
function windowsFromSegments(
  segments: Segment[],
  timelineDurationSeconds: number,
  params: AutoZoomParams
): ZoomWindow[] {
  const leadIn = params.leadInMs / 1000
  const tail = params.easeMs / 1000
  const minHold = params.minHoldMs / 1000
  const maxEnd = timelineDurationSeconds - params.tailGuardMs / 1000

  return segments.map((seg) => {
    const focus = clampZoomFocus({
      x: seg.focusX / seg.weight,
      y: seg.focusY / seg.weight,
    })
    const baseScale = seg.typing ? params.zoomTyping : params.zoomScale
    const start = Math.max(0, seg.startSeconds - leadIn)
    const rawEnd = Math.max(seg.endSeconds + tail, start + minHold)
    const end = Math.min(rawEnd, maxEnd)
    return {
      start,
      end,
      focus,
      scale: quantizeScale(baseScale, params.zoomMax),
      weight: seg.weight,
      typing: seg.typing,
    }
  })
}

/** Merge near-and-aligned windows; the biggest anti-pump lever. */
function mergeWindows(windows: ZoomWindow[], params: AutoZoomParams): ZoomWindow[] {
  const mergeGap = params.mergeGapMs / 1000
  const merged: ZoomWindow[] = []

  for (const win of windows) {
    const prev = merged[merged.length - 1]
    if (
      prev &&
      win.start - prev.end < mergeGap &&
      focusDistance(prev.focus, win.focus) < params.mergeDist
    ) {
      const weight = prev.weight + win.weight
      prev.focus = clampZoomFocus({
        x: (prev.focus.x * prev.weight + win.focus.x * win.weight) / weight,
        y: (prev.focus.y * prev.weight + win.focus.y * win.weight) / weight,
      })
      prev.end = Math.max(prev.end, win.end)
      prev.scale = Math.max(prev.scale, win.scale)
      prev.weight = weight
      prev.typing = prev.typing || win.typing
      continue
    }
    merged.push({ ...win })
  }

  return merged
}

/**
 * Resolve any residual overlap between distinct (non-merged) windows by clipping
 * the EARLIER window's end to the later one's start — the later window contains
 * a fresh action and keeps its full lead-in, while the earlier eases out into
 * the handoff. Windows that collapse below the floor are dropped.
 */
function resolveOverlaps(windows: ZoomWindow[], params: AutoZoomParams): ZoomWindow[] {
  for (let i = 0; i < windows.length - 1; i++) {
    if (windows[i].end > windows[i + 1].start) {
      windows[i].end = windows[i + 1].start
    }
  }
  return windows.filter((w) => w.end - w.start >= params.minZoomClipSeconds)
}

/**
 * Build auto-zoom clips from already-mapped click samples.
 *
 * @param clicks    Click samples in timeline seconds + artboard-normalized focus.
 * @param timelineDurationSeconds  The composition duration (clip times are clamped to it).
 * @param overrides Optional parameter overrides over {@link AUTO_ZOOM_DEFAULTS}.
 * @returns Ready-to-commit `CanvasZoomClip[]`, non-overlapping and fully defaulted.
 */
export function buildAutoZoomClips(
  clicks: readonly AutoZoomClickSample[],
  timelineDurationSeconds: number,
  overrides?: Partial<AutoZoomParams>
): CanvasZoomClip[] {
  const params = { ...AUTO_ZOOM_DEFAULTS, ...overrides }

  if (
    !Number.isFinite(timelineDurationSeconds) ||
    timelineDurationSeconds * 1000 < params.minRecordingMs
  ) {
    return []
  }

  const actions = actionsFromClicks(clicks, params)
  if (actions.length === 0) return []

  const segments = segmentActions(actions, params)

  let windows = windowsFromSegments(segments, timelineDurationSeconds, params)
  windows = windows.filter((w) => w.weight >= params.minSegmentWeight)
  windows = mergeWindows(windows, params)
  windows = resolveOverlaps(windows, params)

  // Rate limit: keep the highest-weight windows under the per-minute cap.
  const maxZooms = Math.max(
    1,
    Math.ceil((timelineDurationSeconds / 60) * params.maxZoomsPerMin)
  )
  if (windows.length > maxZooms) {
    windows = windows
      .map((w, index) => ({ w, index }))
      .sort((a, b) => b.w.weight - a.w.weight || a.index - b.index)
      .slice(0, maxZooms)
      .sort((a, b) => a.w.start - b.w.start)
      .map(({ w }) => w)
  }

  const clips = windows.map((w) =>
    withZoomClipDefaults({
      id: deterministicClipId(w.start, w.focus),
      start: w.start,
      end: w.end,
      enabled: true,
      focus: w.focus,
      scale: w.scale,
      transition: {
        durationMs: params.easeMs,
        curve: ZOOM_TRANSITION_CURVE_DEFAULT,
      },
    })
  )

  // Final safety net: guarantee the single non-overlapping lane invariant the
  // rest of the manual zoom system assumes.
  return normalizeZoomClips(clips, timelineDurationSeconds)
}
