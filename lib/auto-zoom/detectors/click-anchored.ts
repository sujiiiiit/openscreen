// Detector A: click-anchored. The improved version of the original detector —
// it groups deliberate engagements into activity segments by time-gap and
// focus-jump, then resolves each segment into a calm window (lead-in → hold →
// tail). Unlike the original it frames the segment's REGION (a selection span,
// or the union of a click cluster) rather than a single averaged point, and it
// is importance-gated. Pacing (merge / overlap / rate-limit) is shared and runs
// after, in cinematography.ts.

import { focusDistance, rectCenter, rectUnion } from "../geometry"
import type { AutoZoomParams } from "../params"
import type { Engagement, NormRect, ZoomWindow } from "../types"
import type { Detector, DetectorInput } from "./types"

interface Segment {
  startSeconds: number
  endSeconds: number
  region: NormRect
  weight: number
  typing: boolean
}

function segmentEngagements(
  engagements: readonly Engagement[],
  params: AutoZoomParams
): Segment[] {
  const segments: Segment[] = []
  const gapSeconds = params.segmentGapMs / 1000

  for (const engagement of engagements) {
    const current = segments[segments.length - 1]
    const newSegment =
      !current ||
      engagement.t0 - current.endSeconds > gapSeconds ||
      focusDistance(
        rectCenter(engagement.region),
        rectCenter(current.region)
      ) > params.segmentFocusJump

    if (newSegment) {
      segments.push({
        startSeconds: engagement.t0,
        endSeconds: engagement.t1,
        region: engagement.region,
        weight: engagement.score,
        typing: engagement.typing,
      })
      continue
    }

    current.endSeconds = Math.max(current.endSeconds, engagement.t1)
    current.region = rectUnion(current.region, engagement.region)
    current.weight += engagement.score
    current.typing = current.typing || engagement.typing
  }

  return segments
}

function windowFromSegment(
  seg: Segment,
  durationSeconds: number,
  params: AutoZoomParams
): ZoomWindow {
  const leadIn = params.leadInMs / 1000
  const tail = params.easeMs / 1000
  const minHold = params.minHoldMs / 1000
  const maxEnd = durationSeconds - params.tailGuardMs / 1000

  const start = Math.max(0, seg.startSeconds - leadIn)
  const rawEnd = Math.max(seg.endSeconds + tail, start + minHold)
  const end = Math.min(rawEnd, maxEnd)
  return {
    start,
    end,
    region: seg.region,
    score: seg.weight,
    typing: seg.typing,
  }
}

export const clickAnchoredDetector: Detector = {
  id: "click-anchored",
  detect({ engagements, track, params }: DetectorInput): ZoomWindow[] {
    // High recall: every engagement yields a window. Pacing (merge / tile /
    // floor) and confidence→scale handle density, not a drop threshold.
    return segmentEngagements(engagements, params).map((seg) =>
      windowFromSegment(seg, track.durationSeconds, params)
    )
  },
}
