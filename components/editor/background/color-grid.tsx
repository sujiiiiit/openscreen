"use client"

import { useId, useMemo, useState } from "react"
import Color from "color"
import { Squircle } from "@squircle-js/react"

import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const COLOR_PRESETS = [
  { value: "#ff6b6b", label: "Red" },
  { value: "#4ecdc4", label: "Teal" },
  { value: "#45b7d1", label: "Blue" },
  { value: "#bcd1ca", label: "Green" },
  { value: "#ffeaa7", label: "Yellow" },
  { value: "#cbcadb", label: "Lavender" },
  { value: "#d97757", label: "Terracotta" },
] as const

const SHADE_STEPS = 10

function CheckBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex size-5 items-center justify-center rounded-full bg-white text-primary-active",
        className
      )}
    >
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
  )
}

export function ColorGrid() {
  const groupId = useId()
  const [selected, setSelected] = useState<string>(COLOR_PRESETS[0].value)

  const shades = useMemo(() => {
    try {
      const base = Color(selected)
      const [h, s] = base.hsl().array()
      return Array.from({ length: SHADE_STEPS }, (_, index) => {
        const lightness = 95 - index * 9 // 95 → 14
        return Color.hsl(h, s, lightness).hex()
      })
    } catch {
      return []
    }
  }, [selected])

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4">
        <div
          role="radiogroup"
          aria-label="Color"
          className="grid grid-cols-5 gap-2"
        >
          {COLOR_PRESETS.map((color) => {
            const isSelected =
              selected.toLowerCase() === color.value.toLowerCase()
            const inputId = `${groupId}-${color.value}`
            return (
              <Tooltip key={color.value}>
                <TooltipTrigger
                  render={(props) => (
                    <label
                      {...props}
                      htmlFor={inputId}
                      className="block cursor-pointer outline-none"
                    >
                      <input
                        id={inputId}
                        type="radio"
                        name={groupId}
                        value={color.value}
                        checked={isSelected}
                        onChange={() => setSelected(color.value)}
                        className="sr-only"
                      />
                      <Squircle
                        cornerRadius={15}
                        cornerSmoothing={2}
                        className="relative aspect-square w-full overflow-hidden"
                        style={{ backgroundColor: color.value }}
                      >
                        <span
                          className={cn(
                            "absolute inset-0 bg-black/20 transition-opacity",
                            isSelected ? "opacity-100" : "opacity-0"
                          )}
                        />
                        <span
                          className={cn(
                            "absolute inset-0 z-10 flex items-center justify-center transition-opacity",
                            isSelected ? "opacity-100" : "opacity-0"
                          )}
                        >
                          <CheckBadge />
                        </span>
                      </Squircle>
                    </label>
                  )}
                />
                <TooltipContent>{color.value}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Select the color shade above to get color values below
          </p>
          <Squircle
            cornerRadius={17}
            cornerSmoothing={4}
            className="flex h-12 w-full overflow-hidden"
          >
            {shades.map((shade) => {
              const isSelected =
                selected.toLowerCase() === shade.toLowerCase()
              return (
                <Tooltip key={shade}>
                  <TooltipTrigger
                    render={(props) => (
                      <button
                        {...props}
                        type="button"
                        onClick={() => setSelected(shade)}
                        className="relative flex-1 cursor-pointer outline-none"
                        style={{ backgroundColor: shade }}
                      >
                        {isSelected ? (
                          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                            <CheckBadge className="size-4 shadow-lg [&_svg]:size-3" />
                          </span>
                        ) : null}
                      </button>
                    )}
                  />
                  <TooltipContent>{shade}</TooltipContent>
                </Tooltip>
              )
            })}
          </Squircle>
        </div>
      </div>
    </TooltipProvider>
  )
}
