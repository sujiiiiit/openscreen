"use client"

import React, { useEffect, useMemo, useState, type MouseEvent } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  Cancel01Icon,
  Camera01Icon,
  CameraOff01Icon,
  ComputerScreenShareIcon,
  Mic01Icon,
  MicOff01Icon,
  RecordIcon,
  Settings01Icon,
  StopIcon,
  VolumeHighIcon,
  VolumeOffIcon,
  DashedLine02Icon,
  BrowserIcon
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DRAG, NO_DRAG } from "@/lib/window-drag"
import type {
  RecorderInputKind,
  RecorderMenuAnchor,
  RecorderState,
} from "@/types/api"

function Separator() {
  return <div className="mx-2 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
}

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
  platform: "darwin",
}

function menuAnchor(element: HTMLElement): RecorderMenuAnchor {
  const rect = element.getBoundingClientRect()
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.bottom + 6),
  }
}

export default function RecorderPage() {
  const [state, setState] = useState<RecorderState>(EMPTY_STATE)

  const isRecording = state.status === "recording" || state.status === "stopping"
  const isBusy = state.status === "starting" || state.status === "stopping"
  const canChangeInputs = state.status === "idle"
  const canClose = state.status === "idle"
  const systemAudioLabel = state.settings.systemAudio
    ? "System audio"
    : "No system audio"

  const recordLabel = useMemo(() => {
    if (state.status === "starting") return "Starting"
    if (state.status === "stopping") return "Stopping"
    return isRecording ? "Stop" : "Record"
  }, [isRecording, state.status])

  useEffect(() => {
    if (!window.api?.recorder) return undefined

    window.api.recorder.getState().then(setState)
    return window.api.recorder.onChanged(setState)
  }, [])

  async function handleClose() {
    await window.api?.recorder?.close()
  }

  async function showInputMenu(
    kind: RecorderInputKind,
    event: MouseEvent<HTMLButtonElement>,
  ) {
    if (!window.api?.recorder || !canChangeInputs) return
    const next = await window.api.recorder.showInputMenu(
      kind,
      menuAnchor(event.currentTarget),
    )
    setState(next)
  }

  async function toggleRecording() {
    if (!window.api?.recorder || isBusy) return
    const next = isRecording
      ? await window.api.recorder.stop()
      : await window.api.recorder.start()
    setState(next)
  }

  return (
    <div
      data-window="recorder"
      className="flex overeflow-hidden h-13 w-full items-center justify-center overflow-hidden"
      style={DRAG}
    >
      <div className="flex h-full w-190 items-center overflow-hidden px-2 select-none">
        <Button
          variant="ghost"
          size="icon"
          className="hover:bg-white/20 dark:hover:bg-white/5"
          style={NO_DRAG}
          onClick={handleClose}
          disabled={!canClose}
          aria-label="Close recorder"

        >
          <HugeiconsIcon icon={Cancel01Icon} color="currentColor"/>
        </Button>

        <Separator />

        <Button
          variant="ghost"
          size="icon-lg"
          title="Entire screen"
          className="text-xs dark:hover:bg-white/5 "
          style={NO_DRAG}
          aria-pressed="true"
          aria-label="Display source"
        >
          <HugeiconsIcon
            icon={ComputerScreenShareIcon}
            size={15}
            color="currentColor"
          />
        </Button>
        <Button
          variant="ghost"
          title="window"
          size="icon-lg"
          className="text-xs dark:hover:bg-white/5"
          style={NO_DRAG}
          aria-pressed="true"
          aria-label="Display source"
        >
          <HugeiconsIcon icon={BrowserIcon} />
       
        </Button>
        <Button
          variant="ghost"
          size="icon-lg"
          title="Region capture"
          className="text-xs dark:hover:bg-white/5"
          style={NO_DRAG}
          aria-pressed="true"
          aria-label="Display source"
        >
         <HugeiconsIcon icon={DashedLine02Icon} />
        </Button>

        <Separator />

        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 max-w-34 justify-start text-xs text-(--label-color) hover:bg-white/20 dark:hover:bg-white/5"
          style={{
            "--label-color": state.settings.cameraDeviceId
              ? "var(--color-foreground)"
              : "var(--color-muted-foreground)",
            ...NO_DRAG,
          } as React.CSSProperties}
          onClick={(event) => showInputMenu("camera", event)}
          disabled={!canChangeInputs}
          title={state.settings.cameraLabel}
          aria-label={`Camera - ${state.settings.cameraLabel}`}
        >
          <HugeiconsIcon
            icon={state.settings.cameraDeviceId ? Camera01Icon : CameraOff01Icon}
            size={15}
            color="currentColor"
          />
          <span className="truncate">{state.settings.cameraLabel}</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 max-w-38 justify-start text-xs text-(--label-color) hover:bg-white/20 dark:hover:bg-white/5"
          style={{
            "--label-color": state.settings.microphoneDeviceId
              ? "var(--color-foreground)"
              : "var(--color-muted-foreground)",
            ...NO_DRAG,
          } as React.CSSProperties}
          onClick={(event) => showInputMenu("microphone", event)}
          disabled={!canChangeInputs}
          title={state.settings.microphoneLabel}
          aria-label={`Microphone - ${state.settings.microphoneLabel}`}
        >
          <HugeiconsIcon
            icon={state.settings.microphoneDeviceId ? Mic01Icon : MicOff01Icon}
            size={15}
            color="currentColor"
          />
          <span className="truncate">{state.settings.microphoneLabel}</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 max-w-36 justify-start text-xs text-(--label-color) hover:bg-white/20 dark:hover:bg-white/5"
          style={{
            "--label-color": state.settings.systemAudio
              ? "var(--color-foreground)"
              : "var(--color-muted-foreground)",
            ...NO_DRAG,
          } as React.CSSProperties}
          onClick={(event) => showInputMenu("systemAudio", event)}
          disabled={!canChangeInputs}
          aria-label={`System audio - ${systemAudioLabel}`}
        >
          <HugeiconsIcon
            icon={state.settings.systemAudio ? VolumeHighIcon : VolumeOffIcon}
            size={15}
            color="currentColor"
          />
          <span className="truncate">{systemAudioLabel}</span>
        </Button>

        <Separator />

        <Button
          variant={isRecording ? "destructive" : "default"}
          size="xs"
          className="min-w-20 gap-1 text-xs"
          style={NO_DRAG}
          onClick={toggleRecording}
          disabled={isBusy}
          title={state.lastError ?? undefined}
          aria-label={isRecording ? "Stop recording" : "Start recording"}
        >
          {isBusy ? (
            <Spinner size={15} className="text-current" />
          ) : (
            <HugeiconsIcon
              icon={isRecording ? StopIcon : RecordIcon}
              size={15}
              color="currentColor"
            />
          )}
          {recordLabel}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="gap-1 hover:bg-white/20 dark:hover:bg-white/5"
          style={NO_DRAG}
          aria-label="Recorder settings"
        >
          <HugeiconsIcon icon={Settings01Icon} size={15} color="currentColor" />
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={12}
            color="currentColor"
          />
        </Button>
      </div>
    </div>
  )
}
