import { describe, expect, it } from "vitest"

import type { CursorTrackData } from "@/types/api"

import { planAutoSpeedRanges } from "../plan-auto-speed"

const base = (overrides: Partial<CursorTrackData>): CursorTrackData => ({
  moves: [],
  clicks: [],
  processTimeStartMs: 1000,
  displayWidth: 1000,
  displayHeight: 800,
  ...overrides,
})

const keys = (fromMs: number, count: number, stepMs: number) =>
  Array.from({ length: count }, (_, i) => ({
    processTimeMs: 1000 + fromMs + i * stepMs,
  }))

describe("planAutoSpeedRanges", () => {
  it("returns nothing without data or with every kind off", () => {
    expect(planAutoSpeedRanges(null, { typingSpeed: 2, idleSpeed: 4 })).toEqual([])
    expect(
      planAutoSpeedRanges(base({ typing: keys(0, 20, 200) }), {
        typingSpeed: null,
        idleSpeed: null,
      })
    ).toEqual([])
  })

  it("speeds up a typing run (first key → last key + tail)", () => {
    const ranges = planAutoSpeedRanges(base({ typing: keys(5000, 20, 200) }), {
      typingSpeed: 2,
      idleSpeed: null,
    })
    expect(ranges).toHaveLength(1)
    expect(ranges[0].kind).toBe("typing")
    expect(ranges[0].startSeconds).toBeCloseTo(5)
    expect(ranges[0].endSeconds).toBeCloseTo(5 + 19 * 0.2 + 0.25)
    expect(ranges[0].speed).toBe(2)
  })

  it("ignores short typing runs", () => {
    expect(
      planAutoSpeedRanges(base({ typing: keys(5000, 4, 200) }), {
        typingSpeed: 2,
        idleSpeed: null,
      })
    ).toEqual([])
  })

  it("finds idle stretches between activity, with margins", () => {
    const data = base({
      moves: [
        { processTimeMs: 1000 + 1000, x: 0, y: 0 },
        { processTimeMs: 1000 + 1100, x: 50, y: 0 }, // activity @1.1s
        { processTimeMs: 1000 + 3000, x: 51, y: 0 }, // jitter, not activity
        { processTimeMs: 1000 + 9000, x: 200, y: 0 }, // activity @9s
      ],
      clicks: [{ processTimeMs: 1000 + 9500, x: 200, y: 0, type: "down" }],
    })
    const ranges = planAutoSpeedRanges(data, { typingSpeed: null, idleSpeed: 4 })
    const idle = ranges.filter((r) => r.kind === "idle")
    // Idle between 1.1 s and 9 s → [1.6, 8.5]
    expect(idle.some((r) => Math.abs(r.startSeconds - 1.6) < 1e-6 && Math.abs(r.endSeconds - 8.5) < 1e-6)).toBe(true)
    for (const r of idle) expect(r.speed).toBe(4)
  })

  it("never overlaps ranges", () => {
    const data = base({
      typing: [...keys(2000, 10, 200), ...keys(9000, 10, 200)],
      moves: [{ processTimeMs: 1000, x: 0, y: 0 }],
    })
    const ranges = planAutoSpeedRanges(data, { typingSpeed: 2, idleSpeed: 4 })
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].startSeconds).toBeGreaterThanOrEqual(ranges[i - 1].endSeconds)
    }
  })
})
