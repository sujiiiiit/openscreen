import { describe, expect, test } from "vitest"

import type { CanvasVideoItem } from "@/types/editor-canvas"

import {
  ARTBOARD_PRESETS,
  resolveAutoArtboard,
  resolveAutoSourceDims,
} from "./editor-canvas"

function video(
  id: string,
  partial: Partial<CanvasVideoItem> = {}
): CanvasVideoItem {
  return {
    id,
    fileName: `${id}.mov`,
    objectUrl: "",
    fileSize: 0,
    source: { kind: "recording", assetRole: "screen" },
    intrinsicWidth: 1920,
    intrinsicHeight: 1080,
    durationMs: 1000,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    locked: false,
    role: "screen",
    cornerRadius: 0,
    cornerSmoothing: 0,
    borderWidth: 0,
    borderColor: "#000000",
    borderOffset: 0,
    borderAlignment: "center",
    ...partial,
  }
}

describe("resolveAutoSourceDims", () => {
  test("prefers the hydrated screen-source dims over canvas videos", () => {
    expect(
      resolveAutoSourceDims({ width: 3456, height: 2234 }, [
        video("a", { intrinsicWidth: 1280, intrinsicHeight: 720 }),
      ])
    ).toEqual({ width: 3456, height: 2234 })
  })

  test("falls back to the screen-role canvas video's intrinsic size", () => {
    expect(
      resolveAutoSourceDims(null, [
        video("import", {
          role: "media",
          intrinsicWidth: 1280,
          intrinsicHeight: 720,
        }),
        video("screen", { intrinsicWidth: 3456, intrinsicHeight: 2234 }),
      ])
    ).toEqual({ width: 3456, height: 2234 })
  })

  test("falls back to the first on-canvas video with known dims (imports)", () => {
    expect(
      resolveAutoSourceDims(null, [
        video("broken", {
          role: "media",
          intrinsicWidth: 0,
          intrinsicHeight: 0,
        }),
        video("import", {
          role: "media",
          intrinsicWidth: 2560,
          intrinsicHeight: 1440,
        }),
      ])
    ).toEqual({ width: 2560, height: 1440 })
  })

  test("returns null with no source so resolveAutoArtboard falls back to Wide", () => {
    const dims = resolveAutoSourceDims(null, [])
    expect(dims).toBeNull()
    expect(resolveAutoArtboard(dims)).toEqual({
      width: ARTBOARD_PRESETS[0].width,
      height: ARTBOARD_PRESETS[0].height,
    })
  })
})
