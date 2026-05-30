import { describe, expect, it } from "vitest"

import {
  serializeProjectState,
  serializeVideo,
} from "@/components/editor/canvas/persistence"
import { parseProjectState } from "@/electron/ipc/project-schema"
import type { CanvasVideoItem, EditorArtboard } from "@/types/editor-canvas"

const ARTBOARD: EditorArtboard = {
  presetId: "wide",
  width: 1920,
  height: 1080,
  background: null,
  grain: 0,
  padding: 0,
  cursorCustomRenderingEnabled: true,
  cursorSetId: "macos",
  cursorSizeMultiplier: 1,
  cursorMotionBlur: 0,
  cursorMotionRotation: 0.35,
  cursorMotionRotationMode: "side-lean",
  cursorMotionBlurBackend: "gpu",
  cursorSmoothingMode: "default",
  cursorClickPressScale: 0.88,
  cursorAlwaysUsePointer: false,
}

function canvasVideo(
  partial: Partial<CanvasVideoItem> & { id: string }
): CanvasVideoItem {
  const { id, ...rest } = partial
  return {
    id,
    fileName: `${id}.mov`,
    objectUrl: `file:///tmp/${id}.mov`,
    fileSize: 1234,
    source: {
      kind: "imported",
      relativePath: `assets/videos/${id}/${id}.mov`,
      fileSize: 1234,
    },
    intrinsicWidth: 1920,
    intrinsicHeight: 1080,
    durationMs: 5000,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
    locked: false,
    role: "media",
    cornerRadius: 0,
    cornerSmoothing: 0.6,
    borderWidth: 0,
    borderColor: "#000000",
    borderOffset: 0,
    borderAlignment: "inside",
    shadowColor: "rgba(0, 0, 0, 0.25)",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowSpread: 0,
    ...rest,
  }
}

// Round-trip a serialized state through JSON + the schema validator, exactly
// like main does when it reads project.json back off disk.
function roundTrip(state: ReturnType<typeof serializeProjectState>) {
  return parseProjectState(JSON.parse(JSON.stringify(state)))
}

describe("serializeVideo onCanvas flag", () => {
  it("omits onCanvas for on-canvas videos so legacy project.json stays byte-identical", () => {
    const serialized = serializeVideo(canvasVideo({ id: "a" }), true)
    expect("onCanvas" in serialized).toBe(false)
  })

  it("writes onCanvas: false for detached videos", () => {
    const serialized = serializeVideo(canvasVideo({ id: "a" }), false)
    expect(serialized.onCanvas).toBe(false)
  })

  it("defaults to on-canvas when the flag is omitted", () => {
    const serialized = serializeVideo(canvasVideo({ id: "a" }))
    expect("onCanvas" in serialized).toBe(false)
  })
})

describe("serializeProjectState with detached videos", () => {
  it("appends detached videos after on-canvas videos and preserves the flag through a round-trip", () => {
    const onCanvas = [canvasVideo({ id: "screen" }), canvasVideo({ id: "cam" })]
    const detached = [canvasVideo({ id: "removed" })]
    const clips = [
      {
        id: "screen:clip",
        videoId: "screen",
        start: 0,
        end: 5,
        sourceIn: 0,
        sourceOut: 5,
      },
    ]

    const parsed = roundTrip(
      serializeProjectState(ARTBOARD, onCanvas, clips, detached)
    )

    expect(parsed).not.toBeNull()
    expect(parsed!.videos.map((video) => video.id)).toEqual([
      "screen",
      "cam",
      "removed",
    ])
    // On-canvas videos have no onCanvas field; the detached one is false.
    expect(parsed!.videos[0].onCanvas).toBeUndefined()
    expect(parsed!.videos[1].onCanvas).toBeUndefined()
    expect(parsed!.videos[2].onCanvas).toBe(false)
    // Detached videos carry no timeline clip.
    expect(parsed!.timelineClips.map((clip) => clip.videoId)).toEqual([
      "screen",
    ])
  })

  it("defaults detached to an empty list (export snapshot path) — every video stays on-canvas", () => {
    const parsed = roundTrip(
      serializeProjectState(ARTBOARD, [canvasVideo({ id: "a" })], [])
    )
    expect(parsed!.videos).toHaveLength(1)
    expect(parsed!.videos[0].onCanvas).toBeUndefined()
  })
})

describe("cursor motion blur backend persistence", () => {
  it("preserves the selected backend through a round-trip", () => {
    const parsed = roundTrip(
      serializeProjectState(
        { ...ARTBOARD, cursorMotionBlurBackend: "cpu" },
        [canvasVideo({ id: "a" })],
        []
      )
    )

    expect(parsed).not.toBeNull()
    expect(parsed!.artboard.cursorMotionBlurBackend).toBe("cpu")
  })

  it("defaults an invalid backend to gpu for legacy/hand-edited projects", () => {
    const parsed = parseProjectState({
      version: 1,
      artboard: {
        presetId: "wide",
        width: 1920,
        height: 1080,
        background: null,
        padding: 0,
        grain: 0,
        cursorMotionBlurBackend: "webgpu",
      },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })

    expect(parsed).not.toBeNull()
    expect(parsed!.artboard.cursorMotionBlurBackend).toBe("gpu")
  })
})

