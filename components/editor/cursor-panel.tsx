"use client"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"
import {
  CURSOR_MOTION_BLUR_BACKEND_DEFAULT,
  CURSOR_MOTION_BLUR_DEFAULT,
  CURSOR_SIZE_DEFAULT,
  CURSOR_SIZE_MAX,
  CURSOR_SIZE_MIN,
} from "@/components/editor/canvas/cursor-scene"
import {
  useEditorCanvasActions,
  useEditorCanvasArtboard,
  useEditorCanvasMedia,
} from "@/components/editor/canvas/provider"
import type { CursorMotionBlurBackend } from "@/types/editor-canvas"

// The slider works in whole percent (100% = the recorded-accurate minimum) and
// converts to the stored multiplier. Bounds come from cursor-scene so the
// control, the editor overlay, and the export pipeline never drift apart.
const SIZE_MIN_PCT = Math.round(CURSOR_SIZE_MIN * 100)
const SIZE_MAX_PCT = Math.round(CURSOR_SIZE_MAX * 100)
const SIZE_DEFAULT_PCT = Math.round(CURSOR_SIZE_DEFAULT * 100)

// Motion blur is a single 0–100% intensity; the blur velocity is derived from
// cursor speed (see cursor-scene.ts `computeCursorBlur`).
const BLUR_DEFAULT_PCT = Math.round(CURSOR_MOTION_BLUR_DEFAULT * 100)
const BACKENDS: Array<{ value: CursorMotionBlurBackend; label: string }> = [
  { value: "gpu", label: "GPU" },
  { value: "cpu", label: "CPU" },
]

export function CursorPanel() {
  const { artboard } = useEditorCanvasArtboard()
  const { videos } = useEditorCanvasMedia()
  const {
    setCursorSizeMultiplier,
    setCursorMotionBlur,
    setCursorMotionBlurBackend,
  } = useEditorCanvasActions()

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

  const blurPct = Math.round(
    Math.min(1, Math.max(0, artboard.cursorMotionBlur)) * 100
  )
  const isBlurDefault = blurPct === BLUR_DEFAULT_PCT
  const applyBlurPct = (pct: number) => {
    setCursorMotionBlur(pct / 100)
  }
  const backend = artboard.cursorMotionBlurBackend
  const isBackendDefault = backend === CURSOR_MOTION_BLUR_BACKEND_DEFAULT

  return (
    <section className="flex w-full flex-col gap-4 pb-6">
      <header className="space-y-2">
        <h3 className="text-sm font-semibold select-none">Cursor</h3>
        <p className="text-xs text-muted-foreground select-none">
          Adjust how the cursor appears in your recording.
        </p>
      </header>

      <div className="w-full space-y-2">
        <div className="flex items-center">
          <h4
            className={cn(
              "text-xs font-semibold transition-opacity select-none",
              !hasScreenVideo && "opacity-50"
            )}
          >
            Size
          </h4>
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

      <div className="w-full space-y-2">
        <div className="flex items-center">
          <h4
            className={cn(
              "text-xs font-semibold transition-opacity select-none",
              !hasScreenVideo && "opacity-50"
            )}
          >
            Motion blur
          </h4>
        </div>
        <div className="flex w-full items-center gap-3">
          <Slider
            size="sm"
            value={[blurPct]}
            onValueChange={(values) =>
              applyBlurPct(Array.isArray(values) ? values[0] : values)
            }
            min={0}
            max={100}
            disabled={!hasScreenVideo}
            showValueTooltip
            formatValue={(v) => `${Math.round(v)}%`}
            className="flex-1"
          />
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => applyBlurPct(BLUR_DEFAULT_PCT)}
            disabled={!hasScreenVideo || isBlurDefault}
          >
            Reset
          </Button>
        </div>
      </div>

      <div className="w-full space-y-2">
        <div className="flex items-center">
          <h4
            className={cn(
              "text-xs font-semibold transition-opacity select-none",
              !hasScreenVideo && "opacity-50"
            )}
          >
            Blur renderer
          </h4>
        </div>
        <div className="flex w-full items-center gap-3">
          <div
            className={cn(
              "grid h-8 flex-1 grid-cols-2 rounded-md border border-border bg-muted/40 p-0.5",
              !hasScreenVideo && "opacity-50"
            )}
            role="group"
            aria-label="Cursor motion blur renderer"
          >
            {BACKENDS.map((option) => {
              const selected = backend === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    "rounded-[5px] px-2 text-xs font-medium transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    selected
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  aria-pressed={selected}
                  disabled={!hasScreenVideo}
                  onClick={() => setCursorMotionBlurBackend(option.value)}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() =>
              setCursorMotionBlurBackend(CURSOR_MOTION_BLUR_BACKEND_DEFAULT)
            }
            disabled={!hasScreenVideo || isBackendDefault}
          >
            Reset
          </Button>
        </div>
      </div>
    </section>
  )
}
