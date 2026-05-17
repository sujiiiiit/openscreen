"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react"
import Konva from "konva"
import { Group, Layer, Rect, Stage } from "react-konva"

import { ArtboardPixelGrid } from "@/components/editor/canvas/artboard-pixel-grid"
import { CanvasVideoNode } from "@/components/editor/canvas/canvas-video-node"
import { SelectedVideoTransformer } from "@/components/editor/canvas/selected-video-transformer"
import {
  useEditorCanvasActions,
  useEditorCanvasArtboard,
  useEditorCanvasMedia,
  useEditorCanvasView,
} from "@/components/editor/canvas/provider"
import {
  hasZoomModifier,
  isEditableTarget,
  snapViewTransformToScreenPixels,
} from "@/components/editor/canvas/view-transform-utils"
import {
  clampWorkspaceView,
  getZoomedViewTransform,
  WORKSPACE_PINCH_ZOOM_DELTA,
  WORKSPACE_WHEEL_ZOOM_DELTA,
  WORKSPACE_ZOOM_STEP,
} from "@/lib/editor-canvas"
import type { ViewTransform } from "@/types/editor-canvas"

export default function EditorWorkspace() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<Konva.Stage | null>(null)
  const contentLayerRef = useRef<Konva.Layer | null>(null)
  const viewTransformRef = useRef<ViewTransform>({ scale: 1, x: 0, y: 0 })
  const videoNodeMapRef = useRef(new Map<string, Konva.Image>())
  const isSpacePressedRef = useRef(false)
  const isPanningRef = useRef(false)
  const lastPanPointRef = useRef<{ x: number; y: number } | null>(null)
  const pendingViewTransformRef = useRef<ViewTransform | null>(null)
  const viewTransformFrameRef = useRef<number | null>(null)
  const [isSpacePressed, setIsSpacePressed] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [nodeVersion, setNodeVersion] = useState(0)
  const { videos, selectedItemId } = useEditorCanvasMedia()
  const { artboard } = useEditorCanvasArtboard()
  const { viewportSize, viewTransform } = useEditorCanvasView()
  const {
    fitArtboardToViewport,
    selectItem,
    setViewportSize,
    setViewTransform,
    updateVideoTransform,
  } = useEditorCanvasActions()

  useEffect(() => {
    viewTransformRef.current = viewTransform
  }, [viewTransform])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const updateSize = () => {
      const rect = container.getBoundingClientRect()
      setViewportSize({
        width: rect.width,
        height: rect.height,
      })
    }

    updateSize()
    const resizeObserver = new ResizeObserver(updateSize)
    resizeObserver.observe(container)

    return () => resizeObserver.disconnect()
  }, [setViewportSize])

  useEffect(() => {
    return () => {
      if (viewTransformFrameRef.current === null) return

      cancelAnimationFrame(viewTransformFrameRef.current)
    }
  }, [])

  const scheduleViewTransform = useCallback(
    (transform: ViewTransform) => {
      const clampedTransform = snapViewTransformToScreenPixels(
        clampWorkspaceView(transform, viewportSize, artboard)
      )

      viewTransformRef.current = clampedTransform
      pendingViewTransformRef.current = clampedTransform

      if (viewTransformFrameRef.current !== null) return

      viewTransformFrameRef.current = requestAnimationFrame(() => {
        viewTransformFrameRef.current = null

        const nextTransform = pendingViewTransformRef.current
        pendingViewTransformRef.current = null

        if (nextTransform) {
          setViewTransform(nextTransform)
        }
      })
    },
    [artboard, setViewTransform, viewportSize]
  )

  const zoomAroundPoint = useCallback(
    (point: { x: number; y: number }, scale: number) => {
      scheduleViewTransform(
        getZoomedViewTransform(viewTransformRef.current, point, scale)
      )
    },
    [scheduleViewTransform]
  )

  const zoomBy = useCallback(
    (factor: number) => {
      zoomAroundPoint(
        {
          x: viewportSize.width / 2,
          y: viewportSize.height / 2,
        },
        viewTransformRef.current.scale * factor
      )
    },
    [viewportSize.height, viewportSize.width, zoomAroundPoint]
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return

      if (
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        (event.code === "Digit1" || event.code === "Numpad1")
      ) {
        event.preventDefault()
        fitArtboardToViewport()
        return
      }

      if (hasZoomModifier(event)) {
        if (event.code === "Equal" || event.code === "NumpadAdd") {
          event.preventDefault()
          zoomBy(WORKSPACE_ZOOM_STEP)
          return
        }

        if (event.code === "Minus" || event.code === "NumpadSubtract") {
          event.preventDefault()
          zoomBy(1 / WORKSPACE_ZOOM_STEP)
          return
        }

        if (event.code === "Digit0" || event.code === "Numpad0") {
          event.preventDefault()
          zoomAroundPoint(
            {
              x: viewportSize.width / 2,
              y: viewportSize.height / 2,
            },
            1
          )
          return
        }
      }

      if (event.code !== "Space") return

      event.preventDefault()
      if (isSpacePressedRef.current) return

      isSpacePressedRef.current = true
      setIsSpacePressed(true)
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return

      isSpacePressedRef.current = false
      setIsSpacePressed(false)
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)

    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
    }
  }, [
    fitArtboardToViewport,
    viewportSize.height,
    viewportSize.width,
    zoomAroundPoint,
    zoomBy,
  ])

  const endPan = useCallback(() => {
    isPanningRef.current = false
    lastPanPointRef.current = null
    setIsPanning(false)
  }, [])

  const handleWheel: ComponentProps<typeof Stage>["onWheel"] = (event) => {
    event.evt.preventDefault()

    const stage = stageRef.current
    if (!stage) return

    const pointer = stage.getPointerPosition()
    if (!pointer) return

    if (hasZoomModifier(event.evt)) {
      const zoomDelta =
        event.evt.ctrlKey && !event.evt.metaKey
          ? WORKSPACE_PINCH_ZOOM_DELTA
          : WORKSPACE_WHEEL_ZOOM_DELTA

      zoomAroundPoint(
        pointer,
        viewTransformRef.current.scale *
          Math.pow(WORKSPACE_ZOOM_STEP, -event.evt.deltaY / zoomDelta)
      )
      return
    }

    const current = viewTransformRef.current
    scheduleViewTransform({
      ...current,
      x: current.x - event.evt.deltaX,
      y: current.y - event.evt.deltaY,
    })
  }

  const handleMouseDown: ComponentProps<typeof Stage>["onMouseDown"] = (
    event
  ) => {
    const stage = stageRef.current
    const pointer = stage?.getPointerPosition()
    if (!stage || !pointer) return

    if (event.evt.button === 1 || isSpacePressedRef.current) {
      event.evt.preventDefault()
      isPanningRef.current = true
      lastPanPointRef.current = pointer
      setIsPanning(true)
      return
    }

    if (event.target === stage) {
      selectItem(null)
    }
  }

  const handleMouseMove: ComponentProps<typeof Stage>["onMouseMove"] = () => {
    if (!isPanningRef.current) return

    const stage = stageRef.current
    const pointer = stage?.getPointerPosition()
    const lastPoint = lastPanPointRef.current
    if (!pointer || !lastPoint) return

    const current = viewTransformRef.current
    const nextTransform = {
      ...current,
      x: current.x + pointer.x - lastPoint.x,
      y: current.y + pointer.y - lastPoint.y,
    }

    lastPanPointRef.current = pointer
    scheduleViewTransform(nextTransform)
  }

  const registerVideoNode = useCallback(
    (id: string, node: Konva.Image | null) => {
      if (node) {
        videoNodeMapRef.current.set(id, node)
      } else {
        videoNodeMapRef.current.delete(id)
      }

      setNodeVersion((version) => version + 1)
    },
    []
  )

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === 1) {
      event.preventDefault()
    }
  }

  const cursorClassName = isPanning
    ? "cursor-grabbing"
    : isSpacePressed
      ? "cursor-grab"
      : "cursor-default"

  return (
    <div
      ref={containerRef}
      onContextMenu={handleContextMenu}
      className={`relative h-full w-full overflow-hidden bg-editor-workspace ${cursorClassName}`}
    >
      {viewportSize.width > 0 && viewportSize.height > 0 ? (
        <Stage
          ref={stageRef}
          width={viewportSize.width}
          height={viewportSize.height}
          scaleX={viewTransform.scale}
          scaleY={viewTransform.scale}
          x={viewTransform.x}
          y={viewTransform.y}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={endPan}
          onMouseLeave={endPan}
        >
          <Layer listening={false}>
            <Group>
              <Rect
                x={0}
                y={0}
                width={artboard.width}
                height={artboard.height}
                fill="white"
                perfectDrawEnabled={false}
                shadowForStrokeEnabled={false}
                shadowColor="black"
                shadowBlur={
                  viewTransform.scale >= 2 ? 0 : 40 / viewTransform.scale
                }
                shadowOpacity={0.14}
                shadowOffsetY={
                  viewTransform.scale >= 2 ? 0 : 18 / viewTransform.scale
                }
              />
              <ArtboardPixelGrid
                artboard={artboard}
                viewportSize={viewportSize}
                viewTransform={viewTransform}
              />
            </Group>
          </Layer>
          <Layer ref={contentLayerRef}>
            <Group>
              <Rect
                x={0}
                y={0}
                width={artboard.width}
                height={artboard.height}
                fill="rgba(255,255,255,0)"
                perfectDrawEnabled={false}
                onMouseDown={() => selectItem(null)}
                onTap={() => selectItem(null)}
              />
              <Group
                clipX={0}
                clipY={0}
                clipWidth={artboard.width}
                clipHeight={artboard.height}
              >
                {videos.map((video) => (
                  <CanvasVideoNode
                    key={video.id}
                    video={video}
                    isPanMode={isSpacePressed || isPanning}
                    contentLayerRef={contentLayerRef}
                    onNodeChange={registerVideoNode}
                    onSelect={selectItem}
                    onChange={updateVideoTransform}
                  />
                ))}
              </Group>
              <Rect
                x={0}
                y={0}
                width={artboard.width}
                height={artboard.height}
                stroke="rgba(0,0,0,0.10)"
                strokeWidth={1 / viewTransform.scale}
                perfectDrawEnabled={false}
                shadowForStrokeEnabled={false}
                listening={false}
              />
            </Group>
            <SelectedVideoTransformer
              selectedItemId={selectedItemId}
              viewScale={viewTransform.scale}
              nodeVersion={nodeVersion}
              nodeMapRef={videoNodeMapRef}
            />
          </Layer>
        </Stage>
      ) : null}
    </div>
  )
}
