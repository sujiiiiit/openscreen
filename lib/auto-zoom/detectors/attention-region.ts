// Detector B: working-region attention model. Instead of wrapping a fixed
// window around each click, it treats the cursor's *dwell* (fixations) as the
// shape of attention and anchors zooms on deliberate engagements:
//
//   1. Each engagement is EXTENDED to cover the dwell that surrounds it — the
//      fixation the user was in before/after the click — so the hold lasts
//      exactly as long as they actually stayed in that region.
//   2. Extended engagements that overlap in time AND sit in the same region are
//      grouped into one continuous "working region".
//   3. The window holds while activity stays inside and is RELEASED at the next
//      idle span (the locked "stay wide when idle / skimming" rule).
//
// A bare fixation never creates a window (dwell alone never triggers); it only
// shapes a window already anchored by an engagement. Pacing is shared
// (cinematography.ts). Pure and deterministic.

import { focusDistance, rectCenter, rectUnion } from "../geometry"
import type { AutoZoomParams } from "../params"
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

function groupWorkingRegions(
  extended: Extended[],
  params: AutoZoomParams
): Extended[] {
  const sorted = [...extended].sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1)
  const mergeGap = params.mergeGapMs / 1000
  const groups: Extended[] = []
  for (const item of sorted) {
    const group = groups[groups.length - 1]
    const sameRegion =
      group &&
      item.t0 - group.t1 < mergeGap &&
      focusDistance(rectCenter(item.region), rectCenter(group.region)) <
        params.segmentFocusJump
    if (sameRegion) {
      group.t1 = Math.max(group.t1, item.t1)
      group.region = rectUnion(group.region, item.region)
      group.score += item.score
      group.typing = group.typing || item.typing
    } else {
      groups.push({ ...item })
    }
  }
  return groups
}

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

export const attentionRegionDetector: Detector = {
  id: "attention-region",
  detect({ engagements, fixations, idleSpans, track, params }: DetectorInput): ZoomWindow[] {
    if (engagements.length === 0) return []
    // High recall: every working region yields a window; pacing handles density.
    const extended = engagements.map((e) => extendByDwell(e, fixations, params))
    return groupWorkingRegions(extended, params).map((group) =>
      windowFromGroup(group, idleSpans, track.durationSeconds, params)
    )
  },
}
