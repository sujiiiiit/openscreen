"use client"

import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  FileEmpty02Icon,
} from "@hugeicons/core-free-icons"
import { Squircle } from "@squircle-js/react"

import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@/components/animate-ui/primitives/base/accordion"
import { Button, buttonVariants } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsContent, TabsContents } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  useEditorCanvasActions,
  useEditorCanvasMedia,
} from "@/components/editor/canvas/provider"
import {
  SelectionPills,
  type SelectionPillOption,
} from "@/components/editor/selection-pills"
import type {
  CanvasBorderAlignment,
  CanvasVideoItem,
} from "@/types/editor-canvas"

const SMOOTHING_DEFAULT_PERCENT = 100
const RADIUS_SLIDER_MAX = 250
const BORDER_WIDTH_MAX = 64
const BORDER_OFFSET_RANGE = 64
const BORDER_DEFAULT_COLOR = "#000000"
// The native color picker fires `input` events continuously while dragging;
// committing every one into the canvas provider re-renders the scene (and
// spams history/autosave) at pointer rate. The pill previews instantly from
// local state and the real commit trails the drag by this delay.
const BORDER_COLOR_COMMIT_DEBOUNCE_MS = 150
const BORDER_ALIGNMENT_OPTIONS: Array<
  SelectionPillOption<CanvasBorderAlignment>
> = [
  { value: "inside", label: "Inside" },
  { value: "center", label: "Center" },
  { value: "outside", label: "Outside" },
]

const CARD_CORNER_RADIUS = 16
const CARD_CORNER_SMOOTHING = 1

// Sub-tab identifiers inside the Video panel. Kept narrow so accidental
// `onValueChange` calls with unknown strings can't widen the type.
type VideoSubTab = "videos" | "settings"

const FILE_SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown size"
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < FILE_SIZE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  // Show one decimal for KB+, none for raw bytes. Keeps the card legible
  // without a monospace digit treatment.
  const formatted =
    unitIndex === 0
      ? Math.round(value).toString()
      : value >= 10
        ? value.toFixed(0)
        : value.toFixed(1)
  return `${formatted} ${FILE_SIZE_UNITS[unitIndex]}`
}

type AdjustmentRowProps = {
  label: string
  description: string
  value: number
  onValueChange: (value: number) => void
  onReset?: () => void
  min?: number
  max?: number
  disabled?: boolean
  showValueTooltip?: boolean
  formatValue?: (value: number) => string
  resetDisabled?: boolean
}

