import { describe, expect, it } from "vitest"

import {
  sampleCursorAtTime,
  type SmoothedCursorTrack,
} from "@/lib/cursors/cursor-track"
import { resolveCursorAsset } from "@/lib/cursors/cursor-set"

import {
  buildCursorTrack,
  computeCursorBlur,
  CURSOR_MOTION_ROTATION_SIDE_LEAN_MAX_DEG,
  placeCursor,
  type CursorVideoGeometry,
} from "../cursor-scene"

// A synthetic track + 1:1 video geometry so artboard coords equal sample coords
// (display points map straight through with no cover-crop and unit scale). This
// isolates the velocity → motion-blur derivation from the placement math.
function track(
  xs: number[],
  ys: number[],
  dtMs = 100,
  clicks: SmoothedCursorTrack["clicks"] = [],
  cursorId = "pointer"
): SmoothedCursorTrack {
  const n = xs.length
  return {
    t: Float64Array.from(xs.map((_, i) => i * dtMs)),
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    cursorIds: Array.from({ length: n }, () => cursorId),
    clicks,
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
    const blur = computeCursorBlur(movingRight, geometry(), 0.1, {
      intensity: 0,
      motionRotation: 0,
    })
    expect(blur).toBeNull()
  })

  it("returns null when the cursor is still", () => {
    const still = track([100, 100, 100], [50, 50, 50])
    expect(
      computeCursorBlur(still, geometry(), 0.1, {
        intensity: 1,
        motionRotation: 0,
      })
    ).toBeNull()
  })

  it("blurs along the direction of travel", () => {
    const blur = computeCursorBlur(movingRight, geometry(), 0.1, {
      intensity: 1,
      motionRotation: 0,
    })
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
    const full = computeCursorBlur(movingRight, geometry(), 0.1, {
      intensity: 1,
      motionRotation: 0,
    })!
    const half = computeCursorBlur(movingRight, geometry(), 0.1, {
      intensity: 0.5,
      motionRotation: 0,
    })!
    expect(half.velocityX).toBeCloseTo(full.velocityX / 2, 4)
  })

  it("caps the smear length for very fast moves", () => {
    const fast = track([0, 2000, 4000], [50, 50, 50]) // 20000 px/s
    const blur = computeCursorBlur(fast, geometry(), 0.1, {
      intensity: 1,
      motionRotation: 0,
    })!
    expect(Math.hypot(blur.velocityX, blur.velocityY)).toBeLessThanOrEqual(200)
  })

  it("is rotation-invariant in the cursor's local frame", () => {
    // A screen-horizontal move must blur horizontally in local space whether or
    // not the video is rotated (the filter runs pre-rotation).
    const flat = computeCursorBlur(movingRight, geometry(0), 0.1, {
      intensity: 1,
      motionRotation: 0,
    })!
    const rot = computeCursorBlur(movingRight, geometry(90), 0.1, {
      intensity: 1,
      motionRotation: 0,
    })!
    expect(rot.velocityX).toBeCloseTo(flat.velocityX, 4)
    expect(Math.abs(rot.velocityY)).toBeLessThan(1e-6)
  })

  it("uses the final cursor placement rotation for local blur direction", () => {
    const flat = computeCursorBlur(movingRight, geometry(), 0.1, {
      intensity: 1,
      motionRotation: 0,
    })!
    const tilted = computeCursorBlur(movingRight, geometry(), 0.1, {
      intensity: 1,
      motionRotation: 1,
    })!

    expect(tilted.velocityX).toBeLessThan(flat.velocityX)
    expect(tilted.velocityY).toBeLessThan(-1)
  })
})

