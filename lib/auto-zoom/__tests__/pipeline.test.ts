import { describe, expect, it } from "vitest"

import { compareDetectors } from "@/lib/auto-zoom/compare"
import { solveFraming } from "@/lib/auto-zoom/framing"
import { scoreEngagements } from "@/lib/auto-zoom/importance"
import { analyzeKinematics } from "@/lib/auto-zoom/kinematics"
import { AUTO_ZOOM_DEFAULTS } from "@/lib/auto-zoom/params"
import { buildAutoZoomClipsFromTrack } from "@/lib/auto-zoom/pipeline"
import type {
  InteractionEvent,
  InteractionTrack,
  MoveSample,
} from "@/lib/auto-zoom/types"

// --- builders --------------------------------------------------------------

const mv = (t: number, x: number, y: number, cursorId?: string): MoveSample => ({
  t,
  pos: { x, y },
  cursorId,
})

const down = (
  t: number,
  x: number,
  y: number,
  extra?: Partial<InteractionEvent>
): InteractionEvent => ({ t, kind: "click-down", pos: { x, y }, ...extra })

const up = (t: number, x: number, y: number): InteractionEvent => ({
  t,
  kind: "click-up",
  pos: { x, y },
})

/** A short dwell: many near-stationary samples spanning `durSec` at (x,y). */
const dwell = (
  tStart: number,
  durSec: number,
  x: number,
  y: number
): MoveSample[] => {
  const out: MoveSample[] = []
  const n = Math.max(2, Math.round(durSec / 0.05))
  for (let i = 0; i <= n; i++) {
    // tiny jitter, well under fixationMaxRadius (0.04)
    const j = (i % 3) * 0.003
    out.push(mv(tStart + (durSec * i) / n, x + j, y - j))
  }
  return out
}

const track = (over: Partial<InteractionTrack>): InteractionTrack => ({
  moves: [],
  events: [],
  durationSeconds: 30,
  ...over,
})

// --- kinematics ------------------------------------------------------------

describe("analyzeKinematics", () => {
  it("detects a single fixation from a stationary dwell", () => {
    const { fixations } = analyzeKinematics(
      track({ moves: dwell(1, 0.6, 0.5, 0.5) }),
      AUTO_ZOOM_DEFAULTS
    )
    expect(fixations).toHaveLength(1)
    expect(fixations[0].centroid.x).toBeCloseTo(0.5, 1)
    expect(fixations[0].radius).toBeLessThanOrEqual(
      AUTO_ZOOM_DEFAULTS.fixationMaxRadius + 1e-9
    )
  })

  it("splits a fast transit between two dwells into two fixations", () => {
    const moves = [
      ...dwell(1, 0.5, 0.2, 0.2),
      mv(1.7, 0.8, 0.8), // a jump far away (transit)
      ...dwell(2, 0.5, 0.8, 0.8),
    ]
    const { fixations } = analyzeKinematics(track({ moves }), AUTO_ZOOM_DEFAULTS)
    expect(fixations.length).toBe(2)
  })

  it("reports an idle span across a long quiet gap", () => {
    const { idleSpans } = analyzeKinematics(
      track({ moves: [mv(1, 0.5, 0.5), mv(6, 0.5, 0.5)], durationSeconds: 8 }),
      AUTO_ZOOM_DEFAULTS
    )
    expect(idleSpans.some((s) => s.t0 <= 1.01 && s.t1 >= 5.99)).toBe(true)
  })
})

// --- importance ------------------------------------------------------------

describe("scoreEngagements", () => {
  it("boosts a click that follows a dwell (dwell-that-leads-to-a-click)", () => {
    const dwellMoves = dwell(2, 0.6, 0.4, 0.4)
    const withDwell = track({
      moves: dwellMoves,
      events: [down(2.7, 0.4, 0.4), up(2.75, 0.4, 0.4)],
    })
    const withoutDwell = track({
      events: [down(2.7, 0.4, 0.4), up(2.75, 0.4, 0.4)],
    })

    const k1 = analyzeKinematics(withDwell, AUTO_ZOOM_DEFAULTS)
    const e1 = scoreEngagements(withDwell, k1.fixations, AUTO_ZOOM_DEFAULTS)
    const k2 = analyzeKinematics(withoutDwell, AUTO_ZOOM_DEFAULTS)
    const e2 = scoreEngagements(withoutDwell, k2.fixations, AUTO_ZOOM_DEFAULTS)

    expect(e1).toHaveLength(1)
    expect(e2).toHaveLength(1)
    expect(e1[0].score).toBeGreaterThan(e2[0].score)
  })

  it("flags a right-click as a context-menu engagement", () => {
    const t = track({
      events: [
        down(5, 0.5, 0.5, { button: "right" }),
        up(5.05, 0.5, 0.5),
      ],
    })
    const eng = scoreEngagements(t, [], AUTO_ZOOM_DEFAULTS)
    expect(eng).toHaveLength(1)
    expect(eng[0].kind).toBe("context-menu")
  })

  it("flags rapid same-spot clicks as a double-click", () => {
    const t = track({
      events: [
        down(5, 0.5, 0.5),
        up(5.04, 0.5, 0.5),
        down(5.2, 0.5, 0.5),
        up(5.24, 0.5, 0.5),
      ],
    })
    const eng = scoreEngagements(t, [], AUTO_ZOOM_DEFAULTS)
    expect(eng.some((e) => e.kind === "double-click")).toBe(true)
  })
})

