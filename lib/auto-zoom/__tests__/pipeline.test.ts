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

// --- hybrid-stabilized detector --------------------------------------------

describe("hybrid-stabilized detector", () => {
  const buildHybrid = (t: InteractionTrack) =>
    buildAutoZoomClipsFromTrack(t, { detector: "hybrid-stabilized" })

  it("returns [] with no clicks (a wide shot is correct)", () => {
    expect(buildHybrid(track({ events: [] }))).toEqual([])
  })

  it("returns [] for a recording below the minimum length", () => {
    expect(
      buildHybrid(
        track({
          events: [down(1, 0.5, 0.5), up(1.05, 0.5, 0.5)],
          durationSeconds: 2,
        })
      )
    ).toEqual([])
  })

  it("never zooms on dwell alone (no click)", () => {
    expect(buildHybrid(track({ moves: dwell(2, 2, 0.5, 0.5) }))).toEqual([])
  })

  it("extends a hold to cover the dwell around a click", () => {
    const t = track({
      moves: dwell(2, 2, 0.3, 0.3), // dwell from 2s..4s
      events: [down(3, 0.3, 0.3), up(3.05, 0.3, 0.3)],
    })
    const clips = buildHybrid(t)
    expect(clips).toHaveLength(1)
    // The hold starts at/before the dwell start (minus lead-in) and runs past it.
    expect(clips[0].start).toBeLessThanOrEqual(2)
    expect(clips[0].end).toBeGreaterThan(4)
  })

  it("holds one steady shot through a mid-range jump (hysteresis)", () => {
    // Jump 0.2 sits in the hysteresis dead band (> a tight 0.14 per-click split,
    // but < hysteresisFocusJump 0.30): the camera stays in the region, one shot.
    const t = track({
      events: [
        down(5, 0.4, 0.4),
        up(5.05, 0.4, 0.4),
        down(6, 0.6, 0.4),
        up(6.05, 0.6, 0.4),
      ],
    })
    expect(buildHybrid(t)).toHaveLength(1)
  })

  it("splits on a clearly distinct jump (beyond the sticky boundary)", () => {
    const clips = buildHybrid(
      track({
        events: [
          down(5, 0.2, 0.2),
          up(5.05, 0.2, 0.2),
          down(6, 0.8, 0.8),
          up(6.05, 0.8, 0.8),
        ],
      })
    )
    expect(clips).toHaveLength(2)
  })

  it("frames the dense core, not pulled by an absorbed outlier", () => {
    // Three clicks at 0.3 + one absorbed outlier at 0.45 (dist 0.15: sticky, but
    // outside the 0.12 core). The frame centers on the core (~0.3), not the union
    // midpoint (~0.34).
    const clips = buildHybrid(
      track({
        events: [
          down(5, 0.3, 0.3),
          up(5.04, 0.3, 0.3),
          down(5.5, 0.3, 0.3),
          up(5.54, 0.3, 0.3),
          down(6, 0.3, 0.3),
          up(6.04, 0.3, 0.3),
          down(6.5, 0.45, 0.3),
          up(6.54, 0.45, 0.3),
        ],
      })
    )
    expect(clips).toHaveLength(1)
    expect(clips[0].focus.x).toBeCloseTo(0.3, 2)
  })

  it("holds one steady scale across a tiled scene (no scale bounce)", () => {
    // A low-confidence single click then a dense cluster in a distinct region,
    // 1 s apart (non-idle → tiled into one scene). Their desired scales differ,
    // but the scene holds the steady MIN.
    const t = track({
      events: [
        down(5, 0.2, 0.2),
        up(5.04, 0.2, 0.2),
        down(6, 0.8, 0.2),
        up(6.04, 0.8, 0.2),
        down(6.3, 0.8, 0.2),
        up(6.34, 0.8, 0.2),
        down(6.6, 0.8, 0.2),
        up(6.64, 0.8, 0.2),
      ],
    })
    const unified = buildHybrid(t)
    expect(unified).toHaveLength(2)
    expect(unified[0].scale).toBeCloseTo(unified[1].scale, 6)

    // With cohesion off, the dense cluster zooms harder than the single click.
    const split = buildAutoZoomClipsFromTrack(t, {
      detector: "hybrid-stabilized",
      params: { sceneCohesion: false },
    })
    expect(split[1].scale).toBeGreaterThan(split[0].scale)
    expect(unified[0].scale).toBeCloseTo(split[0].scale, 6) // unified to the MIN
  })

  it("keeps independent scales across scenes split by idle", () => {
    const clips = buildHybrid(
      track({
        events: [
          down(5, 0.2, 0.2),
          up(5.04, 0.2, 0.2),
          down(12, 0.8, 0.2),
          up(12.04, 0.8, 0.2),
          down(12.3, 0.8, 0.2),
          up(12.34, 0.8, 0.2),
          down(12.6, 0.8, 0.2),
          up(12.64, 0.8, 0.2),
        ],
        durationSeconds: 20,
      })
    )
    expect(clips).toHaveLength(2)
    expect(clips[1].scale).toBeGreaterThan(clips[0].scale)
  })

  it("covers every click (high recall preserved)", () => {
    const downs = [3, 8, 8.5, 20, 26]
    const clips = buildHybrid(
      track({
        events: [
          down(3, 0.2, 0.2),
          up(3.05, 0.2, 0.2),
          down(8, 0.5, 0.5),
          up(8.05, 0.5, 0.5),
          down(8.5, 0.52, 0.5),
          up(8.55, 0.52, 0.5),
          down(20, 0.8, 0.8),
          up(20.05, 0.8, 0.8),
          down(26, 0.3, 0.7),
          up(26.05, 0.3, 0.7),
        ],
      })
    )
    for (const dt of downs) {
      expect(clips.some((c) => dt >= c.start && dt <= c.end)).toBe(true)
    }
  })

  it("is deterministic (identical input → byte-identical output)", () => {
    const t = track({
      moves: dwell(2, 1.5, 0.3, 0.3),
      events: [
        down(3, 0.3, 0.3),
        up(3.05, 0.3, 0.3),
        down(12, 0.8, 0.7),
        up(12.05, 0.8, 0.7),
      ],
    })
    expect(JSON.stringify(buildHybrid(t))).toEqual(JSON.stringify(buildHybrid(t)))
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
  it("reports metrics for the detector", () => {
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
    expect(metrics.map((m) => m.id)).toEqual(["hybrid-stabilized"])
    for (const m of metrics) {
      expect(m.clipCount).toBeGreaterThan(0)
      expect(m.clickCoverage).toBeGreaterThan(0)
      expect(m.zoomedFraction).toBeGreaterThan(0)
    }
  })
})
