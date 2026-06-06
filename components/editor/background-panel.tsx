"use client"

import { useId, useState } from "react"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  Tabs,
  TabsContent,
  TabsContents,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { WallpaperGrid } from "@/components/editor/background/wallpaper-grid"
import { ColorGrid } from "@/components/editor/background/color-grid"
import {
  useEditorCanvasActions,
  useEditorCanvasArtboard,
  useEditorCanvasMedia,
} from "@/components/editor/canvas/provider"

const BACKGROUND_TABS = [
  { value: "wallpaper", label: "Wallpaper" },
  { value: "color", label: "Color" },
] as const

const BACKGROUND_BLUR_DEFAULT = 0
const BACKGROUND_BLUR_MAX = 200
const GRAIN_DEFAULT = 0
const GRAIN_MAX = 100
const PADDING_DEFAULT = 0
const PADDING_MAX = 500

type AdjustmentRowProps = {
  label: string
  description: string
  value: number
  onValueChange: (value: number) => void
  onReset: () => void
  min?: number
  max?: number
  disabled?: boolean
  showValueTooltip?: boolean
  formatValue?: (value: number) => string
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
}: AdjustmentRowProps) {
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
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={onReset}
          disabled={disabled || value === min}
        >
          Reset
        </Button>
      </div>
    </div>
  )
}

export function BackgroundPanel() {
  const switchId = useId()
  const { artboard } = useEditorCanvasArtboard()
  const { videos } = useEditorCanvasMedia()
  const { setArtboardBackground, setArtboardGrain, setArtboardPadding } =
    useEditorCanvasActions()
  const [enabled, setEnabled] = useState(true)

  const wallpaperBackground =
    artboard.background?.type === "wallpaper" ? artboard.background : null
  const isWallpaperActive = wallpaperBackground !== null
  // Padding insets the screen recording specifically — when no screen-role
  // video exists there's nothing to inset, so we disable the control instead
  // of letting users move a slider that does nothing visible.
  const hasScreenVideo = videos.some((video) => video.role === "screen")
  const blurStrength = Math.max(
    BACKGROUND_BLUR_DEFAULT,
    Math.min(BACKGROUND_BLUR_MAX, wallpaperBackground?.blurRadius ?? 0)
  )
  const grainStrength = Math.max(
    GRAIN_DEFAULT,
    Math.min(GRAIN_MAX, artboard.grain)
  )
  const paddingStrength = Math.max(
    PADDING_DEFAULT,
    Math.min(PADDING_MAX, artboard.padding)
  )

  const applyBlur = (next: number) => {
    if (!wallpaperBackground) return
    const clamped = Math.max(
      BACKGROUND_BLUR_DEFAULT,
      Math.min(BACKGROUND_BLUR_MAX, Math.round(next))
    )
    setArtboardBackground({
      type: "wallpaper",
      value: wallpaperBackground.value,
      blurRadius: clamped > 0 ? clamped : undefined,
    })
  }

  const applyGrain = (next: number) => {
    setArtboardGrain(Math.max(GRAIN_DEFAULT, Math.min(GRAIN_MAX, next)))
  }

  const applyPadding = (next: number) => {
    setArtboardPadding(Math.max(PADDING_DEFAULT, Math.min(PADDING_MAX, next)))
  }

  return (
    <section className="flex w-full flex-col gap-6 pb-6">
      <header className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold select-none">Background</h3>
          <Switch
            id={switchId}
            size="sm"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
        <p className="text-xs text-muted-foreground select-none">
          Adjust canvas fill, gradients, and overlays for your recording
          surface.
        </p>
      </header>
      <Tabs defaultValue="wallpaper">
        <TabsList aria-label="Background style" className="justify-start gap-1">
          {BACKGROUND_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContents className="min-h-24">
          <TabsContent value="wallpaper">
            <WallpaperGrid />
          </TabsContent>

          <TabsContent value="color">
            <ColorGrid />
          </TabsContent>
        </TabsContents>
      </Tabs>
      <div className="flex flex-col gap-9">
        <AdjustmentRow
          label="Padding"
          description={
            hasScreenVideo
              ? "Space around the recording, revealing the background."
              : "Space around the recording — needs a screen recording."
          }
          value={paddingStrength}
          onValueChange={applyPadding}
          onReset={() => applyPadding(PADDING_DEFAULT)}
          min={0}
          max={PADDING_MAX}
          disabled={!hasScreenVideo}
          showValueTooltip
          formatValue={(v) => `${Math.round(v)}px`}
        />
        <AdjustmentRow
          label="Background blur"
          description={
            isWallpaperActive
              ? "Blurs the wallpaper behind the recording."
              : "Blurs the wallpaper — pick a wallpaper first."
          }
          value={blurStrength}
          onValueChange={applyBlur}
          onReset={() => applyBlur(BACKGROUND_BLUR_DEFAULT)}
          min={0}
          max={BACKGROUND_BLUR_MAX}
          disabled={!isWallpaperActive}
          showValueTooltip
          formatValue={(v) => `${Math.round(v)}px`}
        />
        <AdjustmentRow
          label="Grain"
          description="Subtle film-noise texture over the background."
          value={grainStrength}
          onValueChange={applyGrain}
          onReset={() => applyGrain(GRAIN_DEFAULT)}
          min={0}
          max={GRAIN_MAX}
          showValueTooltip
          formatValue={(v) => `${Math.round(v)}`}
        />
      </div>
    </section>
  )
}
