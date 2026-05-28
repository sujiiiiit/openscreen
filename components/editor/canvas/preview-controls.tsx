"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon, PauseIcon, PlayIcon } from "@hugeicons/core-free-icons"

import {
  useEditorCanvasActions,
  useEditorCanvasTimeline,
  useEditorCanvasTimelineActions,
} from "@/components/editor/canvas/provider"

const CONTROLS_HIDE_DELAY_MS = 2500
const ENDED_EPSILON_SECONDS = 0.05

function formatClock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = safe % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(
      secs
    ).padStart(2, "0")}`
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`
}

// Fullscreen preview player chrome: a transparent click-to-toggle surface, an
// auto-hiding bottom transport (play/pause, scrub bar, clock), an always-on exit
// button, and a centered Replay when the timeline finishes. The scrub bar and
// elapsed clock are driven imperatively from the playhead tick subscription so
// the per-frame updates never re-render React.
export function PreviewControls() {
  const { timelineTime, timelineDuration, isTimelinePlaying } =
    useEditorCanvasTimeline()
  const {
    subscribeTimelineTicks,
    setTimelineTime,
    playTimeline,
    pauseTimeline,
    toggleTimelinePlayback,
  } = useEditorCanvasTimelineActions()
  const { exitPreview } = useEditorCanvasActions()

  // Recent-pointer-activity gate. Controls are always shown while paused; while
  // playing they hide once activity lapses. Derived `controlsVisible` keeps the
  // playback state out of any setState-in-effect.
  const [isPointerActive, setIsPointerActive] = useState(true)
  const controlsVisible = !isTimelinePlaying || isPointerActive

  const progressRef = useRef<HTMLDivElement | null>(null)
  const elapsedRef = useRef<HTMLSpanElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const isSeekingRef = useRef(false)
  const durationRef = useRef(timelineDuration)

  const isEnded =
    !isTimelinePlaying &&
    timelineDuration > 0 &&
    timelineTime >= timelineDuration - ENDED_EPSILON_SECONDS

  useEffect(() => {
    durationRef.current = timelineDuration
  }, [timelineDuration])

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  // Mark the chrome active and re-arm the lapse countdown. Called only from
  // event handlers, never from an effect.
  const markActive = useCallback(() => {
    setIsPointerActive(true)
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => {
      setIsPointerActive(false)
    }, CONTROLS_HIDE_DELAY_MS)
  }, [clearHideTimer])

  // Arm the initial lapse countdown on mount (setState lives in the async
  // timeout callback, not the effect body). Cleared on unmount.
  useEffect(() => {
    hideTimerRef.current = window.setTimeout(() => {
      setIsPointerActive(false)
    }, CONTROLS_HIDE_DELAY_MS)
    return clearHideTimer
  }, [clearHideTimer])

  useEffect(() => {
    const paint = (time: number) => {
      const duration = durationRef.current
      const fraction =
        duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0
      if (progressRef.current) {
        progressRef.current.style.width = `${fraction * 100}%`
      }
      if (elapsedRef.current) {
        elapsedRef.current.textContent = formatClock(time)
      }
    }
    return subscribeTimelineTicks(paint)
  }, [subscribeTimelineTicks])

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current
      const duration = durationRef.current
      if (!track || duration <= 0) return
      const rect = track.getBoundingClientRect()
      if (rect.width <= 0) return
      const fraction = Math.min(
        1,
        Math.max(0, (clientX - rect.left) / rect.width)
      )
      setTimelineTime(fraction * duration)
    },
    [setTimelineTime]
  )

  const handleSurfaceClick = useCallback(() => {
    markActive()
    toggleTimelinePlayback()
  }, [markActive, toggleTimelinePlayback])

  const handleSeekPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.stopPropagation()
      if (isTimelinePlaying) pauseTimeline()
      isSeekingRef.current = true
      event.currentTarget.setPointerCapture?.(event.pointerId)
      seekFromClientX(event.clientX)
    },
    [isTimelinePlaying, pauseTimeline, seekFromClientX]
  )

  const handleSeekPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isSeekingRef.current) return
      seekFromClientX(event.clientX)
    },
    [seekFromClientX]
  )

  const handleSeekPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      isSeekingRef.current = false
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    },
    []
  )

  const handleReplay = useCallback(() => {
    setTimelineTime(0)
    playTimeline()
  }, [playTimeline, setTimelineTime])

  return (
    <div
      className="absolute inset-0 z-[60] select-none"
      style={{ cursor: controlsVisible ? "default" : "none" }}
      onPointerMove={markActive}
      onClick={handleSurfaceClick}
    >
      <button
        type="button"
        aria-label="Exit preview"
        title="Exit preview (Esc)"
        onClick={(event) => {
          event.stopPropagation()
          exitPreview()
        }}
        className={`absolute top-5 right-5 flex size-10 items-center justify-center rounded-full bg-black/50 text-white/90 backdrop-blur transition-opacity hover:bg-black/70 hover:text-white ${
          controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={20} color="currentColor" />
      </button>

      {isEnded && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              handleReplay()
            }}
            className="pointer-events-auto flex items-center gap-2 rounded-full bg-white/10 px-6 py-3 text-base font-medium text-white backdrop-blur transition-colors hover:bg-white/20"
          >
            <HugeiconsIcon icon={PlayIcon} size={22} color="currentColor" />
            Replay
          </button>
        </div>
      )}

      <div
        onClick={(event) => event.stopPropagation()}
        className={`absolute right-0 bottom-0 left-0 flex items-center gap-4 bg-gradient-to-t from-black/70 to-transparent px-6 pt-10 pb-6 transition-opacity ${
          controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <button
          type="button"
          aria-label={isTimelinePlaying ? "Pause" : "Play"}
          onClick={() => {
            markActive()
            toggleTimelinePlayback()
          }}
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/10 hover:text-white"
        >
          <HugeiconsIcon
            icon={isTimelinePlaying ? PauseIcon : PlayIcon}
            size={22}
            color="currentColor"
          />
        </button>

        <span
          ref={elapsedRef}
          className="shrink-0 text-sm font-medium text-white/90 tabular-nums"
        >
          {formatClock(timelineTime)}
        </span>

        <div
          ref={trackRef}
          onPointerDown={handleSeekPointerDown}
          onPointerMove={handleSeekPointerMove}
          onPointerUp={handleSeekPointerUp}
          className="group relative h-6 flex-1 cursor-pointer"
        >
          <div className="absolute top-1/2 right-0 left-0 h-1 -translate-y-1/2 rounded-full bg-white/25">
            <div
              ref={progressRef}
              className="h-full rounded-full bg-white"
              style={{
                width:
                  timelineDuration > 0
                    ? `${Math.min(100, (timelineTime / timelineDuration) * 100)}%`
                    : "0%",
              }}
            />
          </div>
        </div>

        <span className="shrink-0 text-sm font-medium text-white/60 tabular-nums">
          {formatClock(timelineDuration)}
        </span>
      </div>
    </div>
  )
}
