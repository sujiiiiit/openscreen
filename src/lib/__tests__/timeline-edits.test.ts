import { describe, expect, it } from "vitest"

import {
  applySourceSpeedRanges,
  clipCursorAlphaAt,
  linkedClipIds,
  remapZoomClips,
  rippleDeleteTimelineClips,
  setTimelineClipsHideCursor,
  setTimelineClipsSpeed,
  sourceToTimelineSeconds,
  splitTimelineClipsAt,
  timelineToSourceSeconds,
} from "@/lib/timeline-edits"
import { withZoomClipDefaults } from "@/lib/zoom-clips"
import type { CanvasTimelineClip } from "@/types/editor-canvas"

const clip = (
  id: string,
  videoId: string,
  start: number,
  end: number,
  sourceIn = start,
  speed?: number
): CanvasTimelineClip => ({
  id,
  videoId,
  start,
  end,
  sourceIn,
  sourceOut: sourceIn + (end - start) * (speed ?? 1),
  ...(speed ? { speed } : {}),
})

let n = 0
const newId = (c: CanvasTimelineClip) => `${c.id}-${++n}`

/** Every clip keeps end − start = source span / speed. */
const expectConsistent = (clips: CanvasTimelineClip[]) => {
  for (const c of clips) {
    expect(c.end - c.start).toBeCloseTo(
      (c.sourceOut - c.sourceIn) / (c.speed ?? 1),
      9
    )
  }
}

describe("speed mapping", () => {
  it("maps timeline ↔ source through the clip speed", () => {
    const c = clip("a", "v", 2, 4, 10, 2) // plays source 10..14 over 2..4
    expect(timelineToSourceSeconds(c, 3)).toBeCloseTo(12)
    expect(sourceToTimelineSeconds(c, 12)).toBeCloseTo(3)
    expect(sourceToTimelineSeconds(c, timelineToSourceSeconds(c, 3.7))).toBeCloseTo(3.7)
  })
})

describe("splitTimelineClipsAt", () => {
  it("cuts every spanning clip at the playhead, keeping sync", () => {
    const clips = [clip("s", "screen", 0, 10), clip("c", "cam", 0, 10)]
    const next = splitTimelineClipsAt(clips, 4, newId)
    expect(next).toHaveLength(4)
    const screen = next.filter((c) => c.videoId === "screen")
    expect(screen.map((c) => [c.start, c.end, c.sourceIn, c.sourceOut])).toEqual([
      [0, 4, 0, 4],
      [4, 10, 4, 10],
    ])
    expectConsistent(next)
    // The two right halves are one linked group.
    const right = next.find((c) => c.videoId === "screen" && c.start === 4)!
    expect(linkedClipIds(next, right.id)).toHaveLength(2)
  })

  it("splits sped-up clips at the right source instant", () => {
    const next = splitTimelineClipsAt([clip("s", "v", 0, 5, 0, 2)], 2, newId)
    expect(next[0].sourceOut).toBeCloseTo(4)
    expect(next[1].sourceIn).toBeCloseTo(4)
    expect(next[1].speed).toBe(2)
    expectConsistent(next)
  })

  it("is a no-op at clip edges or outside every clip", () => {
    const clips = [clip("s", "v", 0, 10)]
    expect(splitTimelineClipsAt(clips, 0, newId)).toBe(clips)
    expect(splitTimelineClipsAt(clips, 10, newId)).toBe(clips)
    expect(splitTimelineClipsAt(clips, 9.95, newId)).toBe(clips)
  })
})

describe("rippleDeleteTimelineClips", () => {
  it("removes a linked segment and closes the gap on every track", () => {
    const clips = [
      clip("s1", "screen", 0, 4),
      clip("s2", "screen", 4, 6),
      clip("s3", "screen", 6, 10),
      clip("c1", "cam", 0, 4),
      clip("c2", "cam", 4, 6),
      clip("c3", "cam", 6, 10),
    ]
    const { clips: next, remap } = rippleDeleteTimelineClips(
      clips,
      linkedClipIds(clips, "s2")
    )
    expect(next.map((c) => c.id).sort()).toEqual(["c1", "c3", "s1", "s3"])
    const s3 = next.find((c) => c.id === "s3")!
    expect([s3.start, s3.end, s3.sourceIn]).toEqual([4, 8, 6])
    expect(remap(2)).toBe(2)
    expect(remap(5)).toBe(4)
    expect(remap(9)).toBe(7)
  })

  it("lifts (no ripple) when another clip still covers the span", () => {
    const clips = [clip("s2", "screen", 4, 6), clip("m", "media", 3, 8)]
    const { clips: next, remap } = rippleDeleteTimelineClips(clips, ["s2"])
    expect(next).toEqual([clips[1]])
    expect(remap(7)).toBe(7)
  })
})

