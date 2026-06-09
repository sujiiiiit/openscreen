// All auto-zoom thresholds in one place. Taste lives here — tune freely.
//
// Philosophy: HIGH RECALL. Every meaningful interaction is a zoom candidate; the
// difference between events is *confidence*, which sets how much they zoom — not
// whether they zoom at all. Nothing is dropped for being "low importance". The
// camera follows the work: same-region bursts become one held zoom, distinct
// regions tile back-to-back, and it only returns to fully wide during genuine
// idle. Merging (same-region) and idle are the only things that reduce the
// zoom count — there is no artificial sparsity quota.

export interface AutoZoomParams {
  // --- Magnification (confidence → scale) ----------------------------------
  /** Base magnification for a plain (lowest-confidence) click. */
  zoomScale: number
  /** Base magnification for a text-entry (typing) engagement. */
  zoomTyping: number
  /** Extra scale per unit of confidence above the base (1.0). */
  confidenceGain: number
  /** Hard cap on generated scale (source-sharpness ceiling). */
  zoomMax: number

  // --- Window shape --------------------------------------------------------
  /** Each ease-in / ease-out ramp length (ms). */
  easeMs: number
  /** Push-in starts this long before the action so it lands on the moment. */
  leadInMs: number
  /** Minimum total clip duration (ms) so a zoom reads as a deliberate hold. */
  minHoldMs: number

  // --- Detector (stabilized clustering) -----------------------------------
  /**
   * Radius (normalized) of a cluster's "core" — the dense sub-cluster around its
   * peak (highest-confidence) engagement whose score-weighted centroid the camera
   * frames. Outliers absorbed for stability (below {@link hysteresisFocusJump})
   * widen the frame but do NOT pull this center, so the framing stays put.
   */
  clusterRadius: number
  /**
   * Sticky region boundary (normalized): an engagement within this of the cluster
   * anchor EXTENDS the current cluster; only a jump ≥ this starts a NEW one. Set
   * well above `segmentFocusJump` so the camera holds a region instead of hopping
   * (the "too much panning" / framing-drift cure). Must exceed `clusterRadius`.
   */
  hysteresisFocusJump: number
  /** Max time gap (ms) to keep engagements in one cluster (≥ `mergeGapMs`). */
  clusterMergeGapMs: number
  /**
   * One scale per scene: collapse a tiled run of windows to a single steady
   * magnification (the run's MIN, so every subject stays framed). Only windows
   * from the hybrid detector are affected; the other detectors never tile-group.
   */
  sceneCohesion: boolean
  /** Hybrid clips' ease-in/out ramp AND window tail (ms) — gentler than `easeMs`. */
  hybridEaseMs: number
  /** Hybrid push-in lead (ms) — slightly longer than `leadInMs` for a calm land. */
  hybridLeadInMs: number

  // --- Pacing --------------------------------------------------------------
  /** Merge two windows closer than this in time (ms) … */
  mergeGapMs: number
  /** … and whose focuses are within this normalized distance (SAME region). */
  mergeDist: number
  /**
   * "Tile" adjacent distinct windows: extend an earlier window's end up to the
   * next window's start when the gap is below this (ms) and no idle sits between
   * — so the camera moves region-to-region instead of flashing wide. Keep this
   * ≥ idleGapMs so any bridged gap is, by definition, not idle.
   */
  bridgeMaxGapMs: number

  // --- Floors / limits -----------------------------------------------------
  /** Absolute clip-duration floor shared with the manual track (seconds). */
  minZoomClipSeconds: number
  /**
   * Safety cap on zooms per minute. Set high — this is a runaway backstop, NOT a
   * sparsity quota. Over the cap, the lowest-confidence windows are merged into
   * neighbours (never dropped) where possible.
   */
  maxZoomsPerMin: number

  // --- Gesture classification ---------------------------------------------
  /** down→up travel above this (normalized) is treated as a drag/selection. */
  dragMinTravel: number
  /** A second click within this window at the same point is a double-click (ms). */
  doubleClickMs: number
  /**
   * After a text-entry (iBeam) click, hold the zoom through the (mouse-silent)
   * typing that follows, up to this long or until the next engagement — a P1
   * heuristic for typing recall without the keystroke stream (P2).
   */
  maxTypingHoldMs: number

  // --- Guards --------------------------------------------------------------
  /** Clip every window's end this far before the timeline end (ignore Stop click). */
  tailGuardMs: number
  /** Recordings shorter than this generate zero zooms. */
  minRecordingMs: number

  // --- Cursor kinematics (move stream) ------------------------------------
  /** A run of moves stays a fixation while its spread stays under this (normalized). */
  fixationMaxRadius: number
  /** A fixation must last at least this long to count (ms). */
  fixationMinMs: number
  /** A gap longer than this with no moves/events ends a fixation / starts idle (ms). */
  idleGapMs: number

  // --- Importance ----------------------------------------------------------
  /**
   * A dwell only "counts" if a click lands within this window of the cursor
   * settling — encodes the rule "dwell alone never triggers a zoom".
   */
  dwellClickWindowMs: number

  // --- Framing -------------------------------------------------------------
  /** Padding kept around the subject region as a fraction of its size. */
  framePadding: number
}

// High-recall defaults: confident events zoom more, every event still zooms,
// and the camera tiles across the timeline (only idle goes wide).
export const AUTO_ZOOM_DEFAULTS: AutoZoomParams = {
  zoomScale: 1.6,
  zoomTyping: 2.0,
  confidenceGain: 0.3,
  zoomMax: 2.6,
  easeMs: 450,
  leadInMs: 250,
  minHoldMs: 900,
  clusterRadius: 0.12,
  hysteresisFocusJump: 0.3,
  clusterMergeGapMs: 2200,
  sceneCohesion: true,
  hybridEaseMs: 650,
  hybridLeadInMs: 300,
  mergeGapMs: 1800,
  mergeDist: 0.1,
  bridgeMaxGapMs: 2000,
  minZoomClipSeconds: 0.5,
  maxZoomsPerMin: 40,
  dragMinTravel: 0.04,
  doubleClickMs: 350,
  maxTypingHoldMs: 5000,
  tailGuardMs: 800,
  minRecordingMs: 3000,
  fixationMaxRadius: 0.04,
  fixationMinMs: 250,
  idleGapMs: 1500,
  dwellClickWindowMs: 1200,
  framePadding: 0.18,
}

export function resolveParams(overrides?: Partial<AutoZoomParams>): AutoZoomParams {
  return overrides ? { ...AUTO_ZOOM_DEFAULTS, ...overrides } : AUTO_ZOOM_DEFAULTS
}
