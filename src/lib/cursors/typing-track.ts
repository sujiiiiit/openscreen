// Typing track — derived from a recording's keystroke + text-caret sidecars.
//
// Two editor behaviors read it, both in the preview AND the export (so they must
// stay pure functions of the recorded data — no per-frame state):
//
//   1. Hide-while-typing. macOS "hidden until the mouse moves" semantics: a
//      TYPING SESSION starts at a typing keyDown and ends at the first pointer
//      activity after it — a mouse-down, or a move that travels more than
//      `TYPING_WAKE_DISTANCE_PTS` from where the pointer sat when typing began.
//      Cursor-shape-only synthetic moves (same position) never end a session.
//      The cursor fades out over `TYPING_FADE_OUT_MS` at session start and back
//      in over `TYPING_FADE_IN_MS` at session end.
//   2. Caret follow. Inside a session, the auto-zoom camera targets the text
//      caret (Accessibility rect sampled after keyDowns) instead of the hidden
//      pointer. Because the whole recording is known up front, the sampler may
//      read slightly AHEAD — the first caret read lands ~40 ms after the first
//      key, and the camera can begin moving `leadMs` before typing starts — so
//      the follow has no reaction lag.
//
// Times are recording-relative ms (`processTimeMs − processTimeStartMs`), the
// same base as `SmoothedCursorTrack`. Positions are display points, top-left.

import type { CursorTrackData } from "@/types/api"

/** Pointer travel (display points) that ends a typing session. */
export const TYPING_WAKE_DISTANCE_PTS = 8
/** Cursor fade-out at the start of a typing session. */
export const TYPING_FADE_OUT_MS = 120
/** Cursor fade-in when pointer activity ends the session. */
export const TYPING_FADE_IN_MS = 160
/** Default anticipation for caret follow before a session's first key. */
export const TYPING_CARET_LEAD_MS = 300
/** How far past a session's first key to look for its first caret read. */
const TYPING_FIRST_CARET_LOOKAHEAD_MS = 600
// "element" caret samples are the focused field's frame (the app could not
// report an exact caret). Only a compact field's centre is a useful target; a
// large text area / web view centre is not, so those samples are dropped.
const ELEMENT_CARET_MAX_WIDTH_PTS = 600
const ELEMENT_CARET_MAX_HEIGHT_PTS = 120

export interface TypingSession {
  /** First typing keyDown of the session. */
  startMs: number
  /** First pointer activity after it; `Infinity` when the recording ends first. */
  endMs: number
  /** Last typing keyDown inside the session. */
  lastKeyMs: number
}

export interface TypingTrack {
  /** Typing keyDown times, ascending. */
  keys: Float64Array
  /** Cursor-hidden intervals, ascending + non-overlapping. */
  sessions: TypingSession[]
  /** Usable caret centres (display points), ascending in `t`. */
  caretT: Float64Array
  caretX: Float64Array
  caretY: Float64Array
}

function easeInOut(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

/** Index of the last element `<= value`, or -1. */
function lastIndexAtOrBefore(values: ArrayLike<number>, value: number): number {
  let lo = 0
  let hi = values.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (values[mid] <= value) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/**
 * Build the typing track from raw cursor data. Returns null when the recording
 * has no typing keystrokes (keystroke capture off / denied, or nothing typed).
 */
export function buildTypingTrack(
  data: CursorTrackData | null
): TypingTrack | null {
  if (!data || !data.typing || data.typing.length === 0) return null
  const origin = data.processTimeStartMs
  const keys = data.typing
    .map((k) => k.processTimeMs - origin)
    .filter((t) => Number.isFinite(t) && t >= 0)
    .sort((a, b) => a - b)
  if (keys.length === 0) return null

  const moves = data.moves
    .map((m) => ({ t: m.processTimeMs - origin, x: m.x, y: m.y }))
    .filter((m) => Number.isFinite(m.t) && Number.isFinite(m.x))
    .sort((a, b) => a.t - b.t)
  const downs = (data.clicks ?? [])
    .filter((c) => {
      const type = c.type?.toLowerCase()
      return type === "mousedown" || type === "down"
    })
    .map((c) => c.processTimeMs - origin)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)

  const sessions: TypingSession[] = []
  const wakeSq = TYPING_WAKE_DISTANCE_PTS * TYPING_WAKE_DISTANCE_PTS
  let moveIndex = 0
  let downIndex = 0
  let k = 0
  while (k < keys.length) {
    const startMs = keys[k]
    // Pointer position when typing began (last move at/before the key).
    while (moveIndex + 1 < moves.length && moves[moveIndex + 1].t <= startMs) {
      moveIndex++
    }
    const anchor = moves[moveIndex]
    let endMs = Infinity
    if (anchor) {
      for (let j = moveIndex + 1; j < moves.length; j++) {
        const m = moves[j]
        if (m.t <= startMs) continue
        const dx = m.x - anchor.x
        const dy = m.y - anchor.y
        if (dx * dx + dy * dy > wakeSq) {
          endMs = m.t
          break
        }
      }
    }
    while (downIndex < downs.length && downs[downIndex] <= startMs) downIndex++
    if (downIndex < downs.length) endMs = Math.min(endMs, downs[downIndex])

    let lastKeyMs = startMs
    while (k < keys.length && keys[k] < endMs) {
      lastKeyMs = keys[k]
      k++
    }
    sessions.push({ startMs, endMs, lastKeyMs })
  }

  const carets = (data.caret ?? [])
    .filter(
      (c) =>
        c.source !== "element" ||
        (c.width <= ELEMENT_CARET_MAX_WIDTH_PTS &&
          c.height <= ELEMENT_CARET_MAX_HEIGHT_PTS)
    )
    .map((c) => ({
      t: c.processTimeMs - origin,
      x: c.x + c.width / 2,
      y: c.y + c.height / 2,
    }))
    .filter((c) => Number.isFinite(c.t) && c.t >= 0)
    .sort((a, b) => a.t - b.t)

  return {
    keys: Float64Array.from(keys),
    sessions,
    caretT: Float64Array.from(carets, (c) => c.t),
    caretX: Float64Array.from(carets, (c) => c.x),
    caretY: Float64Array.from(carets, (c) => c.y),
  }
}

/** The session covering `tMs` (start inclusive, end exclusive), or null. */
export function typingSessionAt(
  track: TypingTrack,
  tMs: number
): TypingSession | null {
  const sessions = track.sessions
  let lo = 0
  let hi = sessions.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sessions[mid].startMs <= tMs) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (found < 0) return null
  const session = sessions[found]
  return tMs < session.endMs ? session : null
}