describe("cursor motion rotation persistence", () => {
  it("preserves the selected motion rotation through a round-trip", () => {
    const parsed = roundTrip(
      serializeProjectState(
        { ...ARTBOARD, cursorMotionRotation: 0.72 },
        [canvasVideo({ id: "a" })],
        []
      )
    )

    expect(parsed).not.toBeNull()
    expect(parsed!.artboard.cursorMotionRotation).toBe(0.72)
  })

  it("preserves the selected motion rotation mode through a round-trip", () => {
    const parsed = roundTrip(
      serializeProjectState(
        { ...ARTBOARD, cursorMotionRotationMode: "rotation" },
        [canvasVideo({ id: "a" })],
        []
      )
    )

    expect(parsed).not.toBeNull()
    expect(parsed!.artboard.cursorMotionRotationMode).toBe("rotation")
  })

  it("defaults missing and invalid motion rotation mode to side-lean", () => {
    const base = {
      presetId: "wide",
      width: 1920,
      height: 1080,
      background: null,
      padding: 0,
      grain: 0,
    }
    const legacy = parseProjectState({
      version: 1,
      artboard: base,
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })
    const invalid = parseProjectState({
      version: 1,
      artboard: { ...base, cursorMotionRotationMode: "spin" },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })

    expect(legacy).not.toBeNull()
    expect(legacy!.artboard.cursorMotionRotationMode).toBe("side-lean")
    expect(invalid).not.toBeNull()
    expect(invalid!.artboard.cursorMotionRotationMode).toBe("side-lean")
  })

  it("defaults missing and invalid motion rotation to 0.35", () => {
    const base = {
      presetId: "wide",
      width: 1920,
      height: 1080,
      background: null,
      padding: 0,
      grain: 0,
    }
    const legacy = parseProjectState({
      version: 1,
      artboard: base,
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })
    const invalid = parseProjectState({
      version: 1,
      artboard: { ...base, cursorMotionRotation: "heavy" },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })

    expect(legacy).not.toBeNull()
    expect(legacy!.artboard.cursorMotionRotation).toBe(0.35)
    expect(invalid).not.toBeNull()
    expect(invalid!.artboard.cursorMotionRotation).toBe(0.35)
  })

  it("clamps motion rotation into the supported range", () => {
    const base = {
      presetId: "wide",
      width: 1920,
      height: 1080,
      background: null,
      padding: 0,
      grain: 0,
    }
    const tooSmall = parseProjectState({
      version: 1,
      artboard: { ...base, cursorMotionRotation: -1 },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })
    const tooLarge = parseProjectState({
      version: 1,
      artboard: { ...base, cursorMotionRotation: 2 },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })

    expect(tooSmall).not.toBeNull()
    expect(tooSmall!.artboard.cursorMotionRotation).toBe(0)
    expect(tooLarge).not.toBeNull()
    expect(tooLarge!.artboard.cursorMotionRotation).toBe(1)
  })
})

describe("custom cursor rendering persistence", () => {
  it("preserves disabled custom cursor rendering through a round-trip", () => {
    const parsed = roundTrip(
      serializeProjectState(
        { ...ARTBOARD, cursorCustomRenderingEnabled: false },
        [canvasVideo({ id: "a" })],
        []
      )
    )

    expect(parsed).not.toBeNull()
    expect(parsed!.artboard.cursorCustomRenderingEnabled).toBe(false)
  })

  it("defaults missing and non-false values to enabled for legacy/hand-edited projects", () => {
    const legacy = parseProjectState({
      version: 1,
      artboard: {
        presetId: "wide",
        width: 1920,
        height: 1080,
        background: null,
        padding: 0,
        grain: 0,
      },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })
    const invalid = parseProjectState({
      version: 1,
      artboard: {
        presetId: "wide",
        width: 1920,
        height: 1080,
        background: null,
        padding: 0,
        grain: 0,
        cursorCustomRenderingEnabled: "no",
      },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })

    expect(legacy).not.toBeNull()
    expect(legacy!.artboard.cursorCustomRenderingEnabled).toBe(true)
    expect(invalid).not.toBeNull()
    expect(invalid!.artboard.cursorCustomRenderingEnabled).toBe(true)
  })
})

