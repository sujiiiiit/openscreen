"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { RefreshIcon } from "@hugeicons/core-free-icons"

import {
  useEditorCanvasArtboard,
  useEditorCanvasMedia,
  useEditorCanvasTimeline,
  useEditorCanvasTimelineActions,
} from "@/components/editor/canvas/provider"
import { getZoomVisibleWindow } from "@/components/editor/canvas/zoom-scene"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  ZOOM_FOCUS_DEFAULT,
  ZOOM_RADIAL_BLUR_DEFAULT,
  ZOOM_SCALE_DEFAULT,
  ZOOM_SCALE_MAX,
  ZOOM_TRANSITION_DURATION_MS_DEFAULT,
  ZOOM_TRANSITION_DURATION_MS_MAX,
  ZOOM_TRANSITION_DURATION_MS_MIN,
  clampZoomFocus,
} from "@/lib/zoom-clips"
import { cn } from "@/lib/utils"
import type { CanvasVideoItem, CanvasZoomClip } from "@/types/editor-canvas"

function AdjustmentRow({
  label,
  value,
  min,
  max,
  step,
  formatValue,
  onValueChange,
  onReset,
  resetDisabled,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  formatValue: (value: number) => string
  onValueChange: (value: number) => void
  onReset: () => void
  resetDisabled?: boolean
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold select-none">{label}</h4>
        <span className="text-[11px] font-medium text-muted-foreground tabular-nums">
          {formatValue(value)}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Slider
          size="sm"
          value={[value]}
          min={min}
          max={max}
          step={step}
          showValueTooltip
          formatValue={formatValue}
          onValueChange={(values) =>
            onValueChange(Array.isArray(values) ? values[0] : values)
          }
          className="flex-1"
        />
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={onReset}
          disabled={resetDisabled}
        >
          Reset
        </Button>
      </div>
    </div>
  )
}

function ZoomPreviewVideo({
  video,
  sourceTime,
  artboardWidth,
  artboardHeight,
}: {
  video: CanvasVideoItem
  sourceTime: number
  artboardWidth: number
  artboardHeight: number
}) {
  const ref = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.pause()
    const seek = () => {
      try {
        node.currentTime = Math.max(0, sourceTime)
      } catch {
        // File-backed media can briefly reject early seeks before metadata.
      }
    }
    if (node.readyState >= 1) {
      seek()
      return
    }
    node.addEventListener("loadedmetadata", seek, { once: true })
    return () => node.removeEventListener("loadedmetadata", seek)
  }, [sourceTime, video.objectUrl])

  return (
    <video
      ref={ref}
      src={video.objectUrl}
      muted
      playsInline
      preload="metadata"
      className="absolute bg-black object-cover"
      style={{
        left: `${(video.x / artboardWidth) * 100}%`,
        top: `${(video.y / artboardHeight) * 100}%`,
        width: `${(video.width / artboardWidth) * 100}%`,
        height: `${(video.height / artboardHeight) * 100}%`,
        transform: `rotate(${video.rotation}deg)`,
        transformOrigin: "0 0",
      }}
    />
  )
}

function ZoomFocusPreview({
  clip,
  onFocusChange,
}: {
  clip: CanvasZoomClip
  onFocusChange: (focus: CanvasZoomClip["focus"]) => void
}) {
  const previewRef = useRef<HTMLDivElement | null>(null)
  const { artboard } = useEditorCanvasArtboard()
  const { videos } = useEditorCanvasMedia()
  const { timelineClips } = useEditorCanvasTimeline()
  const [isDragging, setIsDragging] = useState(false)

  const activeVideos = useMemo(
    () =>
      timelineClips.flatMap((timelineClip) => {
        if (clip.start < timelineClip.start || clip.start >= timelineClip.end) {
          return []
        }
        const video = videos.find(
          (candidate) => candidate.id === timelineClip.videoId
        )
        if (!video) return []
        return [
          {
            video,
            sourceTime:
              timelineClip.sourceIn + (clip.start - timelineClip.start),
          },
        ]
      }),
    [clip.start, timelineClips, videos]
  )

  const targetFocus = clampZoomFocus(clip.focus)
  const visibleWindow = getZoomVisibleWindow(targetFocus, clip.scale, artboard)

  const writeFocusFromEvent = (event: React.PointerEvent<HTMLDivElement>) => {
    const node = previewRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const raw = clampZoomFocus({
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    })
    onFocusChange(raw)
  }

  return (
    <div
      ref={previewRef}
      className={cn(
        "relative w-full overflow-hidden rounded-lg border border-border/60 bg-black shadow-inner",
        isDragging && "cursor-grabbing"
      )}
      style={{ aspectRatio: `${artboard.width} / ${artboard.height}` }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        setIsDragging(true)
        writeFocusFromEvent(event)
      }}
      onPointerMove={(event) => {
        if (!isDragging) return
        writeFocusFromEvent(event)
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId)
        setIsDragging(false)
      }}
      onPointerCancel={() => setIsDragging(false)}
    >
      <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))]" />
      {activeVideos.map(({ video, sourceTime }) => (
        <ZoomPreviewVideo
          key={video.id}
          video={video}
          sourceTime={sourceTime}
          artboardWidth={artboard.width}
          artboardHeight={artboard.height}
        />
      ))}
      <div
        className="pointer-events-none absolute border border-white/70 bg-white/5 shadow-[0_0_0_999px_rgba(0,0,0,0.18)]"
        style={{
          left: `${visibleWindow.x * 100}%`,
          top: `${visibleWindow.y * 100}%`,
          width: `${visibleWindow.width * 100}%`,
          height: `${visibleWindow.height * 100}%`,
        }}
      />
      <div
        className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-violet-500 shadow-[0_0_0_4px_rgba(139,92,246,0.3),0_8px_18px_rgba(0,0,0,0.25)]"
        style={{
          left: `${targetFocus.x * 100}%`,
          top: `${targetFocus.y * 100}%`,
        }}
      />
    </div>
  )
}