describe("placeCursor motion rotation", () => {
  it("keeps a still cursor upright", () => {
    const still = track([100, 100, 100], [50, 50, 50])
    const placement = placeCursor(still, geometry(), 0.1, {
      motionRotation: 1,
    })!

    expect(placement.motionRotationDeg).toBe(0)
    expect(placement.rotation).toBe(0)
  })

  it("tilts clockwise for rightward motion", () => {
    const placement = placeCursor(movingRight, geometry(), 0.1, {
      motionRotation: 1,
    })!

    expect(placement.motionRotationDeg).toBeGreaterThan(0)
    expect(placement.rotation).toBeCloseTo(CURSOR_MOTION_ROTATION_SIDE_LEAN_MAX_DEG, 4)
  })

  it("tilts counter-clockwise for leftward motion", () => {
    const movingLeft = track([200, 100, 0], [50, 50, 50])
    const placement = placeCursor(movingLeft, geometry(), 0.1, {
      motionRotation: 1,
    })!

    expect(placement.motionRotationDeg).toBeLessThan(0)
    expect(placement.rotation).toBeCloseTo(-CURSOR_MOTION_ROTATION_SIDE_LEAN_MAX_DEG, 4)
  })

  it("does not tilt for vertical-only motion", () => {
    const movingDown = track([100, 100, 100], [0, 50, 100])
    const placement = placeCursor(movingDown, geometry(), 0.1, {
      motionRotation: 1,
    })!

    expect(placement.motionRotationDeg).toBeCloseTo(0, 6)
  })

  it("uses the cursor smoothing preset to soften rotation changes", () => {
    const turning = track([0, 100, 100, 100, 100], [50, 50, 150, 250, 350], 100)
    const rapidBefore = placeCursor(turning, geometry(), 0.1, {
      motionRotation: 1,
      smoothingMode: "rapid",
    })!.motionRotationDeg
    const rapidAfter = placeCursor(turning, geometry(), 0.16, {
      motionRotation: 1,
      smoothingMode: "rapid",
    })!.motionRotationDeg
    const slowBefore = placeCursor(turning, geometry(), 0.1, {
      motionRotation: 1,
      smoothingMode: "slow",
    })!.motionRotationDeg
    const slowAfter = placeCursor(turning, geometry(), 0.16, {
      motionRotation: 1,
      smoothingMode: "slow",
    })!.motionRotationDeg

    expect(Math.abs(slowAfter - slowBefore)).toBeLessThan(
      Math.abs(rapidAfter - rapidBefore)
    )
  })

  it("can be disabled with a zero amount", () => {
    const placement = placeCursor(movingRight, geometry(), 0.1, {
      motionRotation: 0,
    })!

    expect(placement.motionRotationDeg).toBe(0)
    expect(placement.rotation).toBe(0)
  })

  it("keeps hotspot placement unchanged when only the tilt changes", () => {
    const flat = placeCursor(movingRight, geometry(), 0.1, {
      motionRotation: 0,
    })!
    const tilted = placeCursor(movingRight, geometry(), 0.1, {
      motionRotation: 1,
    })!

    expect(tilted.rotation).not.toBe(flat.rotation)
    expect(tilted.x).toBeCloseTo(flat.x, 6)
    expect(tilted.y).toBeCloseTo(flat.y, 6)
    expect(tilted.offsetX).toBeCloseTo(flat.offsetX, 6)
    expect(tilted.offsetY).toBeCloseTo(flat.offsetY, 6)
  })

  it("clamps tilt by max angle and slider amount", () => {
    const fast = track([0, 10_000, 20_000], [50, 50, 50])
    const placement = placeCursor(fast, geometry(), 0.1, {
      motionRotation: 0.5,
    })!

    expect(placement.motionRotationDeg).toBeCloseTo(
      CURSOR_MOTION_ROTATION_SIDE_LEAN_MAX_DEG * 0.5,
      4
    )
  })
})

describe("buildCursorTrack smoothing modes", () => {
  const data = {
    processTimeStartMs: 0,
    displayWidth: 200,
    displayHeight: 100,
    moves: [
      { processTimeMs: 0, x: 0, y: 50, cursorId: "pointer" },
      { processTimeMs: 100, x: 100, y: 50, cursorId: "pointer" },
      { processTimeMs: 200, x: 0, y: 50, cursorId: "pointer" },
    ],
    clicks: [],
  }

  it("keeps Rapid smoothed while Slow smooths more heavily", () => {
    const rapid = buildCursorTrack(data, { smoothingMode: "rapid" })!
    const slow = buildCursorTrack(data, { smoothingMode: "slow" })!

    const rapidPeak = sampleCursorAtTime(rapid, 100)!.x
    const slowPeak = sampleCursorAtTime(slow, 100)!.x

    expect(rapidPeak).toBeLessThan(100)
    expect(rapidPeak).toBeGreaterThan(slowPeak)
  })
})

