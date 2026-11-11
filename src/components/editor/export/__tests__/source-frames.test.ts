import { describe, expect, it } from "vitest"

import {
  canUseDirectVideoFrames,
  planExportFrames,
} from "@/components/editor/export/source-frames"
import type { ProjectTimelineClip } from "@/types/api"

function clip(
  partial: Partial<ProjectTimelineClip> & {
    videoId: string
    start: number
    end: number
    sourceIn: number
  },
): ProjectTimelineClip {
  return {
    id: `${partial.videoId}-clip-${partial.start}`,
    videoId: partial.videoId,
    start: partial.start,
    end: partial.end,
    sourceIn: partial.sourceIn,
    sourceOut: partial.sourceIn + (partial.end - partial.start),
  } as ProjectTimelineClip
}

describe("canUseDirectVideoFrames", () => {
  const base = {
    rotation: 0,
    codedWidth: 2880,
    codedHeight: 1800,
    intrinsicWidth: 2880,
    intrinsicHeight: 1800,
  }

  it("allows the fast path for rotation-0 sources whose coded size matches intrinsic", () => {
    expect(canUseDirectVideoFrames(base)).toBe(true)
  })

  it("falls back when the track carries rotation metadata (canvas bakes it in)", () => {
    expect(canUseDirectVideoFrames({ ...base, rotation: 90 })).toBe(false)
    expect(canUseDirectVideoFrames({ ...base, rotation: 180 })).toBe(false)
    expect(canUseDirectVideoFrames({ ...base, rotation: 270 })).toBe(false)
  })

  it("falls back when coded size differs from the intrinsic size the stage was built around", () => {
    expect(
      canUseDirectVideoFrames({ ...base, codedWidth: 1920, codedHeight: 1080 })
    ).toBe(false)
    // One-axis mismatch (e.g. encoder padding) must also fall back — the
    // cover-crop frame Rectangle is in intrinsic pixel coordinates.
    expect(canUseDirectVideoFrames({ ...base, codedHeight: 1802 })).toBe(false)
  })
})

describe("planExportFrames", () => {
  it("emits a per-frame active list and a monotonic source timeline per source", () => {
    // Single clip from t=0..1s at 4 fps → 4 frames, each active.
    const clips = [
      clip({ videoId: "A", start: 0, end: 1, sourceIn: 5 }),
    ]
    const plan = planExportFrames({ clips, totalFrames: 4, fps: 4 })

    expect(plan.framePlan).toHaveLength(4)
    expect(plan.framePlan[0]).toEqual([{ videoId: "A", sourceTimeSec: 5 }])
    expect(plan.framePlan[3]).toEqual([
      { videoId: "A", sourceTimeSec: 5 + 3 / 4 },
    ])

    // Source timeline for A is monotonically increasing.
    const aTimes = plan.sourceTimelinesByVideoId.get("A")!
    expect(aTimes).toEqual([5, 5.25, 5.5, 5.75])
    for (let i = 1; i < aTimes.length; i++) {
      expect(aTimes[i]).toBeGreaterThan(aTimes[i - 1])
    }
  })

  it("excludes frames at or past clip.end (right-open interval)", () => {
    // Clip is [0, 1) — frame at t=1.0 (index 4 at 4 fps for a 5-frame plan)
    // must NOT include the clip.
    const clips = [
      clip({ videoId: "A", start: 0, end: 1, sourceIn: 0 }),
    ]
    const plan = planExportFrames({ clips, totalFrames: 5, fps: 4 })
    expect(plan.framePlan[4]).toEqual([])
  })

  it("supports overlapping clips on different sources in the same frame", () => {
    const clips = [
      clip({ videoId: "A", start: 0, end: 1, sourceIn: 0 }),
      clip({ videoId: "B", start: 0.5, end: 1.5, sourceIn: 10 }),
    ]
    const plan = planExportFrames({ clips, totalFrames: 8, fps: 4 })

    // Frame 0 (t=0): only A
    expect(plan.framePlan[0].map((e) => e.videoId)).toEqual(["A"])
    // Frame 2 (t=0.5): both A and B
    expect(plan.framePlan[2].map((e) => e.videoId).sort()).toEqual([
      "A",
      "B",
    ])
    // Frame 4 (t=1.0): only B (A ended)
    expect(plan.framePlan[4].map((e) => e.videoId)).toEqual(["B"])
  })

  it("returns empty arrays for frames in a gap between clips", () => {
    const clips = [
      clip({ videoId: "A", start: 0, end: 0.5, sourceIn: 0 }),
      clip({ videoId: "A", start: 1, end: 1.5, sourceIn: 5 }),
    ]
    const plan = planExportFrames({ clips, totalFrames: 8, fps: 4 })
    // Frame 2 and 3 (t=0.5 and 0.75) are inside the gap.
    expect(plan.framePlan[2]).toEqual([])
    expect(plan.framePlan[3]).toEqual([])
  })

  it("source-time within a clip is sourceIn + (t - clip.start)", () => {
    const clips = [
      clip({ videoId: "A", start: 2, end: 3, sourceIn: 7 }),
    ]
    const plan = planExportFrames({ clips, totalFrames: 16, fps: 4 })
    // Frame 8 → t=2 → first frame of the clip → source-time = 7
    expect(plan.framePlan[8]).toEqual([{ videoId: "A", sourceTimeSec: 7 }])
    // Frame 11 → t=2.75 → source-time = 7.75
    expect(plan.framePlan[11]).toEqual([
      { videoId: "A", sourceTimeSec: 7.75 },
    ])
  })

  it("handles zero clips cleanly", () => {
    const plan = planExportFrames({ clips: [], totalFrames: 4, fps: 4 })
    expect(plan.framePlan).toHaveLength(4)
    for (const frame of plan.framePlan) expect(frame).toEqual([])
    expect(plan.sourceTimelinesByVideoId.size).toBe(0)
  })

  it("does not lose precision over a long timeline", () => {
    // 60 fps × 60 s = 3600 frames. Last frame's source-time should be
    // numerically close to the clip's right edge minus one frame.
    const clips = [
      clip({ videoId: "A", start: 0, end: 60, sourceIn: 0 }),
    ]
    const totalFrames = 3600
    const plan = planExportFrames({ clips, totalFrames, fps: 60 })
    const lastEntry = plan.framePlan[totalFrames - 1]
    expect(lastEntry).toHaveLength(1)
    expect(lastEntry[0].sourceTimeSec).toBeCloseTo(60 - 1 / 60, 5)
  })
})
