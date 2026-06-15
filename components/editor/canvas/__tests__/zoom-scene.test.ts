import { describe, expect, it } from "vitest"

import {
  IDENTITY_ZOOM_CAMERA,
  clampZoomFocusForScale,
  computeZoomFollowPaths,
  getZoomCameraCenterForTarget,
  getZoomVisibleWindow,
  sampleZoomCameraAtTime,
} from "../zoom-scene"
import { ZOOM_RADIAL_BLUR_SHADER, withZoomClipDefaults } from "@/lib/zoom-clips"

const artboard = { width: 1000, height: 500 }

// The visible normalized window for a given stored focus + scale.
const cursorInWindow = (focusN: number, scale: number, c: number) => {
  const left = focusN * (1 - 1 / scale)
  return c >= left - 1e-9 && c <= left + 1 / scale + 1e-9
}

describe("zoom camera (fixed focus / no follow path)", () => {
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
      mode: "manual",
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
      mode: "manual",
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
      mode: "manual",
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
      mode: "manual",
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
      mode: "manual",
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
    expect(camera.radialBlurSettings).toEqual({ ...ZOOM_RADIAL_BLUR_SHADER })
  })

  it("blurs more for a snappier (shorter) ease", () => {
    const snappy = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      mode: "manual",
      scale: 2,
      radialBlur: 1,
      transition: { durationMs: 300 },
    })
    const slow = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      mode: "manual",
      scale: 2,
      radialBlur: 1,
      transition: { durationMs: 1000 },
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
      mode: "manual",
      scale: 2,
      radialBlur: 1,
      transition: { durationMs: 1000 },
    })
    const short = withZoomClipDefaults({
      id: "short",
      start: 0,
      end: 4,
      mode: "manual",
      scale: 2,
      radialBlur: 1,
      transition: { durationMs: 300 },
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
      mode: "manual",
      scale: 2,
      radialBlur: 1,
      transition: { durationMs: 600 },
    })
    const fourX = withZoomClipDefaults({
      id: "four",
      start: 0,
      end: 4,
      mode: "manual",
      scale: 4,
      radialBlur: 1,
      transition: { durationMs: 600 },
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

describe("spring zoom transition", () => {
  it("zoom-out early frames are smooth (no jump at the start of the ramp)", () => {
    // The leading smoothstep in `springEaseOutRamped` erases the spring's start
    // kink, so the very first frames of the zoom-out barely move (a hard cut /
    // un-guarded spring would step a large fraction of the scale in one frame).
    const c = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 4,
      mode: "manual",
      scale: 2,
      radialBlur: 0,
      transition: { durationMs: 600 },
    })
    // holdEnd = 4 - 0.6 = 3.4.
    const s0 = sampleZoomCameraAtTime([c], artboard, 3.4).scale // held boundary (2)
    const s1 = sampleZoomCameraAtTime([c], artboard, 3.4 + 1 / 120).scale
    const s2 = sampleZoomCameraAtTime([c], artboard, 3.4 + 2 / 120).scale
    expect(s0).toBeCloseTo(2)
    expect(Math.abs(s1 - s0)).toBeLessThan(0.01)
    expect(Math.abs(s2 - s1)).toBeLessThan(0.02)
  })
})

describe("continuous zoom (welding adjacent clips)", () => {
  const A = withZoomClipDefaults({
    id: "a",
    start: 0,
    end: 4,
    mode: "manual",
    scale: 2.5,
    focus: { x: 0.2, y: 0.2 },
  })
  const B = withZoomClipDefaults({
    id: "b",
    start: 4, // abutting A (gap 0)
    end: 8,
    mode: "manual",
    scale: 1.7,
    focus: { x: 0.8, y: 0.8 },
  })

  it("transitions directly between the two settled zooms — never dropping to 1x", () => {
    // At the shared boundary the camera is mid-weld: scale sits between the two
    // targets (2.5 ↔ 1.7), NOT near 1, and the focus has panned A→B.
    const mid = sampleZoomCameraAtTime([A, B], artboard, 4)
    expect(mid.scale).toBeGreaterThan(1.69)
    expect(mid.scale).toBeLessThan(2.51)
    expect(mid.scale).toBeGreaterThan(1.5) // clearly NOT a return to 1x
    // Focus has panned off A (0.2) toward B (0.8) — strictly between.
    expect(mid.radialBlurCenterX).toBeGreaterThan(0.2 + 1e-3)
    expect(mid.radialBlurCenterX).toBeLessThan(0.8)
  })

  it("never dips to identity anywhere across the welded boundary", () => {
    // Sample densely through A's ease-out, the boundary, and B's ease-in.
    for (let t = 3.3; t <= 4.7; t += 0.05) {
      const cam = sampleZoomCameraAtTime([A, B], artboard, t)
      expect(cam.scale).toBeGreaterThan(1.69)
      expect(cam.scale).toBeLessThan(2.51)
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
      mode: "manual",
      scale: 1.7,
      focus: { x: 0.8, y: 0.8 },
    })
    // Mid-gap returns fully wide.
    expect(sampleZoomCameraAtTime([A, far], artboard, 6.5)).toEqual(
      IDENTITY_ZOOM_CAMERA
    )
  })
})

