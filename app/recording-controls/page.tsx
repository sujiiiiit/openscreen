"use client"

import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { PauseIcon, PlayIcon, StopIcon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DRAG, NO_DRAG } from "@/lib/window-drag"
import type { RecorderState } from "@/types/api"

const EMPTY_STATE: RecorderState = {
  status: "idle",
  settings: {
    systemAudio: false,
    microphoneDeviceId: null,
    microphoneLabel: "No microphone",
    cameraDeviceId: null,
    cameraLabel: "No camera",
  },
  sessionId: null,
  outputDir: null,
  activeFiles: null,
  lastResult: null,
  lastError: null,
  pickerMode: null,
  recordingStartedAt: null,
  pausedMs: 0,
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mm = String(minutes).padStart(2, "0")
  const ss = String(seconds).padStart(2, "0")
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

// The displayed elapsed time is the wall-clock interval since the recording
// started, minus the total time the session has been paused. While paused
// the freeze-frame value is computed from the snapshot's pausedMs, which the
// main process bumps whenever the native side reports it.
function computeElapsed(state: RecorderState, now: number): number {
  if (!state.recordingStartedAt) return 0
  const elapsedWall = now - state.recordingStartedAt
  return Math.max(0, elapsedWall - state.pausedMs)
}

export default function RecordingControlsPage() {
  const [state, setState] = useState<RecorderState>(EMPTY_STATE)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!window.api?.recorder) return undefined
    window.api.recorder.getState().then(setState)
    return window.api.recorder.onChanged(setState)
  }, [])

  // Tick the displayed timer 4x/s while actively recording. When paused, the
  // tick still runs but computeElapsed ignores the wall-clock advance because
  // pausedMs grows in lockstep on the main process side, so the displayed
  // value freezes.
  useEffect(() => {
    if (state.status !== "recording") return undefined
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [state.status])

  const elapsed = computeElapsed(state, state.status === "paused" ? Date.now() : now)
  const isPaused = state.status === "paused"
  const isBusy = state.status === "starting" || state.status === "stopping"

  async function handleStop() {
    if (!window.api?.recorder || isBusy) return
    setState(await window.api.recorder.stop())
  }

  async function handleTogglePause() {
    if (!window.api?.recorder || isBusy) return
    if (isPaused) {
      setState(await window.api.recorder.resume())
    } else {
      setState(await window.api.recorder.pause())
    }
  }

  return (
    <div
      data-window="recording-controls"
      className="flex h-13 w-full items-center justify-center overflow-hidden"
      style={DRAG}
    >
      <div className="flex h-full w-full items-center gap-2 px-3 select-none">
        <div
          className="flex items-center gap-2 font-mono text-sm tabular-nums text-foreground"
          aria-live="polite"
          aria-label={`Recording duration ${formatElapsed(elapsed)}`}
        >
          <span
            className={
              isPaused
                ? "size-2 rounded-full bg-amber-400"
                : "size-2 rounded-full bg-red-500 animate-pulse"
            }
            aria-hidden="true"
          />
          <span>{formatElapsed(elapsed)}</span>
        </div>

        <div className="ml-auto flex items-center gap-1" style={NO_DRAG}>
          <Button
            variant="ghost"
            size="icon"
            className="hover:bg-white/20 dark:hover:bg-white/5"
            onClick={handleTogglePause}
            disabled={isBusy}
            aria-label={isPaused ? "Resume recording" : "Pause recording"}
            title={isPaused ? "Resume" : "Pause"}
          >
            <HugeiconsIcon
              icon={isPaused ? PlayIcon : PauseIcon}
              size={16}
              color="currentColor"
            />
          </Button>
          <Button
            variant="destructive"
            size="xs"
            className="gap-1.5 text-xs"
            onClick={handleStop}
            disabled={isBusy}
            aria-label="Stop recording"
            title={state.lastError ?? "Stop recording"}
          >
            {isBusy ? (
              <Spinner size={14} className="text-current" />
            ) : (
              <HugeiconsIcon icon={StopIcon} size={14} color="currentColor" />
            )}
            <span>Stop</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
