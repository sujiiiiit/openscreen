"use client"

import { useId } from "react"
import { motion } from "motion/react"

import { cn } from "@/lib/utils"

// Shared pill-style segmented selector used by the sidebar panels (Cursor
// smoothing, Video border alignment). The selected pill slides between
// options via a Motion layout transition.
export type SelectionPillOption<TValue extends string> = {
  value: TValue
  label: string
}
type SelectionPillSize = "default" | "xs" | "md"

const SELECTION_PILL_BUTTON_CLASS =
  "relative inline-flex shrink-0 items-center justify-center rounded-full whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50"
const SELECTION_PILL_SIZE_CLASS: Record<SelectionPillSize, string> = {
  default: "px-4 py-2 text-sm",
  xs: "h-6 px-2.5 text-xs",
  md: "h-8 px-3 text-sm",
}

export function SelectionPills<TValue extends string>({
  ariaLabel,
  className,
  disabled,
  options,
  size = "default",
  value,
  onValueChange,
}: {
  ariaLabel: string
  className?: string
  disabled: boolean
  options: ReadonlyArray<SelectionPillOption<TValue>>
  size?: SelectionPillSize
  value: TValue
  onValueChange: (value: TValue) => void
}) {
  const indicatorLayoutId = `${useId()}-indicator`

  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-nowrap items-center gap-1",
        className
      )}
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