describe("auto-mode cursor follow (spring)", () => {
  const clip = withZoomClipDefaults({
    id: "z",
    start: 0,
    end: 8,
    scale: 2,
    mode: "auto",
    focus: { x: 0.5, y: 0.5 },
  })

  it("produces a spring follow path with focus keyframes for an auto clip", () => {
    const paths = computeZoomFollowPaths([clip], (t) =>
      t < 3 ? { x: 0.5, y: 0.5 } : { x: 0.85, y: 0.5 }
    )
    expect(paths.size).toBe(1)
    const path = paths.get(clip.id)
    expect(path).toBeTruthy()
    expect(path!.keyframes.length).toBeGreaterThan(1)
    expect(path!.scale).toBeCloseTo(2)
  })

  it("produces NO path for a manual clip (fixed focus)", () => {
    const manual = withZoomClipDefaults({
      id: "m",
      start: 0,
      end: 8,
      scale: 2,
      mode: "manual",
      focus: { x: 0.3, y: 0.3 },
    })
    expect(
      computeZoomFollowPaths([manual], () => ({ x: 0.9, y: 0.9 })).size
    ).toBe(0)
    const cam = sampleZoomCameraAtTime([manual], artboard, 4)
    expect(cam.radialBlurCenterX).toBeCloseTo(0.3)
    expect(cam.radialBlurCenterY).toBeCloseTo(0.3)
  })

  it("follows the cursor: late in a move the cursor is in the window", () => {
    const sampleCursor = (t: number) =>
      t < 2 ? { x: 0.5, y: 0.5 } : { x: 0.9, y: 0.5 }
    const paths = computeZoomFollowPaths([clip], sampleCursor)
    const early = sampleZoomCameraAtTime([clip], artboard, 1, paths)
    expect(cursorInWindow(early.radialBlurCenterX, early.scale, 0.5)).toBe(true)
    const late = sampleZoomCameraAtTime([clip], artboard, 7, paths)
    expect(late.radialBlurCenterX).toBeGreaterThan(early.radialBlurCenterX)
    expect(cursorInWindow(late.radialBlurCenterX, late.scale, 0.9)).toBe(true)
  })

  it("lags the cursor (the spring trails the target, catching up over time)", () => {
    const paths = computeZoomFollowPaths([clip], (t) =>
      t < 3 ? { x: 0.5, y: 0.5 } : { x: 0.9, y: 0.5 }
    )
    const start = sampleZoomCameraAtTime(
      [clip],
      artboard,
      2.9,
      paths
    ).radialBlurCenterX
    const justAfter = sampleZoomCameraAtTime(
      [clip],
      artboard,
      3.1,
      paths
    ).radialBlurCenterX
    const settled = sampleZoomCameraAtTime(
      [clip],
      artboard,
      6,
      paths
    ).radialBlurCenterX
    expect(justAfter).toBeGreaterThan(start)
    expect(justAfter).toBeLessThan(settled + 1e-9)
    expect(settled).toBeGreaterThan(start)
  })

  it("keeps the cursor in the window as it steps across the artboard", () => {
    const stops = [0.5, 0.7, 0.9, 0.95]
    const sampleCursor = (t: number) => {
      const i = Math.min(stops.length - 1, Math.floor(t / 1.5))
      return { x: stops[i], y: stops[i] }
    }
    const paths = computeZoomFollowPaths([clip], sampleCursor)
    for (let i = 0; i < stops.length; i++) {
      const t = i * 1.5 + 1.3 // late in each dwell (spring settled)
      const cam = sampleZoomCameraAtTime([clip], artboard, t, paths)
      expect(cursorInWindow(cam.radialBlurCenterX, cam.scale, stops[i])).toBe(
        true
      )
      expect(cursorInWindow(cam.radialBlurCenterY, cam.scale, stops[i])).toBe(
        true
      )
    }
  })

  it("eases out from the followed frame, not back to the clip focus", () => {
    const sampleCursor = (t: number) =>
      t < 2 ? { x: 0.5, y: 0.5 } : { x: 0.9, y: 0.5 }
    const paths = computeZoomFollowPaths([clip], sampleCursor)
    const easeOut = sampleZoomCameraAtTime([clip], artboard, 7.7, paths)
    expect(easeOut.scale).toBeGreaterThan(1)
    expect(easeOut.scale).toBeLessThan(2)
    expect(easeOut.radialBlurCenterX).toBeGreaterThan(0.6)
  })

  it("is deterministic — the same cursor track yields the same path", () => {
    const sampleCursor = (t: number) => ({ x: t < 3 ? 0.5 : 0.9, y: 0.5 })
    const p1 = computeZoomFollowPaths([clip], sampleCursor)
    const p2 = computeZoomFollowPaths([clip], sampleCursor)
    expect(p1.get(clip.id)).toEqual(p2.get(clip.id))
  })

  it("ignores the follow path on identity frames (outside the clip)", () => {
    const paths = computeZoomFollowPaths([clip], () => ({ x: 0.9, y: 0.9 }))
    expect(sampleZoomCameraAtTime([clip], artboard, 10, paths)).toEqual(
      IDENTITY_ZOOM_CAMERA
    )
  })
})

