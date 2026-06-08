// A/B comparison harness. Runs every detector over the same interaction track
// and reports objective metrics so we can compare the two prototypes on a real
// recording (via a committed fixture in tests, or the editor's dev selector).
// Pure — no I/O.

import { DETECTOR_IDS, type DetectorId } from "./detectors"
import { resolveParams, type AutoZoomParams } from "./params"
import { buildAutoZoomClipsFromTrack } from "./pipeline"
import type { InteractionTrack } from "./types"

export interface DetectorMetrics {
  id: DetectorId
  /** Number of generated zoom clips. */
  clipCount: number
  /** Total seconds the timeline spends zoomed in. */
  zoomedSeconds: number
  /** Fraction of the recording that is zoomed (0..1). */
  zoomedFraction: number
  /** Mean magnification across clips. */
  meanScale: number
  /** Fraction of click-down events that fall inside a generated zoom (0..1). */
  clickCoverage: number
}

function clickDownTimes(track: InteractionTrack): number[] {
  return track.events
    .filter((e) => e.kind === "click-down")
    .map((e) => e.t)
    .sort((a, b) => a - b)
}

export function compareDetectors(
  track: InteractionTrack,
  overrides?: Partial<AutoZoomParams>
): DetectorMetrics[] {
  const params: AutoZoomParams = resolveParams(overrides)
  const duration = Math.max(0, track.durationSeconds || 0)
  const downs = clickDownTimes(track)

  return DETECTOR_IDS.map((id) => {
    const clips = buildAutoZoomClipsFromTrack(track, { detector: id, params })
    const zoomedSeconds = clips.reduce((sum, c) => sum + (c.end - c.start), 0)
    const meanScale = clips.length
      ? clips.reduce((sum, c) => sum + c.scale, 0) / clips.length
      : 0
    const coveredDowns = downs.filter((t) =>
      clips.some((c) => t >= c.start && t <= c.end)
    ).length
    return {
      id,
      clipCount: clips.length,
      zoomedSeconds,
      zoomedFraction: duration > 0 ? zoomedSeconds / duration : 0,
      meanScale,
      clickCoverage: downs.length ? coveredDowns / downs.length : 0,
    }
  })
}
