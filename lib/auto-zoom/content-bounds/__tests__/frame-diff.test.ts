import { describe, expect, it } from "vitest"

import { detectChangedRect, type FrameLuma } from "../frame-diff"

const W = 120
const H = 120

function blank(fill = 0): FrameLuma {
  const data = new Uint8ClampedArray(W * H)
  data.fill(fill)
  return { data, width: W, height: H }
}

function withRect(
  base: FrameLuma,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  value: number
): FrameLuma {
  const data = new Uint8ClampedArray(base.data)
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      data[y * W + x] = value
    }
  }
  return { data, width: W, height: H }
}

describe("detectChangedRect", () => {
  it("finds the bounding box of an appeared rectangle", () => {
    const before = blank(0)
    // A solid rect appears at x∈[48,84), y∈[36,96) → normalized ~[0.4,0.7)×[0.3,0.8).
    const after = withRect(before, 48, 36, 36, 60, 255)
    const rect = detectChangedRect(before, after)
    expect(rect).not.toBeNull()
    expect(rect!.x).toBeCloseTo(0.4, 1)
    expect(rect!.y).toBeCloseTo(0.3, 1)
    expect(rect!.x + rect!.width).toBeCloseTo(0.7, 1)
    expect(rect!.y + rect!.height).toBeCloseTo(0.8, 1)
  })

  it("returns null when nothing changed", () => {
    const a = withRect(blank(20), 10, 10, 30, 30, 200)
    expect(detectChangedRect(a, a)).toBeNull()
  })

  it("returns null for a full-frame change (scroll / page nav)", () => {
    expect(detectChangedRect(blank(0), blank(255))).toBeNull()
  })

  it("rejects scattered noise as a false popover (box-density guard)", () => {
    const before = blank(0)
    const data = new Uint8ClampedArray(before.data)
    // ~40 isolated bright pixels spread across the whole frame: scattered cells,
    // a huge-but-empty bounding box → must not be read as content.
    let seed = 7
    for (let n = 0; n < 40; n++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const x = seed % W
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const y = seed % H
      data[y * W + x] = 255
    }
    const after: FrameLuma = { data, width: W, height: H }
    expect(detectChangedRect(before, after)).toBeNull()
  })

  it("returns null on mismatched or empty frames", () => {
    expect(
      detectChangedRect(blank(0), { data: new Uint8ClampedArray(4), width: 2, height: 2 })
    ).toBeNull()
    expect(
      detectChangedRect(
        { data: new Uint8ClampedArray(0), width: 0, height: 0 },
        { data: new Uint8ClampedArray(0), width: 0, height: 0 }
      )
    ).toBeNull()
  })
})