// --- framing ---------------------------------------------------------------

describe("solveFraming", () => {
  it("uses the base scale and the exact point for a point subject", () => {
    const { focus, scale } = solveFraming(
      { x: 0.5, y: 0.3, width: 0, height: 0 },
      AUTO_ZOOM_DEFAULTS.zoomScale,
      AUTO_ZOOM_DEFAULTS
    )
    expect(focus).toEqual({ x: 0.5, y: 0.3 })
    expect(scale).toBeCloseTo(AUTO_ZOOM_DEFAULTS.zoomScale, 6)
  })

  it("scales down to fit a large region in frame", () => {
    const { scale } = solveFraming(
      { x: 0.1, y: 0.4, width: 0.8, height: 0.2 },
      AUTO_ZOOM_DEFAULTS.zoomScale,
      AUTO_ZOOM_DEFAULTS
    )
    // 0.8 width (+padding) must fit in 1/scale → scale well under the base.
    expect(scale).toBeLessThan(AUTO_ZOOM_DEFAULTS.zoomScale)
  })
})

// --- attention-region detector --------------------------------------------

describe("attention-region detector", () => {
  const build = (t: InteractionTrack) =>
    buildAutoZoomClipsFromTrack(t, { detector: "attention-region" })

  it("never zooms on dwell alone (no click)", () => {
    expect(build(track({ moves: dwell(2, 2, 0.5, 0.5) }))).toEqual([])
  })

  it("extends a hold to cover the dwell around a click", () => {
    const t = track({
      moves: dwell(2, 2, 0.3, 0.3), // dwell from 2s..4s
      events: [down(3, 0.3, 0.3), up(3.05, 0.3, 0.3)],
    })
    const clips = build(t)
    expect(clips).toHaveLength(1)
    // The hold starts at/before the dwell start (minus lead-in) and runs past it.
    expect(clips[0].start).toBeLessThanOrEqual(2)
    expect(clips[0].end).toBeGreaterThan(4)
  })

  it("splits two distant clicks into two clips", () => {
    const clips = build(
      track({
        events: [
          down(3, 0.2, 0.2),
          up(3.05, 0.2, 0.2),
          down(15, 0.8, 0.8),
          up(15.05, 0.8, 0.8),
        ],
      })
    )
    expect(clips).toHaveLength(2)
  })
})

// --- compare harness -------------------------------------------------------

// --- high recall + confidence + tiling -------------------------------------

describe("high-recall pacing", () => {
  it("zooms a dense same-spot cluster harder than a single click (confidence → scale)", () => {
    const single = buildAutoZoomClipsFromTrack(
      track({ events: [down(5, 0.5, 0.5), up(5.04, 0.5, 0.5)] })
    )
    const cluster = buildAutoZoomClipsFromTrack(
      track({
        events: [
          down(5, 0.5, 0.5),
          up(5.04, 0.5, 0.5),
          down(5.5, 0.5, 0.5),
          up(5.54, 0.5, 0.5),
          down(6, 0.5, 0.5),
          up(6.04, 0.5, 0.5),
          down(6.5, 0.5, 0.5),
          up(6.54, 0.5, 0.5),
        ],
      })
    )
    expect(single).toHaveLength(1)
    expect(cluster).toHaveLength(1) // same spot → one held zoom
    expect(cluster[0].scale).toBeGreaterThan(single[0].scale)
  })

  it("tiles across a short non-idle gap (camera stays engaged, no wide flash)", () => {
    const clips = buildAutoZoomClipsFromTrack(
      track({
        events: [
          down(5, 0.2, 0.2),
          up(5.04, 0.2, 0.2),
          down(6.5, 0.8, 0.8), // 1.5 s later, different region, not idle
          up(6.54, 0.8, 0.8),
        ],
      })
    )
    expect(clips).toHaveLength(2)
    // The first zoom holds until the second begins — abutting, not a wide gap.
    expect(Math.abs(clips[0].end - clips[1].start)).toBeLessThan(0.02)
  })

  it("returns to wide across a real idle gap", () => {
    const clips = buildAutoZoomClipsFromTrack(
      track({
        events: [
          down(5, 0.2, 0.2),
          up(5.04, 0.2, 0.2),
          down(12, 0.8, 0.8), // 7 s later → genuine idle between
          up(12.04, 0.8, 0.8),
        ],
        durationSeconds: 20,
      })
    )
    expect(clips).toHaveLength(2)
    // A real idle gap is NOT bridged: the first zoom ends well before the second.
    expect(clips[1].start - clips[0].end).toBeGreaterThan(1)
  })
})

describe("compareDetectors", () => {
  it("returns metrics for both detectors", () => {
    const t = track({
      moves: [...dwell(2, 1.5, 0.3, 0.3), ...dwell(10, 1.5, 0.7, 0.6)],
      events: [
        down(3, 0.3, 0.3),
        up(3.05, 0.3, 0.3),
        down(10.5, 0.7, 0.6),
        up(10.55, 0.7, 0.6),
      ],
    })
    const metrics = compareDetectors(t)
    expect(metrics.map((m) => m.id).sort()).toEqual([
      "attention-region",
      "click-anchored",
    ])
    for (const m of metrics) {
      expect(m.clipCount).toBeGreaterThan(0)
      expect(m.clickCoverage).toBeGreaterThan(0)
      expect(m.zoomedFraction).toBeGreaterThan(0)
    }
  })
})