function AdjustmentRow({
  label,
  description,
  value,
  onValueChange,
  onReset,
  min = 0,
  max = 100,
  disabled = false,
  showValueTooltip = false,
  formatValue,
  resetDisabled,
}: AdjustmentRowProps) {
  const isResetDisabled = resetDisabled ?? value === min
  return (
    <div className="w-full space-y-2">
      <div
        className={cn(
          "space-y-1 transition-opacity select-none",
          disabled && "opacity-50"
        )}
      >
        <h4 className="text-xs font-semibold">{label}</h4>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex w-full items-center gap-3">
        <Slider
          size="sm"
          value={[value]}
          onValueChange={(values) =>
            onValueChange(Array.isArray(values) ? values[0] : values)
          }
          min={min}
          max={max}
          disabled={disabled}
          showValueTooltip={showValueTooltip}
          formatValue={formatValue}
          className="flex-1"
        />
        {onReset ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={onReset}
            disabled={disabled || isResetDisabled}
          >
            Reset
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function VideoFileCard({
  video,
  actionLabel,
  onActivate,
}: {
  video: CanvasVideoItem
  // "Select" for videos already on the canvas, "Add" for ones the user removed
  // (still part of the project). The card chrome is identical either way.
  actionLabel: string
  onActivate: (id: string) => void
}) {
  // Horizontal card: file icon on the left, name + size stacked, and a
  // hover-revealed action affordance pinned to the right. The Squircle
  // wraps a single <button> so the whole card stays one focusable target —
  // the visible label is a non-interactive span styled with `buttonVariants`
  // so clicks bubble to the parent <button> instead of creating a
  // nested-button accessibility hazard.
  return (
    <Squircle
      cornerRadius={CARD_CORNER_RADIUS}
      cornerSmoothing={CARD_CORNER_SMOOTHING}
      className="bg-muted"
      asChild
    >
      <button
        type="button"
        onClick={() => onActivate(video.id)}
        title={video.fileName}
        className="group/card relative flex w-full items-center gap-3 px-3 py-3 text-left transition-transform duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.97]"
      >
        {/* File body — drops to opacity 0.95 on hover/focus so the card
            visibly reacts without dimming the action affordance below. */}
        <span className="flex min-w-0 flex-1 items-center gap-3 transition-opacity group-hover/card:opacity-95 group-focus-visible/card:opacity-95">
          <span className="inline-flex size-10 shrink-0 items-center justify-center text-primary">
            <HugeiconsIcon icon={FileEmpty02Icon} className="size-6" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm leading-tight font-semibold">
              {video.fileName}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatFileSize(video.fileSize)}
            </span>
          </span>
        </span>
        {/* Visual action affordance. Inherits the default Button look via
            `buttonVariants`; `pointer-events-none` so clicks always reach
            the outer card button, keeping a single tab stop per row. */}
        <span
          aria-hidden
          className={cn(
            buttonVariants({ variant: "default", size: "sm" }),
            "pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 opacity-0 transition-opacity group-hover/card:opacity-100 group-focus-visible/card:opacity-100"
          )}
        >
          {actionLabel}
        </span>
      </button>
    </Squircle>
  )
}

function VideoFileGrid({
  videos,
  detachedVideos,
  onSelect,
  onAdd,
}: {
  videos: CanvasVideoItem[]
  // Videos still in the project but removed from the canvas. Listed after the
  // on-canvas videos with an "Add" action that puts them back.
  detachedVideos: CanvasVideoItem[]
  onSelect: (id: string) => void
  onAdd: (id: string) => void
}) {
  if (videos.length === 0 && detachedVideos.length === 0) {
    return (
      <Squircle
        cornerRadius={CARD_CORNER_RADIUS}
        cornerSmoothing={CARD_CORNER_SMOOTHING}
        className="bg-muted px-3 py-6 text-center"
      >
        <p className="text-xs text-muted-foreground select-none">
          Import a video from the Background tab to add it here.
        </p>
      </Squircle>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {videos.map((video) => (
        <VideoFileCard
          key={video.id}
          video={video}
          actionLabel="Select"
          onActivate={onSelect}
        />
      ))}
      {detachedVideos.map((video) => (
        <VideoFileCard
          key={video.id}
          video={video}
          actionLabel="Add"
          onActivate={onAdd}
        />
      ))}
    </div>
  )
}

function BorderControls({ video }: { video: CanvasVideoItem }) {
  const { updateVideoAppearance } = useEditorCanvasActions()
  // Hidden color input opened by the pill Button; kept positioned behind the
  // pill so the native color popup anchors to the control, not the viewport.
  const colorInputRef = useRef<HTMLInputElement>(null)
  // Debounced color commit: `draftColor` drives the pill + input while the
  // user drags inside the OS picker; the provider update fires only after the
  // drag pauses. (BorderControls is keyed by video id upstream, so a video
  // switch remounts this component — the unmount effect flushes any pending
  // color so the last picked value can't be dropped.)
  const [draftColor, setDraftColor] = useState<string | null>(null)
  const colorCommitTimerRef = useRef<number | null>(null)
  const pendingColorRef = useRef<string | null>(null)

  const borderWidth = Math.max(
    0,
    Math.min(BORDER_WIDTH_MAX, Math.round(video.borderWidth))
  )
  const borderOffset = Math.max(
    -BORDER_OFFSET_RANGE,
    Math.min(BORDER_OFFSET_RANGE, Math.round(video.borderOffset))
  )
  const borderColor = video.borderColor || BORDER_DEFAULT_COLOR
  // What the pill shows: the in-flight draft while dragging in the OS
  // picker, otherwise the committed value.
  const displayColor = draftColor ?? borderColor
  const borderDisabled = borderWidth <= 0

  const setBorderWidth = (next: number) => {
    const clamped = Math.max(0, Math.min(BORDER_WIDTH_MAX, Math.round(next)))
    if (clamped === video.borderWidth) return
    updateVideoAppearance(video.id, { borderWidth: clamped })
  }

  const setBorderColor = (next: string) => {
    if (next === video.borderColor) return
    updateVideoAppearance(video.id, { borderColor: next })
  }

  // Kept in a ref so the unmount flush below always commits through the
  // latest closure (fresh `video.borderColor` comparison) without re-running
  // the effect. Updated in an effect, not during render (react-hooks/refs).
  const setBorderColorRef = useRef(setBorderColor)
  useEffect(() => {
    setBorderColorRef.current = setBorderColor
  })

  const handleColorInput = (next: string) => {
    setDraftColor(next)
    pendingColorRef.current = next
    if (colorCommitTimerRef.current !== null) {
      window.clearTimeout(colorCommitTimerRef.current)
    }
    colorCommitTimerRef.current = window.setTimeout(() => {
      colorCommitTimerRef.current = null
      pendingColorRef.current = null
      setDraftColor(null)
      setBorderColorRef.current(next)
    }, BORDER_COLOR_COMMIT_DEBOUNCE_MS)
  }

  useEffect(() => {
    return () => {
      if (colorCommitTimerRef.current !== null) {
        window.clearTimeout(colorCommitTimerRef.current)
      }
      if (pendingColorRef.current !== null) {
        setBorderColorRef.current(pendingColorRef.current)
      }
    }
  }, [])

  const setBorderOffset = (next: number) => {
    const clamped = Math.max(
      -BORDER_OFFSET_RANGE,
      Math.min(BORDER_OFFSET_RANGE, Math.round(next))
    )
    if (clamped === video.borderOffset) return
    updateVideoAppearance(video.id, { borderOffset: clamped })
  }

  const setBorderAlignment = (next: CanvasBorderAlignment) => {
    if (next === video.borderAlignment) return
    updateVideoAppearance(video.id, { borderAlignment: next })
  }

  return (
    <div className="flex w-full flex-col gap-9">
      <AdjustmentRow
        label="Border"
        description="Thickness of the border around the video."
        value={borderWidth}
        onValueChange={setBorderWidth}
        onReset={() => setBorderWidth(0)}
        min={0}
        max={BORDER_WIDTH_MAX}
        showValueTooltip
        formatValue={(v) => `${Math.round(v)}px`}
      />
      <div className="flex w-full items-center justify-between gap-3">
        <h4
          className={cn(
            "text-xs font-semibold transition-opacity select-none",
            borderDisabled && "opacity-50"
          )}
        >
          Border color
        </h4>
        {/* Pill-shaped Button trigger: circular swatch + hex readout. The
            color input is visually hidden behind the pill (so the native
            popup anchors next to it) and is opened via the Button click. */}
        <span className="relative inline-flex">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={borderDisabled}
            onClick={() => colorInputRef.current?.click()}
            title={displayColor}
            className="gap-2 rounded-full pl-1.5 font-mono text-xs text-muted-foreground uppercase tabular-nums"
          >
            <span
              aria-hidden
              className="size-5 shrink-0 rounded-full border border-border"
              style={{ backgroundColor: displayColor }}
            />
            {displayColor.toUpperCase()}
          </Button>
          <input
            ref={colorInputRef}
            type="color"
            value={displayColor}
            onChange={(event) => handleColorInput(event.target.value)}
            disabled={borderDisabled}
            tabIndex={-1}
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 size-full opacity-0"
          />
        </span>
      </div>
      {/* Rarely-touched controls live in a collapsed-by-default accordion so
          the common adjustments above stay compact. Built on the unstyled
          animate-ui Base accordion primitive (Motion height/opacity/mask
          animation), styled minimally so it reads like the sibling rows. */}
      <Accordion>
        <AccordionItem value="advanced">
          <AccordionHeader className="flex">
            <AccordionTrigger className="group/advanced-trigger flex flex-1 items-center justify-between gap-2 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/40">
              {/* Buttons only allow phrasing content — block spans, not h4/p,
                  for the same title + helper-description stack the sibling
                  rows use. */}
              <span className="space-y-1 text-left">
                <span className="block text-xs font-semibold">
                  Advanced settings
                </span>
                <span className="block text-xs font-normal text-muted-foreground">
                  Fine-tune the border offset and alignment.
                </span>
              </span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                strokeWidth={2}
                className="size-4 shrink-0 text-muted-foreground transition-transform duration-300 group-aria-expanded/advanced-trigger:-rotate-180"
              />
            </AccordionTrigger>
          </AccordionHeader>
          <AccordionPanel>
            <div className="flex flex-col gap-9 py-9">
              <div className="flex w-full flex-col gap-6">
                <div
                  className={cn(
                    "space-y-1 transition-opacity select-none",
                    borderDisabled && "opacity-50"
                  )}
                >
                  <h4 className="text-xs font-semibold">Alignment</h4>
                  <p className="text-xs text-muted-foreground">
                    Where the border sits relative to the video edge.
                  </p>
                </div>
                <SelectionPills
                  ariaLabel="Border alignment"
                  disabled={borderDisabled}
                  options={BORDER_ALIGNMENT_OPTIONS}
                  size="md"
                  value={video.borderAlignment}
                  onValueChange={setBorderAlignment}
                />
              </div>
              <AdjustmentRow
                label="Offset"
                description={
                  borderDisabled
                    ? "Moves the border in or out — set a width first."
                    : "Moves the border in or out from the video edge."
                }
                value={borderOffset}
                onValueChange={setBorderOffset}
                onReset={() => setBorderOffset(0)}
                min={-BORDER_OFFSET_RANGE}
                max={BORDER_OFFSET_RANGE}
                disabled={borderDisabled}
                showValueTooltip
                formatValue={(v) => `${Math.round(v)}px`}
                resetDisabled={borderOffset === 0}
              />
            </div>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </div>
  )
}

function VideoAppearanceControls({ video }: { video: CanvasVideoItem }) {
  const { updateVideoAppearance } = useEditorCanvasActions()

  // Cap the slider at 250 px, or half the shorter side (the per-corner
  // squircle budget) when the node is smaller than 500 px. The stored value is
  // allowed up to this clamp; the renderer also re-clamps defensively against
  // the live size, and `computeSquircleCornerParams` caps the smoothing
  // extension `p = (1 + smoothing) · radius` at the budget so the traced path
  // can never self-intersect.
  const radiusMax = Math.max(
    0,
    Math.min(
      RADIUS_SLIDER_MAX,
      Math.floor(Math.min(video.width, video.height) / 2)
    )
  )
  const radius = Math.max(
    0,
    Math.min(radiusMax, Math.round(video.cornerRadius))
  )
  const smoothingPercent = Math.round(
    Math.max(0, Math.min(1, video.cornerSmoothing)) * 100
  )

  const setRadius = (next: number) => {
    const clamped = Math.max(0, Math.min(radiusMax, Math.round(next)))
    if (clamped === video.cornerRadius) return
    updateVideoAppearance(video.id, { cornerRadius: clamped })
  }

  const setSmoothingPercent = (next: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(next)))
    const asUnit = clamped / 100
    if (asUnit === video.cornerSmoothing) return
    updateVideoAppearance(video.id, { cornerSmoothing: asUnit })
  }

  return (
    <div className="flex w-full flex-col gap-9">
      <div className="flex w-full flex-col gap-9">
        <AdjustmentRow
          label="Radius"
          description="Rounds the video's corners."
          value={radius}
          onValueChange={setRadius}
          onReset={() => setRadius(0)}
          min={0}
          max={radiusMax}
          disabled={radiusMax <= 0}
          showValueTooltip
          formatValue={(v) => `${Math.round(v)}px`}
        />
        <AdjustmentRow
          label="Smoothing"
          description="Softens the corner curve into a squircle shape."
          value={smoothingPercent}
          onValueChange={setSmoothingPercent}
          onReset={() => setSmoothingPercent(SMOOTHING_DEFAULT_PERCENT)}
          min={0}
          max={100}
          showValueTooltip
          formatValue={(v) => `${Math.round(v)}%`}
          resetDisabled={smoothingPercent === SMOOTHING_DEFAULT_PERCENT}
        />
      </div>
      <BorderControls video={video} />
    </div>
  )
}

export function VideoPanel() {
  const { videos, detachedVideos, selectedVideo } = useEditorCanvasMedia()
  const { selectItem, addVideoToCanvas } = useEditorCanvasActions()

  // Selection IS the navigation state. There is no visible tab bar — the
  // panel uses <Tabs> purely for the controlled motion transition between
  // the two views. Clicking a file card calls selectItem(id) → activeSubTab
  // flips to "settings"; the "Back" link in Settings calls selectItem(null)
  // → activeSubTab flips back to "videos", and the canvas Transformer +
  // timeline clip highlight all follow because they all derive from the
  // same selectedItemId.
  const activeSubTab: VideoSubTab = selectedVideo ? "settings" : "videos"

  return (
    <section className="flex w-full flex-col pb-6">
      {/* `onValueChange` is intentionally omitted: the active tab is fully
          derived from external selection, so nothing inside Tabs should be
          able to toggle the value on its own. */}
      <Tabs value={activeSubTab}>
        <TabsContents className="min-h-24">
          <TabsContent value="videos">
            <div className="flex w-full flex-col gap-4">
              <header className="space-y-1">
                <h3 className="text-sm font-semibold select-none">Video</h3>
                <p className="truncate text-xs text-muted-foreground select-none">
                  Pick a video to edit its corner shape.
                </p>
              </header>
              <VideoFileGrid
                videos={videos}
                detachedVideos={detachedVideos}
                onSelect={selectItem}
                onAdd={addVideoToCanvas}
              />
            </div>
          </TabsContent>
          <TabsContent value="settings">
            {selectedVideo ? (
              // Keying on the video id resets internal refs cleanly when
              // the user switches videos without first returning to the
              // Videos tab.
              <div
                key={selectedVideo.id}
                className="flex w-full flex-col gap-6"
              >
                <header className="space-y-1">
                  <Button
                    type="button"
                    variant="link"
                    onClick={() => selectItem(null)}
                    // Match the heading's text size + weight so the link
                    // visually replaces the "Video" title in the same slot;
                    // strip the default button height + horizontal padding so
                    // it aligns with the description underneath.
                    className="h-auto -translate-x-5 p-0! px-0 py-0 text-sm font-semibold text-foreground"
                  >
                    <HugeiconsIcon
                      icon={ArrowLeft01Icon}
                      className="size-4.5"
                    />
                    Videos
                  </Button>
                  <p className="truncate text-xs text-muted-foreground select-none">
                    Edit corners for this video.
                  </p>
                </header>
                <VideoAppearanceControls video={selectedVideo} />
              </div>
            ) : null}
          </TabsContent>
        </TabsContents>
      </Tabs>
    </section>
  )
}
