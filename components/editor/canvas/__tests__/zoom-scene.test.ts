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

    const camera = sampleZoomCameraAtTime([clip], artboard, 0.6)
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

    const camera = sampleZoomCameraAtTime([clip], artboard, 0.6)
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

    // Held middle: fully zoomed but not moving -> no motion blur.
    const hold = sampleZoomCameraAtTime([clip], artboard, 2)
    expect(hold.scale).toBeCloseTo(2)
    expect(hold.radialBlur).toBe(0)

    // Mid ease-in and mid ease-out: partially zoomed and moving -> blur present.
    const easeInMid = sampleZoomCameraAtTime([clip], artboard, 0.6)
    expect(easeInMid.scale).toBeGreaterThan(1)
    expect(easeInMid.scale).toBeLessThan(2)
    expect(easeInMid.radialBlur).toBeGreaterThan(0)

    const easeOutMid = sampleZoomCameraAtTime([clip], artboard, 3.4)
    expect(easeOutMid.scale).toBeGreaterThan(1)
    expect(easeOutMid.scale).toBeLessThan(2)
    expect(easeOutMid.radialBlur).toBeGreaterThan(0)
  })

  it("uses the clip clear radius while keeping the rest of the shader look baked", () => {
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

    const camera = sampleZoomCameraAtTime([clip], artboard, 0.6)
    expect(camera.radialBlur).toBeGreaterThan(0)
    expect(camera.radialBlurSettings).toEqual({
      ...ZOOM_RADIAL_BLUR_SHADER,
      centerSize: 0.2,
    })
  })

  it("blurs more for a snappier (shorter) ease", () => {
    const snappy = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      scale: 2,
      radialBlur: 1,
      transition: { easeIn: 0.12, easeOut: 0.12, curve: "smootherstep" },
    })
    const slow = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      scale: 2,
      radialBlur: 1,
      transition: { easeIn: 0.5, easeOut: 0.5, curve: "smootherstep" },
    })

    // Sample each at the midpoint of its ease-in ramp (peak velocity).
    const snappyPeak = sampleZoomCameraAtTime([snappy], artboard, 0.24)
    const slowPeak = sampleZoomCameraAtTime([slow], artboard, 1)
    expect(snappyPeak.radialBlur).toBeGreaterThan(slowPeak.radialBlur)
  })

  it("uses transition speed to shorten the zoom ramp", () => {
    const normal = withZoomClipDefaults({
      id: "normal",
      start: 0,
      end: 4,
      scale: 2,
      radialBlur: 1,
      transition: {
        easeIn: 0.3,
        easeOut: 0.3,
        speed: 1,
        curve: "smootherstep",
      },
    })
    const faster = withZoomClipDefaults({
      id: "fast",
      start: 0,
      end: 4,
      scale: 2,
      radialBlur: 1,
      transition: {
        easeIn: 0.3,
        easeOut: 0.3,
        speed: 2,
        curve: "smootherstep",
      },
    })

    const normalMidRamp = sampleZoomCameraAtTime([normal], artboard, 0.6)
    const fasterSameTime = sampleZoomCameraAtTime([faster], artboard, 0.6)
    const fasterPeak = sampleZoomCameraAtTime([faster], artboard, 0.3)

    expect(normalMidRamp.scale).toBeGreaterThan(1)
    expect(normalMidRamp.scale).toBeLessThan(2)
    expect(fasterSameTime.scale).toBeCloseTo(2)
    expect(fasterPeak.radialBlur).toBeGreaterThan(normalMidRamp.radialBlur)
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
