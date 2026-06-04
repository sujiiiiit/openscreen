import { describe, expect, it } from "vitest"

import {
  MIN_ZOOM_CLIP_SECONDS,
  ZOOM_EASE_PRESET_DEFAULT,
  ZOOM_FOCUS_DEFAULT,
  ZOOM_RADIAL_BLUR_SETTINGS_DEFAULT,
  ZOOM_RADIAL_BLUR_DEFAULT,
  ZOOM_SCALE_DEFAULT,
  ZOOM_TRANSITION_DEFAULT,
  sanitizeZoomClipPatch,
  normalizeZoomClips,
  placeZoomSpan,
  withZoomClipDefaults,
  zoomSpanOverlaps,
} from "@/lib/zoom-clips"
import type { CanvasZoomClip } from "@/types/editor-canvas"

const clip = (id: string, start: number, end: number): CanvasZoomClip =>
  withZoomClipDefaults({ id, start, end })

describe("withZoomClipDefaults", () => {
  it("hydrates span-only clips with manual zoom defaults", () => {
    expect(withZoomClipDefaults({ id: "z", start: 1, end: 3 })).toEqual({
      id: "z",
      start: 1,
      end: 3,
      enabled: true,
      focus: ZOOM_FOCUS_DEFAULT,
      scale: ZOOM_SCALE_DEFAULT,
      radialBlur: ZOOM_RADIAL_BLUR_DEFAULT,
      radialBlurSettings: ZOOM_RADIAL_BLUR_SETTINGS_DEFAULT,
      transition: ZOOM_TRANSITION_DEFAULT,
      easePreset: ZOOM_EASE_PRESET_DEFAULT,
    })
  })

  it("clamps unsafe patch values into the supported ranges", () => {
    expect(
      sanitizeZoomClipPatch({
        enabled: false,
        focus: { x: -0.2, y: 1.4 },
        scale: 99,
        radialBlur: Number.NaN,
        radialBlurSettings: {
          strength: 99,
          falloff: -1,
          centerSize: 99,
          centerSharpness: Number.NaN,
        },
        transition: {
          easeIn: 99,
          easeOut: -1,
          durationMs: 99999,
          speed: 99,
          curve: "unknown" as never,
        },
        easePreset: "unknown" as never,
      })
    ).toEqual({
      enabled: false,
      focus: { x: 0, y: 1 },
      scale: 4,
      radialBlur: ZOOM_RADIAL_BLUR_DEFAULT,
      radialBlurSettings: {
        strength: 2,
        falloff: 0.05,
        centerSize: ZOOM_RADIAL_BLUR_SETTINGS_DEFAULT.centerSize,
        centerSharpness: ZOOM_RADIAL_BLUR_SETTINGS_DEFAULT.centerSharpness,
      },
      transition: {
        easeIn: 0.75,
        easeOut: 0,
        speed: 1,
        durationMs: 2000,
        curve: ZOOM_TRANSITION_DEFAULT.curve,
      },
      easePreset: ZOOM_EASE_PRESET_DEFAULT,
    })
  })

  it("hydrates legacy ease presets into explicit transition values", () => {
    expect(
      withZoomClipDefaults({
        id: "z",
        start: 1,
        end: 3,
        easePreset: "snappy",
      }).transition
    ).toEqual({
      easeIn: 0.16,
      easeOut: 0.18,
      speed: ZOOM_TRANSITION_DEFAULT.speed,
      durationMs: 450,
      curve: "smoothstep",
    })
  })

  it("converts legacy speed-based transition timing into a duration", () => {
    expect(
      withZoomClipDefaults({
        id: "z",
        start: 0,
        end: 4,
        transition: {
          easeIn: 0.3,
          easeOut: 0.4,
          speed: 2,
        },
      }).transition
    ).toEqual({
      easeIn: 0.3,
      easeOut: 0.4,
      speed: ZOOM_TRANSITION_DEFAULT.speed,
      durationMs: 800,
      curve: ZOOM_TRANSITION_DEFAULT.curve,
    })
  })
})

