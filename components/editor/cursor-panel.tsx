"use client"

import { useEffect, useId, useRef, useState } from "react"
import Image from "next/image"
import { motion } from "motion/react"
import { Squircle } from "@squircle-js/react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown01Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  CURSOR_CLICK_PRESS_SCALE_DEFAULT,
  CURSOR_CLICK_PRESS_SCALE_MAX,
  CURSOR_CLICK_PRESS_SCALE_MIN,
  CURSOR_MOTION_BLUR_BACKEND_DEFAULT,
  CURSOR_MOTION_BLUR_DEFAULT,
  CURSOR_MOTION_ROTATION_DEFAULT,
  CURSOR_MOTION_ROTATION_MODE_DEFAULT,
  CURSOR_POINTER_CURSOR_ID,
  CURSOR_SET_DEFAULT,
  CURSOR_SMOOTHING_MODE_DEFAULT,
  CURSOR_SMOOTHING_MODES,
  CURSOR_SIZE_DEFAULT,
  CURSOR_SIZE_MAX,
  CURSOR_SIZE_MIN,
} from "@/components/editor/canvas/cursor-scene"
import { cursorSetIds, resolveCursorAsset } from "@/lib/cursors/cursor-set"
import type {
  CursorAssetEntry,
  CursorSetId,
} from "@/lib/cursors/cursor-manifest"
import {
  useEditorCanvasActions,
  useEditorCanvasArtboard,
  useEditorCanvasMedia,
} from "@/components/editor/canvas/provider"
import type {
  CursorMotionBlurBackend,
  CursorMotionRotationMode,
  CursorSmoothingMode,
} from "@/types/editor-canvas"

// The slider works in whole percent (100% = the recorded-accurate minimum) and
// converts to the stored multiplier. Bounds come from cursor-scene so the
// control, the editor overlay, and the export pipeline never drift apart.
const SIZE_MIN_PCT = Math.round(CURSOR_SIZE_MIN * 100)
const SIZE_MAX_PCT = Math.round(CURSOR_SIZE_MAX * 100)
const SIZE_DEFAULT_PCT = Math.round(CURSOR_SIZE_DEFAULT * 100)
// User-facing click control is expressed as "downscale %" so larger values make
// the cursor press further down. Stored state remains the actual scale target.
const CLICK_DOWNSCALE_MIN_PCT = Math.round(
  (1 - CURSOR_CLICK_PRESS_SCALE_MAX) * 100
)
const CLICK_DOWNSCALE_MAX_PCT = Math.round(
  (1 - CURSOR_CLICK_PRESS_SCALE_MIN) * 100
)
const CLICK_DOWNSCALE_DEFAULT_PCT = Math.round(
  (1 - CURSOR_CLICK_PRESS_SCALE_DEFAULT) * 100
)
// Motion blur is a single 0–100% intensity; the blur velocity is derived from
// cursor speed (see cursor-scene.ts `computeCursorBlur`).
const BLUR_DEFAULT_PCT = Math.round(CURSOR_MOTION_BLUR_DEFAULT * 100)
// Motion rotation is exposed as one checkpoint slider:
// 0 = none, 100 = full side lean, 200 = full direction rotation. The persisted
// state stays split into mode + amount so old projects keep round-tripping.
const MOTION_ROTATION_DEFAULT_PCT = Math.round(
  CURSOR_MOTION_ROTATION_DEFAULT * 100
)
const MOTION_SLIDER_NONE_VALUE = 0
const MOTION_SLIDER_SIDE_LEAN_VALUE = 100
const MOTION_SLIDER_ROTATION_VALUE = 200
const MOTION_SLIDER_SNAP_RADIUS = 5
const MOTION_SLIDER_THUMB_WIDTH_PX = 16
const MOTION_SLIDER_LABELS: Record<
  "none" | CursorMotionRotationMode,
  string
