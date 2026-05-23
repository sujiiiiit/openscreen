// Renderer-side coercion + dimension math for export settings. The
// renderer's tsconfig excludes `electron/`, so the basic helpers
// (`defaultExportSettings`, `coerceExportSettings`,
// `exportContainerExtension`) are mirrored from `electron/ipc/export-schema.ts`
// — those three MUST stay byte-equivalent across the two modules so the
// main process and the renderer agree on what a valid settings object
// looks like.
//
// `exportResolutionPixels` lives ONLY here. It applies a per-preset
// pixel-count budget on top of the long-edge fit to keep near-square
// artboards under H.264 Level 5.2's 9.4 Mpx ceiling — the encoder bumps to
// Level 6.0 above that limit, which most hardware encoders refuse. The
// main process never needs output dimensions today (the renderer hands
// finished bytes back via `reportDone`), so there is no electron-side
// duplicate to drift from. If a future feature needs dimensions in main,
// import this file there too rather than recreating the math.

import type {
  ExportFormatId,
  ExportFrameRate,
  ExportResolutionId,
  ExportSettings,
} from "@/types/api"

export function defaultExportSettings(): ExportSettings {
  return {
    format: "mp4-avc",
    // "Artboard" preserves the user's intentional canvas size exactly —
    // no implicit downscale, text stays as sharp as the source recording.
    // The preset dropdowns (720p/1080p/…) are opt-in resamples.
    resolution: "artboard",
    // 60 fps matches the recorder's default frame rate, so a default
    // export of a default recording produces output with no temporal
    // downsample.
    fps: 60,
  }
}

const FORMAT_IDS: ExportFormatId[] = ["mp4-avc", "mp4-hevc", "webm-vp9"]
const RESOLUTION_IDS: ExportResolutionId[] = [
  "artboard",
  "720p",
  "1080p",
  "1440p",
  "4k",
]
const FRAME_RATES: ExportFrameRate[] = [30, 60]

export function coerceExportSettings(
  patch: Partial<ExportSettings>,
): ExportSettings {
  const defaults = defaultExportSettings()
  const format: ExportFormatId =
    patch.format && FORMAT_IDS.includes(patch.format)
      ? patch.format
      : defaults.format
  const resolution: ExportResolutionId =
    patch.resolution && RESOLUTION_IDS.includes(patch.resolution)
      ? patch.resolution
      : defaults.resolution
  const fps: ExportFrameRate =
    patch.fps !== undefined &&
    FRAME_RATES.includes(patch.fps as ExportFrameRate)
      ? (patch.fps as ExportFrameRate)
      : defaults.fps
  return { format, resolution, fps }
}

export function exportContainerExtension(format: ExportFormatId): string {
  return format === "webm-vp9" ? "webm" : "mp4"
}

/**
 * Compute the export output dimensions for a preset + artboard aspect.
 *
 * The naive "long edge equals preset" rule (where 4K means width=3840)
 * breaks for non-16:9 artboards: a 1920×1247 artboard at the 4K preset
 * would give 3840×2493 — ~9.6 M pixels, above H.264 Level 5.2's 9.4 M
 * pixel ceiling. The encoder then has to bump to Level 6.0, which most
 * hardware encoders refuse, and the export fails.
 *
 * Instead we enforce **both** a long-edge cap AND a total-pixel budget
 * derived from the preset's nominal 16:9 box. Aspect is always preserved;
 * the binding constraint scales the smaller dimension down. So a tighter-
 * aspect artboard at "4K" lands at e.g. 3576×2322 (preserving aspect,
 * within Level 5.2's pixel limit) instead of 3840×2493 (over Level 5.2).
 */
export function exportResolutionPixels(
  resolution: ExportResolutionId,
  artboard: { width: number; height: number },
): { width: number; height: number } {
  if (resolution === "artboard") {
    return {
      width: evenize(artboard.width),
      height: evenize(artboard.height),
    }
  }

  const target = resolutionTarget(resolution)
  const aspect = artboard.width / artboard.height

  // Initial fit: anchor the long edge to the preset's long edge.
  let width: number
  let height: number
  if (aspect >= 1) {
    width = target.longEdge
    height = target.longEdge / aspect
  } else {
    height = target.longEdge
    width = target.longEdge * aspect
  }

  // Pixel-budget cap: scale both dimensions down (preserving aspect) if
  // the long-edge fit exceeded the preset's nominal pixel count. This is
  // what saves us from H.264 Level 6.0 on near-square artboards.
  const pixels = width * height
  if (pixels > target.maxPixels) {
    const scale = Math.sqrt(target.maxPixels / pixels)
    width *= scale
    height *= scale
  }

  return { width: evenize(width), height: evenize(height) }
}

interface ResolutionTarget {
  /** Maximum length of the longer dimension. */
  longEdge: number
  /** Maximum total pixels — derived from the preset's nominal 16:9 box. */
  maxPixels: number
}

function resolutionTarget(
  resolution: Exclude<ExportResolutionId, "artboard">,
): ResolutionTarget {
  switch (resolution) {
    case "720p":
      return { longEdge: 1280, maxPixels: 1280 * 720 }
    case "1080p":
      return { longEdge: 1920, maxPixels: 1920 * 1080 }
    case "1440p":
      return { longEdge: 2560, maxPixels: 2560 * 1440 }
    case "4k":
      return { longEdge: 3840, maxPixels: 3840 * 2160 }
  }
}

function evenize(value: number): number {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded + 1
}
