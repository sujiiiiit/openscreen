"use client"

import { useEffect, useId, useRef, useState } from "react"
import Image from "next/image"
import { Squircle } from "@squircle-js/react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown01Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const COLLAPSED_HEIGHT = 130

const WALLPAPERS = [
  "ipad-17-dark",
  "ipad-17-light",
  "sequoia-blue-orange",
  "sequoia-blue",
  "sonoma-clouds",
  "sonoma-dark",
  "sonoma-evening",
  "sonoma-from-above",
  "sonoma-horizon",
  "sonoma-light",
  "sonoma-river",
  "tahoe-dark",
  "tahoe-light",
  "ventura-dark",
  "ventura-semi-dark",
  "ventura",
] as const

type WallpaperId = (typeof WALLPAPERS)[number]

const THUMB_PATH = (id: WallpaperId) => `/assets/placeholder/${id}.jpg`

export function WallpaperGrid() {
  const groupId = useId()
  const [selected, setSelected] = useState<WallpaperId | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [contentHeight, setContentHeight] = useState(COLLAPSED_HEIGHT)
  const contentRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = contentRef.current
    if (!node) return
    setContentHeight(isOpen ? node.scrollHeight : COLLAPSED_HEIGHT)
  }, [isOpen])

  return (
    <div className="flex flex-col gap-3">
      <div
        className="relative overflow-hidden transition-[height] duration-300 ease-in-out"
        style={{ height: contentHeight }}
      >
        <div
          ref={contentRef}
          role="radiogroup"
          aria-label="Wallpaper"
          className="grid grid-cols-5 gap-2"
        >
      {WALLPAPERS.map((id) => {
        const isSelected = id === selected
        const inputId = `${groupId}-${id}`
        return (
          <label
            key={id}
            htmlFor={inputId}
            className="block cursor-pointer outline-none"
          >
            <input
              id={inputId}
              type="radio"
              name={groupId}
              value={id}
              checked={isSelected}
              onChange={() => setSelected(id)}
              className="sr-only"
            />
            <Squircle
              cornerRadius={15}
              cornerSmoothing={2}
              className="relative aspect-square w-full overflow-hidden"
            >
              <Image
                src={THUMB_PATH(id)}
                alt={id}
                fill
                sizes="80px"
                className="object-cover"
              />
              <span
                className={cn(
                  "absolute inset-0 bg-black/30 transition-opacity",
                  isSelected ? "opacity-100" : "opacity-0"
                )}
              />
              <span
                className={cn(
                  "absolute inset-0 z-10 flex items-center justify-center transition-opacity",
                  isSelected ? "opacity-100" : "opacity-0"
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
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 left-0 h-12 bg-gradient-to-b from-transparent to-background transition-opacity duration-300",
            isOpen ? "opacity-0" : "opacity-100"
          )}
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={isOpen ? "Show fewer wallpapers" : "Show all wallpapers"}
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
    </div>
  )
}
