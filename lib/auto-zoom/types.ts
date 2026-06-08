// Shared types for the staged auto-zoom pipeline.
//
// Auto-zoom is a *generator of ordinary manual zoom clips* (see
// `docs/auto-zoom-algorithm.md`). The pipeline is a chain of pure stages:
//
//   InteractionTrack            (normalize.ts — all input streams, mapped)
//     → Fixation[] / idle       (kinematics.ts — cursor dwell vs transit)
//     → Engagement[]            (importance.ts — "what is worth a closeup")
//     → ZoomWindow[]            (detectors/* — WHEN/WHERE, two strategies)
//     → { focus, scale }        (framing.ts — always keep the subject in frame)
//     → ZoomWindow[]            (cinematography.ts — pacing / anti-pump)
//     → CanvasZoomClip[]        (pipeline.ts — emit, deterministic, normalized)
//
// Everything here is geometry-free and time-resolved: coordinates are already
// artboard-normalized (0..1) and times are already timeline (composition)
// seconds. The renderer adapter (`components/editor/canvas/auto-zoom-scene.ts`)
// owns that mapping so this module stays a pure function of its inputs.

import type { CanvasZoomFocus } from "@/types/editor-canvas"

/** Axis-aligned rectangle in artboard-normalized [0,1] coordinates (top-left origin). */
export interface NormRect {
  /** Left edge (normalized). */
  x: number
  /** Top edge (normalized). */
  y: number
  /** Width (normalized, ≥ 0). */
  width: number
  /** Height (normalized, ≥ 0). */
  height: number
}

/** Normalized mouse button. */
export type InteractionButton = "left" | "right" | "other"

/**
 * A discrete, time-and-space-mapped interaction event. The high-frequency move
 * stream is kept separate (see {@link MoveSample}) because the kinematics stage
 * consumes it differently; everything else (clicks, keys, scroll, focus
 * changes, Accessibility samples) is an `InteractionEvent`.
 */
export type InteractionEventKind =
  | "click-down"
  | "click-up"
  | "key-down"
  | "key-up"
  | "scroll"
  | "focus-change"
  | "ax-caret"
  | "ax-element"
  | "ax-window"

export interface InteractionEvent {
  /** Timeline (composition) seconds — the zoom-clip time base. */
  t: number
  kind: InteractionEventKind
  /** Artboard-normalized point (0..1), when the event has a position. */
  pos?: CanvasZoomFocus
  /** Artboard-normalized bounds, when the event carries a rect (AX element/window/caret). */
  rect?: NormRect
  /** Mouse button (click events). */
  button?: InteractionButton
  /** Semantic cursor shape at the event (`pointingHand`, `iBeam`, …). */
  cursorId?: string
  /** Active modifier keys (`command`, `shift`, …) — P2+. */
  modifiers?: readonly string[]
  /** Typed character (key events) — P2+. */
  char?: string
  /** Whether a key event is an OS autorepeat (held key) — P2+. */
  repeat?: boolean
  /** Scroll deltas in normalized artboard units (scroll events) — P3+. */
  scrollDx?: number
  scrollDy?: number
  /** Accessibility role of the focused element (`button`, `textfield`, …) — P4+. */
  role?: string
}

/** One sample from the cursor-move stream (~120 Hz), mapped into editor space. */
export interface MoveSample {
  /** Timeline (composition) seconds. */
  t: number
  /** Artboard-normalized position (0..1). */
  pos: CanvasZoomFocus
  /** Semantic cursor shape at the sample. */
  cursorId?: string
}

/** The normalized union of every captured input stream for one recording. */
export interface InteractionTrack {
  moves: MoveSample[]
  events: InteractionEvent[]
  /** Composition duration in seconds (clip times are clamped to it). */
  durationSeconds: number
}

/**
 * A cursor *fixation*: a span where the pointer dwelled inside a small region
 * (the eye-tracking-style attention proxy). Transit (saccade) intervals are the
 * gaps between fixations and are not represented explicitly.
 */
export interface Fixation {
  t0: number
  t1: number
  centroid: CanvasZoomFocus
  /** Max normalized spread of the samples from the centroid. */
  radius: number
  /** Number of move samples in the fixation. */
  samples: number
}

/** A span with no captured activity (no moves, no events). */
export interface IdleSpan {
  t0: number
  t1: number
}

export interface KinematicsResult {
  fixations: Fixation[]
  idleSpans: IdleSpan[]
}

/** What kind of deliberate engagement produced a candidate. */
export type EngagementKind =
  | "click" // a plain left-click on no known target
  | "click-target" // a click on a link/button (pointingHand or known AX role)
  | "typing" // a text-entry burst (iBeam / keystrokes)
  | "context-menu" // a right-click (a menu pops at the point)
  | "double-click" // rapid repeated clicks at one point
  | "selection" // a drag-select / text selection — frame the whole span
  | "drag" // a drag gesture that settles somewhere

/**
 * A scored, deliberate engagement — the importance model's output. Only these
 * survive into the detectors; transit / idle / skimming never produce one.
 */
export interface Engagement {
  /** Intent start in timeline seconds (when the action lands). */
  t0: number
  /** Intent end in timeline seconds (== t0 for a point click; the release for a drag/selection). */
  t1: number
  /** The subject region to frame (a zero-size rect for a point click). */
  region: NormRect
  /** Importance weight (≥ 0); higher = more zoom-worthy. */
  score: number
  kind: EngagementKind
  /** Whether this is a text-entry engagement (drives the higher base scale). */
  typing: boolean
}

/** A resolved zoom interval before framing/pacing — a detector's output. */
export interface ZoomWindow {
  start: number
  end: number
  /** The subject region this window should keep in frame. */
  region: NormRect
  /** Accumulated importance (drives rate-limit ranking). */
  score: number
  typing: boolean
}
