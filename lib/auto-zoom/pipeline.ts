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
import type { InteractionTrack, ZoomWindow } from "./types"

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
  /** Which detector to run (defaults to the only one, `hybrid-stabilized`). */
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

  // Per-window framing. Focus is always per-window; scale is the desired
  // magnification, unified across a scene below.
  const framings: WindowFraming[] = windows.map((win) => ({
    win,
    ...solveFraming(
      win.region,
      baseScaleForConfidence(win.score, win.typing, params),
      params
    ),
  }))

  // One scale per scene: a run of tiled (touching) windows holds a single steady
  // magnification instead of bouncing between adjacent zooms.
  if (params.sceneCohesion) {
    unifySceneScales(framings)
  }

  const clips = framings.map(({ win, focus, scale }) =>
    withZoomClipDefaults({
      id: deterministicClipId(win.start, focus),
      start: win.start,
      end: win.end,
      enabled: true,
      focus,
      scale,
      transition: {
        // A gentler, longer push-in/out ramp (calmer motion).
        durationMs: params.hybridEaseMs,
        curve: ZOOM_TRANSITION_CURVE_DEFAULT,
      },
    })
  )

  // Final safety net: guarantee the single non-overlapping lane invariant the
  // rest of the manual zoom system assumes.
  return normalizeZoomClips(clips, track.durationSeconds)
}

interface WindowFraming {
  win: ZoomWindow
  focus: CanvasZoomFocus
  scale: number
}

/** Two windows belong to the same scene when the later one abuts/overlaps the earlier. */
const SCENE_TOUCH_EPSILON = 1e-6

/**
 * Collapse each scene — a maximal run of touching (tiled) windows — to one steady
 * scale: the run's MIN. MIN is the only choice that keeps every subject framed
 * (it can only zoom LESS than a window wanted, never crop). A scene break is a
 * real (idle) gap, where the next window does not abut the previous. Windows are
 * start-sorted and non-overlapping out of pacing, so a single forward scan
 * suffices. Mutates `scale` in place.
 */
function unifySceneScales(framings: WindowFraming[]): void {
  let i = 0
  while (i < framings.length) {
    let j = i
    while (
      j + 1 < framings.length &&
      framings[j + 1].win.start <= framings[j].win.end + SCENE_TOUCH_EPSILON
    ) {
      j++
    }
    let min = Infinity
    for (let k = i; k <= j; k++) min = Math.min(min, framings[k].scale)
    for (let k = i; k <= j; k++) framings[k].scale = min
    i = j + 1
  }
}
