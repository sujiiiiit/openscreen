import { beforeAll, describe, expect, it } from "vitest"

import { applyMotionBlur } from "../cpu-motion-blur"
import type { MotionBlurOptions } from "../types"

// vitest runs in the `node` environment, where `ImageData` is not defined.
// Provide a minimal, spec-compatible shim so the pure CPU filter can run.
beforeAll(() => {
  if (typeof (globalThis as { ImageData?: unknown }).ImageData === "undefined") {
    class ImageDataPolyfill {
      data: Uint8ClampedArray
      width: number
      height: number
      constructor(a: number | Uint8ClampedArray, b: number, c?: number) {
        if (a instanceof Uint8ClampedArray) {
          this.data = a
          this.width = b
          this.height = c ?? a.length / 4 / b
        } else {
          this.width = a
          this.height = b
          this.data = new Uint8ClampedArray(a * b * 4)
        }
      }
    }
    ;(globalThis as { ImageData: unknown }).ImageData = ImageDataPolyfill
  }
})

function solid(width: number, height: number, rgba: [number, number, number, number]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0]
    data[i + 1] = rgba[1]
    data[i + 2] = rgba[2]
    data[i + 3] = rgba[3]
  }
  return new ImageData(data, width, height)
}

/** Left half black, right half white — a single vertical edge at x = width/2. */
function verticalEdge(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = x < width / 2 ? 0 : 255
      const o = (y * width + x) * 4
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  return new ImageData(data, width, height)
}

/** Opaque white block centred in a transparent canvas (models a sprite + margin). */
function opaqueBlockOnTransparent(width: number, height: number, margin: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = margin; y < height - margin; y++) {
    for (let x = margin; x < width - margin; x++) {
      const o = (y * width + x) * 4
      data[o] = 255
      data[o + 1] = 255
      data[o + 2] = 255
      data[o + 3] = 255
    }
  }
  return new ImageData(data, width, height)
}

const base: MotionBlurOptions = { velocityX: 0, velocityY: 0, kernelSize: 15, offset: 0 }

describe("applyMotionBlur", () => {
  it("is a passthrough when velocity is zero (matches Pixi's kernelSize=0 rule)", () => {
    const src = verticalEdge(32, 16)
    const out = applyMotionBlur(src, { ...base, velocityX: 0, velocityY: 0 })
    expect(Array.from(out.data)).toEqual(Array.from(src.data))
  })

  it("does not mutate the input", () => {
    const src = verticalEdge(32, 16)
    const before = Array.from(src.data)
    applyMotionBlur(src, { ...base, velocityX: 30, velocityY: 0 })
    expect(Array.from(src.data)).toEqual(before)
  })

  it("leaves a constant image unchanged (averaging is normalized)", () => {
    const src = solid(24, 24, [90, 140, 200, 255])
    const out = applyMotionBlur(src, { ...base, velocityX: 40, velocityY: 40 })
    // Interior pixels (away from clamped edges) must keep the constant colour.
    const o = (12 * 24 + 12) * 4
    expect(out.data[o]).toBeCloseTo(90, 0)
    expect(out.data[o + 1]).toBeCloseTo(140, 0)
    expect(out.data[o + 2]).toBeCloseTo(200, 0)
    expect(out.data[o + 3]).toBe(255)
  })

  it("spreads a vertical edge horizontally under horizontal velocity", () => {
    const w = 40
    const h = 8
    const src = verticalEdge(w, h)
    const out = applyMotionBlur(src, { ...base, velocityX: 60, velocityY: 0, kernelSize: 21 })

    // The hard edge at the centre becomes a gradient: pixels just left of centre
    // are pulled up from 0, pixels just right are pulled down from 255.
    const at = (x: number) => out.data[(4 * w + x) * 4]
    const left = at(w / 2 - 3)
    const right = at(w / 2 + 3)
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThan(255)
    expect(right).toBeGreaterThan(0)
    expect(right).toBeLessThan(255)
  })

  it("does NOT spread vertically under purely horizontal velocity", () => {
    const w = 40
    const h = 8
    const src = verticalEdge(w, h)
    const out = applyMotionBlur(src, { ...base, velocityX: 60, velocityY: 0, kernelSize: 21 })

    // Two rows sampled at the same x must be identical: the blur is directional.
    const x = w / 2 + 2
    const row2 = out.data[(2 * w + x) * 4]
    const row5 = out.data[(5 * w + x) * 4]
    expect(row2).toBe(row5)
  })

  it("feathers the smear into the transparent margin (premultiplied, no dark fringe)", () => {
    const w = 80
    const h = 40
    const margin = 15 // transparent margin around the opaque block
    const src = opaqueBlockOnTransparent(w, h, margin)
    const out = applyMotionBlur(src, { ...base, velocityX: 50, velocityY: 0, kernelSize: 21 })

    const midY = Math.floor(h / 2)
    // Just outside the block's left edge, inside the margin: now partially covered.
    const o = (midY * w + (margin - 4)) * 4
    expect(out.data[o + 3]).toBeGreaterThan(0) // smear reached into the margin
    expect(out.data[o + 3]).toBeLessThan(255)
    // Premultiplied averaging keeps the colour white (R≈G≈B), not a darkened fringe.
    if (out.data[o + 3] > 10) {
      expect(out.data[o]).toBeGreaterThan(230)
      expect(Math.abs(out.data[o] - out.data[o + 1])).toBeLessThanOrEqual(2)
      expect(Math.abs(out.data[o] - out.data[o + 2])).toBeLessThanOrEqual(2)
    }
  })
})
