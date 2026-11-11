// Auto-zoom GENERATION — a spatiotemporal SHOT PLANNER. Auto-zoom is a
// *generator of ordinary zoom clips*: it runs on a finished recording and emits
// plain `CanvasZoomClip`s onto the existing Zoom track, choosing WHEN
// (start/end), HOW MUCH (scale), and the framing anchor (focus). Every generated
// clip is `mode: "auto"`, so at render time its focus spring-follows the cursor
// (see `zoom-scene.ts`); the stored `focus` is the planned shot centre (what a
// Manual toggle lands on).
//
// It plans the way an editor cuts a screen recording, because the whole
// recording is known up front:
//
//   1. ACTIONS — every down-click, drag (down→up that travelled), and typing
//      burst becomes an action with a time span and a content box (the point,
//      the drag extent, or the caret line the burst covered).
//   2. SHOTS — actions group into one shot only when they are close in TIME
//      *and* their combined box still fits the zoomed view at the gentlest auto
//      scale. Time-only merging (the old Cap port) chained a whole recording of
//      scattered clicks into one zoom that panned across the screen; spatial
//      gating keeps a shot to one area of interest, and scattered activity stays
//      wide.
//   3. FRAMING — each shot's scale is fitted to its box (a point gets the full
//      auto zoom, a wide caret line or drag gets a gentler one), quantized to a
//      small palette so the video reads consistent; the focus is the box centre.
//   4. TIMING — the push-in LANDS before the first action (the click is seen in
//      a settled frame, not mid-zoom), and holds long enough after the last one
//      to read the result.
//   5. SHOT JOINS — a wide beat shorter than MIN_WIDE_GAP_MS is a "pump"
//      (out-and-straight-back-in). Two nearby shots that would pump merge into
//      one; two far shots first give back tail, and if that still can't buy a
//      readable wide beat they abut so the renderer welds them (direct A→B
//      transition, never through 1×).
//
// Pure + deterministic: the same inputs always yield the same clips (stable
// ids), so re-generating is idempotent.

import type { CanvasZoomClip, CanvasZoomFocus } from "@/types/editor-canvas"
import {
  MIN_ZOOM_CLIP_SECONDS,
  ZOOM_SCALE_MAX,
  clampZoomFocus,
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

/** Artboard-normalized (0..1) content box. */
export interface AutoZoomBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** A typing burst, mapped into editor space (see `auto-zoom-scene.ts`). */
export interface AutoZoomTypingBurst {
  /** Timeline seconds of the burst's first / last typing key. */
  startSeconds: number
  endSeconds: number
  /** Anchor: the caret (else pointer) at the first key, 0..1. */
  focus: CanvasZoomFocus
  /** Extent of the caret reads inside the burst; absent → just `focus`. */
  bounds?: AutoZoomBox
}

/** Keys further apart than this split into separate bursts. */
export const TYPING_BURST_MAX_GAP_MS = 1500
/** A run needs at least this many keys to count (a stray key isn't a moment). */
export const TYPING_BURST_MIN_KEYS = 3

/**
 * Lead-in before a shot's first action. With the default 1 s spring ramp the
 * amount is ~97% landed after 500 ms, so the first click plays in a settled
 * frame instead of mid-zoom.
 */
const PRE_PADDING_MS = 500
/**
 * Tail after a shot's last click / drag. Covers the 1 s zoom-out ramp plus ~1 s
 * of settled hold after the action, long enough to read its result.
 */
const CLICK_POST_PADDING_MS = 2000
/** Tail after a typing burst's last key (release soon after typing stops). */
const TYPING_POST_PADDING_MS = 1800
/** Shortest tail a shot may be trimmed to so a far neighbour gets a wide beat. */
const MIN_TAIL_MS = 1500
/** An action joins the current shot when it starts within this of the shot's last action. */
const JOIN_GAP_MS = 3000
/** A wide (1×) beat shorter than this reads as a pump and is avoided. */
const MIN_WIDE_GAP_MS = 1000
/** A shot welded to its successor must stay at least this long, else it is dropped. */
const MIN_SHOT_MS = 1200
/** A down→up pair travelling further than this (normalized) is a drag. */
const DRAG_MIN_TRAVEL = 0.03
/** A down→up pair longer than this is not treated as one gesture. */
const DRAG_MAX_MS = 10_000
/** Actions in the final stretch of the recording are ignored (no time to land). */
const TRAILING_ACTION_IGNORE_MS = 1000
/** A clip never ends closer than this to the recording's end. */
const END_CLAMP_PADDING_MS = 800
/** A clip never starts before this (1 ms). */
const START_MIN_MS = 1

/** Auto magnification palette: a point gets MAX, a broad box down to MIN. */
const AUTO_SCALE_MAX = 2.0
const AUTO_SCALE_MIN = 1.5
const AUTO_SCALE_STEP = 0.25
/**
 * Fraction of the zoomed view a shot's content may occupy — the rest is margin
 * so the content (and the cursor moving between its points) is never framed
 * against the edge.
 */
const SAFE_VIEW_FRACTION = 0.7

type Action = {
  startMs: number
  endMs: number
  box: AutoZoomBox
  tailMs: number
}

type Shot = {
  firstMs: number
  /** Latest action end in the shot (the last thing the viewer must see). */
  lastMs: number
  box: AutoZoomBox
  startMs: number
  endMs: number
  /**
   * An action too broad to frame at the gentlest auto scale (a drag across the
   * screen): it gets no zoom, and no neighbouring shot may cover it.
   */
  wide: boolean
}

const pointBox = (f: CanvasZoomFocus): AutoZoomBox => ({
  minX: f.x,
  minY: f.y,
  maxX: f.x,
  maxY: f.y,
})

const unionBox = (a: AutoZoomBox, b: AutoZoomBox): AutoZoomBox => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY),
})

