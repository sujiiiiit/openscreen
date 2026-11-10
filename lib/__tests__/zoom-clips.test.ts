import { describe, expect, it } from "vitest"

import {
  MIN_ZOOM_CLIP_SECONDS,
  ZOOM_CLIP_DEGENERATE_SECONDS,
  ZOOM_EASE_PRESET_DEFAULT,
  ZOOM_FOCUS_DEFAULT,
  ZOOM_MODE_DEFAULT,
  ZOOM_RADIAL_BLUR_SETTINGS_DEFAULT,
  ZOOM_RADIAL_BLUR_DEFAULT,
  ZOOM_SCALE_DEFAULT,
  ZOOM_TRANSITION_DEFAULT,
  clampZoomMove,
  clampZoomResize,
  getZoomGapBounds,
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
      mode: ZOOM_MODE_DEFAULT,
      scale: ZOOM_SCALE_DEFAULT,
      radialBlur: ZOOM_RADIAL_BLUR_DEFAULT,
      radialBlurSettings: ZOOM_RADIAL_BLUR_SETTINGS_DEFAULT,
      transition: ZOOM_TRANSITION_DEFAULT,
      easePreset: ZOOM_EASE_PRESET_DEFAULT,
      engagedRects: [],
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

  it("allows small but min-sized right-side gaps", () => {
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

  it("treats sub-minimum clips as obstacles", () => {
    // A clip below every floor (float residue / legacy data) must still block
    // placement — being invisible to this check is how overlaps were created.
    const tiny = clip("tiny", 5, 5.01)
    // Anchor inside the tiny clip → rejected.
    expect(placeZoomSpan([tiny], 20, 5.005, 7)).toBeNull()
    // Anchor before it with sub-minimum room → rejected, not overlapped.
    expect(placeZoomSpan([tiny], 20, 4.9, 6)).toBeNull()
    // Anchor after it → placed clear of it.
    expect(placeZoomSpan([tiny], 20, 5.01, 6.01)).toEqual({
      start: 5.01,
      end: 6.01,
    })
  })

  it("snaps the anchor flush to the previous clip and the timeline start", () => {
    const clips = [clip("a", 2, 4)]
    // Within the snap distance after a's end → lands exactly at 4.
    expect(placeZoomSpan(clips, 20, 4.05, 5.05, null, 0.1)).toEqual({
      start: 4,
      end: 5,
    })
    // Within the snap distance of t = 0 → lands exactly at 0.
    expect(placeZoomSpan(clips, 20, 0.05, 1.05, null, 0.1)).toEqual({
      start: 0,
      end: 1,
    })
    // Outside the snap distance → anchor unchanged.
    expect(placeZoomSpan(clips, 20, 4.5, 5.5, null, 0.1)).toEqual({
      start: 4.5,
      end: 5.5,
    })
  })

  it("snaps the end flush to the next clip and the timeline end", () => {
    const clips = [clip("b", 6, 8)]
    // Natural end 5.95 is within the snap distance of b.start → extends to 6.
    expect(placeZoomSpan(clips, 20, 4.5, 5.95, null, 0.1)).toEqual({
      start: 4.5,
      end: 6,
    })
    // Natural end within the snap distance of the timeline end → extends.
    expect(placeZoomSpan(clips, 10, 8.5, 9.95, null, 0.1)).toEqual({
      start: 8.5,
      end: 10,
    })
  })

  it("re-validates a snapped placement identically without snapping", () => {
    // Preview (snapped ghost) === commit (snapless addZoomClip re-check).
    const clips = [clip("a", 2, 4), clip("b", 6, 8)]
    const placed = placeZoomSpan(clips, 20, 4.05, 6.05, null, 0.1)
    expect(placed).not.toBeNull()
    expect(
      placeZoomSpan(clips, 20, placed!.start, placed!.end)
    ).toEqual(placed)
  })
})

describe("getZoomGapBounds", () => {
  const clips = [clip("a", 2, 4), clip("b", 6, 8)]

  it("bounds a middle span by its neighbours", () => {
    expect(getZoomGapBounds(clips, 10, 4.5, 5.5, null)).toEqual({
      lo: 4,
      hi: 6,
    })
  })

  it("bounds edge spans by the timeline", () => {
    expect(getZoomGapBounds(clips, 10, 0.5, 1.5, null)).toEqual({
      lo: 0,
      hi: 2,
    })
    expect(getZoomGapBounds(clips, 10, 8.5, 9.5, null)).toEqual({
      lo: 8,
      hi: 10,
    })
  })

  it("excludes the ignored clip so a clip can measure its own gap", () => {
    expect(getZoomGapBounds(clips, 10, 6, 8, "b")).toEqual({ lo: 4, hi: 10 })
  })

  it("treats sub-minimum clips as walls", () => {
    const tiny = clip("tiny", 5, 5.01)
    expect(getZoomGapBounds([...clips, tiny], 10, 5.5, 5.9, null)).toEqual({
      lo: 5.01,
      hi: 6,
    })
  })

  it("walls off a clip overlapping the reference on its nearer side", () => {
    // Legacy/corrupt state: a clip overlapping the reference's left half
    // becomes a left wall at its end, so dragging the reference resolves the
    // overlap (slides clear to its right) instead of preserving it.
    const overlapping = clip("o", 5.5, 6.5)
    expect(
      getZoomGapBounds([clip("a", 2, 4), overlapping], 10, 6, 8, null)
    ).toEqual({ lo: 6.5, hi: 10 })
  })
})

describe("clampZoomMove", () => {
  const clips = [clip("a", 2, 4), clip("b", 6, 8)]

  it("keeps an in-gap request unchanged", () => {
    expect(clampZoomMove(clips, 10, clip("b", 6, 8), 6.5)).toEqual({
      start: 6.5,
      end: 8.5,
    })
  })

  it("slides flush against the previous neighbour instead of rejecting", () => {
    // Requested far into "a" — clamps to exactly a.end.
    expect(clampZoomMove(clips, 10, clip("b", 6, 8), 3)).toEqual({
      start: 4,
      end: 6,
    })
  })

  it("slides flush against the next neighbour instead of rejecting", () => {
    expect(clampZoomMove(clips, 10, clip("a", 2, 4), 5.7)).toEqual({
      start: 4,
      end: 6,
    })
  })

  it("clamps to the timeline bounds", () => {
    expect(clampZoomMove(clips, 10, clip("a", 2, 4), -3)).toEqual({
      start: 0,
      end: 2,
    })
    expect(clampZoomMove(clips, 10, clip("b", 6, 8), 9.5)).toEqual({
      start: 8,
      end: 10,
    })
  })

  it("welds float residue to exact adjacency", () => {
    const placed = clampZoomMove(clips, 10, clip("b", 6, 8), 4.0004)
    expect(placed.start).toBe(4)
    expect(placed.end).toBe(6)
  })

  it("preserves duration exactly when welding to the right bound", () => {
    const placed = clampZoomMove(clips, 10, clip("a", 2, 4), 3.9996)
    expect(placed).toEqual({ start: 4, end: 6 })
  })

  it("preserves the real duration of legacy short clips", () => {
    // A 0.2 s clip from the old 1/60 s floor must not silently grow on move.
    const legacy = clip("legacy", 1, 1.2)
    expect(clampZoomMove([legacy], 10, legacy, 3)).toEqual({
      start: 3,
      end: 3.2,
    })
  })

  it("cannot cross a sub-minimum clip", () => {
    // The dragged clip stops flush against the tiny clip's start.
    const tiny = clip("tiny", 5, 5.01)
    expect(clampZoomMove([tiny], 10, clip("a", 2, 4), 4.5)).toEqual({
      start: 3,
      end: 5,
    })
  })
})

describe("clampZoomResize", () => {
  const clips = [clip("a", 2, 4), clip("b", 6, 8)]

  it("keeps an in-gap resize unchanged and the anchored edge exact", () => {
    expect(
      clampZoomResize(clips, 10, clip("a", 2, 4), { start: 2, end: 5 }, "right")
    ).toEqual({ start: 2, end: 5 })
  })

  it("stops the right edge flush at the next neighbour", () => {
    expect(
      clampZoomResize(clips, 10, clip("a", 2, 4), { start: 2, end: 7 }, "right")
    ).toEqual({ start: 2, end: 6 })
  })

  it("stops the left edge flush at the previous neighbour", () => {
    expect(
      clampZoomResize(clips, 10, clip("b", 6, 8), { start: 3, end: 8 }, "left")
    ).toEqual({ start: 4, end: 8 })
  })

  it("clamps to the timeline bounds", () => {
    expect(
      clampZoomResize(clips, 10, clip("b", 6, 8), { start: 6, end: 12 }, "right")
    ).toEqual({ start: 6, end: 10 })
    expect(
      clampZoomResize(clips, 10, clip("a", 2, 4), { start: -2, end: 4 }, "left")
    ).toEqual({ start: 0, end: 4 })
  })

  it("enforces the minimum duration on the moving edge", () => {
    expect(
      clampZoomResize(clips, 10, clip("a", 2, 4), { start: 2, end: 2.001 }, "right")
    ).toEqual({ start: 2, end: 2 + MIN_ZOOM_CLIP_SECONDS })
    expect(
      clampZoomResize(clips, 10, clip("b", 6, 8), { start: 7.999, end: 8 }, "left")
    ).toEqual({ start: 8 - MIN_ZOOM_CLIP_SECONDS, end: 8 })
  })

  it("welds float residue on the moving edge to exact adjacency", () => {
    expect(
      clampZoomResize(
        clips,
        10,
        clip("a", 2, 4),
        { start: 2, end: 5.9996 },
        "right"
      )
    ).toEqual({ start: 2, end: 6 })
    expect(
      clampZoomResize(
        clips,
        10,
        clip("b", 6, 8),
        { start: 4.0004, end: 8 },
        "left"
      )
    ).toEqual({ start: 4, end: 8 })
  })

  it("lets the wall beat the minimum-duration floor", () => {
    // A legacy short clip boxed in by its neighbour: growing the right edge
    // fills the gap exactly — it must not cross into the neighbour to reach
    // the minimum duration.
    const legacy = clip("legacy", 5, 5.2)
    const next = clip("next", 5.4, 7)
    expect(
      clampZoomResize([legacy, next], 10, legacy, { start: 5, end: 6 }, "right")
    ).toEqual({ start: 5, end: 5.4 })
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

  it("drops clips that are invalid or become degenerate after trimming", () => {
    expect(
      normalizeZoomClips(
        [
          clip("a", 0, 2),
          clip(
            "degenerate-after-trim",
            2 - ZOOM_CLIP_DEGENERATE_SECONDS / 2,
            2 + ZOOM_CLIP_DEGENERATE_SECONDS / 2
          ),
          clip("outside", 20, 30),
          clip("degenerate", 4, 4 + ZOOM_CLIP_DEGENERATE_SECONDS / 2),
        ],
        10
      )
    ).toEqual([clip("a", 0, 2)])
  })

  it("keeps legacy clips shorter than the creation floor", () => {
    // Created under the old 1/60 s minimum — hydration must not drop them.
    expect(normalizeZoomClips([clip("legacy", 1, 1.1)], 10)).toEqual([
      clip("legacy", 1, 1.1),
    ])
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
