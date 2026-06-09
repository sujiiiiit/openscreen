// The detector contract. A detector decides WHEN to zoom and WHICH subject
// region to frame; it does NOT choose focus/scale (framing.ts) or pace the result
// (cinematography.ts). It consumes the shared input (normalize + kinematics +
// importance) and its windows pass through the shared framing + cinematography
// stages, so it is only the "engagements → windows" step. The contract stays
// pluggable even though `hybrid-stabilized` is currently the only detector.

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

export type DetectorId = "hybrid-stabilized"

export interface Detector {
  id: DetectorId
  detect(input: DetectorInput): ZoomWindow[]
}
