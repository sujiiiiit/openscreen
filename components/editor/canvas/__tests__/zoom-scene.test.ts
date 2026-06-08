import { describe, expect, it } from "vitest"

import {
  IDENTITY_ZOOM_CAMERA,
  clampZoomFocusForScale,
  getZoomCameraCenterForTarget,
  getZoomVisibleWindow,
  sampleZoomCameraAtTime,
} from "../zoom-scene"
import { ZOOM_RADIAL_BLUR_SHADER, withZoomClipDefaults } from "@/lib/zoom-clips"

const artboard = { width: 1000, height: 500 }

describe("manual zoom camera", () => {
  it("returns identity outside zoom clips", () => {
    const clip = withZoomClipDefaults({ id: "z", start: 1, end: 5 })
    expect(sampleZoomCameraAtTime([clip], artboard, 0.5)).toEqual(
      IDENTITY_ZOOM_CAMERA
    )
    expect(sampleZoomCameraAtTime([clip], artboard, 5)).toEqual(
      IDENTITY_ZOOM_CAMERA
    )
  })

  it("clamps focus so the visible window stays inside the artboard", () => {
    expect(clampZoomFocusForScale({ x: 0, y: 1 }, 2, artboard)).toEqual({
      x: 0.25,
      y: 0.75,
    })
    expect(getZoomCameraCenterForTarget({ x: 1, y: 0 }, 2, artboard)).toEqual({
      x: 0.75,
      y: 0.25,
    })
    expect(getZoomVisibleWindow({ x: 0.5, y: 0.5 }, 2, artboard)).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    })
    expect(getZoomVisibleWindow({ x: 1, y: 0 }, 2, artboard)).toEqual({
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 0.5,
    })
  })

  it("lets the stored target sit on an edge while clamping the camera window", () => {
    const clip = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      focus: { x: 1, y: 0 },
      scale: 2,
    })

    const camera = sampleZoomCameraAtTime([clip], artboard, 2)
    expect(camera.scale).toBeCloseTo(2)
    expect(camera.offsetX).toBeCloseTo(-1000)
    expect(camera.offsetY).toBeCloseTo(0)
    expect(camera.radialBlurCenterX).toBeCloseTo(1)
    expect(camera.radialBlurCenterY).toBeCloseTo(0)
  })

  it("uses the rendered target point as the radial blur origin", () => {
    const clip = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      focus: { x: 0, y: 1 },
      scale: 2,
      radialBlur: 1,
    })

    const camera = sampleZoomCameraAtTime([clip], artboard, 0.3)
    expect(camera.radialBlur).toBeGreaterThan(0)
    expect(camera.radialBlurCenterX).toBeCloseTo(0)
    expect(camera.radialBlurCenterY).toBeCloseTo(1)
  })

  it("keeps a near-edge focus fixed while the zoom scales", () => {
    const clip = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      focus: { x: 0.12, y: 0.82 },
      scale: 2,
      radialBlur: 1,
    })

    const camera = sampleZoomCameraAtTime([clip], artboard, 0.3)
    const renderedX = camera.offsetX + camera.scale * 0.12 * artboard.width
    const renderedY = camera.offsetY + camera.scale * 0.82 * artboard.height

    expect(camera.radialBlur).toBeGreaterThan(0)
    expect(renderedX).toBeCloseTo(0.12 * artboard.width)
    expect(renderedY).toBeCloseTo(0.82 * artboard.height)
    expect(camera.radialBlurCenterX).toBeCloseTo(0.12)
    expect(camera.radialBlurCenterY).toBeCloseTo(0.82)
    const visibleWindow = getZoomVisibleWindow(
      { x: 0.12, y: 0.82 },
      2,
      artboard
    )
    expect(visibleWindow.x).toBeCloseTo(0.06)
    expect(visibleWindow.y).toBeCloseTo(0.41)
    expect(visibleWindow.width).toBeCloseTo(0.5)
    expect(visibleWindow.height).toBeCloseTo(0.5)
  })

  it("eases identity -> zoom -> hold -> identity with velocity-shaped blur", () => {
    const clip = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      focus: { x: 0.5, y: 0.5 },
      scale: 2,
      radialBlur: 0.5,
    })

    // Held middle: fully zoomed but not moving -> no zoom blur.
    const hold = sampleZoomCameraAtTime([clip], artboard, 2)
    expect(hold.scale).toBeCloseTo(2)
    expect(hold.radialBlur).toBe(0)

    // Mid ease-in and mid ease-out: partially zoomed and moving -> blur present.
    const easeInMid = sampleZoomCameraAtTime([clip], artboard, 0.3)
    expect(easeInMid.scale).toBeGreaterThan(1)
    expect(easeInMid.scale).toBeLessThan(2)
    expect(easeInMid.radialBlur).toBeGreaterThan(0)

    const easeOutMid = sampleZoomCameraAtTime([clip], artboard, 3.7)
    expect(easeOutMid.scale).toBeGreaterThan(1)
    expect(easeOutMid.scale).toBeLessThan(2)
    expect(easeOutMid.radialBlur).toBeGreaterThan(0)
  })

  it("uses the baked inner radius while ignoring legacy clip settings", () => {
    const clip = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      scale: 2,
      radialBlurSettings: {
        strength: 1.4,
        falloff: 0.5,
        centerSize: 0.2,
        centerSharpness: 0.6,
      },
    })

    const camera = sampleZoomCameraAtTime([clip], artboard, 0.3)
    expect(camera.radialBlur).toBeGreaterThan(0)
    expect(camera.radialBlurSettings).toEqual({
      ...ZOOM_RADIAL_BLUR_SHADER,
    })
  })

  it("blurs more for a snappier (shorter) ease", () => {
    const snappy = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      scale: 2,
      radialBlur: 1,
      transition: { durationMs: 300, curve: "smootherstep" },
    })
    const slow = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      scale: 2,
      radialBlur: 1,
      transition: { durationMs: 1000, curve: "smootherstep" },
    })

    // Sample each at the midpoint of its ease-in ramp (peak velocity).
    const snappyPeak = sampleZoomCameraAtTime([snappy], artboard, 0.15)
    const slowPeak = sampleZoomCameraAtTime([slow], artboard, 0.5)
    expect(snappyPeak.radialBlur).toBeGreaterThan(slowPeak.radialBlur)
  })

  it("uses transition duration to complete the zoom ramp in milliseconds", () => {
    const long = withZoomClipDefaults({
      id: "long",
      start: 0,
      end: 4,
      scale: 2,
      radialBlur: 1,
      transition: {
        durationMs: 1000,
        curve: "smootherstep",
      },
    })
    const short = withZoomClipDefaults({
      id: "short",
      start: 0,
      end: 4,
      scale: 2,
      radialBlur: 1,
      transition: {
        durationMs: 300,
        curve: "smootherstep",
      },
    })

    const longMidRamp = sampleZoomCameraAtTime([long], artboard, 0.5)
    const shortSameTime = sampleZoomCameraAtTime([short], artboard, 0.5)
    const shortPeak = sampleZoomCameraAtTime([short], artboard, 0.15)

    expect(longMidRamp.scale).toBeGreaterThan(1)
    expect(longMidRamp.scale).toBeLessThan(2)
    expect(shortSameTime.scale).toBeCloseTo(2)
    expect(shortPeak.radialBlur).toBeGreaterThan(longMidRamp.radialBlur)
  })

  it("blurs more when a larger scale has to complete in the same duration", () => {
    const twoX = withZoomClipDefaults({
      id: "two",
      start: 0,
      end: 4,
      scale: 2,
      radialBlur: 1,
      transition: { durationMs: 600, curve: "smootherstep" },
    })
    const fourX = withZoomClipDefaults({
      id: "four",
      start: 0,
      end: 4,
      scale: 4,
      radialBlur: 1,
      transition: { durationMs: 600, curve: "smootherstep" },
    })

    const twoXPeak = sampleZoomCameraAtTime([twoX], artboard, 0.3)
    const fourXPeak = sampleZoomCameraAtTime([fourX], artboard, 0.3)

    expect(fourXPeak.scale).toBeGreaterThan(twoXPeak.scale)
    expect(fourXPeak.radialBlur).toBeGreaterThan(twoXPeak.radialBlur)
  })

  it("ignores disabled clips", () => {
    const clip = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      enabled: false,
    })
    expect(sampleZoomCameraAtTime([clip], artboard, 2)).toEqual(
      IDENTITY_ZOOM_CAMERA
    )
  })
})

