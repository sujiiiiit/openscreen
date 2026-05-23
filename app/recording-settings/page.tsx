"use client"

import React, { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DRAG, NO_DRAG } from "@/lib/window-drag"
import { cn } from "@/lib/utils"
import type { RecordingQualitySettings } from "@/types/api"
import type {
  ContainerFormat,
  FrameRate,
  ResolutionMode,
  VideoCodec,
  VideoQuality,
} from "@openscreen/mac-addon"

const DEFAULT_SETTINGS: RecordingQualitySettings = {
  videoCodec: "hevc",
  videoQuality: "high",
  container: "mov",
  resolutionMode: "native",
  frameRate: 60,
}

const CODEC_LABELS: Record<VideoCodec, string> = {
  hevc: "HEVC (H.265) — best balance",
  h264: "H.264 — maximum compatibility",
}

const QUALITY_LABELS: Record<VideoQuality, string> = {
  low: "Low — smallest files",
  medium: "Medium — balanced",
  high: "High — default",
  xhigh: "Extra High — near-lossless",
  max: "Max — minimal compression",
}

const CONTAINER_LABELS: Record<ContainerFormat, string> = {
  mov: "QuickTime (.mov)",
  mp4: "MPEG-4 (.mp4)",
}

const RESOLUTION_LABELS: Record<ResolutionMode, string> = {
  native: "Native (Retina pixels)",
  logical: "Logical (1× points)",
}

const FRAME_RATE_LABELS: Record<FrameRate, string> = {
  0: "Native (up to 120 fps)",
  24: "24 fps — cinematic",
  30: "30 fps",
  60: "60 fps (default)",
}

// Bits-per-pixel table mirrors the native ScreenTrack -resolveOptions logic.
// Used only for the local "estimated bitrate" preview — the canonical value
// lives in the manifest the writer produces.
function bitsPerPixel(codec: VideoCodec, quality: VideoQuality): number {
  const isHEVC = codec === "hevc"
  if (quality === "low") return isHEVC ? 0.02 : 0.04
  if (quality === "medium") return isHEVC ? 0.15 : 0.2
  if (quality === "xhigh") return isHEVC ? 0.8 : 1.2
  if (quality === "max") return isHEVC ? 1.6 : 2.4
  return isHEVC ? 0.4 : 0.6 // high (default)
}

function estimatedBitrateLabel(
  codec: VideoCodec,
  quality: VideoQuality,
  frameRate: FrameRate,
): string {
  // 1920×1080 baseline for a friendly number; users won't know their actual
  // pixel size at config time anyway. The label is illustrative.
  const w = 1920
  const h = 1080
  const fps = frameRate === 0 ? 60 : frameRate
  const mbps = Math.round((w * h * fps * bitsPerPixel(codec, quality)) / 1_000_000)
  return `~${mbps} Mbps at 1920×1080 ${fps} fps`
}

