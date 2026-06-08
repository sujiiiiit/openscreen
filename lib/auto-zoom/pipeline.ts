// The auto-zoom pipeline orchestrator. Wires the pure stages together and emits
// ordinary `CanvasZoomClip[]` for the unchanged manual zoom system. Deterministic:
// the same track + options always yields byte-identical clips (ids included), so
// re-running never churns the autosave fingerprint.

import {
  ZOOM_TRANSITION_CURVE_DEFAULT,
  normalizeZoomClips,
  withZoomClipDefaults,
} from "@/lib/zoom-clips"
import type { CanvasZoomClip, CanvasZoomFocus } from "@/types/editor-canvas"

import { paceWindows } from "./cinematography"
import { getDetector, type DetectorId } from "./detectors"
import { baseScaleForConfidence, solveFraming } from "./framing"
import { clampUnit } from "./geometry"
import { scoreEngagements } from "./importance"
import { analyzeKinematics } from "./kinematics"
import { normalizeTrack } from "./normalize"
import { resolveParams, type AutoZoomParams } from "./params"
import type { InteractionTrack } from "./types"

/**
 * Deterministic clip id from the rounded start time + focus. Identical inputs
 * yield the identical id, so re-running never churns the autosave fingerprint
 * (unlike `createZoomClipId`, which is time+counter based).
 */
function deterministicClipId(
  startSeconds: number,
  focus: CanvasZoomFocus
): string {
  const s = Math.round(startSeconds * 1000)
  const fx = Math.round(clampUnit(focus.x) * 1000)
  const fy = Math.round(clampUnit(focus.y) * 1000)
  return `auto-zoom-${s}-${fx}-${fy}`
}

export interface BuildOptions {
  /** Which detector to run (defaults to click-anchored). */
  detector?: DetectorId
  /** Parameter overrides over {@link AUTO_ZOOM_DEFAULTS}. */
  params?: Partial<AutoZoomParams>
}

/**
 * Build auto-zoom clips from a normalized interaction track.
 *
 * Pipeline: normalize → kinematics → importance → detector → pace → frame → emit.
 */
export function buildAutoZoomClipsFromTrack(
  rawTrack: InteractionTrack,
  options?: BuildOptions
): CanvasZoomClip[] {
  const params = resolveParams(options?.params)
  const track = normalizeTrack(rawTrack)

  if (track.durationSeconds * 1000 < params.minRecordingMs) return []

  const { fixations, idleSpans } = analyzeKinematics(track, params)
  const engagements = scoreEngagements(track, fixations, params)
  if (engagements.length === 0) return []

  const detector = getDetector(options?.detector)
  const windows = paceWindows(
    detector.detect({ track, engagements, fixations, idleSpans, params }),
    idleSpans,
    track.durationSeconds,
    params
  )

  const clips = windows.map((win) => {
    const { focus, scale } = solveFraming(
      win.region,
      baseScaleForConfidence(win.score, win.typing, params),
      params
    )
    return withZoomClipDefaults({
      id: deterministicClipId(win.start, focus),
      start: win.start,
      end: win.end,
      enabled: true,
      focus,
      scale,
      transition: {
        durationMs: params.easeMs,
        curve: ZOOM_TRANSITION_CURVE_DEFAULT,
      },
    })
  })

  // Final safety net: guarantee the single non-overlapping lane invariant the
  // rest of the manual zoom system assumes.
  return normalizeZoomClips(clips, track.durationSeconds)
}
