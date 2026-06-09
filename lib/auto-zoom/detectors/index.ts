// Detector registry. The detector is the "engagements → windows" stage; it plugs
// into the shared pipeline. `hybrid-stabilized` is currently the only detector;
// the registry stays as the seam so another can be added without touching the
// pipeline.

import { hybridStabilizedDetector } from "./hybrid-stabilized"
import type { Detector, DetectorId } from "./types"

export const DETECTORS: Record<DetectorId, Detector> = {
  "hybrid-stabilized": hybridStabilizedDetector,
}

export const DETECTOR_IDS: DetectorId[] = ["hybrid-stabilized"]

export const DEFAULT_DETECTOR_ID: DetectorId = "hybrid-stabilized"

export function getDetector(id?: DetectorId): Detector {
  return (id && DETECTORS[id]) || hybridStabilizedDetector
}

export type { Detector, DetectorId, DetectorInput } from "./types"
