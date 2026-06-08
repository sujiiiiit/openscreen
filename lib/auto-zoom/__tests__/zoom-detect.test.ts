import { describe, expect, it } from "vitest"

import {
  AUTO_ZOOM_DEFAULTS,
  buildAutoZoomClips,
  type AutoZoomClickSample,
} from "@/lib/auto-zoom/zoom-detect"
import { MIN_ZOOM_CLIP_SECONDS } from "@/lib/zoom-clips"
import type { CanvasZoomClip } from "@/types/editor-canvas"

// --- sample builders -------------------------------------------------------

/** A simple click: down + up at the same point. */
const click = (
  tSeconds: number,
  x: number,
  y: number,
  cursorId?: string
): AutoZoomClickSample[] => [
  { tSeconds, focus: { x, y }, type: "down", cursorId },
  { tSeconds: tSeconds + 0.05, focus: { x, y }, type: "up", cursorId },
]

/** A drag: down at A, up at B. */
const drag = (
  tDown: number,
  ax: number,
  ay: number,
  tUp: number,
  bx: number,
  by: number,
  cursorId?: string
): AutoZoomClickSample[] => [
  { tSeconds: tDown, focus: { x: ax, y: ay }, type: "down", cursorId },
  { tSeconds: tUp, focus: { x: bx, y: by }, type: "up", cursorId },
]

/** Assert the output is a single sorted, non-overlapping lane. */
const expectNonOverlapping = (clips: CanvasZoomClip[]) => {
  for (let i = 0; i < clips.length - 1; i++) {
    expect(clips[i].end).toBeLessThanOrEqual(clips[i + 1].start + 1e-9)
    expect(clips[i].start).toBeLessThan(clips[i].end)
  }
}

// --- guards ----------------------------------------------------------------

describe("buildAutoZoomClips guards", () => {
  it("returns [] for no clicks", () => {
    expect(buildAutoZoomClips([], 30)).toEqual([])
  })

  it("returns [] when the recording is below the minimum length", () => {
    // 2 s < MIN_RECORDING_MS (3 s), even with a click.
    expect(buildAutoZoomClips(click(1, 0.5, 0.5), 2)).toEqual([])
  })

  it("returns [] for a non-finite duration", () => {
    expect(buildAutoZoomClips(click(1, 0.5, 0.5), Number.NaN)).toEqual([])
  })
})

// --- single click ----------------------------------------------------------

describe("buildAutoZoomClips single click", () => {
  it("emits one calm hold anchored at the click, with lead-in and min hold", () => {
    const clips = buildAutoZoomClips(click(10, 0.5, 0.3), 30)
    expect(clips).toHaveLength(1)
    const [c] = clips
    expect(c.start).toBeCloseTo(10 - AUTO_ZOOM_DEFAULTS.leadInMs / 1000, 6)
    // end = lastAction(10.05) + ease tail(0.6), but at least min hold from start.
    expect(c.end - c.start).toBeGreaterThanOrEqual(
      AUTO_ZOOM_DEFAULTS.minHoldMs / 1000 - 1e-9
    )
    expect(c.focus).toEqual({ x: 0.5, y: 0.3 })
    expect(c.scale).toBeCloseTo(AUTO_ZOOM_DEFAULTS.zoomScale, 6)
    expect(c.enabled).toBe(true)
    expect(c.transition.durationMs).toBe(AUTO_ZOOM_DEFAULTS.easeMs)
    expect(c.transition.curve).toBe("smootherstep")
    expect(c.id.startsWith("auto-zoom-")).toBe(true)
  })

  it("clamps an out-of-range focus into [0,1]", () => {
    const clips = buildAutoZoomClips(click(10, 1.5, -0.2), 30)
    expect(clips).toHaveLength(1)
    expect(clips[0].focus).toEqual({ x: 1, y: 0 })
  })
})

// --- determinism -----------------------------------------------------------

describe("buildAutoZoomClips determinism", () => {
  it("is a pure function: identical input → byte-identical output (ids included)", () => {
    const input = [
      ...click(4, 0.2, 0.2),
      ...click(4.4, 0.22, 0.21),
      ...click(12, 0.8, 0.7, "pointingHand"),
      ...drag(20, 0.3, 0.3, 20.6, 0.6, 0.65),
      ...click(26, 0.5, 0.5, "iBeam"),
    ]
    const a = buildAutoZoomClips(input, 30)
    const b = buildAutoZoomClips([...input], 30)
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
    expect(a.length).toBeGreaterThan(0)
  })

  it("is order-independent (out-of-order samples sort deterministically)", () => {
    const ordered = [...click(5, 0.4, 0.4), ...click(18, 0.7, 0.2)]
    const shuffled = [ordered[2], ordered[0], ordered[3], ordered[1]]
    expect(buildAutoZoomClips(shuffled, 30)).toEqual(
      buildAutoZoomClips(ordered, 30)
    )
  })
})

