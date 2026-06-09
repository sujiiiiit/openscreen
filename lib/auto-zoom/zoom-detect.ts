// Public entry point for the auto-zoom detector. The implementation is the
// staged pipeline in this directory (see `docs/auto-zoom-algorithm.md`); this
// file re-exports it and keeps the original click-only API working so existing
// callers and tests don't churn.
//
// Auto-zoom is a *generator of ordinary manual zoom clips*: it runs once when a
// finished recording first opens, analyses the captured interaction, and emits
// plain `CanvasZoomClip`s onto the existing manual Zoom track — choosing only
// WHEN (start/end), WHERE (focus), and HOW MUCH (scale). The renderer, export,
// persistence, and Zoom panel are the manual system, unchanged.

import type { CanvasZoomClip, CanvasZoomFocus } from "@/types/editor-canvas"

import { resolveParams, type AutoZoomParams } from "./params"
import { buildAutoZoomClipsFromTrack } from "./pipeline"
import type { InteractionButton, InteractionEvent, InteractionTrack } from "./types"

export { AUTO_ZOOM_DEFAULTS, resolveParams } from "./params"
export type { AutoZoomParams } from "./params"
export { buildAutoZoomClipsFromTrack } from "./pipeline"
export type { BuildOptions } from "./pipeline"
export { compareDetectors } from "./compare"
export type { DetectorMetrics } from "./compare"
export {
  DETECTOR_IDS,
  DEFAULT_DETECTOR_ID,
  type DetectorId,
} from "./detectors"
export type {
  Engagement,
  Fixation,
  InteractionButton,
  InteractionEvent,
  InteractionTrack,
  MoveSample,
  NormRect,
  ZoomWindow,
} from "./types"

/**
 * A captured click already mapped into the editor's coordinate/time spaces.
 * Retained for callers/tests that work with clicks only; internally it is
 * converted into the richer {@link InteractionTrack}.
 */
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

function normalizeButton(button: number | string | undefined): InteractionButton {
  if (button === "right" || button === 1 || button === 2) return "right"
  if (button === "other") return "other"
  return "left"
}

function trackFromClickSamples(
  clicks: readonly AutoZoomClickSample[],
  durationSeconds: number
): InteractionTrack {
  const events: InteractionEvent[] = clicks.map((click) => ({
    t: click.tSeconds,
    kind: click.type === "down" ? "click-down" : "click-up",
    pos: click.focus,
    cursorId: click.cursorId,
    button: normalizeButton(click.button),
  }))
  return { moves: [], events, durationSeconds }
}

/**
 * Build auto-zoom clips from click samples only (a clicks-only convenience over
 * the detector). New callers should build a full {@link InteractionTrack} and use
 * {@link buildAutoZoomClipsFromTrack} so cursor moves feed the dwell model.
 */
export function buildAutoZoomClips(
  clicks: readonly AutoZoomClickSample[],
  timelineDurationSeconds: number,
  overrides?: Partial<AutoZoomParams>
): CanvasZoomClip[] {
  return buildAutoZoomClipsFromTrack(
    trackFromClickSamples(clicks, timelineDurationSeconds),
    { params: resolveParams(overrides) }
  )
}