> = {
  none: "None",
  "side-lean": "Side lean",
  rotation: "Rotation",
}
const MOTION_SLIDER_CHECKPOINTS: Array<{
  key: "none" | CursorMotionRotationMode
  value: number
}> = [
  { key: "none", value: MOTION_SLIDER_NONE_VALUE },
  { key: "side-lean", value: MOTION_SLIDER_SIDE_LEAN_VALUE },
  { key: "rotation", value: MOTION_SLIDER_ROTATION_VALUE },
]
const motionSliderCheckpointPosition = (value: number) => {
  const pct = (value / MOTION_SLIDER_ROTATION_VALUE) * 100
  const offset =
    MOTION_SLIDER_THUMB_WIDTH_PX / 2 -
    (value / MOTION_SLIDER_ROTATION_VALUE) * MOTION_SLIDER_THUMB_WIDTH_PX
  return offset < 0
    ? `calc(${pct}% - ${Math.abs(offset)}px)`
    : `calc(${pct}% + ${offset}px)`
}
const BACKENDS: Array<{ value: CursorMotionBlurBackend; label: string }> = [
  { value: "gpu", label: "GPU" },
  { value: "cpu", label: "CPU" },
]
const SMOOTHING_LABELS: Record<CursorSmoothingMode, string> = {
  rapid: "Rapid",
  quick: "Quick",
  default: "Default",
  slow: "Slow",
}

type CursorSelectionOption<TValue extends string> = {
  value: TValue
  label: string
}
type CursorSelectionPillSize = "default" | "xs"

const SMOOTHING_OPTIONS: Array<CursorSelectionOption<CursorSmoothingMode>> =
  CURSOR_SMOOTHING_MODES.map((mode) => ({
    value: mode,
    label: SMOOTHING_LABELS[mode],
  }))
const CURSOR_STYLE_COLLAPSED_HEIGHT = 130

function cursorSetSortRank(id: CursorSetId): { group: number; index: number } {
  if (id === CURSOR_SET_DEFAULT) return { group: 0, index: 0 }
  if (id === "macos-tahoe") return { group: 1, index: 0 }
  if (id === "touch") return { group: 2, index: 0 }
  if (id === "halloween") return { group: 3, index: 0 }
  const custom = /^custom-(\d+)$/.exec(id)
  if (custom) return { group: 4, index: Number(custom[1]) }
  return { group: 5, index: 0 }
}

function compareCursorSetIds(a: CursorSetId, b: CursorSetId): number {
  const rankA = cursorSetSortRank(a)
  const rankB = cursorSetSortRank(b)
  if (rankA.group !== rankB.group) return rankA.group - rankB.group
  if (rankA.index !== rankB.index) return rankA.index - rankB.index
  return a.localeCompare(b)
}

function cursorSetLabel(id: CursorSetId): string {
  if (id === "macos") return "macOS"
  if (id === "macos-tahoe") return "macOS Tahoe"
  if (id === "touch") return "Touch"
  if (id === "halloween") return "Halloween"
  const custom = /^custom-(\d+)$/.exec(id)
  return custom ? `Style ${custom[1]}` : id
}

function cursorPreviewScale(asset: CursorAssetEntry | null): number {
  const scale = asset?.opticalScale ?? 1
  if (!Number.isFinite(scale) || scale <= 0) return 1
  return Math.min(1.25, Math.max(0.4, scale))
}

const CURSOR_STYLE_OPTIONS = [...cursorSetIds]
  .sort(compareCursorSetIds)
  .map((id) => ({
    id,
    label: cursorSetLabel(id),
    asset: resolveCursorAsset(CURSOR_POINTER_CURSOR_ID, id, CURSOR_SET_DEFAULT),
  }))

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function motionSliderValueFromSettings(
  amount: number,
  mode: CursorMotionRotationMode
): number {
  const clampedAmount = clampUnit(amount)
  if (clampedAmount <= 0) return MOTION_SLIDER_NONE_VALUE
  const amountPct = clampedAmount * 100
  return mode === "rotation"
    ? MOTION_SLIDER_SIDE_LEAN_VALUE + amountPct
    : amountPct
}

function motionSettingsFromSliderValue(value: number): {
  amount: number
  mode: CursorMotionRotationMode
} {
  const clamped = Math.min(
    MOTION_SLIDER_ROTATION_VALUE,
    Math.max(MOTION_SLIDER_NONE_VALUE, Number.isFinite(value) ? value : 0)
  )
  if (clamped <= MOTION_SLIDER_SIDE_LEAN_VALUE) {
    return { amount: clamped / 100, mode: "side-lean" }
  }
  return {
    amount: (clamped - MOTION_SLIDER_SIDE_LEAN_VALUE) / 100,
    mode: "rotation",
  }
}

