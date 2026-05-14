"use client"

import { useEffect, useState } from "react"
import Image from "next/image"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  BrowserIcon,
  ModernTvIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { RecordIcon } from "@/components/ui/record-icon"
import { Spinner } from "@/components/ui/spinner"
import type { PickerOverlayTarget } from "@/types/api"

export default function WindowPickerPage() {
  const [target, setTarget] = useState<PickerOverlayTarget | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!window.api?.windowPicker) return undefined

    const unsubscribe = window.api.windowPicker.onTargetChanged(setTarget)
    // Pull the current target on mount. The push channel only fires when the
    // resolved target's key changes, and display mode resolves the same
    // target every poll — so without this we'd never receive the initial
    // target on the first display-picker open.
    let stale = false
    window.api.windowPicker.getCurrentTarget().then((current) => {
      if (!stale && current) setTarget(current)
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void window.api.windowPicker.cancel()
      }
    }
    window.addEventListener("keydown", onKeyDown)

    return () => {
      stale = true
      unsubscribe()
      window.removeEventListener("keydown", onKeyDown)
      void window.api.windowPicker.setInteractive(false)
    }
  }, [])

  async function setInteractive(interactive: boolean) {
    await window.api?.windowPicker?.setInteractive(interactive)
  }

  async function startRecording() {
    if (confirming) return
    setConfirming(true)
    try {
      await window.api?.windowPicker?.confirm()
    } finally {
      setConfirming(false)
    }
  }

  if (!target) {
    return (
      <main
        data-window="window-picker"
        className="h-screen w-screen bg-transparent"
      />
    )
  }

  const isDisplay = target.mode === "display"
  const targetWidth = Math.max(1, target.bounds.width)
  const targetHeight = Math.max(1, target.bounds.height)
  const cornerRadius = isDisplay
    ? 0
    : Math.min(22, Math.max(10, Math.min(targetWidth, targetHeight) / 20))

  return (
    <main
      data-window="window-picker"
      className="relative h-screen w-screen overflow-hidden bg-transparent text-foreground transition-none select-none"
    >
      <section
        className="pointer-events-none absolute top-0 left-0 flex items-center justify-center overflow-hidden border border-border/60 bg-background/35 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06),0_0_0_1px_rgba(0,0,0,0.25)]"
        style={{
          width: targetWidth,
          height: targetHeight,
          borderRadius: cornerRadius,
          contain: "layout paint style",
          transform: `translate3d(${target.bounds.x}px, ${target.bounds.y}px, 0)`,
          transition: "none",
          willChange: "transform, width, height",
        }}
      >
        <div className="absolute inset-x-0 top-0 h-px bg-foreground/15" />
        <div className="relative flex min-w-70 flex-col items-center">
          {target.iconDataUrl && !isDisplay && (
            <div className="mb-5 flex size-19 items-center justify-center overflow-hidden">
              <Image
                src={target.iconDataUrl}
                alt=""
                width={72}
                height={72}
                sizes="72px"
                priority
                className="size-full object-contain"
                draggable={false}
              />
            </div>
          )}

          <h1 className="max-w-96 truncate text-center text-[32px] leading-none font-semibold text-foreground drop-shadow-[0_2px_8px_rgba(0,0,0,0.55)]">
            {target.title}
          </h1>

          <div className="mt-3 flex items-center gap-2 text-sm font-medium text-foreground/85 drop-shadow-[0_1px_4px_rgba(0,0,0,0.45)]">
            <span>{target.sizeLabel}</span>
          </div>

          <div
            className="pointer-events-auto mt-7 flex flex-col items-center gap-4"
            onPointerEnter={() => void setInteractive(true)}
            onPointerLeave={() => void setInteractive(false)}
            onFocus={() => void setInteractive(true)}
            onBlur={() => void setInteractive(false)}
          >
            <Button
              size="lg"
              onClick={startRecording}
              disabled={confirming}
              aria-label={`Start recording ${target.title}`}
            >
              {confirming ? (
                <Spinner size={16} className="text-current" />
              ) : (
                <RecordIcon
                  data-icon="inline-start"
                  size={20}
                  className="text-current"
                />
              )}
              <span>Start recording</span>
            </Button>
          </div>
        </div>
      </section>
    </main>
  )
}
