import { describe, expect, it } from "vitest"

import {
  displayPointToArtboard,
  type CursorVideoGeometry,
} from "@/components/editor/canvas/cursor-scene"

const geom = (over: Partial<CursorVideoGeometry> = {}): CursorVideoGeometry => ({
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  rotation: 0,
  intrinsicWidth: 1920,
  intrinsicHeight: 1080,
  ...over,
})

describe("displayPointToArtboard", () => {
  it("maps linearly when the video fills the artboard 1:1", () => {
    const p = displayPointToArtboard(960, 540, geom(), 1920, 1080)
    expect(p.x).toBeCloseTo(960, 6)
    expect(p.y).toBeCloseTo(540, 6)
    expect(p.onScreen).toBe(true)
    // → focus (÷ artboard) is the click's normalized position.
    expect(p.x / 1920).toBeCloseTo(0.5, 6)
    expect(p.y / 1080).toBeCloseTo(0.5, 6)
  })

  it("accounts for a video inset inside a padded artboard", () => {
    // 800×600 video placed at (100,100); a display-center click lands at the
    // video's center in artboard space (focus 0.5,0.5 against a 1000×800 board).
    const video = geom({
      x: 100,
      y: 100,
      width: 800,
      height: 600,
      intrinsicWidth: 800,
      intrinsicHeight: 600,
    })
    const p = displayPointToArtboard(400, 300, video, 800, 600)
    expect(p.x).toBeCloseTo(500, 6)
    expect(p.y).toBeCloseTo(400, 6)
    expect(p.x / 1000).toBeCloseTo(0.5, 6)
    expect(p.y / 800).toBeCloseTo(0.5, 6)
  })

  it("applies the object-fit:cover crop (square source into a wide frame)", () => {
    // Square 1000×1000 source shown in an 800×400 frame → vertical crop of 250
    // px top & bottom. The display center maps to the frame center.
    const video = geom({
      width: 800,
      height: 400,
      intrinsicWidth: 1000,
      intrinsicHeight: 1000,
    })
    const center = displayPointToArtboard(500, 500, video, 1000, 1000)
    expect(center.x).toBeCloseTo(400, 6)
    expect(center.y).toBeCloseTo(200, 6)
    expect(center.onScreen).toBe(true)

    // A point near the display top is cropped away → off-screen.
    const top = displayPointToArtboard(500, 100, video, 1000, 1000)
    expect(top.onScreen).toBe(false)
  })

  it("flags points outside the video rect as off-screen", () => {
    const p = displayPointToArtboard(-50, 540, geom(), 1920, 1080)
    expect(p.onScreen).toBe(false)
  })
})