function snapMotionSliderValue(value: number): number {
  const clamped = Math.min(
    MOTION_SLIDER_ROTATION_VALUE,
    Math.max(MOTION_SLIDER_NONE_VALUE, Number.isFinite(value) ? value : 0)
  )
  const nearest = MOTION_SLIDER_CHECKPOINTS.reduce(
    (closest, checkpoint) =>
      Math.abs(checkpoint.value - clamped) < Math.abs(closest - clamped)
        ? checkpoint.value
        : closest,
    MOTION_SLIDER_NONE_VALUE
  )
  return Math.abs(nearest - clamped) <= MOTION_SLIDER_SNAP_RADIUS
    ? nearest
    : clamped
}

function motionSliderLabelForValue(value: number): string {
  const { amount, mode } = motionSettingsFromSliderValue(value)
  if (amount <= 0) return MOTION_SLIDER_LABELS.none
  return `${MOTION_SLIDER_LABELS[mode]} ${Math.round(amount * 100)}%`
}

function activeMotionCheckpoint(value: number): "none" | CursorMotionRotationMode {
  const { amount, mode } = motionSettingsFromSliderValue(value)
  return amount <= 0 ? "none" : mode
}

const SELECTION_PILL_BUTTON_CLASS =
  "relative inline-flex shrink-0 items-center justify-center rounded-full whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50"
const SELECTION_PILL_SIZE_CLASS: Record<CursorSelectionPillSize, string> = {
  default: "px-4 py-2 text-sm",
  xs: "h-6 px-2.5 text-xs",
}

function CursorSelectionPills<TValue extends string>({
  ariaLabel,
  disabled,
  options,
  size = "default",
  value,
  onValueChange,
}: {
  ariaLabel: string
  disabled: boolean
  options: ReadonlyArray<CursorSelectionOption<TValue>>
  size?: CursorSelectionPillSize
  value: TValue
  onValueChange: (value: TValue) => void
}) {
  const indicatorLayoutId = `${useId()}-indicator`

  return (
    <div
      className="flex min-w-0 flex-1 flex-nowrap items-center gap-1"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const selected = value === option.value
        return (
          <motion.button
            key={option.value}
            type="button"
            className={cn(
              SELECTION_PILL_BUTTON_CLASS,
              SELECTION_PILL_SIZE_CLASS[size]
            )}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onValueChange(option.value)}
          >
            {selected && (
              <motion.span
                layoutId={indicatorLayoutId}
                className="absolute inset-0 rounded-full bg-primary-active-bg"
                transition={{ type: "tween", duration: 0.2 }}
              />
            )}
            <span
              className={cn(
                "relative z-10",
                selected ? "text-primary-active" : "text-primary"
              )}
            >
              {option.label}
            </span>
          </motion.button>
        )
      })}
    </div>
  )
}

