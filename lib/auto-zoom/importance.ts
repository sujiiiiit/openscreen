// Stage: importance. Turns the normalized track + fixations into scored
// *engagements* — the "think like a human editor" model. Only deliberate
// engagement produces a candidate:
//
//   • a click (plain, on a link/button, right-click menu, or double-click)
//   • a text-entry (iBeam / typing) click
//   • a drag / text-selection (framed as the WHOLE span)
//
// Suppressed (never an engagement): bare cursor dwell, transit, idle, scrolling.
// A fixation only *boosts* a click that lands right after it ("dwell that leads
// to a click"); dwell alone never triggers a zoom. Pure and deterministic.

import { focusDistance, pointRect, rectFromPoints } from "./geometry"
import type { AutoZoomParams } from "./params"
import type {
  Engagement,
  EngagementKind,
  Fixation,
  InteractionEvent,
  InteractionTrack,
} from "./types"

// Additive importance bonuses. Base = 1; higher = more zoom-worthy. The exact
// values are taste — only the relative ordering matters (rate-limit ranking).
const SCORE_BASE = 1
const SCORE_TARGET = 0.15 // click on a link/button (pointingHand / AX role)
const SCORE_TYPING = 0.1 // text-entry context
const SCORE_CONTEXT_MENU = 0.2 // right-click (a menu pops at the point)
const SCORE_DOUBLE_CLICK = 0.25 // rapid repeat = strong "open this"
const SCORE_SELECTION = 0.2 // a drag / selection gesture
const SCORE_DWELL = 0.3 // settled, then clicked — strongest intent signal

const TARGET_CURSORS = new Set(["pointingHand"])
const TARGET_ROLES = new Set(["button", "link", "AXButton", "AXLink"])

function normalizeButton(
  button: InteractionEvent["button"]
): "left" | "right" | "other" {
  if (button === "right") return "right"
  if (button === "other") return "other"
  return "left"
}

function isTyping(down: InteractionEvent, up: InteractionEvent | null): boolean {
  return down.cursorId === "iBeam" || up?.cursorId === "iBeam"
}

function isTarget(down: InteractionEvent, up: InteractionEvent | null): boolean {
  if (TARGET_CURSORS.has(down.cursorId ?? "")) return true
  if (up && TARGET_CURSORS.has(up.cursorId ?? "")) return true
  if (down.role && TARGET_ROLES.has(down.role)) return true
  return false
}

/** Did the cursor settle (a fixation end) at this point shortly before tDown? */
function dwellLeadingTo(
  fixations: readonly Fixation[],
  tDown: number,
  point: { x: number; y: number },
  params: AutoZoomParams
): boolean {
  const windowSeconds = params.dwellClickWindowMs / 1000
  for (const fixation of fixations) {
    if (fixation.t1 > tDown) continue
    if (tDown - fixation.t1 > windowSeconds) continue
    if (focusDistance(fixation.centroid, point) <= params.fixationMaxRadius * 3) {
      return true
    }
  }
  return false
}

export function scoreEngagements(
  track: InteractionTrack,
  fixations: readonly Fixation[],
  params: AutoZoomParams
): Engagement[] {
  // Stable order: by time, down-before-up at the same instant, then arrival.
  const clicks = track.events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        (event.kind === "click-down" || event.kind === "click-up") &&
        Number.isFinite(event.t)
    )
    .sort(
      (a, b) =>
        a.event.t - b.event.t ||
        (a.event.kind === b.event.kind
          ? 0
          : a.event.kind === "click-down"
            ? -1
            : 1) ||
        a.index - b.index
    )
    .map(({ event }) => event)

  const engagements: Engagement[] = []
  let pendingDown: InteractionEvent | null = null
  let lastDown: { t: number; pos: { x: number; y: number } } | null = null

  const emit = (down: InteractionEvent, up: InteractionEvent | null) => {
    const downPos = down.pos ?? { x: 0.5, y: 0.5 }
    const upPos = up?.pos ?? downPos
    const travel = up ? focusDistance(downPos, upPos) : 0
    const isDrag = travel > params.dragMinTravel
    const typing = isTyping(down, up)
    const target = isTarget(down, up)
    const button = normalizeButton(down.button)
    const isContextMenu = button === "right"

    const isDoubleClick =
      !isDrag &&
      lastDown !== null &&
      (down.t - lastDown.t) * 1000 <= params.doubleClickMs &&
      focusDistance(downPos, lastDown.pos) <= params.dragMinTravel

    const hasDwell = dwellLeadingTo(fixations, down.t, downPos, params)

    let kind: EngagementKind = "click"
    if (isDrag) kind = "selection"
    else if (isContextMenu) kind = "context-menu"
    else if (isDoubleClick) kind = "double-click"
    else if (typing) kind = "typing"
    else if (target) kind = "click-target"

    let score = SCORE_BASE
    if (target) score += SCORE_TARGET
    if (typing) score += SCORE_TYPING
    if (isContextMenu) score += SCORE_CONTEXT_MENU
    if (isDoubleClick) score += SCORE_DOUBLE_CLICK
    if (isDrag) score += SCORE_SELECTION
    if (hasDwell) score += SCORE_DWELL

    // A drag/selection frames its whole span and settles where it ends; a click
    // is its point and lands at the press moment.
    const region = isDrag ? rectFromPoints([downPos, upPos]) : pointRect(downPos)
    const t0 = down.t
    const t1 = isDrag && up ? up.t : down.t

    engagements.push({ t0, t1, region, score, kind, typing })

    if (!isDrag) lastDown = { t: down.t, pos: downPos }
  }

  for (const click of clicks) {
    if (click.kind === "click-down") {
      if (pendingDown) emit(pendingDown, null)
      pendingDown = click
    } else if (pendingDown) {
      emit(pendingDown, click)
      pendingDown = null
    }
  }
  if (pendingDown) emit(pendingDown, null)

  // Typing-recall heuristic (P1, no keystroke stream yet): a text-entry click is
  // followed by typing that emits no mouse events, so the period looks idle.
  // Hold the zoom on the field through that gap — up to `maxTypingHoldMs` or
  // until the next engagement — so typing reads as one sustained zoom.
  const maxTypingHold = params.maxTypingHoldMs / 1000
  for (let i = 0; i < engagements.length; i++) {
    const engagement = engagements[i]
    if (!engagement.typing) continue
    const next = engagements[i + 1]
    const limit = next
      ? Math.min(engagement.t0 + maxTypingHold, next.t0)
      : engagement.t0 + maxTypingHold
    if (limit > engagement.t1) engagement.t1 = limit
  }

  return engagements
}
