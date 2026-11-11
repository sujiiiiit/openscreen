import { describe, expect, it } from "vitest"

import { normalizeZoomClips } from "@/lib/zoom-clips"

import {
  generateZoomClipsFromClicks,
  type AutoZoomClickSample,
  type AutoZoomTypingBurst,
} from "../generate-from-clicks"

const click = (tSeconds: number, x = 0.5, y = 0.5): AutoZoomClickSample => ({
  tSeconds,
  focus: { x, y },
  type: "down",
})

const up = (tSeconds: number, x = 0.5, y = 0.5): AutoZoomClickSample => ({
  tSeconds,
  focus: { x, y },
  type: "up",
})

describe("generateZoomClipsFromClicks", () => {
  it("returns nothing without clicks or a valid duration", () => {
    expect(generateZoomClipsFromClicks([], 30)).toEqual([])
    expect(generateZoomClipsFromClicks([click(1)], 0)).toEqual([])
  })

  it("lands the push-in before a single click and holds after it", () => {
    const clips = generateZoomClipsFromClicks([click(5, 0.4, 0.6)], 30)
    expect(clips).toHaveLength(1)
    expect(clips[0].mode).toBe("auto")
    expect(clips[0].scale).toBeCloseTo(2)
    // window = [5 − 0.5, 5 + 2.0]
    expect(clips[0].start).toBeCloseTo(4.5)
    expect(clips[0].end).toBeCloseTo(7)
    expect(clips[0].focus.x).toBeCloseTo(0.4)
    expect(clips[0].focus.y).toBeCloseTo(0.6)
  })

  it("groups nearby clicks in the same area into one shot", () => {
    const clips = generateZoomClipsFromClicks(
      [click(5, 0.4, 0.4), click(6, 0.5, 0.45), click(8, 0.45, 0.5)],
      30
    )
    expect(clips).toHaveLength(1)
    expect(clips[0].start).toBeCloseTo(4.5)
    expect(clips[0].end).toBeCloseTo(10)
    // focus = centre of the clicks' box
    expect(clips[0].focus.x).toBeCloseTo(0.45)
    expect(clips[0].focus.y).toBeCloseTo(0.45)
  })

  it("fits the scale to the spread of the shot's clicks", () => {
    // 0.3 apart: 0.7 / 0.3 = 2.33 → quantized 2.25, clamped to the 2.0 max.
    expect(
      generateZoomClipsFromClicks([click(5, 0.35, 0.5), click(6, 0.65, 0.5)], 30)[0]
        .scale
    ).toBeCloseTo(2)
    // 0.42 apart: 0.7 / 0.42 = 1.67 → 1.5.
    const wide = generateZoomClipsFromClicks(
      [click(5, 0.29, 0.5), click(6, 0.71, 0.5)],
      30
    )
    expect(wide).toHaveLength(1)
    expect(wide[0].scale).toBeCloseTo(1.5)
  })

  it("does NOT chain clicks in different areas into one panning zoom", () => {
    // Top-left then bottom-right, 4 s apart: two shots, not one long pan.
    const clips = generateZoomClipsFromClicks(
      [click(5, 0.1, 0.1), click(9, 0.9, 0.9)],
      30
    )
    expect(clips).toHaveLength(2)
    expect(clips[0].focus.x).toBeCloseTo(0.1)
    expect(clips[1].focus.x).toBeCloseTo(0.9)
  })

  it("splits same-area clicks that are far apart in time", () => {
    const clips = generateZoomClipsFromClicks([click(5), click(12)], 30)
    expect(clips).toHaveLength(2)
  })

  it("stays zoomed instead of pumping between two same-area shots", () => {
    // 3.2 s apart (beyond the join gap): A ends 8.2+… the wide beat would be
    // ~0.7 s — a pump — so the shots merge.
    const clips = generateZoomClipsFromClicks([click(5), click(8.2)], 30)
    expect(clips).toHaveLength(1)
    expect(clips[0].end).toBeCloseTo(10.2)
  })

  it("trims tail to open a readable wide beat between far shots", () => {
    // Far apart, 4 s between clicks: A's 2 s tail is trimmed so the wide beat
    // before B (starting at 8.5) is at least 1 s.
    const clips = generateZoomClipsFromClicks(
      [click(5, 0.1, 0.1), click(9, 0.9, 0.9)],
      30
    )
    expect(clips[1].start).toBeCloseTo(8.5)
    expect(clips[1].start - clips[0].end).toBeGreaterThanOrEqual(1 - 1e-9)
    expect(clips[0].end - 5).toBeGreaterThanOrEqual(1.5 - 1e-9)
  })

  it("abuts far shots that are too close in time for a wide beat (weld)", () => {
    const clips = generateZoomClipsFromClicks(
      [click(5, 0.1, 0.1), click(6.5, 0.9, 0.9)],
      30
    )
    expect(clips).toHaveLength(2)
    expect(clips[0].end).toBeCloseTo(clips[1].start)
    // The cut never comes before A's click.
    expect(clips[0].end).toBeGreaterThan(5)
  })

  it("frames a drag's whole extent", () => {
    const clips = generateZoomClipsFromClicks([click(5, 0.3, 0.5), up(6, 0.6, 0.5)], 30)
    expect(clips).toHaveLength(1)
    expect(clips[0].focus.x).toBeCloseTo(0.45)
    // the tail runs from the drag's END (mouse-up)
    expect(clips[0].end).toBeCloseTo(8)
    expect(clips[0].scale).toBeCloseTo(2) // 0.7 / 0.3 → capped
  })

  it("leaves a screen-wide drag wide and keeps neighbours off it", () => {
    const clips = generateZoomClipsFromClicks(
      [click(3, 0.2, 0.2), click(5, 0.1, 0.5), up(6, 0.9, 0.5), click(10, 0.8, 0.8)],
      30
    )
    for (const c of clips) {
      // nothing zoomed while the drag (5 → 6 s) plays
      expect(c.end <= 5 + 1e-9 || c.start >= 6 - 1e-9).toBe(true)
    }
    expect(clips.some((c) => c.focus.x === 0.8)).toBe(true)
  })

  it("treats a stationary down→up as a plain click", () => {
    const clips = generateZoomClipsFromClicks([click(5, 0.3, 0.5), up(5.1, 0.3, 0.5)], 30)
    expect(clips[0].end).toBeCloseTo(7)
  })

  it("ignores trailing clicks in the last second of the recording", () => {
    expect(generateZoomClipsFromClicks([click(29.5)], 30)).toEqual([])
  })

  it("ignores lone mouse-up events", () => {
    expect(generateZoomClipsFromClicks([up(5)], 30)).toEqual([])
  })

  it("clamps the window to the recording bounds", () => {
    const clips = generateZoomClipsFromClicks([click(0.1), click(28.5)], 30)
    expect(clips[0].start).toBeCloseTo(0.001)
    expect(clips[clips.length - 1].end).toBeCloseTo(29.2)
  })

  it("is idempotent — re-running yields identical clips", () => {
    const input = [click(5), click(15, 0.2, 0.8)]
    expect(generateZoomClipsFromClicks(input, 30)).toEqual(
      generateZoomClipsFromClicks(input, 30)
    )
  })
})

