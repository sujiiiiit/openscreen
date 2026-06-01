import { describe, expect, it } from "vitest"

import {
  IDENTITY_ZOOM_CAMERA,
  clampZoomFocusForScale,
  getZoomVisibleWindow,
  sampleZoomCameraAtTime,
} from "../zoom-scene"
import { withZoomClipDefaults } from "@/lib/zoom-clips"

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
    expect(getZoomVisibleWindow({ x: 0.5, y: 0.5 }, 2, artboard)).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    })
  })

  it("uses the clip as the full normal-to-zoom-to-normal effect", () => {
    const clip = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      focus: { x: 0.5, y: 0.5 },
      scale: 2,
      radialBlur: 0.35,
    })
    const easeMid = sampleZoomCameraAtTime([clip], artboard, 0.48)
    expect(easeMid.scale).toBeCloseTo(1.5, 2)
    expect(easeMid.radialBlur).toBeGreaterThan(0.34)

    const hold = sampleZoomCameraAtTime([clip], artboard, 2)
    expect(hold.scale).toBeCloseTo(2)
    expect(hold.radialBlur).toBe(0)

    const endMid = sampleZoomCameraAtTime([clip], artboard, 3.44)
    expect(endMid.scale).toBeCloseTo(1.5, 1)
    expect(endMid.radialBlur).toBeGreaterThan(0)
  })

  it("uses explicit transition settings and carries blur shader settings", () => {
    const clip = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      scale: 2,
      transition: { easeIn: 0.5, easeOut: 0.25, curve: "linear" },
      radialBlurSettings: {
        strength: 1.4,
        falloff: 0.5,
        centerSize: 0.2,
        centerSharpness: 0.6,
      },
    })

    const camera = sampleZoomCameraAtTime([clip], artboard, 1)
    expect(camera.scale).toBeCloseTo(1.5)
    expect(camera.radialBlurSettings).toEqual({
      strength: 1.4,
      falloff: 0.5,
      centerSize: 0.2,
      centerSharpness: 0.6,
    })
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