/**
 * Cursor opacity (0..1) at `tMs` under hide-while-typing. 1 outside every
 * session; fades out at a session's start and back in after its end. The
 * fade-in starts from wherever the fade-out had reached, so a session shorter
 * than the fade never pops.
 */
export function typingCursorAlphaAt(track: TypingTrack, tMs: number): number {
  const sessions = track.sessions
  let lo = 0
  let hi = sessions.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sessions[mid].startMs <= tMs) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (found < 0) return 1
  const session = sessions[found]
  const fadeOut = (t: number) =>
    1 - easeInOut((t - session.startMs) / TYPING_FADE_OUT_MS)
  if (tMs < session.endMs) return fadeOut(tMs)
  const sinceEnd = tMs - session.endMs
  if (sinceEnd >= TYPING_FADE_IN_MS) return 1
  const fromAlpha = fadeOut(session.endMs)
  return fromAlpha + (1 - fromAlpha) * easeInOut(sinceEnd / TYPING_FADE_IN_MS)
}

/**
 * The text caret (display points) the camera should target at `tMs`, or null
 * when the pointer — not the caret — is the focus (outside every session, or no
 * usable caret read for the session). Within a session it holds the latest
 * caret read; before the session's first read it uses that first read
 * (lookahead). Up to `leadMs` before a session it already returns the session's
 * first caret so a zoom can start moving toward it before the first key.
 */
export function sampleTypingCaretAt(
  track: TypingTrack,
  tMs: number,
  leadMs: number = TYPING_CARET_LEAD_MS
): { x: number; y: number } | null {
  if (track.caretT.length === 0) return null
  let session = typingSessionAt(track, tMs)
  if (!session && leadMs > 0) {
    const ahead = typingSessionAt(track, tMs + leadMs)
    if (ahead && ahead.startMs > tMs) session = ahead
  }
  if (!session) return null

  const { caretT, caretX, caretY } = track
  const at = Math.max(tMs, session.startMs)
  const idx = lastIndexAtOrBefore(caretT, at)
  if (idx >= 0 && caretT[idx] >= session.startMs) {
    return { x: caretX[idx], y: caretY[idx] }
  }
  // No read yet in this session — use its first read, if it arrives soon.
  const next = idx + 1
  if (
    next < caretT.length &&
    caretT[next] < session.endMs &&
    caretT[next] - session.startMs <= TYPING_FIRST_CARET_LOOKAHEAD_MS
  ) {
    return { x: caretX[next], y: caretY[next] }
  }
  return null
}

/**
 * Typing bursts for auto-zoom generation: runs of typing keys whose gaps stay
 * under `maxGapMs`, keeping only runs of at least `minKeys` (a stray keystroke
 * is not a zoom-worthy moment). Ascending, recording-relative ms.
 */
export function typingBursts(
  track: TypingTrack,
  options: { maxGapMs: number; minKeys: number }
): Array<{ startMs: number; endMs: number; keyCount: number }> {
  const bursts: Array<{ startMs: number; endMs: number; keyCount: number }> = []
  const keys = track.keys
  let i = 0
  while (i < keys.length) {
    let j = i
    while (j + 1 < keys.length && keys[j + 1] - keys[j] <= options.maxGapMs) j++
    const keyCount = j - i + 1
    if (keyCount >= options.minKeys) {
      bursts.push({ startMs: keys[i], endMs: keys[j], keyCount })
    }
    i = j + 1
  }
  return bursts
}
