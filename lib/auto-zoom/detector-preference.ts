// Renderer-side dev affordance for A/B-ing the two auto-zoom detectors on real
// recordings. The chosen detector is read by the provider's one-shot AND
// Regenerate paths, so flipping it + Regenerate re-runs detection with the other
// strategy. App-level (localStorage), not persisted into project.json — it is a
// debugging/tuning control, not project state.

import { DEFAULT_DETECTOR_ID, DETECTOR_IDS, type DetectorId } from "./detectors"

const STORAGE_KEY = "openscreen:autoZoomDetector"

export function getAutoZoomDetector(): DetectorId {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_DETECTOR_ID
    const value = localStorage.getItem(STORAGE_KEY)
    if (value && (DETECTOR_IDS as string[]).includes(value)) {
      return value as DetectorId
    }
  } catch {
    // localStorage can throw in restricted contexts — fall back to the default.
  }
  return DEFAULT_DETECTOR_ID
}

export function setAutoZoomDetector(id: DetectorId): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Best-effort: ignore storage failures.
  }
}
