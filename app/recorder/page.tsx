"use client"

import React, { useEffect, useState, type MouseEvent } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  Cancel01Icon,
  Camera01Icon,
  CameraOff01Icon,
  Mic01Icon,
  MicOff01Icon,
  Settings01Icon,
  VolumeHighIcon,
  ModernTvIcon,
  VolumeOffIcon,
  BrowserIcon,
  DashedLine02Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { DRAG, NO_DRAG } from "@/lib/window-drag"
import type {
  RecorderInputKind,
  RecorderMenuAnchor,
  RecorderPickerMode,
  RecorderState,
} from "@/types/api"

function Separator() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
}

const EMPTY_STATE: RecorderState = {
  status: "idle",
  settings: {
    systemAudio: false,
    microphoneDeviceId: null,
    microphoneLabel: "No microphone",
    cameraDeviceId: null,
    cameraLabel: "No camera",
    hideCameraPreview: false,
    hideCursor: false,
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

function menuAnchor(element: HTMLElement): RecorderMenuAnchor {
  const rect = element.getBoundingClientRect()
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.bottom + 6),
  }
}

export default function RecorderPage() {
  const [state, setState] = useState<RecorderState>(EMPTY_STATE)

  const canChangeInputs = state.status === "idle" && state.pickerMode === null
  const canPickTarget = state.status === "idle"
  const canClose = state.status === "idle"
  const systemAudioLabel = (() => {
    if (!state.settings.systemAudio) return "No system audio"
    if (state.settings.systemAudioScope === "all") return "Record system audio"
    const count = state.settings.systemAudioApplications.length
    if (count === 0) return "No apps selected"
    return `Sound from ${count} ${count === 1 ? "app" : "apps"}`
  })()

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
    event: MouseEvent<HTMLButtonElement>
  ) {
    if (!window.api?.recorder || !canChangeInputs) return
    const next = await window.api.recorder.showInputMenu(
      kind,
      menuAnchor(event.currentTarget)
    )
    setState(next)
  }

  async function showSettingsMenu(event: MouseEvent<HTMLButtonElement>) {
    if (!window.api?.recorder || !canChangeInputs) return
    const next = await window.api.recorder.showSettingsMenu(
      menuAnchor(event.currentTarget)
    )
    setState(next)
  }

  async function startPicker(mode: RecorderPickerMode) {
    if (!window.api?.recorder || !canPickTarget) return
    if (state.pickerMode === mode) {
      const next = await window.api.recorder.cancelPicker()
      setState(next)
      return
    }
    const next = await window.api.recorder.startPicker(mode)
    setState(next)
  }

  return (
    <div
      data-window="recorder"
      className="flex w-full h-13 items-center justify-center overflow-hidden bg-transparent"
      style={DRAG}
    >
      <div className="flex h-full w-full items-center overflow-hidden px-1 select-none">
        <Button
          variant="ghost"
          size="icon"
          className="hover:bg-white/20 dark:hover:bg-white/5 focus-visible:bg-white/20 dark:focus-visible:bg-white/5"
          style={NO_DRAG}
          onClick={handleClose}
          disabled={!canClose}
          aria-label="Close recorder"
        >
          <HugeiconsIcon icon={Cancel01Icon} color="currentColor" />
        </Button>

        <Separator />
        <Button
          variant="ghost"
          size="icon-lg"
          className={state.pickerMode === "display" ? "bg-white/20 dark:bg-white/5 hover:bg-white/20 dark:hover:bg-white/5 focus-visible:bg-white/20 dark:focus-visible:bg-white/5" : "hover:bg-white/20 dark:hover:bg-white/5 focus-visible:bg-white/20 dark:focus-visible:bg-white/5"}
          style={NO_DRAG}
          onClick={() => startPicker("display")}
          disabled={!canPickTarget}
          aria-pressed={state.pickerMode === "display"}
          title="Display"
          aria-label="Select display to record"
        >
          <HugeiconsIcon icon={ModernTvIcon} />
        </Button>
        <Button
          variant="ghost"
          size="icon-lg"
          className={state.pickerMode === "window" ? "bg-white/20 dark:bg-white/5 hover:bg-white/20 dark:hover:bg-white/5 focus-visible:bg-white/20 dark:focus-visible:bg-white/5" : "hover:bg-white/20 dark:hover:bg-white/5 focus-visible:bg-white/20 dark:focus-visible:bg-white/5"}
          style={NO_DRAG}
          onClick={() => startPicker("window")}
          disabled={!canPickTarget}
          aria-pressed={state.pickerMode === "window"}
          title="Window"
          aria-label="Select window to record"
        >
          <HugeiconsIcon icon={BrowserIcon} />
        </Button>
        <Button
          variant="ghost"
          size="icon-lg"
          className={state.pickerMode === "region" ? "bg-white/20 dark:bg-white/5 hover:bg-white/20 dark:hover:bg-white/5 focus-visible:bg-white/20 dark:focus-visible:bg-white/5" : "hover:bg-white/20 dark:hover:bg-white/5 focus-visible:bg-white/20 dark:focus-visible:bg-white/5"}
          style={NO_DRAG}
          onClick={() => startPicker("region")}
          disabled={!canPickTarget}
          aria-pressed={state.pickerMode === "region"}
          title="Region"
          aria-label="Select region to record"
        >
          <HugeiconsIcon icon={DashedLine02Icon} />
        </Button>
        <Separator />

        <Button
          variant="ghost"
          size="sm"
          className="w-34 shrink-0 min-w-0 justify-center text-xs text-(--label-color) hover:bg-white/20 dark:hover:bg-white/5 focus-visible:bg-white/20 dark:focus-visible:bg-white/5"
          style={
            {
              "--label-color": state.settings.cameraDeviceId
                ? "var(--color-foreground)"
                : "var(--color-muted-foreground)",
              ...NO_DRAG,
            } as React.CSSProperties
          }
          onClick={(event) => showInputMenu("camera", event)}
          disabled={!canChangeInputs}
          title={state.settings.cameraLabel}
          aria-label={`Camera - ${state.settings.cameraLabel}`}
        >
          <HugeiconsIcon
            icon={
              state.settings.cameraDeviceId ? Camera01Icon : CameraOff01Icon
            }
            size={15}
            color="currentColor"
          />
          <span className="truncate">{state.settings.cameraLabel}</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="w-34 shrink-0 min-w-0 justify-center text-xs text-(--label-color) hover:bg-white/20 dark:hover:bg-white/5 focus-visible:bg-white/20 dark:focus-visible:bg-white/5"
          style={
            {
              "--label-color": state.settings.microphoneDeviceId
                ? "var(--color-foreground)"
                : "var(--color-muted-foreground)",
              ...NO_DRAG,
            } as React.CSSProperties
          }
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
          className="w-34 shrink-0 min-w-0 justify-center text-xs text-(--label-color) hover:bg-white/20 dark:hover:bg-white/5 focus-visible:bg-white/20 dark:focus-visible:bg-white/5"
          style={
            {
              "--label-color": state.settings.systemAudio
                ? "var(--color-foreground)"
                : "var(--color-muted-foreground)",
              ...NO_DRAG,
            } as React.CSSProperties
          }
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
          variant="ghost"
          size="sm"
          className="gap-1 hover:bg-white/20 dark:hover:bg-white/5 focus-visible:bg-white/20 dark:focus-visible:bg-white/5"
          style={NO_DRAG}
          onClick={showSettingsMenu}
          disabled={!canChangeInputs}
          title="Recorder settings"
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