// Renders a labeled row with a header, optional sublabel, and a control
// (passed via `children`). Keeps the form scannable without pulling in a
// full form library.
function SettingRow({
  label,
  description,
  disabled,
  children,
}: {
  label: string
  description?: React.ReactNode
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 py-2.5",
        disabled && "opacity-50",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] leading-tight">{label}</span>
        {description ? (
          <span className="text-muted-foreground text-[11px] leading-snug">
            {description}
          </span>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

interface SelectOption<T extends string | number> {
  value: T
  label: string
  disabled?: boolean
}

// Minimal Select built on the existing DropdownMenu primitives. base-ui
// doesn't ship a styled <select> in this project; reusing DropdownMenu keeps
// the visual language consistent with the rest of the recorder UI.
function Select<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  width = 220,
}: {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (next: T) => void
  disabled?: boolean
  width?: number
}) {
  const current = options.find((o) => o.value === value) ?? options[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            style={{ ...NO_DRAG, minWidth: width }}
            className="justify-between"
          >
            <span className="truncate">{current?.label}</span>
            <span className="text-muted-foreground ml-2 text-xs">▾</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" style={{ minWidth: width }}>
        {options.map((option) => (
          <DropdownMenuItem
            key={String(option.value)}
            disabled={option.disabled}
            onClick={() => {
              if (option.disabled) return
              onChange(option.value)
            }}
            text={option.label}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default function RecordingSettingsPage() {
  const [settings, setSettings] = useState<RecordingQualitySettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!window.api?.recorder?.getRecordingSettings) {
      // Renderer mounted outside Electron (tests, storybook). Keep defaults.
      setLoading(false)
      return
    }
    let cancelled = false
    window.api.recorder.getRecordingSettings().then((value) => {
      if (cancelled) return
      setSettings(value)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Apply a partial update. The main process is authoritative — it returns
  // the resolved result, which we use to overwrite local state.
  const patch = async (next: Partial<RecordingQualitySettings>) => {
    if (!window.api?.recorder?.setRecordingSettings) {
      setSettings((current) => ({ ...current, ...next }))
      return
    }
    const resolved = await window.api.recorder.setRecordingSettings(next)
    setSettings(resolved)
  }

  const codecOptions: SelectOption<VideoCodec>[] = useMemo(
    () =>
      (Object.keys(CODEC_LABELS) as VideoCodec[]).map((codec) => ({
        value: codec,
        label: CODEC_LABELS[codec],
      })),
    [],
  )
  const qualityOptions: SelectOption<VideoQuality>[] = useMemo(
    () =>
      (Object.keys(QUALITY_LABELS) as VideoQuality[]).map((q) => ({
        value: q,
        label: QUALITY_LABELS[q],
      })),
    [],
  )
  const containerOptions: SelectOption<ContainerFormat>[] = useMemo(
    () =>
      (Object.keys(CONTAINER_LABELS) as ContainerFormat[]).map((c) => ({
        value: c,
        label: CONTAINER_LABELS[c],
      })),
    [],
  )
  const resolutionOptions: SelectOption<ResolutionMode>[] = useMemo(
    () =>
      (Object.keys(RESOLUTION_LABELS) as ResolutionMode[]).map((r) => ({
        value: r,
        label: RESOLUTION_LABELS[r],
      })),
    [],
  )
  const frameRateOptions: SelectOption<FrameRate>[] = useMemo(
    () =>
      ([0, 24, 30, 60] as FrameRate[]).map((fr) => ({
        value: fr,
        label: FRAME_RATE_LABELS[fr],
      })),
    [],
  )


  return (
    <div
      data-window="recording-settings"
      className="text-foreground flex h-screen flex-col bg-transparent"
      style={DRAG}
    >
      <header className="flex items-center justify-between px-5 pt-4 pb-3">
        <div>
          <h1 className="text-[13px] font-medium leading-tight">
           Settings
          </h1>
         
        </div>
        <Button
          variant="ghost"
          size="sm"
          style={NO_DRAG}
          onClick={() => window.close()}
        >
          Done
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-5" style={NO_DRAG}>
        {loading ? (
          <div className="text-muted-foreground py-4 text-sm">Loading…</div>
        ) : (
          <>
            <section>
             
              <SettingRow label="Codec">
                <Select
                  value={settings.videoCodec}
                  options={codecOptions}
                  onChange={(value) => patch({ videoCodec: value })}
                />
              </SettingRow>
              <SettingRow
                label="Quality"
                description="Bitrate preset for H.264 / HEVC."
              >
                <Select
                  value={settings.videoQuality}
                  options={qualityOptions}
                  onChange={(value) => patch({ videoQuality: value })}
                />
              </SettingRow>
              <SettingRow
                label="Container"
                description="MP4 is universally compatible; MOV is QuickTime-native."
              >
                <Select
                  value={settings.container}
                  options={containerOptions}
                  onChange={(value) => patch({ container: value })}
                />
              </SettingRow>
              <SettingRow
                label="Resolution"
                description="Native captures at the display's true pixel size."
              >
                <Select
                  value={settings.resolutionMode}
                  options={resolutionOptions}
                  onChange={(value) => patch({ resolutionMode: value })}
                />
              </SettingRow>
              <SettingRow
                label="Frame rate"
                description="Native follows the display refresh up to 120 fps."
              >
                <Select
                  value={settings.frameRate}
                  options={frameRateOptions}
                  onChange={(value) => patch({ frameRate: value })}
                />
              </SettingRow>
            </section>

           
          </>
        )}
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground pt-4 pb-1 text-[10px] font-medium uppercase tracking-wider">
      {children}
    </div>
  )
}
