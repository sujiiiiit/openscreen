import { describe, expect, it } from "vitest"

import {
  generateZoomClipsFromClicks,
  type AutoZoomClickSample,
} from "../generate-from-clicks"

const click = (tSeconds: number, x = 0.5, y = 0.5): AutoZoomClickSample => ({
  tSeconds,
  focus: { x, y },
  type: "down",
})

describe("generateZoomClipsFromClicks", () => {
  it("returns nothing without clicks or a valid duration", () => {
    expect(generateZoomClipsFromClicks([], 30)).toEqual([])
    expect(generateZoomClipsFromClicks([click(1)], 0)).toEqual([])
  })

  it("pads a single click into an auto clip at the fixed magnification", () => {
    const clips = generateZoomClipsFromClicks([click(5, 0.4, 0.6)], 30)
    expect(clips).toHaveLength(1)
    expect(clips[0].mode).toBe("auto")
    expect(clips[0].scale).toBeCloseTo(2)
    // window = [5 - 0.3, 5 + 2.5]
    expect(clips[0].start).toBeCloseTo(4.7)
    expect(clips[0].end).toBeCloseTo(7.5)
    // the click position seeds the ease-in anchor
    expect(clips[0].focus.x).toBeCloseTo(0.4)
    expect(clips[0].focus.y).toBeCloseTo(0.6)
  })

  it("merges adjacent clicks into one clip", () => {
    const clips = generateZoomClipsFromClicks([click(5), click(6)], 30)
    expect(clips).toHaveLength(1)
    expect(clips[0].start).toBeCloseTo(4.7) // first click − 0.3
    expect(clips[0].end).toBeCloseTo(8.5) // last click + 2.5
  })

  it("chains clicks up to ~5s apart into ONE long clip (interval-gap merge)", () => {
    // interval-gap merge: a window joins when it starts within 2.5s of the
    // cluster's END (which itself sits 2.5s past the previous click), so clicks
    // ~5s apart still chain — far fewer, longer clips than a per-click-gap merge.
    const clips = generateZoomClipsFromClicks([click(5), click(10)], 30)
    expect(clips).toHaveLength(1)
    expect(clips[0].start).toBeCloseTo(4.7)
    expect(clips[0].end).toBeCloseTo(12.5) // last click (10) + 2.5
  })

  it("splits clicks beyond the merge reach into separate clips", () => {
    // 6s apart: the second window starts at 10.7s, past the first cluster's end
    // (7.5s) + 2.5s = 10s → a new clip.
    const clips = generateZoomClipsFromClicks([click(5), click(11)], 30)
    expect(clips).toHaveLength(2)
  })

  it("ignores trailing clicks in the last second of the recording", () => {
    expect(generateZoomClipsFromClicks([click(29.5)], 30)).toEqual([])
  })

  it("ignores mouse-up events (only down-clicks anchor a zoom)", () => {
    const up: AutoZoomClickSample = {
      tSeconds: 5,
      focus: { x: 0.5, y: 0.5 },
      type: "up",
    }
    expect(generateZoomClipsFromClicks([up], 30)).toEqual([])
  })

  it("clamps the window to the recording bounds", () => {
    const clips = generateZoomClipsFromClicks([click(0.1)], 30)
    expect(clips).toHaveLength(1)
    expect(clips[0].start).toBeCloseTo(0) // max(0, 0.1 − 0.3)
  })

  it("is idempotent — re-running yields identical ids", () => {
    const a = generateZoomClipsFromClicks([click(5), click(15)], 30)
    const b = generateZoomClipsFromClicks([click(5), click(15)], 30)
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id))
  })
})
