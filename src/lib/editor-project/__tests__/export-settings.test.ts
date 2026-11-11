import { describe, expect, it } from "vitest"

import {
  coerceExportSettings,
  defaultExportSettings,
  exportContainerExtension,
  exportResolutionPixels,
} from "@/lib/editor-project/export-settings"
import type {
  ExportFormatId,
  ExportFrameRate,
  ExportResolutionId,
} from "@/types/api"

describe("defaultExportSettings", () => {
  it("returns the documented baseline (mp4-avc / artboard / 60 fps)", () => {
    expect(defaultExportSettings()).toEqual({
      format: "mp4-avc",
      resolution: "artboard",
      fps: 60,
    })
  })
})

describe("coerceExportSettings", () => {
  it("returns defaults when patch is empty", () => {
    expect(coerceExportSettings({})).toEqual(defaultExportSettings())
  })

  it("preserves valid fields verbatim", () => {
    const out = coerceExportSettings({
      format: "mp4-hevc",
      resolution: "1440p",
      fps: 30,
    })
    expect(out).toEqual({ format: "mp4-hevc", resolution: "1440p", fps: 30 })
  })

  it("replaces unknown enum values with defaults", () => {
    const out = coerceExportSettings({
      format: "garbage" as unknown as ExportFormatId,
      resolution: "8k" as unknown as ExportResolutionId,
      fps: 24 as unknown as ExportFrameRate,
    })
    expect(out).toEqual(defaultExportSettings())
  })

  it("merges partial valid fields with defaults", () => {
    const out = coerceExportSettings({ format: "webm-vp9" })
    expect(out).toEqual({
      format: "webm-vp9",
      resolution: "artboard",
      fps: 60,
    })
  })
})

describe("exportContainerExtension", () => {
  it("maps each format to the right container", () => {
    expect(exportContainerExtension("mp4-avc")).toBe("mp4")
    expect(exportContainerExtension("mp4-hevc")).toBe("mp4")
    expect(exportContainerExtension("webm-vp9")).toBe("webm")
  })
})

describe("exportResolutionPixels", () => {
  it("artboard preset passes width/height through and evenizes", () => {
    expect(
      exportResolutionPixels("artboard", { width: 1920, height: 1080 }),
    ).toEqual({ width: 1920, height: 1080 })
    // Odd input → next-even rounding.
    expect(
      exportResolutionPixels("artboard", { width: 1921, height: 1081 }),
    ).toEqual({ width: 1922, height: 1082 })
  })

  it("16:9 artboards land on the preset's nominal long edge", () => {
    expect(
      exportResolutionPixels("1080p", { width: 1920, height: 1080 }),
    ).toEqual({ width: 1920, height: 1080 })
    expect(
      exportResolutionPixels("720p", { width: 1920, height: 1080 }),
    ).toEqual({ width: 1280, height: 720 })
    expect(
      exportResolutionPixels("4k", { width: 1920, height: 1080 }),
    ).toEqual({ width: 3840, height: 2160 })
  })

  it("preserves aspect for non-16:9 artboards", () => {
    // 4:3 artboard at 1080p preset. The aspect cap binds (long-edge fit
    // would give 1920×1440 = 2.76 Mpx, above the 1080p budget of 2.07
    // Mpx), so the result is scaled to stay under the budget while
    // keeping the aspect ratio.
    const r = exportResolutionPixels("1080p", { width: 1024, height: 768 })
    // Aspect preserved within evenize rounding (one-frame tolerance).
    expect(r.width / r.height).toBeCloseTo(1024 / 768, 1)
    // Result is under the nominal budget (small evenize slack allowed).
    const budget = 1920 * 1080
    expect(r.width * r.height).toBeLessThanOrEqual(Math.ceil(budget * 1.005))
  })

  it("caps total pixels at each preset's nominal budget", () => {
    // The bug this prevents: 1920×1247 (near-square) at 4K preset would,
    // under naive long-edge fit, yield 3840×2493 ≈ 9.57 Mpx, which is
    // ABOVE H.264 Level 5.2's 9.4 Mpx ceiling. The pixel-budget cap
    // forces the output back under the preset's nominal 4K pixel count.
    //
    // The cap is "nominal" — evenize rounding can push the final pixel
    // count up to ~0.5% above the bare budget because each dimension is
    // rounded UP to the next even number when the cap-scaled value is
    // odd. That's still well under H.264 Level 5.2's 9.4 Mpx ceiling, so
    // the cap does its job.
    const r = exportResolutionPixels("4k", { width: 1920, height: 1247 })
    const budget = 3840 * 2160
    expect(r.width * r.height).toBeLessThanOrEqual(Math.ceil(budget * 1.005))
    // Still comfortably under Level 5.2 (9.4 Mpx).
    expect(r.width * r.height).toBeLessThan(9_437_184)
    expect(r.width / r.height).toBeCloseTo(1920 / 1247, 1)
  })

  it("returns even dimensions (AVC/HEVC reject odd)", () => {
    const probes: Array<{ width: number; height: number }> = [
      { width: 1280, height: 720 },
      { width: 1919, height: 1079 },
      { width: 999, height: 333 },
      { width: 2521, height: 1683 },
    ]
    for (const probe of probes) {
      for (const res of ["720p", "1080p", "1440p", "4k", "artboard"] as const) {
        const out = exportResolutionPixels(res, probe)
        expect(out.width % 2).toBe(0)
        expect(out.height % 2).toBe(0)
      }
    }
  })

  it("never returns a dimension less than 2", () => {
    const r = exportResolutionPixels("artboard", { width: 1, height: 1 })
    expect(r.width).toBeGreaterThanOrEqual(2)
    expect(r.height).toBeGreaterThanOrEqual(2)
  })
})