function CursorStylePicker({
  disabled,
  value,
  onValueChange,
}: {
  disabled: boolean
  value: CursorSetId
  onValueChange: (value: CursorSetId) => void
}) {
  const groupId = useId()
  const [isOpen, setIsOpen] = useState(false)
  const [contentHeight, setContentHeight] = useState(
    CURSOR_STYLE_COLLAPSED_HEIGHT
  )
  const [canExpand, setCanExpand] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = contentRef.current
    if (!node) return
    let frame: number | null = null
    const updateHeight = () => {
      const nextCanExpand =
        node.scrollHeight > CURSOR_STYLE_COLLAPSED_HEIGHT + 1
      setCanExpand(nextCanExpand)
      setContentHeight(
        isOpen || !nextCanExpand
          ? node.scrollHeight
          : CURSOR_STYLE_COLLAPSED_HEIGHT
      )
    }
    const scheduleUpdateHeight = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(updateHeight)
    }
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleUpdateHeight)
    resizeObserver?.observe(node)
    scheduleUpdateHeight()
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
    }
  }, [isOpen])

  return (
    <div className={cn("flex flex-col gap-3", disabled && "opacity-50")}>
      <div
        className="relative overflow-hidden transition-[height] duration-300 ease-in-out"
        style={{ height: contentHeight }}
      >
        <div
          ref={contentRef}
          role="radiogroup"
          aria-label="Cursor style"
          className="grid grid-cols-5 gap-2"
        >
          {CURSOR_STYLE_OPTIONS.map((option) => {
            const selected = option.id === value
            const inputId = `${groupId}-${option.id}`
            return (
              <label
                key={option.id}
                htmlFor={inputId}
                className={cn(
                  "block outline-none",
                  disabled ? "cursor-not-allowed" : "cursor-pointer"
                )}
                title={option.label}
              >
                <input
                  id={inputId}
                  type="radio"
                  name={groupId}
                  value={option.id}
                  checked={selected}
                  disabled={disabled}
                  onChange={() => onValueChange(option.id)}
                  className="sr-only"
                />
                <Squircle
                  cornerRadius={15}
                  cornerSmoothing={2}
                  className="relative aspect-square w-full overflow-hidden bg-white"
                >
                  {option.asset ? (
                    <span className="absolute top-1/2 left-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center">
                      <Image
                        src={option.asset.url}
                        alt=""
                        width={36}
                        height={36}
                        unoptimized
                        draggable={false}
                        className="size-9 object-contain drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]"
                        style={{
                          transform: `scale(${cursorPreviewScale(option.asset)})`,
                        }}
                      />
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "absolute inset-0 bg-black/30 transition-opacity",
                      selected ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span
                    className={cn(
                      "absolute inset-0 z-10 flex items-center justify-center transition-opacity",
                      selected ? "opacity-100" : "opacity-0"
                    )}
                  >
                    <span className="flex size-5 items-center justify-center rounded-full bg-white text-primary-active">
                      <svg
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="size-3.5"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          clipRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        />
                      </svg>
                    </span>
                  </span>
                </Squircle>
              </label>
            )
          })}
        </div>
        {canExpand ? (
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute right-0 bottom-0 left-0 h-12 bg-gradient-to-b from-transparent to-background transition-opacity duration-300",
              isOpen ? "opacity-0" : "opacity-100"
            )}
          />
        ) : null}
      </div>
      {canExpand ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={
            isOpen ? "Show fewer cursor styles" : "Show all cursor styles"
          }
          onClick={() => setIsOpen((prev) => !prev)}
          className="w-full"
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className={cn(
              "transition-transform duration-300",
              isOpen && "-rotate-180"
            )}
          />
        </Button>
      ) : null}
    </div>
  )
}