describe("cursor click scale", () => {
  it("builds click press events from mouseclick sidecar samples", () => {
    const fromSidecar = buildCursorTrack(
      {
        processTimeStartMs: 1000,
        displayWidth: 200,
        displayHeight: 100,
        moves: [
          { processTimeMs: 1000, x: 100, y: 50, cursorId: "pointer" },
          { processTimeMs: 1400, x: 100, y: 50, cursorId: "pointer" },
        ],
        clicks: [
          {
            processTimeMs: 1060,
            x: 100,
            y: 50,
            cursorId: "pointer",
            type: "mouseDown",
            button: "left",
          },
          {
            processTimeMs: 1160,
            x: 100,
            y: 50,
            cursorId: "pointer",
            type: "mouseUp",
            button: "left",
          },
        ],
      },
      { smoothingMode: "rapid" }
    )!

    expect(fromSidecar.clicks).toEqual([
      { t: 60, type: "down" },
      { t: 160, type: "up" },
    ])
    expect(placeCursor(fromSidecar, geometry(), 0.09)!.clickScale).toBeLessThan(
      1
    )
  })

  const clicked = track(
    [100, 100, 100, 100, 100, 100],
    [50, 50, 50, 50, 50, 50],
    100,
    [
      { t: 100, type: "down" },
      { t: 150, type: "up" },
    ]
  )

  it("eases into press and rebounds after release", () => {
    expect(placeCursor(clicked, geometry(), 0.05)!.clickScale).toBe(1)
    expect(placeCursor(clicked, geometry(), 0.12)!.clickScale).toBeLessThan(1)
    expect(placeCursor(clicked, geometry(), 0.26)!.clickScale).toBeGreaterThan(
      1
    )
    expect(placeCursor(clicked, geometry(), 0.4)!.clickScale).toBeCloseTo(1, 4)
  })

  it("keeps the hotspot position pinned while scaling", () => {
    const before = placeCursor(clicked, geometry(), 0.05)!
    const pressed = placeCursor(clicked, geometry(), 0.12)!

    expect(pressed.width).toBeLessThan(before.width)
    expect(pressed.x).toBeCloseTo(before.x, 6)
    expect(pressed.y).toBeCloseTo(before.y, 6)
  })

  it("uses the configured pressed scale and lets 100% disable shrink", () => {
    const held = track([100, 100, 100, 100, 100], [50, 50, 50, 50, 50], 100, [
      { t: 100, type: "down" },
    ])

    expect(
      placeCursor(held, geometry(), 0.3, { clickPressScale: 0.7 })!.clickScale
    ).toBeCloseTo(0.7, 4)
    expect(
      placeCursor(held, geometry(), 0.3, { clickPressScale: 1 })!.clickScale
    ).toBe(1)
  })

  it("presses in faster on rapid than on slow smoothing", () => {
    const held = track([100, 100, 100, 100, 100], [50, 50, 50, 50, 50], 100, [
      { t: 100, type: "down" },
    ])
    // 50 ms after the down: rapid (45 ms press) has reached the target while
    // slow (95 ms press) is still easing in, so rapid is shrunk further.
    const rapid = placeCursor(held, geometry(), 0.15, {
      smoothingMode: "rapid",
    })!.clickScale
    const slow = placeCursor(held, geometry(), 0.15, {
      smoothingMode: "slow",
    })!.clickScale
    expect(rapid).toBeLessThan(slow)
  })

  it("releases sooner on rapid than on slow smoothing", () => {
    // `clicked` releases at 150 ms; 200 ms later rapid (150 ms release) has
    // fully settled back to 1 while slow (300 ms release) is still rebounding.
    const rapid = placeCursor(clicked, geometry(), 0.35, {
      smoothingMode: "rapid",
    })!.clickScale
    const slow = placeCursor(clicked, geometry(), 0.35, {
      smoothingMode: "slow",
    })!.clickScale
    expect(rapid).toBe(1)
    expect(slow).not.toBe(1)
  })
})

