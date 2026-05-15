"use client"

import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Delete02Icon,
  PauseIcon,
  PlayIcon,
  RedoIcon,
  StopIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
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
    hideCameraPreview: false,
    systemAudioScope: "all",
    systemAudioApplications: [],
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

function Separator() {
  return <div className="mx-2 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
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
  // interval stops and the last tick value freezes the displayed duration.
  useEffect(() => {
    if (state.status !== "recording") return undefined
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [state.status])

  const elapsed = computeElapsed(state, now)
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

  async function handleRestart() {
    if (!window.api?.recorder || isBusy) return
    setState(await window.api.recorder.restart())
  }

  async function handleDelete() {
    if (!window.api?.recorder || isBusy) return
    setState(await window.api.recorder.delete())
  }

  return (
    <div
      data-window="recording-controls"
      className="flex h-13 w-full items-center justify-center overflow-hidden"
      style={DRAG}
    >
      <div className="flex h-full w-full items-center px-2 select-none">
        <div className="flex items-center" style={NO_DRAG}>
          <Button
            variant="destructive-ghost"
            size="sm"
            className="min-w-20 gap-2 px-2 text-sm tabular-nums"
            onClick={handleStop}
            disabled={isBusy}
            aria-live="polite"
            aria-label={`Recording duration ${formatElapsed(elapsed)}`}
            title={state.lastError ?? "Stop and save recording"}
          >
            <HugeiconsIcon
              icon={StopIcon}
              size={16}
              color="currentColor"
              fill="currentColor"
            />
            <span>{formatElapsed(elapsed)}</span>
          </Button>
        </div>

        <Separator />

        <div className="flex items-center gap-1" style={NO_DRAG}>
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
              fill="currentColor"
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hover:bg-white/20 dark:hover:bg-white/5"
            onClick={handleRestart}
            disabled={isBusy}
            aria-label="Restart recording"
            title="Restart recording"
          >
            <HugeiconsIcon icon={RedoIcon} size={16} color="currentColor" />
          </Button>
          <Button
            variant="destructive-ghost"
            size="icon"
            onClick={handleDelete}
            disabled={isBusy}
            aria-label="Delete recording"
            title="Delete recording"
          >
            <HugeiconsIcon icon={Delete02Icon} size={16} color="currentColor" />
          </Button>
        </div>
      </div>
    </div>
  )
}
