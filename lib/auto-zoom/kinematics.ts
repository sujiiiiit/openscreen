// Stage: cursor kinematics. Splits the high-frequency move stream into
// *fixations* (the pointer dwelled inside a small region — an attention proxy)
// and detects *idle* spans (no activity at all). Transit (saccade) intervals
// are implicit: the gaps between fixations. Pure and deterministic.

import { focusDistance } from "./geometry"
import type {
  AutoZoomParams,
} from "./params"
import type {
  Fixation,
  IdleSpan,
  InteractionTrack,
  KinematicsResult,
  MoveSample,
} from "./types"

interface Cluster {
  t0: number
  tPrev: number
  sumX: number
  sumY: number
  pts: { x: number; y: number }[]
}

function computeFixations(
  moves: readonly MoveSample[],
  params: AutoZoomParams
): Fixation[] {
  const fixations: Fixation[] = []
  let cluster: Cluster | null = null

  const flush = () => {
    if (!cluster) return
    const durationMs = (cluster.tPrev - cluster.t0) * 1000
    if (durationMs >= params.fixationMinMs && cluster.pts.length >= 2) {
      const count = cluster.pts.length
      const centroid = { x: cluster.sumX / count, y: cluster.sumY / count }
      let radius = 0
      for (const p of cluster.pts) {
        const d = focusDistance(p, centroid)
        if (d > radius) radius = d
      }
      fixations.push({
        t0: cluster.t0,
        t1: cluster.tPrev,
        centroid,
        radius,
        samples: count,
      })
    }
    cluster = null
  }

  for (const move of moves) {
    if (!Number.isFinite(move.t)) continue
    if (!cluster) {
      cluster = {
        t0: move.t,
        tPrev: move.t,
        sumX: move.pos.x,
        sumY: move.pos.y,
        pts: [move.pos],
      }
      continue
    }
    const gapMs = (move.t - cluster.tPrev) * 1000
    const count = cluster.pts.length
    const centroid = { x: cluster.sumX / count, y: cluster.sumY / count }
    const dist = focusDistance(move.pos, centroid)
    if (gapMs > params.idleGapMs || dist > params.fixationMaxRadius) {
      flush()
      cluster = {
        t0: move.t,
        tPrev: move.t,
        sumX: move.pos.x,
        sumY: move.pos.y,
        pts: [move.pos],
      }
    } else {
      cluster.tPrev = move.t
      cluster.sumX += move.pos.x
      cluster.sumY += move.pos.y
      cluster.pts.push(move.pos)
    }
  }
  flush()

  return fixations
}

function computeIdleSpans(
  track: InteractionTrack,
  params: AutoZoomParams
): IdleSpan[] {
  const times: number[] = []
  for (const move of track.moves) {
    if (Number.isFinite(move.t)) times.push(move.t)
  }
  for (const event of track.events) {
    if (Number.isFinite(event.t)) times.push(event.t)
  }
  times.sort((a, b) => a - b)

  const spans: IdleSpan[] = []
  let prev = 0
  for (const t of times) {
    if ((t - prev) * 1000 > params.idleGapMs) spans.push({ t0: prev, t1: t })
    if (t > prev) prev = t
  }
  if ((track.durationSeconds - prev) * 1000 > params.idleGapMs) {
    spans.push({ t0: prev, t1: track.durationSeconds })
  }
  return spans
}

export function analyzeKinematics(
  track: InteractionTrack,
  params: AutoZoomParams
): KinematicsResult {
  return {
    fixations: computeFixations(track.moves, params),
    idleSpans: computeIdleSpans(track, params),
  }
}

/** Whether `t` falls inside any fixation span (a settled-cursor moment). */
export function fixationAt(
  fixations: readonly Fixation[],
  t: number
): Fixation | null {
  for (const fixation of fixations) {
    if (t >= fixation.t0 && t <= fixation.t1) return fixation
  }
  return null
}
