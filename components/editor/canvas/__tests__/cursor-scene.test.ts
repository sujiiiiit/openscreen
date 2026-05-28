import { describe, expect, it } from "vitest"

import type { SmoothedCursorTrack } from "@/lib/cursors/cursor-track"

import { computeCursorBlur, type CursorVideoGeometry } from "../cursor-scene"

// A synthetic track + 1:1 video geometry so artboard coords equal sample coords
// (display points map straight through with no cover-crop and unit scale). This
// isolates the velocity → motion-blur derivation from the placement math.
function track(xs: number[], ys: number[], dtMs = 100): SmoothedCursorTrack {
  const n = xs.length
  return {
    t: Float64Array.from(xs.map((_, i) => i * dtMs)),
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    cursorIds: Array.from({ length: n }, () => "pointer"),
    displayWidth: 200,
    displayHeight: 100,
    durationMs: (n - 1) * dtMs,
  }
}

function geometry(rotation = 0): CursorVideoGeometry {
  return {
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    rotation,
    intrinsicWidth: 200,
    intrinsicHeight: 100,
  }
}

const movingRight = track([0, 100, 200], [50, 50, 50]) // 1000 px/s along +x

describe("computeCursorBlur", () => {
  it("returns null when intensity is 0 (off)", () => {
    const blur = computeCursorBlur(movingRight, geometry(), 0.1, { intensity: 0 })
    expect(blur).toBeNull()
  })

  it("returns null when the cursor is still", () => {
    const still = track([100, 100, 100], [50, 50, 50])
    expect(computeCursorBlur(still, geometry(), 0.1, { intensity: 1 })).toBeNull()
  })

  it("blurs along the direction of travel", () => {
    const blur = computeCursorBlur(movingRight, geometry(), 0.1, { intensity: 1 })
    expect(blur).not.toBeNull()
    expect(blur!.velocityX).toBeGreaterThan(0)
    expect(Math.abs(blur!.velocityY)).toBeLessThan(1e-6)
    expect(blur!.offset).toBe(0)
    // 1000 px/s * (1/30 s shutter) * 1.0 intensity ≈ 33 px of smear.
    const smear = Math.hypot(blur!.velocityX, blur!.velocityY)
    expect(smear).toBeGreaterThan(28)
    expect(smear).toBeLessThan(40)
    expect(blur!.kernelSize % 2).toBe(1) // odd
  })

  it("scales smear length linearly with intensity", () => {
    const full = computeCursorBlur(movingRight, geometry(), 0.1, { intensity: 1 })!
    const half = computeCursorBlur(movingRight, geometry(), 0.1, { intensity: 0.5 })!
    expect(half.velocityX).toBeCloseTo(full.velocityX / 2, 4)
  })

  it("caps the smear length for very fast moves", () => {
    const fast = track([0, 2000, 4000], [50, 50, 50]) // 20000 px/s
    const blur = computeCursorBlur(fast, geometry(), 0.1, { intensity: 1 })!
    expect(Math.hypot(blur.velocityX, blur.velocityY)).toBeLessThanOrEqual(200)
  })

  it("is rotation-invariant in the cursor's local frame", () => {
    // A screen-horizontal move must blur horizontally in local space whether or
    // not the video is rotated (the filter runs pre-rotation).
    const flat = computeCursorBlur(movingRight, geometry(0), 0.1, { intensity: 1 })!
    const rot = computeCursorBlur(movingRight, geometry(90), 0.1, { intensity: 1 })!
    expect(rot.velocityX).toBeCloseTo(flat.velocityX, 4)
    expect(Math.abs(rot.velocityY)).toBeLessThan(1e-6)
  })
})
