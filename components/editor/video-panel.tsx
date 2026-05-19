"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowLeft01Icon, FileEmpty02Icon } from "@hugeicons/core-free-icons"
import { Squircle } from "@squircle-js/react"

import { Button, buttonVariants } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsContent, TabsContents } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  formatRgba,
  parseRgba,
  rgbaToHex,
  type Rgba,
} from "@/lib/rgba-color"
import {
  useEditorCanvasActions,
  useEditorCanvasMedia,
} from "@/components/editor/canvas/provider"
import type {
  CanvasBorderAlignment,
  CanvasVideoItem,
} from "@/types/editor-canvas"

const SMOOTHING_DEFAULT_PERCENT = 60
const BORDER_WIDTH_MAX = 64
const BORDER_OFFSET_RANGE = 64
const BORDER_DEFAULT_COLOR = "#000000"
const BORDER_ALIGNMENT_OPTIONS: Array<{
  value: CanvasBorderAlignment
  label: string
}> = [
  { value: "inside", label: "Inside" },
  { value: "center", label: "Center" },
  { value: "outside", label: "Outside" },
]
const SHADOW_OFFSET_RANGE = 128
const SHADOW_BLUR_MAX = 128
const SHADOW_SPREAD_RANGE = 64

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
      <h4
        className={cn(
          "text-xs font-semibold transition-opacity select-none",
          disabled && "opacity-50"
        )}
      >
        {label}
      </h4>
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
  onSelect,
}: {
  video: CanvasVideoItem
  onSelect: (id: string) => void
}) {
  // Horizontal card: file icon on the left, name + size stacked, and a
  // hover-revealed "Select" affordance pinned to the right. The Squircle
  // wraps a single <button> so the whole card stays one focusable target —
  // the visible "Select" is a non-interactive span styled with
  // `buttonVariants` so clicks bubble to the parent <button> instead of
  // creating a nested-button accessibility hazard.
  return (
    <Squircle
      cornerRadius={CARD_CORNER_RADIUS}
      cornerSmoothing={CARD_CORNER_SMOOTHING}
      className="bg-muted"
      asChild
    >
      <button
        type="button"
        onClick={() => onSelect(video.id)}
        title={video.fileName}
        className="group/card relative flex w-full items-center gap-3 px-3 py-3 text-left outline-none transition-transform duration-100 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {/* File body — drops to opacity 0.95 on hover/focus so the card
            visibly reacts without dimming the Select affordance below. */}
        <span className="flex min-w-0 flex-1 items-center gap-3 transition-opacity group-hover/card:opacity-95 group-focus-visible/card:opacity-95">
          <span className="inline-flex size-10 shrink-0 items-center justify-center text-primary">
            <HugeiconsIcon icon={FileEmpty02Icon} className="size-6" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-semibold leading-tight">
              {video.fileName}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatFileSize(video.fileSize)}
            </span>
          </span>
        </span>
        {/* Visual Select affordance. Inherits the default Button look via
            `buttonVariants`; `pointer-events-none` so clicks always reach
            the outer card button, keeping a single tab stop per row. */}
        <span
          aria-hidden
          className={cn(
            buttonVariants({ variant: "default", size: "sm" }),
            "pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 opacity-0 transition-opacity group-hover/card:opacity-100 group-focus-visible/card:opacity-100"
          )}
        >
          Select
        </span>
      </button>
    </Squircle>
  )
}

function VideoFileGrid({
  videos,
  onSelect,
}: {
  videos: CanvasVideoItem[]
  onSelect: (id: string) => void
}) {
  if (videos.length === 0) {
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
        <VideoFileCard key={video.id} video={video} onSelect={onSelect} />
      ))}
    </div>
  )
}