describe("setTimelineClipsSpeed", () => {
  it("re-times the group and ripples later clips", () => {
    const clips = [
      clip("a", "screen", 0, 2),
      clip("b", "screen", 2, 6),
      clip("cb", "cam", 2, 6),
      clip("c", "screen", 6, 10),
    ]
    const { clips: next, remap } = setTimelineClipsSpeed(
      clips,
      linkedClipIds(clips, "b"),
      2
    )
    const byId = new Map(next.map((c) => [c.id, c]))
    expect([byId.get("b")!.start, byId.get("b")!.end]).toEqual([2, 4])
    expect(byId.get("cb")!.end).toBe(4)
    expect([byId.get("c")!.start, byId.get("c")!.end]).toEqual([4, 8])
    expect(byId.get("c")!.sourceIn).toBe(6)
    expectConsistent(next)
    expect(remap(1)).toBe(1)
    expect(remap(4)).toBe(3)
    expect(remap(8)).toBe(6)
  })

  it("back to 1× restores the original layout and drops the field", () => {
    const clips = [clip("b", "v", 0, 4), clip("c", "v", 4, 6)]
    const fast = setTimelineClipsSpeed(clips, ["b"], 4).clips
    const back = setTimelineClipsSpeed(fast, ["b"], 1).clips
    expect(back).toEqual(clips)
  })
})

describe("remapZoomClips", () => {
  it("compresses zooms over a sped-up stretch and shifts later ones", () => {
    const clips = [clip("a", "v", 0, 2), clip("b", "v", 2, 6), clip("c", "v", 6, 20)]
    const { remap, clips: next } = setTimelineClipsSpeed(clips, ["b"], 2)
    const zooms = [
      withZoomClipDefaults({ id: "z1", start: 2, end: 6 }),
      withZoomClipDefaults({ id: "z2", start: 8, end: 10 }),
    ]
    const out = remapZoomClips(zooms, remap, Math.max(...next.map((c) => c.end)))
    expect(out.map((z) => [z.start, z.end])).toEqual([
      [2, 4],
      [6, 8],
    ])
  })

  it("drops zooms collapsed by a ripple delete", () => {
    const clips = [clip("a", "v", 0, 2), clip("b", "v", 2, 6), clip("c", "v", 6, 10)]
    const { remap } = rippleDeleteTimelineClips(clips, ["b"])
    const zooms = [withZoomClipDefaults({ id: "z", start: 3, end: 5 })]
    expect(remapZoomClips(zooms, remap, 6)).toEqual([])
  })
})

describe("clipCursorAlphaAt (per-clip hide cursor)", () => {
  const clips = setTimelineClipsHideCursor(
    [clip("a", "v", 0, 2), clip("b", "v", 2, 4), clip("c", "v", 4, 6), clip("d", "v", 6, 8)],
    ["b", "c"],
    true
  )

  it("is fully visible outside hidden clips", () => {
    expect(clipCursorAlphaAt(clips, 1)).toBe(1)
    expect(clipCursorAlphaAt(clips, 7)).toBe(1)
  })

  it("fades out at the run start with the typing fade, no re-fade between contiguous clips", () => {
    expect(clipCursorAlphaAt(clips, 2)).toBe(1)
    const mid = clipCursorAlphaAt(clips, 2.06)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(clipCursorAlphaAt(clips, 2.2)).toBe(0)
    expect(clipCursorAlphaAt(clips, 4.001)).toBe(0) // contiguous: still hidden
  })

  it("fades back in after the run ends", () => {
    const a = clipCursorAlphaAt(clips, 6.08)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(1)
    expect(clipCursorAlphaAt(clips, 6.2)).toBe(1)
  })
})

describe("applySourceSpeedRanges", () => {
  it("splits + speeds the mapped stretch on all tracks and ripples", () => {
    const clips = [clip("s", "screen", 0, 20), clip("c", "cam", 0, 20)]
    const { clips: next, remap, applied } = applySourceSpeedRanges(
      clips,
      "screen",
      [
        { startSeconds: 4, endSeconds: 8, speed: 2 },
        { startSeconds: 12, endSeconds: 16, speed: 4 },
      ],
      newId
    )
    expect(applied).toBe(2)
    expectConsistent(next)
    const screen = next
      .filter((c) => c.videoId === "screen")
      .sort((a, b) => a.start - b.start)
    expect(screen.map((c) => [c.start, c.end, c.speed ?? 1])).toEqual([
      [0, 4, 1],
      [4, 6, 2],
      [6, 10, 1],
      [10, 11, 4],
      [11, 15, 1],
    ])
    // camera re-timed identically
    const cam = next
      .filter((c) => c.videoId === "cam")
      .sort((a, b) => a.start - b.start)
    expect(cam.map((c) => [c.start, c.end])).toEqual(screen.map((c) => [c.start, c.end]))
    // source continuity is preserved
    for (let i = 1; i < screen.length; i++) {
      expect(screen[i].sourceIn).toBeCloseTo(screen[i - 1].sourceOut)
    }
    expect(remap(20)).toBeCloseTo(15)
    expect(remap(14)).toBeCloseTo(10.5)
  })

  it("leaves user re-timed segments alone", () => {
    const clips = [clip("s", "screen", 0, 5, 0, 2)]
    const out = applySourceSpeedRanges(
      clips,
      "screen",
      [{ startSeconds: 2, endSeconds: 6, speed: 4 }],
      newId
    )
    expect(out.applied).toBe(0)
    expect(out.clips).toEqual(clips)
  })
})
