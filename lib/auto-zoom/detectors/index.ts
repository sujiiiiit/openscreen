// Detector registry. Both detectors implement the same interface and plug into
// the same pipeline; the selector lets us A/B them on real recordings.

import { attentionRegionDetector } from "./attention-region"
import { clickAnchoredDetector } from "./click-anchored"
import type { Detector, DetectorId } from "./types"

export const DETECTORS: Record<DetectorId, Detector> = {
  "click-anchored": clickAnchoredDetector,
  "attention-region": attentionRegionDetector,
}

export const DETECTOR_IDS: DetectorId[] = ["click-anchored", "attention-region"]

// Click-anchored is the safe default: it reproduces the original, well-tested
// behavior. The attention model is the prototype we compare against it.
export const DEFAULT_DETECTOR_ID: DetectorId = "click-anchored"

export function getDetector(id?: DetectorId): Detector {
  return (id && DETECTORS[id]) || clickAnchoredDetector
}

export type { Detector, DetectorId, DetectorInput } from "./types"