describe("generateZoomClipsFromClicks — typing bursts", () => {
  it("emits an auto clip for a typing burst with the typing tail", () => {
    const clips = generateZoomClipsFromClicks([], 30, [
      { startSeconds: 5, endSeconds: 8, focus: { x: 0.3, y: 0.2 } },
    ])
    expect(clips).toHaveLength(1)
    expect(clips[0].mode).toBe("auto")
    expect(clips[0].start).toBeCloseTo(4.5) // first key − 0.5
    expect(clips[0].end).toBeCloseTo(9.8) // last key + 1.8
    expect(clips[0].focus.x).toBeCloseTo(0.3)
  })

  it("frames the caret extent of a burst with a gentler scale", () => {
    const clips = generateZoomClipsFromClicks([], 30, [
      {
        startSeconds: 5,
        endSeconds: 8,
        focus: { x: 0.2, y: 0.5 },
        bounds: { minX: 0.2, minY: 0.5, maxX: 0.6, maxY: 0.52 },
      },
    ])
    expect(clips[0].focus.x).toBeCloseTo(0.4)
    expect(clips[0].scale).toBeCloseTo(1.75) // 0.7 / 0.4 = 1.75
  })

  it("chains a click and the typing that follows in the same area", () => {
    const clips = generateZoomClipsFromClicks([click(5, 0.3, 0.2)], 30, [
      { startSeconds: 6, endSeconds: 10, focus: { x: 0.32, y: 0.2 } },
    ])
    expect(clips).toHaveLength(1)
    expect(clips[0].start).toBeCloseTo(4.5)
    expect(clips[0].end).toBeCloseTo(11.8)
  })
})