const boxExtent = (b: AutoZoomBox) =>
  Math.max(b.maxX - b.minX, b.maxY - b.minY)

/** Whether a box fits the safe area of the view at `scale`. */
const fitsAtScale = (b: AutoZoomBox, scale: number) =>
  boxExtent(b) <= SAFE_VIEW_FRACTION / scale + 1e-9

/** The largest palette scale whose safe area contains the box. */
function fitScale(b: AutoZoomBox): number {
  const extent = boxExtent(b)
  const raw = extent > 0 ? SAFE_VIEW_FRACTION / extent : AUTO_SCALE_MAX
  const quantized = Math.floor(raw / AUTO_SCALE_STEP + 1e-9) * AUTO_SCALE_STEP
  return Math.min(
    ZOOM_SCALE_MAX,
    Math.max(AUTO_SCALE_MIN, Math.min(AUTO_SCALE_MAX, quantized))
  )
}

/** Down-clicks as actions; a down→up pair that travelled becomes one drag. */
function clickActions(clicks: readonly AutoZoomClickSample[]): Action[] {
  const sorted = clicks
    .filter((c) => Number.isFinite(c.tSeconds))
    .map((c) => ({ ...c, tMs: Math.floor(c.tSeconds * 1000) }))
    .sort((a, b) => a.tMs - b.tMs)
  const actions: Action[] = []
  for (let i = 0; i < sorted.length; i++) {
    const down = sorted[i]
    if (down.type !== "down") continue
    let box = pointBox(down.focus)
    let endMs = down.tMs
    for (let j = i + 1; j < sorted.length; j++) {
      const next = sorted[j]
      if (next.type === "down") break
      if (next.tMs - down.tMs > DRAG_MAX_MS) break
      const sameButton =
        down.button === undefined ||
        next.button === undefined ||
        next.button === down.button
      if (!sameButton) continue
      const travel = Math.hypot(
        next.focus.x - down.focus.x,
        next.focus.y - down.focus.y
      )
      if (travel > DRAG_MIN_TRAVEL) {
        box = unionBox(box, pointBox(next.focus))
        endMs = next.tMs
      }
      break
    }
    actions.push({
      startMs: down.tMs,
      endMs,
      box,
      tailMs: CLICK_POST_PADDING_MS,
    })
  }
  return actions
}

function typingActions(bursts: readonly AutoZoomTypingBurst[]): Action[] {
  return bursts
    .filter(
      (b) =>
        Number.isFinite(b.startSeconds) &&
        Number.isFinite(b.endSeconds) &&
        b.endSeconds >= b.startSeconds
    )
    .map((b) => ({
      startMs: Math.floor(b.startSeconds * 1000),
      endMs: Math.floor(b.endSeconds * 1000),
      box: b.bounds
        ? unionBox(b.bounds, pointBox(b.focus))
        : pointBox(b.focus),
      tailMs: TYPING_POST_PADDING_MS,
    }))
}

/**
 * Generate auto-zoom clips from recorded clicks (+ optional typing bursts) by
 * planning spatiotemporal shots — see the file header for the model. Returns a
 * single non-overlapping lane (via {@link normalizeZoomClips}); empty when there
 * are no usable actions.
 */