export function CursorPanel() {
  const { artboard } = useEditorCanvasArtboard()
  const { videos } = useEditorCanvasMedia()
  const {
    setCursorCustomRenderingEnabled,
    setCursorSetId,
    setCursorSizeMultiplier,
    setCursorSmoothingMode,
    setCursorClickPressScale,
    setCursorAlwaysUsePointer,
    setCursorMotionRotation,
    setCursorMotionRotationMode,
    setCursorMotionBlur,
    setCursorMotionBlurBackend,
  } = useEditorCanvasActions()
  const customRenderingSwitchId = useId()
  const alwaysUsePointerSwitchId = useId()

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
  const motionRotationAmount = clampUnit(artboard.cursorMotionRotation)
  const motionRotationMode = artboard.cursorMotionRotationMode
  const motionSliderValue = motionSliderValueFromSettings(
    motionRotationAmount,
    motionRotationMode
  )
  const isMotionRotationDefault =
    Math.round(motionSliderValue) === MOTION_ROTATION_DEFAULT_PCT &&
    motionRotationMode === CURSOR_MOTION_ROTATION_MODE_DEFAULT
  const applyMotionSliderValue = (value: number, snap = false) => {
    const settings = motionSettingsFromSliderValue(
      snap ? snapMotionSliderValue(value) : value
    )
    if (settings.mode !== motionRotationMode) {
      setCursorMotionRotationMode(settings.mode)
    }
    if (Math.abs(settings.amount - motionRotationAmount) > 0.0001) {
      setCursorMotionRotation(settings.amount)
    }
  }
  const motionCheckpoint = activeMotionCheckpoint(motionSliderValue)
  const resetMotionRotation = () => {
    setCursorMotionRotation(CURSOR_MOTION_ROTATION_DEFAULT)
    setCursorMotionRotationMode(CURSOR_MOTION_ROTATION_MODE_DEFAULT)
  }
  const smoothingMode = artboard.cursorSmoothingMode
  const isSmoothingDefault = smoothingMode === CURSOR_SMOOTHING_MODE_DEFAULT
  const clickDownscalePct = Math.round(
    (1 -
      Math.min(
        CURSOR_CLICK_PRESS_SCALE_MAX,
        Math.max(CURSOR_CLICK_PRESS_SCALE_MIN, artboard.cursorClickPressScale)
      )) *
      100
  )
  const isClickDownscaleDefault =
    clickDownscalePct === CLICK_DOWNSCALE_DEFAULT_PCT
  const applyClickDownscalePct = (pct: number) => {
    setCursorClickPressScale(1 - pct / 100)
  }
  const backend = artboard.cursorMotionBlurBackend
  const isBackendDefault = backend === CURSOR_MOTION_BLUR_BACKEND_DEFAULT
  const customRenderingEnabled = artboard.cursorCustomRenderingEnabled
  const cursorControlsDisabled = !hasScreenVideo || !customRenderingEnabled
  const alwaysUsePointer = artboard.cursorAlwaysUsePointer
  const cursorSetId = artboard.cursorSetId

  return (
    <section className="flex w-full flex-col gap-4 pb-6">
      <header className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold select-none">Cursor</h3>
          <Switch
            id={customRenderingSwitchId}
            size="sm"
            checked={customRenderingEnabled}
            onCheckedChange={setCursorCustomRenderingEnabled}
            disabled={!hasScreenVideo}
            aria-label="Custom cursor rendering"
          />
        </div>
        <p className="text-xs text-muted-foreground select-none">
          Adjust how the cursor appears in your recording.
        </p>
      </header>

      <div className="flex w-full items-center justify-between gap-3">
        <label
          htmlFor={alwaysUsePointerSwitchId}
          className={cn(
            "text-xs font-semibold transition-opacity select-none",
            cursorControlsDisabled && "opacity-50"
          )}
        >
          Always use pointer
        </label>
        <Switch
          id={alwaysUsePointerSwitchId}
          size="sm"
          checked={alwaysUsePointer}
          onCheckedChange={setCursorAlwaysUsePointer}
          disabled={cursorControlsDisabled}
        />
      </div>

      <div className="w-full space-y-2">
        <div className="flex items-center">
          <h4 className="text-xs font-semibold transition-opacity select-none">
            Cursor style
          </h4>
        </div>
        <CursorStylePicker
          disabled={false}
          value={cursorSetId}
          onValueChange={setCursorSetId}
        />
      </div>

      <div className="w-full space-y-2">
        <div className="flex items-center">
          <h4
            className={cn(
              "text-xs font-semibold transition-opacity select-none",
              cursorControlsDisabled && "opacity-50"
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
            disabled={cursorControlsDisabled}
            showValueTooltip
            formatValue={(v) => `${Math.round(v)}%`}
            className="flex-1"
          />
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => applyPct(SIZE_DEFAULT_PCT)}
            disabled={cursorControlsDisabled || isDefault}
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
              cursorControlsDisabled && "opacity-50"
            )}
          >
            Click downscale
          </h4>
        </div>
        <div className="flex w-full items-center gap-3">
          <Slider
            size="sm"
            value={[clickDownscalePct]}
            onValueChange={(values) =>
              applyClickDownscalePct(Array.isArray(values) ? values[0] : values)
            }
            min={CLICK_DOWNSCALE_MIN_PCT}
            max={CLICK_DOWNSCALE_MAX_PCT}
            disabled={cursorControlsDisabled}
            showValueTooltip
            formatValue={(v) => `${Math.round(v)}%`}
            className="flex-1"
          />
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => applyClickDownscalePct(CLICK_DOWNSCALE_DEFAULT_PCT)}
            disabled={cursorControlsDisabled || isClickDownscaleDefault}
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
              cursorControlsDisabled && "opacity-50"
            )}
          >
            Smoothing
          </h4>
        </div>
        <div className="flex w-full items-center gap-2">
          <CursorSelectionPills
            ariaLabel="Cursor smoothing"
            disabled={cursorControlsDisabled}
            options={SMOOTHING_OPTIONS}
            size="xs"
            value={smoothingMode}
            onValueChange={setCursorSmoothingMode}
          />
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() =>
              setCursorSmoothingMode(CURSOR_SMOOTHING_MODE_DEFAULT)
            }
            disabled={cursorControlsDisabled || isSmoothingDefault}
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
              cursorControlsDisabled && "opacity-50"
            )}
          >
            Motion
          </h4>
        </div>
        <div className="flex w-full items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="relative pt-6 pb-1.5">
              <div
                className="pointer-events-none absolute inset-x-0 top-[1.5625rem] z-0 h-0"
                aria-hidden="true"
              >
                {MOTION_SLIDER_CHECKPOINTS.map((checkpoint) => (
                  <span
                    key={checkpoint.key}
                    className={cn(
                      "absolute top-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background transition-colors",
                      motionCheckpoint === checkpoint.key
                        ? "bg-primary-active"
                        : "bg-muted-foreground"
                    )}
                    style={{
                      left: motionSliderCheckpointPosition(checkpoint.value),
                    }}
                  />
                ))}
              </div>
              <Slider
                size="sm"
                value={[motionSliderValue]}
                onValueChange={(values) =>
                  applyMotionSliderValue(
                    Array.isArray(values) ? values[0] : values
                  )
                }
                onValueCommitted={(values) =>
                  applyMotionSliderValue(
                    Array.isArray(values) ? values[0] : values,
                    true
                  )
                }
                min={MOTION_SLIDER_NONE_VALUE}
                max={MOTION_SLIDER_ROTATION_VALUE}
                step={1}
                disabled={cursorControlsDisabled}
                showValueTooltip
                formatValue={motionSliderLabelForValue}
                aria-label="Cursor motion"
                className="relative z-10 flex-1"
              />
            </div>
            <div
              className={cn(
                "relative h-3 text-[10px] leading-none font-medium select-none",
                cursorControlsDisabled && "opacity-50"
              )}
            >
              {MOTION_SLIDER_CHECKPOINTS.map((checkpoint, index) => (
                <span
                  key={checkpoint.key}
                  className={cn(
                    "absolute top-0 transition-colors",
                    index === 0 && "-translate-x-0",
                    index === 1 && "-translate-x-1/2",
                    index === 2 && "-translate-x-full",
                    motionCheckpoint === checkpoint.key
                      ? "text-primary-active"
                      : "text-muted-foreground"
                  )}
                  style={{
                    left: motionSliderCheckpointPosition(checkpoint.value),
                  }}
                >
                  {MOTION_SLIDER_LABELS[checkpoint.key]}
                </span>
              ))}
            </div>
          </div>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-4"
            onClick={resetMotionRotation}
            disabled={cursorControlsDisabled || isMotionRotationDefault}
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
              cursorControlsDisabled && "opacity-50"
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
            disabled={cursorControlsDisabled}
            showValueTooltip
            formatValue={(v) => `${Math.round(v)}%`}
            className="flex-1"
          />
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => applyBlurPct(BLUR_DEFAULT_PCT)}
            disabled={cursorControlsDisabled || isBlurDefault}
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
              cursorControlsDisabled && "opacity-50"
            )}
          >
            Blur renderer
          </h4>
        </div>
        <div className="flex w-full items-center gap-2">
          <CursorSelectionPills
            ariaLabel="Cursor motion blur renderer"
            disabled={cursorControlsDisabled}
            options={BACKENDS}
            size="xs"
            value={backend}
            onValueChange={setCursorMotionBlurBackend}
          />
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() =>
              setCursorMotionBlurBackend(CURSOR_MOTION_BLUR_BACKEND_DEFAULT)
            }
            disabled={cursorControlsDisabled || isBackendDefault}
          >
            Reset
          </Button>
        </div>
      </div>
    </section>
  )
}
