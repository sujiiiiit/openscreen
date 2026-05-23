// IMPORTANT: this schema is the source of truth for the export-settings
// surface area. The renderer-facing copies in `types/api.d.ts` MUST mirror
// these exports until we collapse the two tsconfig roots into a shared
// workspace.

export type ExportFormatId = 'mp4-avc' | 'mp4-hevc' | 'webm-vp9'

export type ExportResolutionId =
  | 'artboard'
  | '720p'
  | '1080p'
  | '1440p'
  | '4k'

export type ExportFrameRate = 30 | 60

export interface ExportSettings {
  format: ExportFormatId
  resolution: ExportResolutionId
  fps: ExportFrameRate
}

export type ExportPhase =
  | 'idle'
  | 'preparing'
  | 'encoding'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'cancelled'

export interface ExportProgress {
  framesDone: number
  framesTotal: number
  // Best-effort wall-clock ETA in seconds. `null` until we have enough
  // samples to estimate (first ~30 frames). Encoder backpressure makes the
  // first second of any export non-representative.
  etaSeconds: number | null
}

export interface ExportJobState {
  phase: ExportPhase
  settings: ExportSettings
  progress: ExportProgress
  outputPath: string | null
  startedAtUnixMs: number | null
  lastError: string | null
}

export function defaultExportSettings(): ExportSettings {
  return {
    format: 'mp4-avc',
    // "Artboard" preserves the user's intentional canvas size exactly —
    // no implicit downscale, text stays as sharp as the source recording.
    // The preset dropdowns (720p/1080p/…) are opt-in resamples.
    resolution: 'artboard',
    // 60 fps matches the recorder's default frame rate, so a default
    // export of a default recording produces output with no temporal
    // downsample.
    fps: 60,
  }
}

const FORMAT_IDS: ExportFormatId[] = ['mp4-avc', 'mp4-hevc', 'webm-vp9']
const RESOLUTION_IDS: ExportResolutionId[] = [
  'artboard',
  '720p',
  '1080p',
  '1440p',
  '4k',
]
const FRAME_RATES: ExportFrameRate[] = [30, 60]

/**
 * Coerce a partial settings update onto a valid set. Unknown enum values are
 * replaced with defaults so the form can never wedge.
 */
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
    patch.fps !== undefined && FRAME_RATES.includes(patch.fps as ExportFrameRate)
      ? (patch.fps as ExportFrameRate)
      : defaults.fps
  return { format, resolution, fps }
}

export function exportContainerExtension(format: ExportFormatId): string {
  return format === 'webm-vp9' ? 'webm' : 'mp4'
}

// NOTE: the renderer-side `exportResolutionPixels` (in
// `lib/editor-project/export-settings.ts`) is the single source of truth for
// output-dimension math. We deliberately do NOT mirror it here: the renderer
// version applies both a long-edge cap and a per-preset pixel-count budget
// to avoid H.264 Level 5.2's 9.4 Mpx ceiling on near-square artboards, and
// keeping two implementations in lockstep proved fragile. The main process
// never needs the output dimensions today — the renderer hands the finished
// bytes back via `reportDone` — so there is no caller here to satisfy.