function BorderControls({ video }: { video: CanvasVideoItem }) {
  const { updateVideoAppearance } = useEditorCanvasActions()

  const borderWidth = Math.max(0, Math.min(BORDER_WIDTH_MAX, Math.round(video.borderWidth)))
  const borderOffset = Math.max(
    -BORDER_OFFSET_RANGE,
    Math.min(BORDER_OFFSET_RANGE, Math.round(video.borderOffset))
  )
  const borderColor = video.borderColor || BORDER_DEFAULT_COLOR
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
    <div className="flex w-full flex-col gap-5">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase select-none">
        Border
      </h4>
      <AdjustmentRow
        label="Width"
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
          Color
        </h4>
        <div className="flex items-center gap-2">
          <label
            className={cn(
              "relative inline-flex size-6 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-border ring-offset-background transition-shadow hover:ring-2 hover:ring-ring/40 focus-within:ring-2 focus-within:ring-ring/40",
              borderDisabled && "pointer-events-none opacity-50"
            )}
            style={{ backgroundColor: borderColor }}
            title={borderColor}
          >
            <input
              type="color"
              value={borderColor}
              onChange={(event) => setBorderColor(event.target.value)}
              disabled={borderDisabled}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
              aria-label="Border color"
            />
          </label>
          <span className="font-mono text-xs text-muted-foreground uppercase tabular-nums select-none">
            {borderColor.replace(/^#/, "").toUpperCase()}
          </span>
        </div>
      </div>
      <div className="flex w-full flex-col gap-2">
        <h4
          className={cn(
            "text-xs font-semibold transition-opacity select-none",
            borderDisabled && "opacity-50"
          )}
        >
          Alignment
        </h4>
        <div
          role="radiogroup"
          aria-label="Border alignment"
          className={cn(
            "inline-flex w-full overflow-hidden rounded-md border border-border bg-muted/40 p-0.5",
            borderDisabled && "pointer-events-none opacity-50"
          )}
        >
          {BORDER_ALIGNMENT_OPTIONS.map((option) => {
            const checked = video.borderAlignment === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => setBorderAlignment(option.value)}
                disabled={borderDisabled}
                className={cn(
                  "flex-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  checked
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>
      <AdjustmentRow
        label="Offset"
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
  )
}

// Inline rgba color picker. The swatch is a native `<input type="color">`
// (RGB), and the hex sits beside it as a directly-editable text input.
// Alpha lives on a sibling Opacity slider in the parent panel — keeping
// the swatch focused on RGB means no popover and no extra click.
function ColorAlphaSwatch({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  ariaLabel: string
}) {
  const parsed = parseRgba(value) ?? { r: 0, g: 0, b: 0, a: 0 }
  const hex = rgbaToHex(parsed)

  const emit = (next: Partial<Rgba>) => {
    const merged: Rgba = {
      r: next.r ?? parsed.r,
      g: next.g ?? parsed.g,
      b: next.b ?? parsed.b,
      a: next.a ?? parsed.a,
    }
    onChange(formatRgba(merged))
  }

  const handleHex = (hexInput: string) => {
    const candidate = parseRgba(hexInput)
    if (!candidate) return
    emit({ r: candidate.r, g: candidate.g, b: candidate.b })
  }

  return (
    <div className="flex items-center gap-2">
      <label
        aria-label={ariaLabel}
        // Checker behind the color so alpha < 1 reads at a glance — the
        // same affordance Figma uses.
        className={cn(
          "relative inline-flex size-6 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-border ring-offset-background transition-shadow outline-none hover:ring-2 hover:ring-ring/40 focus-within:ring-2 focus-within:ring-ring/40",
          disabled && "pointer-events-none opacity-50"
        )}
        style={{
          backgroundImage:
            "linear-gradient(45deg, #c0c0c0 25%, transparent 25%), linear-gradient(-45deg, #c0c0c0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #c0c0c0 75%), linear-gradient(-45deg, transparent 75%, #c0c0c0 75%)",
          backgroundSize: "8px 8px",
          backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0",
        }}
      >
        <span
          aria-hidden
          className="absolute inset-0 size-full"
          style={{ backgroundColor: value }}
        />
        <input
          type="color"
          value={hex}
          onChange={(event) => handleHex(event.target.value)}
          disabled={disabled}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
      <input
        type="text"
        value={hex.replace(/^#/, "").toUpperCase()}
        onChange={(event) => handleHex(`#${event.target.value}`)}
        disabled={disabled}
        spellCheck={false}
        // Width tuned for six hex characters + a touch of breathing room.
        // The caret-monospace look matches the Border row's read-only hex
        // chip for visual continuity across the panel.
        className={cn(
          "w-16 rounded-md border border-border bg-background px-1.5 py-1 font-mono text-xs tracking-wider tabular-nums uppercase outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
          disabled && "pointer-events-none opacity-50"
        )}
      />
    </div>
  )
}

function ShadowControls({ video }: { video: CanvasVideoItem }) {
  const { updateVideoAppearance } = useEditorCanvasActions()

  const blur = Math.max(0, Math.min(SHADOW_BLUR_MAX, Math.round(video.shadowBlur)))
  const offsetX = Math.max(
    -SHADOW_OFFSET_RANGE,
    Math.min(SHADOW_OFFSET_RANGE, Math.round(video.shadowOffsetX))
  )
  const offsetY = Math.max(
    -SHADOW_OFFSET_RANGE,
    Math.min(SHADOW_OFFSET_RANGE, Math.round(video.shadowOffsetY))
  )
  const spread = Math.max(
    -SHADOW_SPREAD_RANGE,
    Math.min(SHADOW_SPREAD_RANGE, Math.round(video.shadowSpread))
  )
  // Alpha is still stored on `shadowColor` (single source of truth, rgba
  // string). The Opacity slider just edits that field's alpha channel.
  const parsedShadow = parseRgba(video.shadowColor) ?? {
    r: 0,
    g: 0,
    b: 0,
    a: 0,
  }
  const opacityPercent = Math.round(parsedShadow.a * 100)

  const setShadowField = (
    key:
      | "shadowBlur"
      | "shadowOffsetX"
      | "shadowOffsetY"
      | "shadowSpread",
    next: number,
    min: number,
    max: number
  ) => {
    const clamped = Math.max(min, Math.min(max, Math.round(next)))
    if (clamped === video[key]) return
    updateVideoAppearance(video.id, { [key]: clamped })
  }

  const setShadowColor = (next: string) => {
    if (next === video.shadowColor) return
    updateVideoAppearance(video.id, { shadowColor: next })
  }

  const setShadowOpacity = (percent: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(percent))) / 100
    if (clamped === parsedShadow.a) return
    setShadowColor(formatRgba({ ...parsedShadow, a: clamped }))
  }

  return (
    <div className="flex w-full flex-col gap-5">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase select-none">
        Shadow
      </h4>
      <div className="flex w-full items-center justify-between gap-3">
        <h4 className="text-xs font-semibold select-none">Color</h4>
        <ColorAlphaSwatch
          value={video.shadowColor}
          onChange={setShadowColor}
          ariaLabel="Shadow color"
        />
      </div>
      <AdjustmentRow
        label="Opacity"
        value={opacityPercent}
        onValueChange={setShadowOpacity}
        onReset={() => setShadowOpacity(25)}
        min={0}
        max={100}
        showValueTooltip
        formatValue={(v) => `${Math.round(v)}%`}
        resetDisabled={opacityPercent === 25}
      />
      <AdjustmentRow
        label="X"
        value={offsetX}
        onValueChange={(v) =>
          setShadowField(
            "shadowOffsetX",
            v,
            -SHADOW_OFFSET_RANGE,
            SHADOW_OFFSET_RANGE
          )
        }
        onReset={() =>
          setShadowField("shadowOffsetX", 0, -SHADOW_OFFSET_RANGE, SHADOW_OFFSET_RANGE)
        }
        min={-SHADOW_OFFSET_RANGE}
        max={SHADOW_OFFSET_RANGE}
        showValueTooltip
        formatValue={(v) => `${Math.round(v)}px`}
        resetDisabled={offsetX === 0}
      />
      <AdjustmentRow
        label="Y"
        value={offsetY}
        onValueChange={(v) =>
          setShadowField(
            "shadowOffsetY",
            v,
            -SHADOW_OFFSET_RANGE,
            SHADOW_OFFSET_RANGE
          )
        }
        onReset={() =>
          setShadowField("shadowOffsetY", 0, -SHADOW_OFFSET_RANGE, SHADOW_OFFSET_RANGE)
        }
        min={-SHADOW_OFFSET_RANGE}
        max={SHADOW_OFFSET_RANGE}
        showValueTooltip
        formatValue={(v) => `${Math.round(v)}px`}
        resetDisabled={offsetY === 0}
      />
      <AdjustmentRow
        label="Blur"
        value={blur}
        onValueChange={(v) => setShadowField("shadowBlur", v, 0, SHADOW_BLUR_MAX)}
        onReset={() => setShadowField("shadowBlur", 0, 0, SHADOW_BLUR_MAX)}
        min={0}
        max={SHADOW_BLUR_MAX}
        showValueTooltip
        formatValue={(v) => `${Math.round(v)}px`}
        resetDisabled={blur === 0}
      />
      <AdjustmentRow
        label="Spread"
        value={spread}
        onValueChange={(v) =>
          setShadowField(
            "shadowSpread",
            v,
            -SHADOW_SPREAD_RANGE,
            SHADOW_SPREAD_RANGE
          )
        }
        onReset={() =>
          setShadowField("shadowSpread", 0, -SHADOW_SPREAD_RANGE, SHADOW_SPREAD_RANGE)
        }
        min={-SHADOW_SPREAD_RANGE}
        max={SHADOW_SPREAD_RANGE}
        showValueTooltip
        formatValue={(v) => `${Math.round(v)}px`}
        resetDisabled={spread === 0}
      />
    </div>
  )
}

function VideoAppearanceControls({ video }: { video: CanvasVideoItem }) {
  const { updateVideoAppearance } = useEditorCanvasActions()

  // Cap the slider at half the shorter side so the path can never
  // self-intersect. The stored value is allowed up to this clamp; the
  // sceneFunc also re-clamps defensively against the live size.
  const radiusMax = Math.max(
    0,
    Math.floor(Math.min(video.width, video.height) / 2)
  )
  const radius = Math.max(0, Math.min(radiusMax, Math.round(video.cornerRadius)))
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
    <div className="flex w-full flex-col gap-8">
      <div className="flex w-full flex-col gap-5">
        <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase select-none">
          Corners
        </h4>
        <AdjustmentRow
          label="Radius"
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
      <ShadowControls video={video} />
    </div>
  )
}

export function VideoPanel() {
  const { videos, selectedVideo } = useEditorCanvasMedia()
  const { selectItem } = useEditorCanvasActions()

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
              <VideoFileGrid videos={videos} onSelect={selectItem} />
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
                    className="h-auto p-0! text-sm font-semibold text-foreground px-0 py-0 -translate-x-6"
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
