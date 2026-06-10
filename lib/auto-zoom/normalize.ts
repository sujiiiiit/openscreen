// Stage: normalize. The renderer adapter
// (`components/editor/canvas/auto-zoom-scene.ts`) maps each captured stream into
// editor space (artboard-normalized focus + timeline seconds); this stage is
// the pure finalizer that sorts every stream by time and drops non-finite
// samples, so downstream stages can assume a clean, time-ordered track.
//
// Keeping the merge here (rather than in the adapter) means a future signal
// only has to be appended to the track — the ordering/sanitizing is centralized.

import { clampUnit } from "./geometry"
import type {
  InteractionEvent,
  InteractionTrack,
  MoveSample,
  NormRect,
} from "./types"

function sanitizeRect(rect: NormRect | undefined): NormRect | undefined {
  if (!rect) return undefined
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return undefined
  }
  const x = clampUnit(rect.x)
  const y = clampUnit(rect.y)
  const width = Math.min(Math.max(rect.width, 0), 1 - x)
  const height = Math.min(Math.max(rect.height, 0), 1 - y)
  if (width <= 0 || height <= 0) return undefined
  return { x, y, width, height }
}

function sanitizeMove(move: MoveSample): MoveSample | null {
  if (!Number.isFinite(move.t)) return null
  if (!move.pos || !Number.isFinite(move.pos.x) || !Number.isFinite(move.pos.y)) {
    return null
  }
  return {
    t: move.t,
    pos: { x: clampUnit(move.pos.x), y: clampUnit(move.pos.y) },
    cursorId: move.cursorId,
  }
}

function sanitizeEvent(event: InteractionEvent): InteractionEvent | null {
  if (!Number.isFinite(event.t)) return null
  const pos = event.pos
    ? { x: clampUnit(event.pos.x), y: clampUnit(event.pos.y) }
    : undefined
  return { ...event, pos, rect: sanitizeRect(event.rect) }
}

/** Sort + sanitize a raw track into the clean, time-ordered form stages expect. */
export function normalizeTrack(track: InteractionTrack): InteractionTrack {
  const moves = track.moves
    .map(sanitizeMove)
    .filter((m): m is MoveSample => m !== null)
    .sort((a, b) => a.t - b.t)

  const events = track.events
    .map(sanitizeEvent)
    .filter((e): e is InteractionEvent => e !== null)
    .sort((a, b) => a.t - b.t)

  const durationSeconds = Number.isFinite(track.durationSeconds)
    ? Math.max(0, track.durationSeconds)
    : 0

  return { moves, events, durationSeconds }
}