describe("continuous zoom (welding adjacent clips)", () => {
  const A = withZoomClipDefaults({
    id: "a",
    start: 0,
    end: 4,
    scale: 2.5,
    focus: { x: 0.2, y: 0.2 },
  })
  const B = withZoomClipDefaults({
    id: "b",
    start: 4, // abutting A (gap 0)
    end: 8,
    scale: 1.7,
    focus: { x: 0.8, y: 0.8 },
  })

  it("transitions directly between the two settled zooms — never dropping to 1x", () => {
    // At the shared boundary the camera is mid-weld: scale sits between the two
    // targets (2.5 ↔ 1.7), NOT near 1, and the focus has panned halfway.
    const mid = sampleZoomCameraAtTime([A, B], artboard, 4)
    expect(mid.scale).toBeGreaterThan(1.7 - 1e-6)
    expect(mid.scale).toBeLessThan(2.5 + 1e-6)
    expect(mid.scale).toBeGreaterThan(1.5) // clearly NOT a return to 1x
    expect(mid.radialBlurCenterX).toBeCloseTo(0.5, 1) // focus panned A→B
  })

  it("never dips to identity anywhere across the welded boundary", () => {
    // Sample densely through A's ease-out, the boundary, and B's ease-in.
    for (let t = 3.3; t <= 4.7; t += 0.05) {
      const cam = sampleZoomCameraAtTime([A, B], artboard, t)
      expect(cam.scale).toBeGreaterThan(1.7 - 1e-6)
      expect(cam.scale).toBeLessThan(2.5 + 1e-6)
    }
  })

  it("still holds each clip's own settled zoom away from the boundary", () => {
    expect(sampleZoomCameraAtTime([A, B], artboard, 2).scale).toBeCloseTo(2.5)
    expect(sampleZoomCameraAtTime([A, B], artboard, 6).scale).toBeCloseTo(1.7)
  })

  it("does NOT weld across a real gap (keeps the wide beat)", () => {
    const far = withZoomClipDefaults({
      id: "b",
      start: 9, // 5 s gap after A — far beyond the weld threshold
      end: 13,
      scale: 1.7,
      focus: { x: 0.8, y: 0.8 },
    })
    // Mid-gap returns fully wide, exactly as before.
    expect(sampleZoomCameraAtTime([A, far], artboard, 6.5)).toEqual(
      IDENTITY_ZOOM_CAMERA
    )
  })
})