describe("follow motion blur (directional pan blur)", () => {
  const clip = withZoomClipDefaults({
    id: "z",
    start: 0,
    end: 8,
    scale: 2,
    mode: "auto",
    focus: { x: 0.5, y: 0.5 },
  })

  it("has no pan blur while the cursor is still", () => {
    const paths = computeZoomFollowPaths([clip], () => ({ x: 0.5, y: 0.5 }))
    const held = sampleZoomCameraAtTime([clip], artboard, 4, paths)
    expect(Math.abs(held.panBlurX)).toBeLessThan(1e-6)
    expect(Math.abs(held.panBlurY)).toBeLessThan(1e-6)
  })

  it("smears along the motion axis during a follow, fading to zero once settled", () => {
    const paths = computeZoomFollowPaths([clip], (t) =>
      t < 3 ? { x: 0.2, y: 0.5 } : { x: 0.9, y: 0.5 }
    )
    expect(sampleZoomCameraAtTime([clip], artboard, 1, paths).panBlurX).toBe(0)

    let maxPanX = 0
    for (let t = 2.95; t <= 3.6; t += 1 / 120) {
      const cam = sampleZoomCameraAtTime([clip], artboard, t, paths)
      maxPanX = Math.max(maxPanX, Math.abs(cam.panBlurX))
      expect(Math.abs(cam.panBlurY)).toBeLessThan(1e-6)
    }
    expect(maxPanX).toBeGreaterThan(0)

    const settled = sampleZoomCameraAtTime([clip], artboard, 6, paths)
    expect(Math.abs(settled.panBlurX)).toBeLessThan(1e-6)
    expect(Math.abs(settled.panBlurY)).toBeLessThan(1e-6)
  })

  it("never exceeds the smear cap, even for a fast deep-zoom follow", () => {
    const deep = withZoomClipDefaults({
      id: "z",
      start: 0,
      end: 8,
      scale: 2.6,
      mode: "auto",
      focus: { x: 0.1, y: 0.1 },
    })
    const paths = computeZoomFollowPaths([deep], (t) =>
      t < 3 ? { x: 0.1, y: 0.1 } : { x: 0.95, y: 0.95 }
    )
    for (let t = 2.9; t <= 4.2; t += 1 / 120) {
      const cam = sampleZoomCameraAtTime([deep], artboard, t, paths)
      expect(Math.abs(cam.panBlurX)).toBeLessThanOrEqual(0.14 + 1e-9)
      expect(Math.abs(cam.panBlurY)).toBeLessThanOrEqual(0.14 + 1e-9)
    }
  })

  it("does not pan-blur the zoom eases (those keep radial blur only)", () => {
    const paths = computeZoomFollowPaths([clip], (t) =>
      t < 2 ? { x: 0.5, y: 0.5 } : { x: 0.9, y: 0.5 }
    )
    const easeOut = sampleZoomCameraAtTime([clip], artboard, 7.7, paths)
    expect(easeOut.scale).toBeLessThan(2)
    expect(easeOut.panBlurX).toBe(0)
    expect(easeOut.panBlurY).toBe(0)
    const easeIn = sampleZoomCameraAtTime([clip], artboard, 0.3, paths)
    expect(easeIn.panBlurX).toBe(0)
    expect(easeIn.panBlurY).toBe(0)
  })
})
