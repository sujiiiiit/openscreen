// The auto-zoom detector: stabilized, working-region. Decides WHEN to zoom and
// WHICH region to frame; framing (focus/scale) and pacing run after it. It covers
// every engagement (high recall — nothing is dropped) while holding the camera
// still and framing steadily:
//
//   1. Each engagement is EXTENDED to cover the cursor dwell around it (the
//      fixation before/after the click), so the hold lasts as long as the user
//      actually stayed in that region. A bare fixation never creates a window —
//      dwell only shapes a window already anchored by a deliberate engagement.
//   2. Extended engagements are grouped into clusters with HYSTERESIS: a sticky
//      region boundary (`hysteresisFocusJump`, much larger than a naive per-click
//      split) so a small wander never starts a new region — the cure for needless
//      panning and framing drift. One cluster → one steady held window.
//   3. Each cluster is framed on a STABLE anchor — the score-weighted centroid of
//      its dense core (members within `clusterRadius` of the peak engagement), not
//      the drifting union center; the union is grown symmetrically about the anchor
//      so every subject stays in frame while the center stays put.
//   4. The hold is RELEASED at the next idle span (stay wide only when idle).
//
// One scale per scene and the gentler hybrid eases live in pipeline.ts. Pure and
// deterministic.

import {
  focusDistance,
  growRectAroundCenter,
  rectCenter,
  rectUnion,
} from "../geometry"
import type { AutoZoomParams } from "../params"
import type { CanvasZoomFocus } from "@/types/editor-canvas"
import type {
  Engagement,
  Fixation,
  IdleSpan,
  NormRect,
  ZoomWindow,
} from "../types"
import type { Detector, DetectorInput } from "./types"

interface Extended {
  t0: number
  t1: number
  region: NormRect
  score: number
  typing: boolean
}

function maxDim(region: NormRect): number {
  return Math.max(region.width, region.height)
}

/** Extend an engagement to cover the dwell (fixations) around it. */
function extendByDwell(
  engagement: Engagement,
  fixations: readonly Fixation[],
  params: AutoZoomParams
): Extended {
  const windowSeconds = params.dwellClickWindowMs / 1000
  const nearRadius = params.fixationMaxRadius * 3 + maxDim(engagement.region) / 2
  const center = rectCenter(engagement.region)

  let t0 = engagement.t0
  let t1 = engagement.t1
  let region = engagement.region
  let score = engagement.score

  for (const fixation of fixations) {
    if (fixation.t1 < t0 - windowSeconds || fixation.t0 > t1 + windowSeconds) {
      continue
    }
    if (focusDistance(fixation.centroid, center) > nearRadius) continue
    t0 = Math.min(t0, fixation.t0)
    t1 = Math.max(t1, fixation.t1)
    // The dwell region tightens the framing only if it sits inside the subject.
    region = rectUnion(region, {
      x: fixation.centroid.x,
      y: fixation.centroid.y,
      width: 0,
      height: 0,
    })
    score += 0.1 // sustained attention bonus
  }

  return { t0, t1, region, score, typing: engagement.typing }
}

/**
 * Turn a grouped cluster into a held window: lead-in → hold (≥ `minHoldMs`) →
 * tail, released at the first idle span that begins after the activity ends.
 */
function windowFromGroup(
  group: Extended,
  idleSpans: readonly IdleSpan[],
  durationSeconds: number,
  params: AutoZoomParams
): ZoomWindow {
  const leadIn = params.leadInMs / 1000
  const tail = params.easeMs / 1000
  const minHold = params.minHoldMs / 1000
  const maxEnd = durationSeconds - params.tailGuardMs / 1000

  const start = Math.max(0, group.t0 - leadIn)
  let end = Math.max(group.t1 + tail, start + minHold)

  // Release the hold at the first idle span that begins after the activity ends
  // (don't keep the camera zoomed while the user has clearly gone quiet).
  for (const idle of idleSpans) {
    if (idle.t0 >= group.t1 && idle.t0 < end) {
      end = Math.min(end, idle.t0 + tail)
    }
  }
  end = Math.min(end, maxEnd)

  return {
    start,
    end,
    region: group.region,
    score: group.score,
    typing: group.typing,
  }
}