describe("cursor follow (cursor never leaves the zoom window)", () => {
  const clip = withZoomClipDefaults({
    id: "z",
    start: 0,
    end: 6,
    scale: 2,
    focus: { x: 0.5, y: 0.5 },
  })
  // The visible normalized window for a given (effective focus, scale).
  const cursorInWindow = (focusN: number, scale: number, c: number) => {
    const left = focusN * (1 - 1 / scale)
    return c >= left - 1e-9 && c <= left + 1 / scale + 1e-9
  }

  it("does not move the camera while the cursor stays in the dead zone", () => {
    const base = sampleZoomCameraAtTime([clip], artboard, 3)
    const followed = sampleZoomCameraAtTime([clip], artboard, 3, {
      x: 0.5,
      y: 0.5,
    })
    expect(followed.radialBlurCenterX).toBeCloseTo(base.radialBlurCenterX)
    expect(followed.offsetX).toBeCloseTo(base.offsetX)
    expect(followed.offsetY).toBeCloseTo(base.offsetY)
  })

  it("pans to bring a cursor that would be off-window back inside it", () => {
    const noFollow = sampleZoomCameraAtTime([clip], artboard, 3) // window [0.25,0.75]
    // At the clip's fixed focus the cursor at 0.95 would be off-window…
    expect(cursorInWindow(noFollow.radialBlurCenterX, noFollow.scale, 0.95)).toBe(
      false
    )
    const cam = sampleZoomCameraAtTime([clip], artboard, 3, { x: 0.95, y: 0.5 })
    // …so the camera pans right and the cursor is now inside the window.
    expect(cam.radialBlurCenterX).toBeGreaterThan(noFollow.radialBlurCenterX)
    expect(cursorInWindow(cam.radialBlurCenterX, cam.scale, 0.95)).toBe(true)
  })

  it("keeps the cursor in-bounds across a sweep to the corner", () => {
    for (let c = 0.5; c <= 1.0001; c += 0.05) {
      const cam = sampleZoomCameraAtTime([clip], artboard, 3, { x: c, y: c })
      expect(cursorInWindow(cam.radialBlurCenterX, cam.scale, c)).toBe(true)
      expect(cursorInWindow(cam.radialBlurCenterY, cam.scale, c)).toBe(true)
    }
  })

  it("ignores the cursor on identity frames (not zoomed)", () => {
    expect(
      sampleZoomCameraAtTime([clip], artboard, 10, { x: 0.95, y: 0.95 })
    ).toEqual(IDENTITY_ZOOM_CAMERA)
  })
})
