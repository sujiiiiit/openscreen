"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import {
  CameraVideoIcon,
  ComputerVideoIcon,
  FolderLibraryIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { useProject } from "@/components/editor/project/provider"
import type { ProjectAsset, ProjectAssetAudioTrack } from "@/types/api"

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

function roleLabel(role: ProjectAsset["role"]): string {
  return role === "screen" ? "Screen" : "Camera"
}

function audioTrackLabel(track: ProjectAssetAudioTrack): string {
  const source = track.source === "microphone" ? "Mic" : "System audio"
  const parts: string[] = [source]
  if (track.sampleRate) {
    parts.push(`${Math.round(track.sampleRate / 100) / 10} kHz`)
  }
  if (track.channelCount) {
    parts.push(
      track.channelCount === 1
        ? "mono"
        : track.channelCount === 2
          ? "stereo"
          : `${track.channelCount}ch`,
    )
  }
  return parts.join(" · ")
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium tabular-nums">{value}</span>
    </div>
  )
}

function AssetTile({ asset }: { asset: ProjectAsset }) {
  const duration = formatDuration(asset.durationMs)
  const size = formatBytes(asset.fileSize)
  const dimensions =
    asset.width && asset.height ? `${asset.width} × ${asset.height}` : null

  return (
    <article className="flex flex-col gap-2 rounded-md border bg-muted/35 p-3">
      <header className="flex items-center gap-2">
        <span className="inline-flex size-7 items-center justify-center rounded-md bg-background text-foreground">
          <HugeiconsIcon
            icon={asset.role === "camera" ? CameraVideoIcon : ComputerVideoIcon}
            className="size-4"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={asset.fileName}>
            {asset.fileName}
          </p>
          <p className="text-xs text-muted-foreground">{roleLabel(asset.role)}</p>
        </div>
      </header>
      <div className="flex flex-col gap-1">
        {duration ? <MetadataRow label="Duration" value={duration} /> : null}
        {dimensions ? <MetadataRow label="Dimensions" value={dimensions} /> : null}
        {size ? <MetadataRow label="Size" value={size} /> : null}
        {asset.codec ? (
          <MetadataRow label="Codec" value={asset.codec.toUpperCase()} />
        ) : null}
        {asset.audioTracks.length > 0 ? (
          <div className="flex flex-col gap-1 pt-1">
            <span className="text-xs text-muted-foreground">Audio</span>
            <ul className="flex flex-col gap-0.5">
              {asset.audioTracks.map((track, index) => (
                <li
                  key={`${track.source}-${index}`}
                  className="text-xs font-medium tabular-nums"
                >
                  {audioTrackLabel(track)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </article>
  )
}

export function AssetsPanel() {
  const { project, isLoading, error, reload, openPicker } = useProject()

  return (
    <section className="flex w-full flex-col gap-4">
      <header className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold select-none">Assets</h3>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Refresh project"
            onClick={() => {
              void reload()
            }}
          >
            <HugeiconsIcon icon={Refresh01Icon} className="size-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground select-none">
          Files captured in the current project. Open another project to inspect a previous recording.
        </p>
        {project ? (
          <p
            className="truncate text-xs text-muted-foreground"
            title={project.path}
          >
            {project.name}
          </p>
        ) : null}
      </header>

      <Button
        type="button"
        variant="outline"
        className="w-full justify-start"
        onClick={() => {
          void openPicker()
        }}
      >
        <HugeiconsIcon icon={FolderLibraryIcon} data-icon="inline-start" />
        Open project folder
      </Button>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading project…</p>
      ) : project && project.assets.length > 0 ? (
        <div className="flex flex-col gap-3">
          {project.assets.map((asset) => (
            <AssetTile key={asset.filePath} asset={asset} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No project loaded. Record something or open a project folder.
        </p>
      )}
    </section>
  )
}
