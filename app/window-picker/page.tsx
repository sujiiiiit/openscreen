"use client"

import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  BrowserIcon,
  ModernTvIcon,
  RecordIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { PickerOverlayTarget } from "@/types/api"

export default function WindowPickerPage() {
  const [target, setTarget] = useState<PickerOverlayTarget | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!window.api?.windowPicker) return undefined

    const unsubscribe = window.api.windowPicker.onTargetChanged(setTarget)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void window.api.windowPicker.cancel()
      }
    }
    window.addEventListener("keydown", onKeyDown)

    return () => {
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
    return <main data-window="window-picker" className="h-screen w-screen bg-transparent" />
  }

  const isDisplay = target.mode === "display"
  const targetWidth = Math.max(1, target.bounds.width)
  const targetHeight = Math.max(1, target.bounds.height)
  const contentScale = Math.min(
    1,
    Math.max(0.58, Math.min((targetWidth - 24) / 420, (targetHeight - 24) / 350)),
  )
  const cornerRadius = isDisplay
    ? 0
    : Math.min(22, Math.max(10, Math.min(targetWidth, targetHeight) / 20))

  return (
    <main
      data-window="window-picker"
      className="relative h-screen w-screen overflow-hidden bg-transparent text-white select-none"
    >
      <section
        className="pointer-events-none absolute flex items-center justify-center overflow-hidden border border-[#6f82ff]/45 bg-[#16205c]/72 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),0_0_0_1px_rgba(54,75,190,0.28),0_22px_80px_rgba(5,8,24,0.28)]"
        style={{
          left: target.bounds.x,
          top: target.bounds.y,
          width: targetWidth,
          height: targetHeight,
          borderRadius: cornerRadius,
        }}
      >
        <div className="absolute inset-0 bg-[#243078]/35" />
        <div className="absolute inset-x-0 top-0 h-px bg-white/20" />
        <div
          className="relative flex min-w-70 origin-center flex-col items-center"
          style={{ transform: `scale(${contentScale})` }}
        >
          <div className="mb-7 flex size-21 items-center justify-center overflow-hidden rounded-[24px] border border-white/15 bg-black/35 shadow-[0_12px_34px_rgba(0,0,0,0.42)]">
            {target.iconDataUrl && !isDisplay ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={target.iconDataUrl}
                alt=""
                className="size-full object-contain"
                draggable={false}
              />
            ) : (
              <HugeiconsIcon
                icon={isDisplay ? ModernTvIcon : BrowserIcon}
                size={46}
                color="currentColor"
                className="text-white/88"
              />
            )}
          </div>

          <h1 className="max-w-96 truncate text-center text-[36px] leading-none font-semibold text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.55)]">
            {target.title}
          </h1>

          <div className="mt-3 flex items-center gap-2 text-[15px] font-medium text-white/92 drop-shadow-[0_1px_4px_rgba(0,0,0,0.45)]">
            <span>{target.sizeLabel}</span>
            <span className="rounded-lg bg-white/20 px-2.5 py-1 text-white/90 ring-1 ring-white/10">
              {target.modeLabel}
            </span>
          </div>

          <div
            className="pointer-events-auto mt-8 flex flex-col items-center gap-14"
            onPointerEnter={() => void setInteractive(true)}
            onPointerLeave={() => void setInteractive(false)}
            onFocus={() => void setInteractive(true)}
            onBlur={() => void setInteractive(false)}
          >
            <Button
              className="h-13 min-w-70 gap-3 rounded-lg border-0 bg-[#5332ff] px-8 text-[16px] font-semibold text-white shadow-[0_12px_28px_rgba(40,20,180,0.36)] hover:bg-[#6447ff]"
              onClick={startRecording}
              disabled={confirming}
              aria-label={`Start recording ${target.title}`}
            >
              {confirming ? (
                <Spinner size={19} className="text-current" />
              ) : (
                <span className="flex size-6 items-center justify-center rounded-full bg-white text-[#4d31f2] shadow-[0_1px_5px_rgba(0,0,0,0.3)]">
                  <HugeiconsIcon icon={RecordIcon} size={15} color="currentColor" />
                </span>
              )}
              <span>Start recording</span>
              <HugeiconsIcon icon={ArrowDown01Icon} size={18} color="currentColor" />
            </Button>

            <Button
              variant="ghost"
              className="h-8 rounded-lg border border-white/35 bg-white/14 px-3 text-[15px] font-medium text-white/82 shadow-[0_6px_18px_rgba(0,0,0,0.22)] hover:bg-white/14"
              disabled
              aria-label="Adjust recording area"
            >
              Adjust recording area
            </Button>
          </div>
        </div>
      </section>
    </main>
  )
}
