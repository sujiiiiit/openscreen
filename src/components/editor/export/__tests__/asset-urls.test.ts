import { describe, expect, it } from "vitest"

import { buildExportAssetUrlsByVideoId } from "@/components/editor/export/asset-urls"
import type { CanvasVideoItem } from "@/types/editor-canvas"

function video(partial: Partial<CanvasVideoItem> & { id: string }) {
  const { id, ...rest } = partial
  return {
    id,
    fileName: `${id}.mov`,
    objectUrl: partial.objectUrl ?? "",
    fileSize: 1,
    source: { kind: "recording", assetRole: "screen" },
    intrinsicWidth: 1920,
    intrinsicHeight: 1080,
    durationMs: 1000,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
    locked: false,
    role: "screen",
    cornerRadius: 0,
    cornerSmoothing: 0.6,
    borderWidth: 0,
    borderColor: "#000000",
    borderOffset: 0,
    borderAlignment: "inside",
    ...rest,
  } satisfies CanvasVideoItem
}

describe("buildExportAssetUrlsByVideoId", () => {
  it("uses live canvas video URLs for freshly synthesized recordings", () => {
    const urls = buildExportAssetUrlsByVideoId(
      [video({ id: "project:screen", objectUrl: "file:///screen.mov" })],
      {},
    )

    expect(urls).toEqual({ "project:screen": "file:///screen.mov" })
  })

  it("prefers the live URL over a stale project-summary URL", () => {
    const urls = buildExportAssetUrlsByVideoId(
      [video({ id: "asset", objectUrl: "file:///new.mov" })],
      { asset: "file:///old.mov" },
    )

    expect(urls).toEqual({ asset: "file:///new.mov" })
  })

  it("falls back to the project-summary URL when the runtime URL is empty", () => {
    const urls = buildExportAssetUrlsByVideoId(
      [video({ id: "asset", objectUrl: "" })],
      { asset: "file:///saved.mov" },
    )

    expect(urls).toEqual({ asset: "file:///saved.mov" })
  })

  it("drops stale project-summary entries for videos outside the snapshot", () => {
    const urls = buildExportAssetUrlsByVideoId(
      [video({ id: "current", objectUrl: "file:///current.mov" })],
      {
        current: "file:///saved-current.mov",
        deleted: "file:///deleted.mov",
      },
    )

    expect(urls).toEqual({ current: "file:///current.mov" })
  })
})
