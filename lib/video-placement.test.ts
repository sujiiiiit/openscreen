import { describe, expect, test } from "vitest"

import type { CanvasVideoItem } from "@/types/editor-canvas"

import {
  applyAutoLayout,
  ARTBOARD_PADDING_MAX,
  computeVideoPlacement,
  getPaddingInsetPx,
} from "./video-placement"

const artboard = (width: number, height: number, padding = 0) => ({
  width,
  height,
  padding,
})

function video(
  id: string,
  partial: Partial<CanvasVideoItem> = {}
): CanvasVideoItem {
  return {
    id,
    fileName: `${id}.mov`,
    objectUrl: "",
    fileSize: 0,
    source: { kind: "recording", assetRole: "screen" },
    intrinsicWidth: 1920,
    intrinsicHeight: 1080,
    durationMs: 1000,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    locked: false,
    role: "screen",
    cornerRadius: 0,
    cornerSmoothing: 0,
    borderWidth: 0,
    borderColor: "#000000",
    borderOffset: 0,
    borderAlignment: "center",
    shadowColor: "rgba(0,0,0,0)",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowSpread: 0,
    ...partial,
  }
}

describe("getPaddingInsetPx", () => {
  test("zero and negative padding produce no inset", () => {
    expect(getPaddingInsetPx(artboard(1920, 1080, 0))).toBe(0)
    expect(getPaddingInsetPx(artboard(1920, 1080, -10))).toBe(0)
  })

  test("clamps to the slider max and the artboard's shorter edge", () => {
    expect(getPaddingInsetPx(artboard(1920, 1080, 10_000))).toBe(
      ARTBOARD_PADDING_MAX
    )
    // Shorter edge 200 → max inset floor(200 / 2) - 1 = 99.
    expect(getPaddingInsetPx(artboard(1920, 200, 150))).toBe(99)
  })
})

describe("computeVideoPlacement", () => {
  test("padding 0 → cover-fit: wide video on a square artboard crops horizontally", () => {
    const placement = computeVideoPlacement(
      { width: 1920, height: 1080 },
      artboard(1000, 1000)
    )

    // Cover scale = max(1000/1920, 1000/1080) = 1000/1080.
    expect(placement.height).toBeCloseTo(1000, 5)
    expect(placement.width).toBeCloseTo((1920 * 1000) / 1080, 5)
    // Centered: overflow splits evenly.
    expect(placement.x).toBeCloseTo((1000 - placement.width) / 2, 5)
    expect(placement.y).toBeCloseTo(0, 5)
  })

  test("padding 0 → cover-fit: tall video on a wide artboard crops vertically", () => {
    const placement = computeVideoPlacement(
      { width: 1080, height: 1920 },
      artboard(1920, 1080)
    )

    expect(placement.width).toBeCloseTo(1920, 5)
    expect(placement.height).toBeCloseTo((1920 * 1920) / 1080, 5)
    expect(placement.x).toBeCloseTo(0, 5)
    expect(placement.y).toBeCloseTo((1080 - placement.height) / 2, 5)
  })

  test("padding > 0 → contain-fit inside the padded inner rect, centered", () => {
    const placement = computeVideoPlacement(
      { width: 1920, height: 1080 },
      artboard(1920, 1080, 100)
    )

    // Inner rect 1720×880; contain scale = min(1720/1920, 880/1080) = 880/1080.
    const scale = 880 / 1080
    expect(placement.width).toBeCloseTo(1920 * scale, 5)
    expect(placement.height).toBeCloseTo(880, 5)
    // Entirely inside the inner rect.
    expect(placement.x).toBeGreaterThanOrEqual(100)
    expect(placement.x + placement.width).toBeLessThanOrEqual(1820)
    expect(placement.y).toBeCloseTo(100, 5)
    // Aspect preserved.
    expect(placement.width / placement.height).toBeCloseTo(1920 / 1080, 5)
    // Centered.
    expect(placement.x).toBeCloseTo((1920 - placement.width) / 2, 5)
  })

  test("non-positive intrinsics fall back to the full artboard", () => {
    expect(
      computeVideoPlacement({ width: 0, height: 0 }, artboard(1920, 1080))
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })
})

describe("applyAutoLayout", () => {
  test("recomputes placement for every role and zeroes rotation", () => {
    const items = [
      video("screen", { x: 5, y: 5, width: 10, height: 10, rotation: 1 }),
      video("camera", { role: "camera", intrinsicWidth: 640, intrinsicHeight: 480 }),
      video("media", { role: "media", intrinsicWidth: 1000, intrinsicHeight: 1000 }),
    ]
    const next = applyAutoLayout(items, artboard(1920, 1080))

    for (const item of next) {
      const expected = computeVideoPlacement(
        { width: item.intrinsicWidth, height: item.intrinsicHeight },
        artboard(1920, 1080)
      )
      expect(item.x).toBeCloseTo(expected.x, 5)
      expect(item.y).toBeCloseTo(expected.y, 5)
      expect(item.width).toBeCloseTo(expected.width, 5)
      expect(item.height).toBeCloseTo(expected.height, 5)
      expect(item.rotation).toBe(0)
    }
  })

  test("ignores the legacy locked flag", () => {
    const locked = video("locked", {
      locked: true,
      x: 123,
      y: 456,
      width: 10,
      height: 10,
    })
    const [next] = applyAutoLayout([locked], artboard(1920, 1080))

    expect(next.x).not.toBe(123)
    expect(next.locked).toBe(true) // the flag itself round-trips untouched
  })

  test("returns the same references when nothing changes", () => {
    const items = [video("a")]
    const laidOut = applyAutoLayout(items, artboard(1920, 1080, 50))
    const again = applyAutoLayout(laidOut, artboard(1920, 1080, 50))

    // Identity is the autosave-convergence guarantee: hydration recompute on
    // an already-derived project must not look like a new edit.
    expect(again).toBe(laidOut)
    expect(again[0]).toBe(laidOut[0])
  })

  test("preserves unchanged items when only one item moves", () => {
    const stable = video("stable")
    const laidOut = applyAutoLayout([stable], artboard(1920, 1080))
    const moved = video("moved", {
      intrinsicWidth: 500,
      intrinsicHeight: 500,
      x: -1,
    })
    const next = applyAutoLayout([...laidOut, moved], artboard(1920, 1080))

    expect(next[0]).toBe(laidOut[0])
    expect(next[1].x).not.toBe(-1)
  })
})
