// The pluggable detector contract. A detector decides WHEN to zoom and WHICH
// subject region to frame; it does NOT choose focus/scale (framing.ts) or pace
// the result (cinematography.ts). Both detectors share the input (normalize +
// kinematics + importance) and the output passes (framing + cinematography),
// so they differ only in how they turn engagements into windows.

import type { AutoZoomParams } from "../params"
import type {
  Engagement,
  Fixation,
  IdleSpan,
  InteractionTrack,
  ZoomWindow,
} from "../types"

export interface DetectorInput {
  track: InteractionTrack
  engagements: Engagement[]
  fixations: Fixation[]
  idleSpans: IdleSpan[]
  params: AutoZoomParams
}

export type DetectorId = "click-anchored" | "attention-region"

export interface Detector {
  id: DetectorId
  detect(input: DetectorInput): ZoomWindow[]
}
