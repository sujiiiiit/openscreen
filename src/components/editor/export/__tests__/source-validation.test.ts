import { describe, expect, it } from "vitest"

import {
  findMissingActiveSourceVideoIds,
  formatExportSourceList,
} from "@/components/editor/export/source-validation"
import type { ProjectStateV1, ProjectTimelineClip, ProjectVideo } from "@/types/api"

function projectVideo(partial: Partial<ProjectVideo> & { id: string }) {
  const { id, ...rest } = partial
  return {
    id,
    fileName: `${id}.mov`,
    source: { kind: "recording", assetRole: "screen" },
    intrinsicWidth: 1920,
    intrinsicHeight: 1080,
    durationMs: 1000,
    role: "screen",
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
    locked: false,
    cornerRadius: 0,
    cornerSmoothing: 0.6,
    borderWidth: 0,
    borderColor: "#000000",
    borderOffset: 0,
    borderAlignment: "inside",
    ...rest,
  } satisfies ProjectVideo
}

function clip(
  partial: Partial<ProjectTimelineClip> & {
    videoId: string
    start: number
    end: number
  },
) {
  const { videoId, start, end, ...rest } = partial
  return {
    id: `${videoId}-clip`,
    videoId,
    start,
    end,
    sourceIn: 0,
    sourceOut: end - start,
    ...rest,
  } satisfies ProjectTimelineClip
}

function state(partial: Partial<ProjectStateV1>): ProjectStateV1 {
  return {
    version: 1,
    artboard: {
      presetId: "wide",
      width: 1920,
      height: 1080,
      background: null,
      padding: 0,    },
    videos: [],
    timelineClips: [],
    updatedAtUnixMs: 0,
    ...partial,
  }
}

describe("findMissingActiveSourceVideoIds", () => {
  it("reports active timeline videos with no export URL", () => {
    const snapshot = state({
      videos: [projectVideo({ id: "screen" })],
      timelineClips: [clip({ videoId: "screen", start: 0, end: 5 })],
    })

    expect(findMissingActiveSourceVideoIds(snapshot, {})).toEqual(["screen"])
  })

  it("does not require URLs for zero-length clips", () => {
    const snapshot = state({
      videos: [projectVideo({ id: "screen" })],
      timelineClips: [clip({ videoId: "screen", start: 2, end: 2 })],
    })

    expect(findMissingActiveSourceVideoIds(snapshot, {})).toEqual([])
  })

  it("deduplicates missing videos referenced by multiple clips", () => {
    const snapshot = state({
      videos: [projectVideo({ id: "screen" })],
      timelineClips: [
        clip({ videoId: "screen", start: 0, end: 1 }),
        clip({ videoId: "screen", start: 2, end: 3 }),
      ],
    })

    expect(findMissingActiveSourceVideoIds(snapshot, {})).toEqual(["screen"])
  })

  it("formats source labels from video file names", () => {
    const snapshot = state({
      videos: [
        projectVideo({ id: "screen", fileName: "screen.mov" }),
        projectVideo({ id: "camera", fileName: "camera.mov" }),
      ],
    })

    expect(formatExportSourceList(snapshot, ["screen", "camera", "ghost"])).toBe(
      "screen.mov, camera.mov, ghost",
    )
  })
})