// --- segmentation, clustering, merging -------------------------------------

describe("buildAutoZoomClips segmentation", () => {
  it("splits two clicks far apart in time into two clips", () => {
    const clips = buildAutoZoomClips(
      [...click(5, 0.2, 0.2), ...click(20, 0.8, 0.8)],
      30
    )
    expect(clips).toHaveLength(2)
    expect(clips[0].focus.x).toBeCloseTo(0.2, 2)
    expect(clips[1].focus.x).toBeCloseTo(0.8, 2)
    expectNonOverlapping(clips)
  })

  it("collapses a rapid same-spot cluster into one clip", () => {
    const clips = buildAutoZoomClips(
      [...click(5, 0.5, 0.5), ...click(5.3, 0.5, 0.5), ...click(5.6, 0.51, 0.49)],
      30
    )
    expect(clips).toHaveLength(1)
  })

  it("merges two near-in-time, near-focus segments into one continuous hold (anti-pump)", () => {
    const clips = buildAutoZoomClips(
      [...click(5, 0.5, 0.5), ...click(7, 0.55, 0.52)],
      30
    )
    expect(clips).toHaveLength(1)
    // Spans from the first lead-in to the second action's tail.
    expect(clips[0].start).toBeCloseTo(5 - AUTO_ZOOM_DEFAULTS.leadInMs / 1000, 6)
    expect(clips[0].end).toBeGreaterThan(7)
  })
})

// --- typing & drag ---------------------------------------------------------

describe("buildAutoZoomClips signal types", () => {
  it("zooms more for a text-entry (iBeam) cluster", () => {
    const clips = buildAutoZoomClips(click(8, 0.4, 0.4, "iBeam"), 30)
    expect(clips).toHaveLength(1)
    expect(clips[0].scale).toBeCloseTo(AUTO_ZOOM_DEFAULTS.zoomTyping, 6)
  })

  it("anchors a drag at its release/settle point", () => {
    const clips = buildAutoZoomClips(drag(8, 0.2, 0.2, 8.5, 0.5, 0.6), 30)
    expect(clips).toHaveLength(1)
    expect(clips[0].focus.x).toBeCloseTo(0.5, 6)
    expect(clips[0].focus.y).toBeCloseTo(0.6, 6)
  })

  it("treats a tiny down→up jitter as a click, not a drag", () => {
    const clips = buildAutoZoomClips(drag(8, 0.5, 0.5, 8.1, 0.51, 0.5), 30)
    expect(clips).toHaveLength(1)
    expect(clips[0].focus.x).toBeCloseTo(0.5, 6)
  })
})

// --- reducers: rate limit & tail guard -------------------------------------

describe("buildAutoZoomClips reducers", () => {
  it("rate-limits to maxZoomsPerMin", () => {
    // 60 s recording → cap = 4. Six well-separated clicks at distinct corners.
    const clips = buildAutoZoomClips(
      [
        ...click(5, 0.1, 0.1),
        ...click(15, 0.9, 0.9),
        ...click(25, 0.1, 0.9),
        ...click(35, 0.9, 0.1),
        ...click(45, 0.5, 0.1),
        ...click(55, 0.1, 0.5),
      ],
      60
    )
    expect(clips.length).toBeLessThanOrEqual(4)
    expectNonOverlapping(clips)
  })

  it("clamps a near-end clip's end before the tail guard", () => {
    const clips = buildAutoZoomClips(click(29, 0.5, 0.5), 30)
    expect(clips).toHaveLength(1)
    expect(clips[0].end).toBeLessThanOrEqual(
      30 - AUTO_ZOOM_DEFAULTS.tailGuardMs / 1000 + 1e-9
    )
  })

  it("drops a trailing Stop-button-style click whose hold can't fit", () => {
    // 20 s recording, click at 19.8 s: lead-in start (19.45) is past the tail
    // guard (19.2), so the window collapses below the floor and is dropped.
    const clips = buildAutoZoomClips(click(19.8, 0.5, 0.5), 20)
    expect(clips).toEqual([])
  })

  it("never emits a clip shorter than the manual duration floor", () => {
    const clips = buildAutoZoomClips(
      [...click(5, 0.2, 0.2), ...click(9, 0.8, 0.8), ...click(13, 0.3, 0.7)],
      30
    )
    for (const c of clips) {
      expect(c.end - c.start).toBeGreaterThanOrEqual(MIN_ZOOM_CLIP_SECONDS - 1e-9)
    }
    expectNonOverlapping(clips)
  })
})