describe("cursor style persistence", () => {
  it("preserves the selected cursor set through a round-trip", () => {
    const parsed = roundTrip(
      serializeProjectState(
        { ...ARTBOARD, cursorSetId: "halloween" },
        [canvasVideo({ id: "a" })],
        []
      )
    )

    expect(parsed).not.toBeNull()
    expect(parsed!.artboard.cursorSetId).toBe("halloween")
  })

  it("defaults missing and invalid cursor sets to macos for legacy/hand-edited projects", () => {
    const legacy = parseProjectState({
      version: 1,
      artboard: {
        presetId: "wide",
        width: 1920,
        height: 1080,
        background: null,
        padding: 0,
        grain: 0,
      },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })
    const invalid = parseProjectState({
      version: 1,
      artboard: {
        presetId: "wide",
        width: 1920,
        height: 1080,
        background: null,
        padding: 0,
        grain: 0,
        cursorSetId: "made-up",
      },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })

    expect(legacy).not.toBeNull()
    expect(legacy!.artboard.cursorSetId).toBe("macos")
    expect(invalid).not.toBeNull()
    expect(invalid!.artboard.cursorSetId).toBe("macos")
  })
})

describe("cursor smoothing persistence", () => {
  it("preserves the selected smoothing mode through a round-trip", () => {
    const parsed = roundTrip(
      serializeProjectState(
        { ...ARTBOARD, cursorSmoothingMode: "slow" },
        [canvasVideo({ id: "a" })],
        []
      )
    )

    expect(parsed).not.toBeNull()
    expect(parsed!.artboard.cursorSmoothingMode).toBe("slow")
  })

  it("defaults an invalid smoothing mode to default for legacy/hand-edited projects", () => {
    const parsed = parseProjectState({
      version: 1,
      artboard: {
        presetId: "wide",
        width: 1920,
        height: 1080,
        background: null,
        padding: 0,
        grain: 0,
        cursorSmoothingMode: "raw",
      },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })

    expect(parsed).not.toBeNull()
    expect(parsed!.artboard.cursorSmoothingMode).toBe("default")
  })
})

describe("cursor click press scale persistence", () => {
  it("preserves the selected click press scale through a round-trip", () => {
    const parsed = roundTrip(
      serializeProjectState(
        { ...ARTBOARD, cursorClickPressScale: 0.72 },
        [canvasVideo({ id: "a" })],
        []
      )
    )

    expect(parsed).not.toBeNull()
    expect(parsed!.artboard.cursorClickPressScale).toBe(0.72)
  })

  it("defaults and clamps click press scale for legacy/hand-edited projects", () => {
    const legacy = parseProjectState({
      version: 1,
      artboard: {
        presetId: "wide",
        width: 1920,
        height: 1080,
        background: null,
        padding: 0,
        grain: 0,
      },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })
    const tooSmall = parseProjectState({
      version: 1,
      artboard: {
        presetId: "wide",
        width: 1920,
        height: 1080,
        background: null,
        padding: 0,
        grain: 0,
        cursorClickPressScale: 0.2,
      },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })

    expect(legacy).not.toBeNull()
    expect(legacy!.artboard.cursorClickPressScale).toBe(0.88)
    expect(tooSmall).not.toBeNull()
    expect(tooSmall!.artboard.cursorClickPressScale).toBe(0.5)
  })
})

describe("cursor pointer override persistence", () => {
  it("preserves the always-use-pointer setting through a round-trip", () => {
    const parsed = roundTrip(
      serializeProjectState(
        { ...ARTBOARD, cursorAlwaysUsePointer: true },
        [canvasVideo({ id: "a" })],
        []
      )
    )

    expect(parsed).not.toBeNull()
    expect(parsed!.artboard.cursorAlwaysUsePointer).toBe(true)
  })

  it("defaults non-true values to false for legacy/hand-edited projects", () => {
    const legacy = parseProjectState({
      version: 1,
      artboard: {
        presetId: "wide",
        width: 1920,
        height: 1080,
        background: null,
        padding: 0,
        grain: 0,
      },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })
    const invalid = parseProjectState({
      version: 1,
      artboard: {
        presetId: "wide",
        width: 1920,
        height: 1080,
        background: null,
        padding: 0,
        grain: 0,
        cursorAlwaysUsePointer: "yes",
      },
      videos: [],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })

    expect(legacy).not.toBeNull()
    expect(legacy!.artboard.cursorAlwaysUsePointer).toBe(false)
    expect(invalid).not.toBeNull()
    expect(invalid!.artboard.cursorAlwaysUsePointer).toBe(false)
  })
})

describe("parseProjectState onCanvas tolerance", () => {
  it("treats a legacy record with no onCanvas field as on-canvas (undefined)", () => {
    const legacy = roundTrip(
      serializeProjectState(ARTBOARD, [canvasVideo({ id: "a" })], [])
    )
    expect(legacy!.videos[0].onCanvas).toBeUndefined()
  })

  it("ignores a non-boolean onCanvas value", () => {
    const parsed = parseProjectState({
      version: 1,
      artboard: {
        presetId: "wide",
        width: 1920,
        height: 1080,
        background: null,
        padding: 0,
        grain: 0,
      },
      videos: [
        {
          ...serializeVideo(canvasVideo({ id: "a" })),
          onCanvas: "yes",
        },
      ],
      timelineClips: [],
      updatedAtUnixMs: 0,
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.videos[0].onCanvas).toBeUndefined()
  })
})
