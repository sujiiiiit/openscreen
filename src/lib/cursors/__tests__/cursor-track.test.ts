import { describe, expect, it } from "vitest"

import {
  CURSOR_TYPE_STABILIZE_MS,
  stabilizeCursorIds,
  type RawCursorSample,
} from "@/lib/cursors/cursor-track"

const s = (t: number, cursorId: string): RawCursorSample => ({
  t,
  x: t, // distinct so we can assert positions are untouched
  y: -t,
  cursorId,
})

const ids = (samples: RawCursorSample[]) => samples.map((r) => r.cursorId)

describe("stabilizeCursorIds", () => {
  it("collapses a short shape blip (arrow→iBeam→arrow) to the steady shape", () => {
    // iBeam run is 50 ms (< 150) → held to the surrounding arrow.
    const out = stabilizeCursorIds(
      [s(0, "arrow"), s(200, "iBeam"), s(250, "arrow"), s(600, "arrow")],
      CURSOR_TYPE_STABILIZE_MS
    )
    expect(ids(out)).toEqual(["arrow", "arrow", "arrow", "arrow"])
  })

  it("collapses several consecutive short blips of different shapes", () => {
    const out = stabilizeCursorIds(
      [
        s(0, "arrow"),
        s(100, "iBeam"),
        s(120, "resize"),
        s(140, "arrow"),
        s(600, "arrow"),
      ],
      CURSOR_TYPE_STABILIZE_MS
    )
    expect(ids(out)).toEqual(["arrow", "arrow", "arrow", "arrow", "arrow"])
  })

  it("keeps a genuine (sustained) shape change", () => {
    // pointingHand persists 400 ms (>= 150) → kept.
    const out = stabilizeCursorIds(
      [s(0, "arrow"), s(200, "pointer"), s(400, "pointer"), s(600, "arrow")],
      CURSOR_TYPE_STABILIZE_MS
    )
    expect(ids(out)).toEqual(["arrow", "pointer", "pointer", "arrow"])
  })

  it("keeps the final run even if short (it persists to the recording end)", () => {
    const out = stabilizeCursorIds(
      [s(0, "arrow"), s(500, "arrow"), s(550, "iBeam")],
      CURSOR_TYPE_STABILIZE_MS
    )
    expect(ids(out)).toEqual(["arrow", "arrow", "iBeam"])
  })

  it("keeps a short LEADING run (no prior shape to fall back to)", () => {
    const out = stabilizeCursorIds(
      [s(0, "iBeam"), s(50, "arrow"), s(600, "arrow")],
      CURSOR_TYPE_STABILIZE_MS
    )
    expect(ids(out)).toEqual(["iBeam", "arrow", "arrow"])
  })

  it("never touches positions, only the cursor id", () => {
    const input = [s(0, "arrow"), s(50, "iBeam"), s(300, "arrow")]
    const out = stabilizeCursorIds(input, CURSOR_TYPE_STABILIZE_MS)
    expect(out.map((r) => [r.t, r.x, r.y])).toEqual(
      input.map((r) => [r.t, r.x, r.y])
    )
    // input is not mutated
    expect(input[1].cursorId).toBe("iBeam")
  })

  it("is a no-op for a non-positive threshold or <2 samples", () => {
    const input = [s(0, "arrow"), s(50, "iBeam")]
    expect(stabilizeCursorIds(input, 0)).toBe(input)
    expect(
      stabilizeCursorIds([s(0, "arrow")], CURSOR_TYPE_STABILIZE_MS)
    ).toEqual([s(0, "arrow")])
  })
})