export function generateZoomClipsFromClicks(
  clicks: readonly AutoZoomClickSample[],
  durationSeconds: number,
  typingBursts: readonly AutoZoomTypingBurst[] = []
): CanvasZoomClip[] {
  if (!(durationSeconds > 0)) return []
  const durationMs = durationSeconds * 1000
  const actionCutoffMs = durationMs - TRAILING_ACTION_IGNORE_MS
  const endLimitMs = durationMs - END_CLAMP_PADDING_MS
  if (actionCutoffMs <= 0 || endLimitMs <= START_MIN_MS) return []

  const actions = [...clickActions(clicks), ...typingActions(typingBursts)]
    .filter((a) => a.startMs < actionCutoffMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  if (actions.length === 0) return []

  const windowFor = (firstMs: number, endMs: number) => ({
    startMs: Math.max(firstMs - PRE_PADDING_MS, START_MIN_MS),
    endMs: Math.min(endMs, endLimitMs),
  })

  // 1. Group actions into shots: close in time AND compact enough to frame
  //    together at the gentlest auto scale.
  const shots: Shot[] = []
  for (const a of actions) {
    const cur = shots[shots.length - 1]
    const union = cur ? unionBox(cur.box, a.box) : a.box
    if (
      cur &&
      !cur.wide &&
      a.startMs - cur.lastMs <= JOIN_GAP_MS &&
      fitsAtScale(union, AUTO_SCALE_MIN)
    ) {
      cur.lastMs = Math.max(cur.lastMs, a.endMs)
      cur.box = union
      cur.endMs = Math.min(Math.max(cur.endMs, a.endMs + a.tailMs), endLimitMs)
    } else {
      shots.push({
        firstMs: a.startMs,
        lastMs: a.endMs,
        box: a.box,
        ...windowFor(a.startMs, a.endMs + a.tailMs),
        wide: !fitsAtScale(a.box, AUTO_SCALE_MIN),
      })
    }
  }

  // 2. Resolve joins so no wide beat is shorter than MIN_WIDE_GAP_MS (a pump).
  //    A dropped shot's actions must stay wide, so once one is dropped the
  //    shots around it may neither merge nor weld across it (`blocked`), and
  //    the next shot may not start before its last action (`floorMs`).
  const resolved: Shot[] = []
  let blocked = false
  let floorMs = 0
  const drop = (s: Shot) => {
    blocked = true
    floorMs = Math.max(floorMs, s.lastMs)
  }
  for (const original of shots) {
    const shot = { ...original }
    if (shot.wide) {
      // Stays wide: end the shots before it by its start (dropping any that
      // would be left sub-readable), then block across it.
      for (;;) {
        const prev = resolved[resolved.length - 1]
        if (!prev || prev.endMs <= shot.firstMs) break
        prev.endMs = shot.firstMs
        if (prev.endMs - prev.startMs >= MIN_SHOT_MS) break
        drop(resolved.pop() as Shot)
      }
      drop(shot)
      continue
    }
    shot.startMs = Math.max(shot.startMs, floorMs)
    for (;;) {
      const prev = resolved[resolved.length - 1]
      if (!prev || shot.startMs - prev.endMs >= MIN_WIDE_GAP_MS) {
        resolved.push(shot)
        blocked = false
        break
      }
      const union = unionBox(prev.box, shot.box)
      if (!blocked && fitsAtScale(union, AUTO_SCALE_MIN)) {
        // Same area, just a slightly longer pause: stay in rather than pump.
        prev.lastMs = Math.max(prev.lastMs, shot.lastMs)
        prev.box = union
        prev.endMs = Math.max(prev.endMs, shot.endMs)
        break
      }
      // Different areas: give back tail to open a readable wide beat…
      const trimmedEnd = Math.min(
        prev.endMs,
        Math.max(prev.lastMs + MIN_TAIL_MS, prev.startMs + MIN_SHOT_MS)
      )
      if (shot.startMs - trimmedEnd >= MIN_WIDE_GAP_MS) {
        prev.endMs = Math.min(prev.endMs, shot.startMs - MIN_WIDE_GAP_MS)
        resolved.push(shot)
        blocked = false
        break
      }
      if (blocked) {
        // A dropped action sits between: push B's start back to open the wide
        // beat (B's first action plays wide); drop B if too little is left.
        prev.endMs = trimmedEnd
        shot.startMs = prev.endMs + MIN_WIDE_GAP_MS
        if (shot.endMs - shot.startMs < MIN_SHOT_MS) {
          drop(shot)
          break
        }
        resolved.push(shot)
        blocked = false
        break
      }
      // …or abut them so the renderer welds A → B without passing through 1×.
      // The cut sits after A's last action and no later than B's first.
      const cut =
        shot.startMs >= prev.lastMs
          ? shot.startMs
          : (prev.lastMs + shot.firstMs) / 2
      if (cut - prev.startMs < MIN_SHOT_MS) {
        // Squeezing A to fit would leave a sub-readable flash between two
        // reframes (rapid clicks hopping across the screen): drop A — those
        // actions stay wide — and resolve B against the shot before it. B may
        // not start pushing in before A's last action, or that action would
        // play off-screen in B's zoomed view.
        const dropped = resolved.pop()
        if (dropped) {
          drop(dropped)
          shot.startMs = Math.max(shot.startMs, dropped.lastMs)
        }
        continue
      }
      prev.endMs = cut
      shot.startMs = cut
      resolved.push(shot)
      break
    }
  }

  // 3. Emit: scale fitted to the shot's box, focus at its centre.
  const clips: CanvasZoomClip[] = []
  for (const s of resolved) {
    const startMs = Math.round(s.startMs)
    const endMs = Math.round(s.endMs)
    if ((endMs - startMs) / 1000 < MIN_ZOOM_CLIP_SECONDS) continue
    clips.push(
      withZoomClipDefaults({
        // Deterministic id (excludes scale) so re-generating doesn't churn ids.
        id: `auto-zoom-${startMs}-${endMs}`,
        start: startMs / 1000,
        end: endMs / 1000,
        scale: fitScale(s.box),
        mode: "auto",
        focus: clampZoomFocus({
          x: (s.box.minX + s.box.maxX) / 2,
          y: (s.box.minY + s.box.maxY) / 2,
        }),
      })
    )
  }

  return normalizeZoomClips(clips, durationSeconds)
}