describe("placeCursor pointer override", () => {
  it("can force non-pointer cursor shapes to render as the themed pointer", () => {
    const textCursor = track([100, 100], [50, 50], 100, [], "iBeam")

    const normal = placeCursor(textCursor, geometry(), 0)!
    const forced = placeCursor(textCursor, geometry(), 0, {
      alwaysUsePointer: true,
    })!

    expect(normal.url).toContain("ibeamstroke")
    expect(forced.url).toContain("pointer")
    expect(forced.x).toBeCloseTo(normal.x, 6)
    expect(forced.y).toBeCloseTo(normal.y, 6)
  })

  it("uses the selected cursor set's pointer asset", () => {
    const textCursor = track([100, 100], [50, 50], 100, [], "iBeam")

    const macos = placeCursor(textCursor, geometry(), 0, {
      alwaysUsePointer: true,
      cursorSet: "macos",
    })!
    const forced = placeCursor(textCursor, geometry(), 0, {
      alwaysUsePointer: true,
      cursorSet: "custom-2",
    })!
    const asset = resolveCursorAsset("pointer", "custom-2", "macos")!

    expect(forced.url).toContain("/assets/cursors/sets/custom-2/pointer")
    expect(asset.opticalScale).toBeLessThan(1)
    expect(forced.height).toBeCloseTo(macos.height * asset.opticalScale, 4)
    expect(forced.x).toBeCloseTo(macos.x, 6)
    expect(forced.y).toBeCloseTo(macos.y, 6)
  })
})

describe("placeCursor cursor set", () => {
  it("resolves cursor assets from the selected set", () => {
    const placement = placeCursor(movingRight, geometry(), 0.1, {
      cursorSet: "halloween",
    })!

    expect(placement.url).toContain("/assets/cursors/sets/halloween/pointer")
  })

  it("normalizes selected styles to the macOS optical size", () => {
    const macos = placeCursor(movingRight, geometry(), 0.1, {
      cursorSet: "macos",
    })!
    const custom = placeCursor(movingRight, geometry(), 0.1, {
      cursorSet: "custom-1",
    })!
    const asset = resolveCursorAsset("pointer", "custom-1", "macos")!

    expect(asset.opticalScale).toBeLessThan(1)
    expect(custom.height).toBeCloseTo(macos.height * asset.opticalScale, 4)
    expect(custom.x).toBeCloseTo(macos.x, 6)
    expect(custom.y).toBeCloseTo(macos.y, 6)
    expect(custom.offsetX).toBeCloseTo(asset.hotspot[0] * custom.width, 6)
    expect(custom.offsetY).toBeCloseTo(asset.hotspot[1] * custom.height, 6)
  })
})

describe("placeCursor size", () => {
  const referenceSize = { width: 200, height: 100 }

  it("keeps render size independent from screen video resize", () => {
    const full = placeCursor(movingRight, geometry(), 0.1, { referenceSize })!
    const resized = placeCursor(
      movingRight,
      { ...geometry(), width: 100, height: 50 },
      0.1,
      { referenceSize }
    )!

    expect(resized.width).toBeCloseTo(full.width, 6)
    expect(resized.height).toBeCloseTo(full.height, 6)
    // Position still follows the resized video's content box.
    expect(resized.x).toBeCloseTo(full.x / 2, 6)
    expect(resized.y).toBeCloseTo(full.y / 2, 6)
  })

  it("preserves the fitted-video baseline size for the same cursor setting", () => {
    const placement = placeCursor(movingRight, geometry(), 0.1, {
      sizeMultiplier: 2.7,
      referenceSize,
    })!

    expect(placement.height).toBeCloseTo(52 * 2.7, 6)
  })
})
