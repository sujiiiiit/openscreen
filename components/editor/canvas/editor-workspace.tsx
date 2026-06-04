"use client"

import { useEffect, useRef } from "react"
import dynamic from "next/dynamic"

import { PreviewControls } from "@/components/editor/canvas/preview-controls"
import {
  useEditorCanvasActions,
  useEditorCanvasTimeline,
  useEditorCanvasTimelineActions,
  useEditorCanvasView,
  useEditorHistory,
} from "@/components/editor/canvas/provider"
import {
  hasZoomModifier,
  isEditableTarget,
} from "@/components/editor/canvas/view-transform-utils"

// The PixiJS canvas is the editor canvas. Loaded with ssr:false because PixiJS
// initializes against the browser canvas/GPU.
const PixiCanvas = dynamic(
  () =>
    import("@/components/editor/canvas/pixi/pixi-canvas").then(
      (m) => m.PixiCanvas
    ),
  { ssr: false }
)

/**
 * The editor workspace shell. The canvas itself (viewport, nodes, selection,
 * transform, cursor, zoom, blur) is the PixiJS scene/controllers; this component
 * only owns the outer chrome + the keyboard that isn't already handled by those
 * controllers:
 *
 *  - ViewportController: wheel/pinch/drag zoom + pan, zoom/fit/space shortcuts.
 *  - TransformController: select/marquee, move/resize/rotate, delete/duplicate/
 *    lock/nudge/escape.
 *  - Here: undo/redo, timeline frame-step, zoom-clip delete, and (in fullscreen
 *    preview) Space → play/pause; plus preview enter/exit (fullscreen + play).
 */
export default function EditorWorkspace() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const isPreviewModeRef = useRef(false)
  const prevPreviewModeRef = useRef(false)
  const selectedZoomClipIdRef = useRef<string | null>(null)

  const { isPreviewMode } = useEditorCanvasView()
  const { exitPreview } = useEditorCanvasActions()
  const { selectedZoomClipId } = useEditorCanvasTimeline()
  const {
    setTimelineTime,
    playTimeline,
    pauseTimeline,
    toggleTimelinePlayback,
    stepTimelineFrame,
    removeZoomClip,
  } = useEditorCanvasTimelineActions()
  const { undo, redo } = useEditorHistory()

  useEffect(() => {
    isPreviewModeRef.current = isPreviewMode
  }, [isPreviewMode])
  useEffect(() => {
    selectedZoomClipIdRef.current = selectedZoomClipId
  }, [selectedZoomClipId])

  // A dropped fullscreen (Esc / OS gesture) while still in preview means the user
  // wants out of preview.
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (isPreviewModeRef.current && document.fullscreenElement == null) {
        exitPreview()
      }
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange)
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange)
    }
  }, [exitPreview])

  // Preview enter/exit: enter → fullscreen the workspace + play from 0; exit →
  // leave fullscreen + pause. The fill-fit view + restore is the canvas's job
  // (PixiCanvas reacts to isPreviewMode). The exit branch is guarded so the
  // initial mount is a no-op.
  useEffect(() => {
    const wasPreview = prevPreviewModeRef.current
    prevPreviewModeRef.current = isPreviewMode

    if (isPreviewMode) {
      const container = containerRef.current
      if (container && document.fullscreenElement !== container) {
        const request = container.requestFullscreen?.()
        if (request && typeof request.catch === "function") {
          request.catch(() => exitPreview())
        }
      }
      setTimelineTime(0)
      playTimeline()
      return
    }

    if (!wasPreview) return
    pauseTimeline()
    if (document.fullscreenElement) {
      void document.exitFullscreen?.()
    }
  }, [exitPreview, isPreviewMode, pauseTimeline, playTimeline, setTimelineTime])

  // Keyboard not already owned by the Pixi controllers.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return

      // In fullscreen preview the workspace is a player: Space toggles play/pause
      // and every editor shortcut is muted (Esc exits via the browser).
      if (isPreviewModeRef.current) {
        if (event.code === "Space") {
          event.preventDefault()
          toggleTimelinePlayback()
        }
        return
      }

      if (hasZoomModifier(event) && event.code === "KeyZ") {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }

      // A selected zoom clip is removed independently of node selection (the two
      // are mutually exclusive). Node deletion is the TransformController's.
      if (
        selectedZoomClipIdRef.current &&
        (event.code === "Delete" || event.code === "Backspace")
      ) {
        event.preventDefault()
        removeZoomClip(selectedZoomClipIdRef.current)
        return
      }

      // Frame-step the timeline playhead (`,` / `.`).
      if (
        !hasZoomModifier(event) &&
        !event.shiftKey &&
        (event.code === "Comma" || event.code === "Period")
      ) {
        event.preventDefault()
        stepTimelineFrame(event.code === "Comma" ? -1 : 1)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [redo, removeZoomClip, stepTimelineFrame, toggleTimelinePlayback, undo])

  return (
    <div
      ref={containerRef}
      className={
        isPreviewMode
          ? "relative h-full w-full overflow-hidden bg-black"
          : "relative h-full w-full overflow-hidden bg-editor-workspace"
      }
    >
      <PixiCanvas />
      {isPreviewMode && <PreviewControls />}
    </div>
  )
}