describe("generateZoomClipsFromClicks — invariants (randomized)", () => {
  // Deterministic LCG so failures reproduce.
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const c01 = (v: number) => Math.min(1, Math.max(0, v))

  it("always yields a clean, pump-free lane that frames every kept action", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed)
      const duration = 3 + r() * 80
      const maxStep = [0.6, 2, 6][seed % 3]
      const clicks: AutoZoomClickSample[] = []
      const typing: AutoZoomTypingBurst[] = []
      // Every point the viewer must see while it happens.
      const points: Array<{ t: number; x: number; y: number }> = []
      let t = r() * 2
      while (t < duration) {
        const last = points[points.length - 1]
        const near = last !== undefined && r() < 0.5
        const x = c01(near ? last.x + (r() - 0.5) * 0.2 : r())
        const y = c01(near ? last.y + (r() - 0.5) * 0.2 : r())
        const step = 0.05 + r() * maxStep
        const kind = r()
        if (kind < 0.15) {
          const len = r() * 4
          const w = r() * 0.5
          const end = { x: c01(x + w), y: c01(y + 0.03) }
          typing.push({
            startSeconds: t,
            endSeconds: t + len,
            focus: { x, y },
            bounds: { minX: x, minY: y, maxX: end.x, maxY: end.y },
          })
          points.push({ t, x, y }, { t: t + len, ...end })
          t += len + step
          continue
        }
        clicks.push(click(t, x, y))
        points.push({ t, x, y })
        if (kind < 0.4) {
          // Some drags, a few of them screen-wide (those must stay wide).
          const ux = c01(x + (r() - 0.5) * (r() < 0.3 ? 1.6 : 0.3))
          const ut = t + r() * Math.min(0.8, step * 0.9)
          clicks.push(up(ut, ux, y))
          if (Math.abs(ux - x) > 0.03) points.push({ t: ut, x: ux, y })
        }
        t += step
      }
      const clips = generateZoomClipsFromClicks(clicks, duration, typing)

      // Non-overlapping, sorted, in bounds, stable under re-normalization.
      expect(normalizeZoomClips(clips, duration)).toEqual(clips)
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i]
        expect(c.start).toBeGreaterThanOrEqual(0)
        expect(c.end).toBeLessThanOrEqual(duration)
        expect(c.end - c.start).toBeGreaterThanOrEqual(0.5 - 1e-9)
        expect(c.scale).toBeGreaterThanOrEqual(1.5 - 1e-9)
        expect(c.scale).toBeLessThanOrEqual(2 + 1e-9)
        if (i > 0) {
          const gap = c.start - clips[i - 1].end
          // Either welded (abutting) or a readable wide beat — never a pump.
          expect(gap < 1e-6 || gap >= 1 - 1e-6).toBe(true)
        }
      }

      // Every action point a clip covers sits inside that clip's zoomed view.
      // (A clip that starts on the point's millisecond is still at 1× there.)
      for (const k of points) {
        // Trailing actions (final second — usually the Stop button) are ignored.
        if (k.t >= duration - 1) continue
        const c = clips.find((z) => k.t > z.start + 1e-3 && k.t < z.end)
        if (!c) continue
        const half = 0.5 / c.scale
        expect(Math.abs(k.x - c.focus.x)).toBeLessThanOrEqual(half + 1e-9)
        expect(Math.abs(k.y - c.focus.y)).toBeLessThanOrEqual(half + 1e-9)
      }
    }
  })
})