interface Cluster {
  t0: number
  t1: number
  /** Union of every member region (so the whole subject stays framed). */
  region: NormRect
  score: number
  typing: boolean
  members: Extended[]
  /** Center of the highest-confidence member so far (the membership reference). */
  peakCenter: CanvasZoomFocus
  peakScore: number
}

/**
 * Group extended engagements into clusters with a sticky (hysteretic) boundary:
 * a member joins the current cluster while it stays within `hysteresisFocusJump`
 * of the cluster's peak and within `clusterMergeGapMs` in time; only a clearly
 * distinct jump opens a new cluster. The peak (and thus the membership anchor)
 * only ever moves to a STRICTLY higher-confidence member — it never drifts toward
 * absorbed outliers.
 */
function clusterEngagements(
  extended: readonly Extended[],
  params: AutoZoomParams
): Cluster[] {
  const sorted = [...extended].sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1)
  const gapMax = params.clusterMergeGapMs / 1000
  const clusters: Cluster[] = []

  for (const item of sorted) {
    const center = rectCenter(item.region)
    const cur = clusters[clusters.length - 1]
    const sticky =
      cur &&
      item.t0 - cur.t1 < gapMax &&
      focusDistance(center, cur.peakCenter) < params.hysteresisFocusJump

    if (sticky) {
      cur.t1 = Math.max(cur.t1, item.t1)
      cur.region = rectUnion(cur.region, item.region)
      cur.score += item.score
      cur.typing = cur.typing || item.typing
      cur.members.push(item)
      // Ties → keep the earlier peak (strict >), matching cinematography's rule.
      if (item.score > cur.peakScore) {
        cur.peakScore = item.score
        cur.peakCenter = center
      }
      continue
    }

    clusters.push({
      t0: item.t0,
      t1: item.t1,
      region: item.region,
      score: item.score,
      typing: item.typing,
      members: [item],
      peakCenter: center,
      peakScore: item.score,
    })
  }

  return clusters
}

/**
 * The stable framing center: the score-weighted centroid of the cluster's dense
 * core — members within `clusterRadius` of the peak. Outliers absorbed for
 * region stability sit outside the core and so do not pull the center.
 */
function clusterAnchor(cluster: Cluster, params: AutoZoomParams): CanvasZoomFocus {
  let sx = 0
  let sy = 0
  let sw = 0
  for (const member of cluster.members) {
    const center = rectCenter(member.region)
    if (focusDistance(center, cluster.peakCenter) <= params.clusterRadius) {
      const weight = Math.max(member.score, 1e-6)
      sx += center.x * weight
      sy += center.y * weight
      sw += weight
    }
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw } : cluster.peakCenter
}

export const hybridStabilizedDetector: Detector = {
  id: "hybrid-stabilized",
  detect({ engagements, fixations, idleSpans, track, params }: DetectorInput): ZoomWindow[] {
    if (engagements.length === 0) return []
    // Gentler, longer eases + lead-in for the hold (calmer motion).
    const holdParams: AutoZoomParams = {
      ...params,
      leadInMs: params.hybridLeadInMs,
      easeMs: params.hybridEaseMs,
    }
    const extended = engagements.map((e) => extendByDwell(e, fixations, params))
    return clusterEngagements(extended, params).map((cluster) => {
      const anchor = clusterAnchor(cluster, params)
      const region = growRectAroundCenter(cluster.region, anchor)
      return windowFromGroup(
        {
          t0: cluster.t0,
          t1: cluster.t1,
          region,
          score: cluster.score,
          typing: cluster.typing,
        },
        idleSpans,
        track.durationSeconds,
        holdParams
      )
    })
  },
}