describe("placeZoomSpan", () => {
  it("places a span in empty space, clamped to the timeline duration", () => {
    expect(placeZoomSpan([], 10, 2, 4)).toEqual({ start: 2, end: 4 })
    // End clamped to duration.
    expect(placeZoomSpan([], 5, 4, 6)).toEqual({ start: 4, end: 5 })
  })

  it("shrinks the right edge to the next clip's start so it never overlaps", () => {
    const clips = [clip("a", 5, 8)]
    expect(placeZoomSpan(clips, 20, 4, 7)).toEqual({ start: 4, end: 5 })
  })

  it("shrinks to a smaller right-side gap when the requested span cannot fit", () => {
    const clips = [clip("a", 3, 5), clip("b", 7, 10)]
    expect(placeZoomSpan(clips, 20, 6, 9)).toEqual({ start: 6, end: 7 })
  })

  it("rejects a start that falls inside an existing clip", () => {
    const clips = [clip("a", 2, 6)]
    expect(placeZoomSpan(clips, 20, 4, 8)).toBeNull()
  })

  it("rejects when the available room is below the minimum", () => {
    const clips = [clip("a", 2 + MIN_ZOOM_CLIP_SECONDS / 2, 6)]
    expect(placeZoomSpan(clips, 20, 2, 4)).toBeNull()
  })

  it("allows tiny but frame-sized right-side gaps", () => {
    const clips = [clip("a", 2 + MIN_ZOOM_CLIP_SECONDS * 1.5, 6)]
    expect(placeZoomSpan(clips, 20, 2, 4)).toEqual({
      start: 2,
      end: 2 + MIN_ZOOM_CLIP_SECONDS * 1.5,
    })
  })

  it("excludes the ignored clip from the overlap test", () => {
    const clips = [clip("a", 2, 5)]
    // Re-placing "a" at the same spot is allowed because it ignores itself.
    expect(placeZoomSpan(clips, 20, 2, 5, "a")).toEqual({ start: 2, end: 5 })
  })

  it("rejects a click at the timeline boundary because no right-side room remains", () => {
    expect(placeZoomSpan([], 10, 10, 12)).toBeNull()
  })
})

describe("zoomSpanOverlaps", () => {
  const clips = [clip("a", 2, 5), clip("b", 8, 10)]

  it("detects overlap with any other clip", () => {
    expect(zoomSpanOverlaps(clips, 4, 6, null)).toBe(true)
    expect(zoomSpanOverlaps(clips, 9, 11, null)).toBe(true)
  })

  it("returns false for a clear gap", () => {
    expect(zoomSpanOverlaps(clips, 5, 8, null)).toBe(false)
  })

  it("treats touching edges as non-overlapping (half-open ranges)", () => {
    expect(zoomSpanOverlaps(clips, 5, 8, null)).toBe(false)
    expect(zoomSpanOverlaps(clips, 0, 2, null)).toBe(false)
  })

  it("ignores the clip being moved", () => {
    expect(zoomSpanOverlaps(clips, 2, 5, "a")).toBe(false)
  })
})

describe("normalizeZoomClips", () => {
  it("sorts and trims restored clips into one non-overlapping lane", () => {
    expect(
      normalizeZoomClips(
        [clip("b", 2, 5), clip("a", 0, 3), clip("c", 6, 8)],
        10
      )
    ).toEqual([clip("a", 0, 3), clip("b", 3, 5), clip("c", 6, 8)])
  })

  it("drops clips that are invalid or become too small after trimming", () => {
    expect(
      normalizeZoomClips(
        [
          clip("a", 0, 2),
          clip(
            "too-small-after-trim",
            2 - MIN_ZOOM_CLIP_SECONDS / 2,
            2 + MIN_ZOOM_CLIP_SECONDS / 2
          ),
          clip("outside", 20, 30),
          clip("tiny", 4, 4 + MIN_ZOOM_CLIP_SECONDS / 2),
        ],
        10
      )
    ).toEqual([clip("a", 0, 2)])
  })

  it("clamps restored clips to the timeline duration", () => {
    expect(normalizeZoomClips([clip("a", 8, 12)], 10)).toEqual([
      clip("a", 8, 10),
    ])
  })

  it("preserves zoom settings while trimming restored clips", () => {
    expect(
      normalizeZoomClips(
        [
          withZoomClipDefaults({
            id: "a",
            start: 8,
            end: 12,
            enabled: false,
            focus: { x: 0.3, y: 0.7 },
            scale: 2.25,
            radialBlur: 0.5,
            easePreset: "slow",
          }),
        ],
        10
      )
    ).toEqual([
      withZoomClipDefaults({
        id: "a",
        start: 8,
        end: 10,
        enabled: false,
        focus: { x: 0.3, y: 0.7 },
        scale: 2.25,
        radialBlur: 0.5,
        easePreset: "slow",
      }),
    ])
  })
})
