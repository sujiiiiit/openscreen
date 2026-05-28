"use client"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"
import {
  CURSOR_SIZE_DEFAULT,
  CURSOR_SIZE_MAX,
  CURSOR_SIZE_MIN,
} from "@/components/editor/canvas/cursor-scene"
import {
  useEditorCanvasActions,
  useEditorCanvasArtboard,
  useEditorCanvasMedia,
} from "@/components/editor/canvas/provider"

// The slider works in whole percent (100% = the recorded-accurate minimum) and
// converts to the stored multiplier. Bounds come from cursor-scene so the
// control, the editor overlay, and the export pipeline never drift apart.
const SIZE_MIN_PCT = Math.round(CURSOR_SIZE_MIN * 100)
const SIZE_MAX_PCT = Math.round(CURSOR_SIZE_MAX * 100)
const SIZE_DEFAULT_PCT = Math.round(CURSOR_SIZE_DEFAULT * 100)

export function CursorPanel() {
  const { artboard } = useEditorCanvasArtboard()
  const { videos } = useEditorCanvasMedia()
  const { setCursorSizeMultiplier } = useEditorCanvasActions()

  // The recorded cursor is drawn over the screen recording, so the control is
  // meaningless without one — disable it rather than move a slider that does
  // nothing visible (mirrors the Padding control in the Background panel).
  const hasScreenVideo = videos.some((video) => video.role === "screen")

  const multiplier = Math.min(
    CURSOR_SIZE_MAX,
    Math.max(CURSOR_SIZE_MIN, artboard.cursorSizeMultiplier)
  )
  const sizePct = Math.round(multiplier * 100)
  const isDefault = sizePct === SIZE_DEFAULT_PCT

  const applyPct = (pct: number) => {
    setCursorSizeMultiplier(pct / 100)
  }

  return (
    <section className="flex w-full flex-col gap-4 pb-6">
      <header className="space-y-2">
        <h3 className="text-sm font-semibold select-none">Cursor</h3>
        <p className="text-xs text-muted-foreground select-none">
          Resize the recorded pointer for emphasis. 100% is the recorded-
          accurate size; larger values magnify the cursor while keeping its
          position and timing exact.
        </p>
      </header>

      <div className="w-full space-y-2">
        <div className="flex items-center justify-between">
          <h4
            className={cn(
              "text-xs font-semibold transition-opacity select-none",
              !hasScreenVideo && "opacity-50"
            )}
          >
            Size
          </h4>
          <span
            className={cn(
              "text-xs text-muted-foreground tabular-nums select-none",
              !hasScreenVideo && "opacity-50"
            )}
          >
            {sizePct}%
          </span>
        </div>
        <div className="flex w-full items-center gap-3">
          <Slider
            size="sm"
            value={[sizePct]}
            onValueChange={(values) =>
              applyPct(Array.isArray(values) ? values[0] : values)
            }
            min={SIZE_MIN_PCT}
            max={SIZE_MAX_PCT}
            disabled={!hasScreenVideo}
            showValueTooltip
            formatValue={(v) => `${Math.round(v)}%`}
            className="flex-1"
          />
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => applyPct(SIZE_DEFAULT_PCT)}
            disabled={!hasScreenVideo || isDefault}
          >
            Reset
          </Button>
        </div>
      </div>
    </section>
  )
}
