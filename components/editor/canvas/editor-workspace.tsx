"use client"

import { useEffect, useRef, useState } from "react"
import dynamic from "next/dynamic"

import { PreviewControls } from "@/components/editor/canvas/preview-controls"
import {
  useEditorCanvasActions,
  useEditorCanvasMedia,
  useEditorCanvasTimeline,
  useEditorCanvasTimelineActions,
  useEditorCanvasView,
  useEditorHistory,
} from "@/components/editor/canvas/provider"
import {
  hasZoomModifier,
  isEditableTarget,
} from "@/components/editor/canvas/view-transform-utils"
import { RENDERER_BACKEND_CHANGE_EVENT } from "@/components/editor/canvas/pixi/renderer-preference"
import { ARTBOARD_SELECTION_ID } from "@/types/editor-canvas"

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
 * cursor, zoom, blur) is the PixiJS scene/controllers; this component only owns
 * the outer chrome + the keyboard that isn't already handled by those
 * controllers:
 *
 *  - ViewportController: wheel/pinch/drag zoom + pan, zoom/fit/space shortcuts.
 *  - SelectionController: hover + click-to-select.
 *  - Here: undo/redo, timeline frame-step, zoom-clip delete, selected-video
 *    delete, and (in fullscreen preview) Space → play/pause; plus preview
 *    enter/exit (fullscreen + play).
 */
export default function EditorWorkspace() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const isPreviewModeRef = useRef(false)
  const prevPreviewModeRef = useRef(false)
  const selectedZoomClipIdRef = useRef<string | null>(null)
  const selectedItemIdRef = useRef<string | null>(null)

  const { isPreviewMode } = useEditorCanvasView()
  const { exitPreview, deleteVideo } = useEditorCanvasActions()
  const { selectedItemId } = useEditorCanvasMedia()
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
  useEffect(() => {
    selectedItemIdRef.current = selectedItemId
  }, [selectedItemId])

  // Renderer backend preference (zoom-menu Renderer submenu). Bumping the key
  // remounts <PixiCanvas>, which tears down the whole Application and re-inits
  // with the new `preference` — the same mount/unmount path React strict mode
  // already exercises, so videos and overlays re-register cleanly through the
  // provider transport.
  const [rendererEpoch, setRendererEpoch] = useState(0)
  useEffect(() => {
    const onRendererChange = () => setRendererEpoch((epoch) => epoch + 1)
    window.addEventListener(RENDERER_BACKEND_CHANGE_EVENT, onRendererChange)
    return () =>
      window.removeEventListener(
        RENDERER_BACKEND_CHANGE_EVENT,
        onRendererChange
      )
  }, [])

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

      // Delete/Backspace removes the selected zoom clip or detaches the
      // selected video (the two selections are mutually exclusive — selecting
      // one clears the other in the provider).
      if (
        (event.code === "Delete" || event.code === "Backspace") &&
        !hasZoomModifier(event) &&
        !event.altKey
      ) {
        if (selectedZoomClipIdRef.current) {
          event.preventDefault()
          removeZoomClip(selectedZoomClipIdRef.current)
          return
        }
        // The artboard sentinel selection has nothing to delete.
        if (
          selectedItemIdRef.current &&
          selectedItemIdRef.current !== ARTBOARD_SELECTION_ID
        ) {
          event.preventDefault()
          deleteVideo(selectedItemIdRef.current)
          return
        }
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
  }, [
    deleteVideo,
    redo,
    removeZoomClip,
    stepTimelineFrame,
    toggleTimelinePlayback,
    undo,
  ])

  return (
    <div
      ref={containerRef}
      className={
        isPreviewMode
          ? "relative h-full w-full overflow-hidden bg-black"
          : "relative h-full w-full overflow-hidden bg-editor-workspace"
      }
    >
      <PixiCanvas key={rendererEpoch} />
      {isPreviewMode && <PreviewControls />}
    </div>
  )
}