export function ZoomPanel() {
  const { zoomClips, selectedZoomClipId } = useEditorCanvasTimeline()
  const { updateZoomClip } = useEditorCanvasTimelineActions()
  const selectedClip =
    zoomClips.find((clip) => clip.id === selectedZoomClipId) ?? null

  if (!selectedClip) {
    return (
      <section className="space-y-2 pb-6">
        <h3 className="text-sm font-semibold select-none">Zoom</h3>
        <p className="text-xs text-muted-foreground select-none">
          Select a Zoom clip in the timeline.
        </p>
      </section>
    )
  }

  const scalePct = Math.round(selectedClip.scale * 100)
  const blurPct = Math.round(selectedClip.radialBlur * 100)

  return (
    <section className="flex w-full flex-col gap-6 pb-6">
      <header className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold select-none">Zoom</h3>
          <Switch
            size="sm"
            checked={selectedClip.enabled}
            aria-label="Enable zoom clip"
            onCheckedChange={(enabled) =>
              updateZoomClip(selectedClip.id, { enabled })
            }
          />
        </div>
        <p className="text-xs text-muted-foreground tabular-nums select-none">
          {selectedClip.start.toFixed(2)}s - {selectedClip.end.toFixed(2)}s
        </p>
      </header>

      <ZoomFocusPreview
        clip={selectedClip}
        onFocusChange={(focus) => updateZoomClip(selectedClip.id, { focus })}
      />

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            updateZoomClip(selectedClip.id, { focus: ZOOM_FOCUS_DEFAULT })
          }
          disabled={
            selectedClip.focus.x === ZOOM_FOCUS_DEFAULT.x &&
            selectedClip.focus.y === ZOOM_FOCUS_DEFAULT.y
          }
        >
          <HugeiconsIcon icon={RefreshIcon} size={14} color="currentColor" />
          Center
        </Button>
      </div>

      <AdjustmentRow
        label="Scale"
        value={scalePct}
        min={100}
        max={ZOOM_SCALE_MAX * 100}
        step={5}
        formatValue={(value) => `${Math.round(value)}%`}
        onValueChange={(value) => {
          const scale = value / 100
          updateZoomClip(selectedClip.id, { scale })
        }}
        onReset={() =>
          updateZoomClip(selectedClip.id, {
            scale: ZOOM_SCALE_DEFAULT,
          })
        }
        resetDisabled={selectedClip.scale === ZOOM_SCALE_DEFAULT}
      />

      <AdjustmentRow
        label="Strength"
        value={blurPct}
        min={0}
        max={100}
        step={1}
        formatValue={(value) => `${Math.round(value)}%`}
        onValueChange={(value) =>
          updateZoomClip(selectedClip.id, { radialBlur: value / 100 })
        }
        onReset={() =>
          updateZoomClip(selectedClip.id, {
            radialBlur: ZOOM_RADIAL_BLUR_DEFAULT,
          })
        }
        resetDisabled={selectedClip.radialBlur === ZOOM_RADIAL_BLUR_DEFAULT}
      />

      <div className="space-y-3 border-t border-border/60 pt-4">
        <h4 className="text-xs font-semibold select-none">Transition</h4>
        <AdjustmentRow
          label="Duration"
          value={selectedClip.transition.durationMs}
          min={ZOOM_TRANSITION_DURATION_MS_MIN}
          max={ZOOM_TRANSITION_DURATION_MS_MAX}
          step={25}
          formatValue={(value) => `${Math.round(value)} ms`}
          onValueChange={(value) => {
            updateZoomClip(selectedClip.id, {
              transition: {
                ...selectedClip.transition,
                durationMs: Math.round(value),
              },
            })
          }}
          onReset={() =>
            updateZoomClip(selectedClip.id, {
              transition: {
                ...selectedClip.transition,
                durationMs: ZOOM_TRANSITION_DURATION_MS_DEFAULT,
              },
            })
          }
          resetDisabled={
            selectedClip.transition.durationMs ===
            ZOOM_TRANSITION_DURATION_MS_DEFAULT
          }
        />
      </div>
    </section>
  )
}
