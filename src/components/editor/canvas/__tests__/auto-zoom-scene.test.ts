import { describe, expect, it } from "vitest"

import {
  autoZoomClicksFromCursorData,
  type AutoZoomScreenClip,
} from "@/components/editor/canvas/auto-zoom-scene"
import type { CursorVideoGeometry } from "@/components/editor/canvas/cursor-scene"
import type { CursorTrackData } from "@/types/api"

const VIDEO: CursorVideoGeometry = {
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  rotation: 0,
  intrinsicWidth: 1920,
  intrinsicHeight: 1080,
}
const ARTBOARD = { width: 1920, height: 1080 }
const UNTRIMMED: AutoZoomScreenClip[] = [
  { start: 0, end: 10, sourceIn: 0, sourceOut: 10 },
]

const data = (clicks: CursorTrackData["clicks"]): CursorTrackData => ({
  moves: [],
  clicks,
  processTimeStartMs: 1000,
  displayWidth: 1920,
  displayHeight: 1080,
})

describe("autoZoomClicksFromCursorData", () => {
  it("maps a click's time to source-relative seconds and position to artboard focus", () => {
    const samples = autoZoomClicksFromCursorData(
      data([{ processTimeMs: 3000, x: 960, y: 540, type: "mouseDown", cursorId: "arrow" }]),
      VIDEO,
      UNTRIMMED,
      ARTBOARD
    )
    expect(samples).toHaveLength(1)
    expect(samples[0].tSeconds).toBeCloseTo(2, 6) // (3000-1000)/1000
    expect(samples[0].type).toBe("down")
    expect(samples[0].focus.x).toBeCloseTo(0.5, 6)
    expect(samples[0].focus.y).toBeCloseTo(0.5, 6)
    expect(samples[0].cursorId).toBe("arrow")
  })

  it("normalizes mouseUp/mouseDown and ignores other event types", () => {
    const samples = autoZoomClicksFromCursorData(
      data([
        { processTimeMs: 2000, x: 100, y: 100, type: "mouseDown" },
        { processTimeMs: 2100, x: 100, y: 100, type: "mouseUp" },
        { processTimeMs: 2200, x: 100, y: 100, type: "mouseMoved" },
      ]),
      VIDEO,
      UNTRIMMED,
      ARTBOARD
    )
    expect(samples.map((s) => s.type)).toEqual(["down", "up"])
  })

  it("drops clicks whose source time is trimmed out, and offsets by sourceIn", () => {
    // Clip shows source [2s,7s) at timeline [5s,10s).
    const clips: AutoZoomScreenClip[] = [
      { start: 5, end: 10, sourceIn: 2, sourceOut: 7 },
    ]
    const samples = autoZoomClicksFromCursorData(
      data([
        { processTimeMs: 2000, x: 960, y: 540, type: "mouseDown" }, // source 1s → trimmed out
        { processTimeMs: 4000, x: 960, y: 540, type: "mouseDown" }, // source 3s → timeline 6s
      ]),
      VIDEO,
      clips,
      ARTBOARD
    )
    expect(samples).toHaveLength(1)
    expect(samples[0].tSeconds).toBeCloseTo(6, 6)
  })

  it("drops clicks that map off the visible video", () => {
    const samples = autoZoomClicksFromCursorData(
      data([{ processTimeMs: 3000, x: -50, y: 540, type: "mouseDown" }]),
      VIDEO,
      UNTRIMMED,
      ARTBOARD
    )
    expect(samples).toEqual([])
  })

  it("drops clicks before the recording start (negative source time)", () => {
    const samples = autoZoomClicksFromCursorData(
      data([{ processTimeMs: 500, x: 960, y: 540, type: "mouseDown" }]),
      VIDEO,
      UNTRIMMED,
      ARTBOARD
    )
    expect(samples).toEqual([])
  })
})
