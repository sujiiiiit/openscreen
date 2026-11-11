import {
  canEncodeVideo,
  canEncodeAudio,
  type VideoCodec,
} from "mediabunny"

import type {
  ExportCodecSupport,
  ExportFormatId,
  ExportResolutionId,
  ExportFrameRate,
} from "@/types/api"
import { exportResolutionPixels } from "@/lib/editor-project/export-settings"

interface ProbeOptions {
  artboard: { width: number; height: number }
  resolution: ExportResolutionId
  // Reserved for the future when canEncodeVideo gains a framerate probe.
  // Today the probe only takes width/height/bitrate so fps is informational.
  fps?: ExportFrameRate
}

/**
 * Returns whether each export format is encodable on the current runtime.
 * Probes Mediabunny's codec/dimension check rather than guessing — Electron's
 * Chromium has H.264 + VP9 universally, HEVC encode depends on the
 * underlying OS/GPU.
 */
export async function probeExportFormats(
  options: ProbeOptions,
): Promise<ExportCodecSupport[]> {
  const { width, height } = exportResolutionPixels(
    options.resolution,
    options.artboard,
  )
  const results: ExportCodecSupport[] = []
  for (const format of FORMATS) {
    const codec = formatToVideoCodec(format)
    try {
      const ok = await canEncodeVideo(codec, { width, height })
      results.push({ format, supported: ok })
    } catch {
      results.push({ format, supported: false })
    }
  }
  return results
}

export async function probeAudioSupport(): Promise<boolean> {
  try {
    return await canEncodeAudio("aac", {
      numberOfChannels: 2,
      sampleRate: 48_000,
    })
  } catch {
    return false
  }
}

const FORMATS: ExportFormatId[] = ["mp4-avc", "mp4-hevc", "webm-vp9"]

export function formatToVideoCodec(format: ExportFormatId): VideoCodec {
  switch (format) {
    case "mp4-avc":
      return "avc"
    case "mp4-hevc":
      return "hevc"
    case "webm-vp9":
      return "vp9"
  }
}
