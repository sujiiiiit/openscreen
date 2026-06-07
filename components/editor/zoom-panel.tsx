"use client"

import { useEffect, useRef, useState } from "react"

import {
  useEditorCanvasArtboard,
  useEditorCanvasTimeline,
  useEditorCanvasTimelineActions,
} from "@/components/editor/canvas/provider"
import { captureSceneSnapshot } from "@/components/editor/canvas/scene-snapshot"
import { getZoomVisibleWindow } from "@/components/editor/canvas/zoom-scene"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  ZOOM_RADIAL_BLUR_DEFAULT,
  ZOOM_SCALE_DEFAULT,
  ZOOM_SCALE_MAX,
  ZOOM_TRANSITION_DURATION_MS_DEFAULT,
  ZOOM_TRANSITION_DURATION_MS_MAX,
  ZOOM_TRANSITION_DURATION_MS_MIN,
  clampZoomFocus,
} from "@/lib/zoom-clips"
import { cn } from "@/lib/utils"
import type { CanvasZoomClip } from "@/types/editor-canvas"

function AdjustmentRow({
  label,
  description,
  value,
  min,
  max,
  step,
  formatValue,
  onValueChange,
  onReset,
  resetDisabled,
  disabled = false,
}: {
  label: string
  description: string
  value: number
  min: number
  max: number
  step?: number
  formatValue: (value: number) => string
  onValueChange: (value: number) => void
  onReset: () => void
  resetDisabled?: boolean
  disabled?: boolean
}) {
  return (
    <div className="space-y-2">
      {/* No inline value readout — the slider's value tooltip already shows
          the current value (matches the Video panel's AdjustmentRow). */}
      <div
        className={cn(
          "space-y-1 transition-opacity select-none",
          disabled && "opacity-50"
        )}
      >
        <h4 className="text-xs font-semibold">{label}</h4>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-3">
        <Slider
          size="sm"
          value={[value]}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
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
          disabled={disabled || resetDisabled}
        >
          Reset
        </Button>
      </div>
    </div>
  )
}

// Snapshot width for the focus preview. The preview box is sidebar-sized, so
// rasterizing the full 3000px+ artboard would only waste readback time; the
// scene capture never upscales past the artboard's own width.
const ZOOM_PREVIEW_SNAPSHOT_WIDTH = 1280

/**
 * Temp image of the composed artboard — background, padding, video nodes with
 * their appearance (corners / border / shadow), and the cursor overlay — so
 * the focus preview shows exactly what the zoom will magnify. Captured from
 * the live PixiJS scene (`captureSceneSnapshot`, a synchronous GPU extract of
 * the unzoomed composition) each time a Zoom clip is selected. Video content
 * shows the current playhead frame; appearance is always current.
 */
function useSceneSnapshotUrl(clipId: string): string | null {
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null)
  // Tracks the live object URL so a replacement or unmount can revoke it —
  // the blob is a temp image that must not outlive the preview.
  const snapshotUrlRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const canvas = captureSceneSnapshot(ZOOM_PREVIEW_SNAPSHOT_WIDTH)
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (cancelled || !blob) return
      const next = URL.createObjectURL(blob)
      if (snapshotUrlRef.current) URL.revokeObjectURL(snapshotUrlRef.current)
      snapshotUrlRef.current = next
      setSnapshotUrl(next)
    }, "image/png")
    return () => {
      cancelled = true
    }
  }, [clipId])

  useEffect(() => {
    return () => {
      if (snapshotUrlRef.current) URL.revokeObjectURL(snapshotUrlRef.current)
      snapshotUrlRef.current = null
    }
  }, [])

  return snapshotUrl
}

function ZoomFocusPreview({
  clip,
  disabled = false,
  onFocusChange,
}: {
  clip: CanvasZoomClip
  disabled?: boolean
  onFocusChange: (focus: CanvasZoomClip["focus"]) => void
}) {
  const previewRef = useRef<HTMLDivElement | null>(null)
  const { artboard } = useEditorCanvasArtboard()
  const [isDragging, setIsDragging] = useState(false)
  const snapshotUrl = useSceneSnapshotUrl(clip.id)

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
        "relative w-full overflow-hidden border border-border/60 bg-black shadow-inner transition-opacity",
        isDragging && "cursor-grabbing",
        // Disabled clip: keep showing the snapshot, but block focus edits.
        disabled && "pointer-events-none opacity-50"
      )}
      aria-disabled={disabled}
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
      {snapshotUrl ? (
        // temp object URL; next/image can't optimize blob: sources. The
        // snapshot has the artboard's aspect ratio — same as this box.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={snapshotUrl}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full"
        />
      ) : null}
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
  // Disabled clip: the header switch stays interactive, everything else dims
  // and locks; the clip's settings are kept so re-enabling restores them.
  const clipDisabled = !selectedClip.enabled

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

      <div className="flex w-full flex-col gap-9">
        <div className="space-y-2">
          <ZoomFocusPreview
            clip={selectedClip}
            disabled={clipDisabled}
            onFocusChange={(focus) =>
              updateZoomClip(selectedClip.id, { focus })
            }
          />
          <p
            className={cn(
              "text-xs text-muted-foreground transition-opacity select-none",
              clipDisabled && "opacity-50"
            )}
          >
            Drag the dot to set the point the zoom centers on.
          </p>
        </div>

        <AdjustmentRow
          label="Scale"
          description="How far the view zooms in."
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
          disabled={clipDisabled}
        />

        <AdjustmentRow
          label="Strength"
          description="Radial motion blur while the zoom is moving."
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
          disabled={clipDisabled}
        />

        <AdjustmentRow
          label="Duration"
          description="How long the zoom-in and zoom-out ramps take."
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
          disabled={clipDisabled}
        />
      </div>
    </section>
  )
}
