"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react"
import Konva from "konva"
import { Group, Layer, Rect, Stage } from "react-konva"

import { ArtboardBackground } from "@/components/editor/canvas/artboard-background"
import { ArtboardGrain } from "@/components/editor/canvas/artboard-grain"
import { ArtboardPixelGrid } from "@/components/editor/canvas/artboard-pixel-grid"
import { CanvasVideoNode } from "@/components/editor/canvas/canvas-video-node"
import {
  HOVER_OUTLINE_STROKE,
  HOVER_OUTLINE_STROKE_WIDTH,
  KEYBOARD_NUDGE_LARGE_STEP,
  KEYBOARD_NUDGE_STEP,
  SNAP_THRESHOLD_SCREEN_PX,
  VIDEO_NODE_NAME,
} from "@/components/editor/canvas/canvas-node-constants"
import { SelectedVideoTransformer } from "@/components/editor/canvas/selected-video-transformer"
import { SelectionToolbar } from "@/components/editor/canvas/selection-toolbar"
import {
  SnapGuideOverlay,
  type SnapGuideOverlayHandle,
} from "@/components/editor/canvas/snap-guide-overlay"
import {
  useEditorCanvasActions,
  useEditorCanvasArtboard,
  useEditorCanvasMedia,
  useEditorCanvasTimeline,
  useEditorCanvasTimelineActions,
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
  PIXEL_GRID_SETTINGS,
  WORKSPACE_PINCH_ZOOM_DELTA,
  WORKSPACE_WHEEL_ZOOM_DELTA,
  WORKSPACE_ZOOM_STEP,
} from "@/lib/editor-canvas"
import {
  buildSnapCache,
  findDragSnaps,
  getRotatedAABB,
  snapToIntegerArtboardPixels,
  viewportArtboardAABB,
  type SnapCache,
} from "@/lib/editor-canvas-snap"
import {
  ARTBOARD_SELECTION_ID,
  type CanvasVideoItem,
  type EditorArtboard,
  type ViewTransform,
} from "@/types/editor-canvas"
import { useSidebarTabsContext } from "@/components/editor/sidebar/tabs-provider"

const SELECTION_TOOLBAR_GAP = 18
const SELECTION_TOOLBAR_VIEWPORT_MARGIN = 12
const SELECTION_TOOLBAR_INSIDE_PADDING = 12
const DEFAULT_SELECTION_TOOLBAR_SIZE = {
  width: 120,
  height: 52,
}

function clampToolbarPosition(value: number, min: number, max: number) {
  if (max < min) return min

  return Math.min(max, Math.max(min, value))
}

function normalizeRotationForReadout(rotation: number) {
  const normalized = ((((rotation + 180) % 360) + 360) % 360) - 180
  const rounded = Math.round(normalized)

  return Object.is(rounded, -0) ? 0 : rounded
}

function getVideoNodeFromTarget(target: Konva.Node | null) {
  if (
    target &&
    target.hasName(VIDEO_NODE_NAME) &&
    target instanceof Konva.Image
  ) {
    return target
  }

  return null
}

function getVideoModelScreenRect(
  video: CanvasVideoItem,
  viewTransform: ViewTransform
) {
  const angle = (video.rotation * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const corners = [
    { x: 0, y: 0 },
    { x: video.width, y: 0 },
    { x: video.width, y: video.height },
    { x: 0, y: video.height },
  ].map((point) => ({
    x:
      viewTransform.x +
      (video.x + point.x * cos - point.y * sin) * viewTransform.scale,
    y:
      viewTransform.y +
      (video.y + point.x * sin + point.y * cos) * viewTransform.scale,
  }))
  const minX = Math.min(...corners.map((point) => point.x))
  const minY = Math.min(...corners.map((point) => point.y))
  const maxX = Math.max(...corners.map((point) => point.x))
  const maxY = Math.max(...corners.map((point) => point.y))

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function getVideoNodeScreenRect(
  node: Konva.Image,
  viewTransform: ViewTransform
) {
  const width = node.width() * Math.abs(node.scaleX())
  const height = node.height() * Math.abs(node.scaleY())
  const angle = (node.rotation() * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const nodeX = node.x()
  const nodeY = node.y()
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ].map((point) => ({
    x:
      viewTransform.x +
      (nodeX + point.x * cos - point.y * sin) * viewTransform.scale,
    y:
      viewTransform.y +
      (nodeY + point.x * sin + point.y * cos) * viewTransform.scale,
  }))
  const minX = Math.min(...corners.map((point) => point.x))
  const minY = Math.min(...corners.map((point) => point.y))
  const maxX = Math.max(...corners.map((point) => point.x))
  const maxY = Math.max(...corners.map((point) => point.y))

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

export default function EditorWorkspace() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<Konva.Stage | null>(null)
  const contentLayerRef = useRef<Konva.Layer | null>(null)
  const overlayLayerRef = useRef<Konva.Layer | null>(null)
  const artboardBackdropRef = useRef<HTMLDivElement | null>(null)
  const selectionToolbarRef = useRef<HTMLDivElement | null>(null)
  const rotationReadoutRef = useRef<HTMLDivElement | null>(null)
  const lastAppliedTransformRef = useRef<ViewTransform | null>(null)
  const viewTransformRef = useRef<ViewTransform>({ scale: 1, x: 0, y: 0 })
  const viewportSizeRef = useRef({ width: 0, height: 0 })
  const toolbarSizeRef = useRef(DEFAULT_SELECTION_TOOLBAR_SIZE)
  const selectedItemIdRef = useRef<string | null>(null)
  const selectedVideoRef = useRef<CanvasVideoItem | null>(null)
  const timelineVisibleVideoIdsRef = useRef<ReadonlySet<string>>(new Set())
  const videoNodeMapRef = useRef(new Map<string, Konva.Image>())
  const isSpacePressedRef = useRef(false)
  const isPanningRef = useRef(false)
  const lastPanPointRef = useRef<{ x: number; y: number } | null>(null)
  const pendingViewTransformRef = useRef<ViewTransform | null>(null)
  const viewTransformFrameRef = useRef<number | null>(null)
  const toolbarPositionFrameRef = useRef<number | null>(null)
  const isRotatingSelectedNodeRef = useRef(false)
  const rotatingNodeRef = useRef<Konva.Image | null>(null)
  const [isSpacePressed, setIsSpacePressed] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [nodeVersion, setNodeVersion] = useState(0)
  const hoverOutlineRef = useRef<Konva.Rect | null>(null)
  const hoveredIdRef = useRef<string | null>(null)
  const isPanModeRef = useRef(false)
  const guideOverlayRef = useRef<SnapGuideOverlayHandle | null>(null)
  const snapCacheRef = useRef<SnapCache | null>(null)
  const isSnapDisabledRef = useRef(false)
  const videosRef = useRef<CanvasVideoItem[]>([])
  const artboardRef = useRef<EditorArtboard | null>(null)
  const nudgeGuideClearTimerRef = useRef<number | null>(null)
  const { videos, selectedItemId, selectedVideo } = useEditorCanvasMedia()
  const { primaryAudioVideoId, timelineVisibleVideoIds } =
    useEditorCanvasTimeline()
  const { artboard } = useEditorCanvasArtboard()
  const { viewportSize, viewTransform } = useEditorCanvasView()
  const {
    fitArtboardToViewport,
    deleteVideo,
    duplicateVideo,
    selectItem,
    setVideoLocked,
    setViewportSize,
    setViewTransform,
    updateVideoTransform,
  } = useEditorCanvasActions()
  const {
    registerTimelineCanvasNode,
    registerTimelineVideoElement,
    onTimelineVideoSeeked,
  } = useEditorCanvasTimelineActions()
  const { selectTab: selectSidebarTab, open: openSidebar } =
    useSidebarTabsContext()
  const selectedVideoIsTimelineVisible =
    selectedItemId !== null && timelineVisibleVideoIds.has(selectedItemId)
  const selectedTimelineVideo = selectedVideoIsTimelineVisible
    ? selectedVideo
    : null
  const visibleVideos = useMemo(
    () => videos.filter((video) => timelineVisibleVideoIds.has(video.id)),
    [timelineVisibleVideoIds, videos]
  )

  const updateSelectionToolbarPosition = useCallback(() => {
    const toolbar = selectionToolbarRef.current
    if (!toolbar) return

    if (isRotatingSelectedNodeRef.current) {
      toolbar.style.visibility = "hidden"
      return
    }

    const stage = stageRef.current
    const selectedItemId = selectedItemIdRef.current
    const selectedVideo = selectedVideoRef.current
    const selectedNode = selectedItemId
      ? videoNodeMapRef.current.get(selectedItemId)
      : null
    const viewport = viewportSizeRef.current

    if (
      selectedItemId &&
      !timelineVisibleVideoIdsRef.current.has(selectedItemId)
    ) {
      toolbar.style.visibility = "hidden"
      return
    }

    if (viewport.width <= 0 || viewport.height <= 0) {
      toolbar.style.visibility = "hidden"
      return
    }

    const screenRect =
      stage && selectedNode
        ? getVideoNodeScreenRect(selectedNode, viewTransformRef.current)
        : selectedVideo
          ? getVideoModelScreenRect(selectedVideo, viewTransformRef.current)
          : null

    if (!screenRect) {
      toolbar.style.visibility = "hidden"
      return
    }

    const toolbarWidth = toolbarSizeRef.current.width
    const toolbarHeight = toolbarSizeRef.current.height
    const margin = SELECTION_TOOLBAR_VIEWPORT_MARGIN
    const centerX = screenRect.x + screenRect.width / 2
    let x = centerX - toolbarWidth / 2
    let y = screenRect.y - toolbarHeight - SELECTION_TOOLBAR_GAP

    if (y < margin) {
      const belowY = screenRect.y + screenRect.height + SELECTION_TOOLBAR_GAP
      if (belowY + toolbarHeight <= viewport.height - margin) {
        y = belowY
      } else {
        y = screenRect.y + SELECTION_TOOLBAR_INSIDE_PADDING
      }
    }

    x = clampToolbarPosition(x, margin, viewport.width - toolbarWidth - margin)
    y = clampToolbarPosition(
      y,
      margin,
      viewport.height - toolbarHeight - margin
    )

    toolbar.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(
      y
    )}px, 0)`
    toolbar.style.visibility = "visible"
  }, [])

  const updateRotationReadout = useCallback((node: Konva.Image) => {
    const readout = rotationReadoutRef.current
    if (!readout) return

    readout.textContent = `${normalizeRotationForReadout(node.rotation())}°`
    readout.style.visibility = "visible"
  }, [])

  const showRotationReadout = useCallback(
    (node: Konva.Image) => {
      rotatingNodeRef.current = node
      isRotatingSelectedNodeRef.current = true
      selectionToolbarRef.current?.style.setProperty("visibility", "hidden")
      updateRotationReadout(node)
    },
    [updateRotationReadout]
  )

  const hideRotationReadout = useCallback(() => {
    if (!isRotatingSelectedNodeRef.current && !rotatingNodeRef.current) return

    isRotatingSelectedNodeRef.current = false
    rotatingNodeRef.current = null

    const readout = rotationReadoutRef.current
    if (readout) {
      readout.style.visibility = "hidden"
    }

    updateSelectionToolbarPosition()
  }, [updateSelectionToolbarPosition])

  const scheduleSelectionToolbarPosition = useCallback(() => {
    if (toolbarPositionFrameRef.current !== null) return

    toolbarPositionFrameRef.current = requestAnimationFrame(() => {
      toolbarPositionFrameRef.current = null
      updateSelectionToolbarPosition()
    })
  }, [updateSelectionToolbarPosition])

  const updateHoverOutline = useCallback(() => {
    const rect = hoverOutlineRef.current
    if (!rect) return

    const id = hoveredIdRef.current
    const selected = selectedItemIdRef.current
    const layer = rect.getLayer()

    const hide = () => {
      if (rect.visible()) {
        rect.visible(false)
        layer?.batchDraw()
      }
    }

    if (
      !id ||
      id === selected ||
      isPanModeRef.current ||
      !timelineVisibleVideoIdsRef.current.has(id)
    ) {
      hide()
      return
    }

    const node = videoNodeMapRef.current.get(id)
    if (!node) {
      hide()
      return
    }

    rect.setAttrs({
      x: node.x(),
      y: node.y(),
      width: node.width() * Math.abs(node.scaleX()),
      height: node.height() * Math.abs(node.scaleY()),
      rotation: node.rotation(),
      visible: true,
    })
    layer?.batchDraw()
  }, [])

  const clearHoverOutline = useCallback(() => {
    if (!hoveredIdRef.current) return

    hoveredIdRef.current = null
    updateHoverOutline()
  }, [updateHoverOutline])

  const selectArtboard = useCallback(() => {
    clearHoverOutline()
    hideRotationReadout()
    selectItem(ARTBOARD_SELECTION_ID)
    selectSidebarTab("background")
    openSidebar()
  }, [
    clearHoverOutline,
    hideRotationReadout,
    openSidebar,
    selectItem,
    selectSidebarTab,
  ])

  const updateHoverFromTarget = useCallback(
    (target: Konva.Node | null) => {
      if (isPanModeRef.current) {
        clearHoverOutline()
        return
      }

      const node = getVideoNodeFromTarget(target)
      const id = node?.id() ?? null

      if (!id || id === selectedItemIdRef.current) {
        clearHoverOutline()
        return
      }

      if (id === hoveredIdRef.current) return

      hoveredIdRef.current = id
      updateHoverOutline()
    },
    [clearHoverOutline, updateHoverOutline]
  )

  const applyStageViewTransform = useCallback(
    (transform: ViewTransform) => {
      const stage = stageRef.current
      if (!stage) return

      stage.scale({
        x: transform.scale,
        y: transform.scale,
      })
      stage.position({
        x: transform.x,
        y: transform.y,
      })
      stage.batchDraw()

      const backdrop = artboardBackdropRef.current
      if (backdrop) {
        backdrop.style.transform = `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`
      }

      lastAppliedTransformRef.current = transform

      if (isRotatingSelectedNodeRef.current && rotatingNodeRef.current) {
        updateRotationReadout(rotatingNodeRef.current)
      } else {
        updateSelectionToolbarPosition()
      }
    },
    [updateRotationReadout, updateSelectionToolbarPosition]
  )

  useLayoutEffect(() => {
    viewTransformRef.current = viewTransform

    const last = lastAppliedTransformRef.current
    if (
      last &&
      last.scale === viewTransform.scale &&
      last.x === viewTransform.x &&
      last.y === viewTransform.y
    ) {
      return
    }

    applyStageViewTransform(viewTransform)
  }, [applyStageViewTransform, viewTransform])

  useEffect(() => {
    viewportSizeRef.current = viewportSize
    if (isRotatingSelectedNodeRef.current && rotatingNodeRef.current) {
      updateRotationReadout(rotatingNodeRef.current)
    } else {
      scheduleSelectionToolbarPosition()
    }
  }, [scheduleSelectionToolbarPosition, updateRotationReadout, viewportSize])

  useLayoutEffect(() => {
    selectedItemIdRef.current = selectedItemId
    selectedVideoRef.current = selectedVideo
    hideRotationReadout()
    updateSelectionToolbarPosition()
  }, [
    hideRotationReadout,
    selectedItemId,
    selectedVideo,
    updateSelectionToolbarPosition,
  ])

  useEffect(() => {
    videosRef.current = videos
  }, [videos])

  useEffect(() => {
    artboardRef.current = artboard
  }, [artboard])

  useLayoutEffect(() => {
    updateSelectionToolbarPosition()
  }, [nodeVersion, updateSelectionToolbarPosition])

  useLayoutEffect(() => {
    const toolbar = selectionToolbarRef.current
    if (!toolbar) return

    const updateToolbarSize = () => {
      const rect = toolbar.getBoundingClientRect()
      toolbarSizeRef.current = {
        width: rect.width || DEFAULT_SELECTION_TOOLBAR_SIZE.width,
        height: rect.height || DEFAULT_SELECTION_TOOLBAR_SIZE.height,
      }
      updateSelectionToolbarPosition()
    }

    updateToolbarSize()
    const resizeObserver = new ResizeObserver(updateToolbarSize)
    resizeObserver.observe(toolbar)

    return () => resizeObserver.disconnect()
  }, [
    selectedTimelineVideo?.id,
    selectedTimelineVideo?.locked,
    updateSelectionToolbarPosition,
  ])

  useEffect(() => {
    isPanModeRef.current = isSpacePressed || isPanning
    if (isPanModeRef.current) {
      clearHoverOutline()
    }
    updateHoverOutline()
  }, [clearHoverOutline, isPanning, isSpacePressed, updateHoverOutline])

  useEffect(() => {
    timelineVisibleVideoIdsRef.current = timelineVisibleVideoIds

    if (
      selectedItemIdRef.current &&
      !timelineVisibleVideoIds.has(selectedItemIdRef.current)
    ) {
      guideOverlayRef.current?.clear()
      hideRotationReadout()
    } else {
      scheduleSelectionToolbarPosition()
    }

    updateHoverOutline()
  }, [
    hideRotationReadout,
    scheduleSelectionToolbarPosition,
    timelineVisibleVideoIds,
    updateHoverOutline,
  ])

  useEffect(() => {
    updateHoverOutline()
  }, [selectedItemId, updateHoverOutline])

  useEffect(() => {
    if (typeof window !== "undefined") {
      Konva.pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    }
  }, [])

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
      if (viewTransformFrameRef.current !== null) {
        cancelAnimationFrame(viewTransformFrameRef.current)
      }

      if (toolbarPositionFrameRef.current !== null) {
        cancelAnimationFrame(toolbarPositionFrameRef.current)
      }

      if (nudgeGuideClearTimerRef.current !== null) {
        window.clearTimeout(nudgeGuideClearTimerRef.current)
      }
    }
  }, [])

  const scheduleViewTransform = useCallback(
    (transform: ViewTransform) => {
      const clampedTransform = snapViewTransformToScreenPixels(
        clampWorkspaceView(transform, viewportSize, artboard)
      )

      viewTransformRef.current = clampedTransform
      applyStageViewTransform(clampedTransform)
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
    [applyStageViewTransform, artboard, setViewTransform, viewportSize]
  )

  const flushPendingViewTransform = useCallback(() => {
    const nextTransform = pendingViewTransformRef.current
    if (!nextTransform) return

    pendingViewTransformRef.current = null
    if (viewTransformFrameRef.current !== null) {
      cancelAnimationFrame(viewTransformFrameRef.current)
      viewTransformFrameRef.current = null
    }

    setViewTransform(nextTransform)
  }, [setViewTransform])

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

  const buildDragSnapCache = useCallback(
    (excludeId: string | null) => {
      const currentArtboard = artboardRef.current ?? artboard
      const visibleIds = timelineVisibleVideoIdsRef.current
      const others = (videosRef.current ?? videos).filter(
        (video) => video.id !== excludeId && visibleIds.has(video.id)
      )
      const currentView = viewTransformRef.current
      const currentViewport = viewportSizeRef.current
      const viewportAABB =
        currentViewport.width > 0 && currentViewport.height > 0
          ? viewportArtboardAABB(currentViewport, currentView)
          : null
      const inflatedViewport = viewportAABB
        ? {
            x: viewportAABB.x - viewportAABB.width * 0.25,
            y: viewportAABB.y - viewportAABB.height * 0.25,
            width: viewportAABB.width * 1.5,
            height: viewportAABB.height * 1.5,
          }
        : null
      const gridStep =
        currentView.scale >= PIXEL_GRID_SETTINGS.visibleFromScale
          ? PIXEL_GRID_SETTINGS.unit
          : null
      snapCacheRef.current = buildSnapCache({
        artboard: currentArtboard,
        otherVideos: others,
        includeRuleOfThirds: true,
        gridStep,
        viewportAABB: inflatedViewport,
      })
    },
    [artboard, videos]
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control") {
        if (!isSnapDisabledRef.current) {
          isSnapDisabledRef.current = true
          guideOverlayRef.current?.clear()
        }
      }

      if (isEditableTarget(event.target)) return

      if (selectedItemIdRef.current) {
        const selectedVideo = selectedVideoRef.current

        if (
          event.shiftKey &&
          hasZoomModifier(event) &&
          event.code === "KeyL" &&
          selectedVideo
        ) {
          event.preventDefault()
          setVideoLocked(selectedVideo.id, !selectedVideo.locked)
          return
        }

        if (
          hasZoomModifier(event) &&
          !event.shiftKey &&
          event.code === "KeyD"
        ) {
          event.preventDefault()
          duplicateVideo(selectedItemIdRef.current)
          return
        }

        if (event.code === "Delete" || event.code === "Backspace") {
          event.preventDefault()
          deleteVideo(selectedItemIdRef.current)
          return
        }

        if (
          !hasZoomModifier(event) &&
          (event.code === "ArrowUp" ||
            event.code === "ArrowDown" ||
            event.code === "ArrowLeft" ||
            event.code === "ArrowRight") &&
          selectedVideo &&
          !selectedVideo.locked &&
          timelineVisibleVideoIdsRef.current.has(selectedVideo.id)
        ) {
          event.preventDefault()
          const step = event.shiftKey
            ? KEYBOARD_NUDGE_LARGE_STEP
            : KEYBOARD_NUDGE_STEP
          const dx =
            event.code === "ArrowLeft"
              ? -step
              : event.code === "ArrowRight"
                ? step
                : 0
          const dy =
            event.code === "ArrowUp"
              ? -step
              : event.code === "ArrowDown"
                ? step
                : 0

          const candidateX = selectedVideo.x + dx
          const candidateY = selectedVideo.y + dy
          let finalX = candidateX
          let finalY = candidateY

          buildDragSnapCache(selectedVideo.id)
          const cache = snapCacheRef.current
          if (cache && !isSnapDisabledRef.current) {
            const aabb = getRotatedAABB({
              x: candidateX,
              y: candidateY,
              width: selectedVideo.width,
              height: selectedVideo.height,
              rotation: selectedVideo.rotation,
            })
            const threshold =
              SNAP_THRESHOLD_SCREEN_PX /
              Math.max(0.0001, viewTransformRef.current.scale)
            const result = findDragSnaps(aabb, cache, threshold)

            // Apply per-axis snap only on the axis the user actually nudged.
            // If the snap would reverse or fully cancel the nudge (e.g.,
            // the node is already on a guide), drop the snap so the press
            // still moves the node by the step.
            let snappedX =
              dx === 0 ? selectedVideo.x : candidateX + result.deltaX
            let snappedY =
              dy === 0 ? selectedVideo.y : candidateY + result.deltaY

            let xSnapActive = dx !== 0
            let ySnapActive = dy !== 0

            if (
              xSnapActive &&
              Math.sign(snappedX - selectedVideo.x) !== Math.sign(dx)
            ) {
              snappedX = candidateX
              xSnapActive = false
            }
            if (
              ySnapActive &&
              Math.sign(snappedY - selectedVideo.y) !== Math.sign(dy)
            ) {
              snappedY = candidateY
              ySnapActive = false
            }

            finalX = snappedX
            finalY = snappedY

            const filteredGuides = result.guides.filter((guide) =>
              guide.axis === "x" ? xSnapActive : ySnapActive
            )
            const filteredDistances = result.distances.filter((distance) =>
              distance.axis === "x" ? xSnapActive : ySnapActive
            )

            if (filteredGuides.length > 0 || filteredDistances.length > 0) {
              guideOverlayRef.current?.setGuides(
                filteredGuides,
                filteredDistances
              )
              if (nudgeGuideClearTimerRef.current !== null) {
                window.clearTimeout(nudgeGuideClearTimerRef.current)
              }
              nudgeGuideClearTimerRef.current = window.setTimeout(() => {
                guideOverlayRef.current?.clear()
                nudgeGuideClearTimerRef.current = null
              }, 700)
            } else {
              guideOverlayRef.current?.clear()
              if (nudgeGuideClearTimerRef.current !== null) {
                window.clearTimeout(nudgeGuideClearTimerRef.current)
                nudgeGuideClearTimerRef.current = null
              }
            }
          }
          snapCacheRef.current = null

          updateVideoTransform(selectedVideo.id, {
            x: snapToIntegerArtboardPixels(finalX),
            y: snapToIntegerArtboardPixels(finalY),
          })
          return
        }
      }

      if (event.shiftKey && !event.metaKey && !event.ctrlKey) {
        if (event.code === "KeyF") {
          event.preventDefault()
          fitArtboardToViewport()
          return
        }

        if (event.code === "Digit2" || event.code === "Numpad2") {
          event.preventDefault()
          zoomAroundPoint(
            {
              x: viewportSize.width / 2,
              y: viewportSize.height / 2,
            },
            2
          )
          return
        }
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
      if (event.key === "Meta" || event.key === "Control") {
        if (!event.metaKey && !event.ctrlKey) {
          isSnapDisabledRef.current = false
        }
      }

      if (event.code !== "Space") return

      isSpacePressedRef.current = false
      setIsSpacePressed(false)
    }

    const handleWindowBlur = () => {
      if (isSnapDisabledRef.current) {
        isSnapDisabledRef.current = false
      }
      if (isSpacePressedRef.current) {
        isSpacePressedRef.current = false
        setIsSpacePressed(false)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)
    window.addEventListener("blur", handleWindowBlur)

    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
      window.removeEventListener("blur", handleWindowBlur)
    }
  }, [
    buildDragSnapCache,
    deleteVideo,
    duplicateVideo,
    fitArtboardToViewport,
    setVideoLocked,
    updateVideoTransform,
    viewportSize.height,
    viewportSize.width,
    zoomAroundPoint,
    zoomBy,
  ])

  const endPan = useCallback(() => {
    isPanningRef.current = false
    lastPanPointRef.current = null
    flushPendingViewTransform()
    setIsPanning(false)
  }, [flushPendingViewTransform])

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
      clearHoverOutline()
      hideRotationReadout()
      isPanningRef.current = true
      lastPanPointRef.current = pointer
      setIsPanning(true)
      return
    }

    const videoNode = getVideoNodeFromTarget(event.target)
    if (videoNode) {
      event.cancelBubble = true
      selectedItemIdRef.current = videoNode.id()
      clearHoverOutline()
      hideRotationReadout()
      selectItem(videoNode.id())
      updateSelectionToolbarPosition()
      return
    }

    if (event.target === stage) {
      clearHoverOutline()
      hideRotationReadout()
      selectItem(null)
    }
  }

  const handleTap: ComponentProps<typeof Stage>["onTap"] = (event) => {
    if (isSpacePressedRef.current) return

    const stage = stageRef.current
    const videoNode = getVideoNodeFromTarget(event.target)
    if (videoNode) {
      event.cancelBubble = true
      selectedItemIdRef.current = videoNode.id()
      clearHoverOutline()
      hideRotationReadout()
      selectItem(videoNode.id())
      updateSelectionToolbarPosition()
      return
    }

    if (stage && event.target === stage) {
      clearHoverOutline()
      hideRotationReadout()
      selectItem(null)
    }
  }

  const handleMouseMove: ComponentProps<typeof Stage>["onMouseMove"] = (
    event
  ) => {
    if (!isPanningRef.current) {
      updateHoverFromTarget(event.target)
      return
    }

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

  const handleDragStart: ComponentProps<typeof Stage>["onDragStart"] = (
    event
  ) => {
    const videoNode = getVideoNodeFromTarget(event.target)
    if (!videoNode) return

    selectedItemIdRef.current = videoNode.id()
    clearHoverOutline()
    hideRotationReadout()
    selectItem(videoNode.id())
    if (nudgeGuideClearTimerRef.current !== null) {
      window.clearTimeout(nudgeGuideClearTimerRef.current)
      nudgeGuideClearTimerRef.current = null
    }
    buildDragSnapCache(videoNode.id())
    updateSelectionToolbarPosition()
  }

  const handleDragMove: ComponentProps<typeof Stage>["onDragMove"] = (
    event
  ) => {
    const videoNode = getVideoNodeFromTarget(event.target)
    if (!videoNode) return

    const cache = snapCacheRef.current
    if (!cache || isSnapDisabledRef.current) {
      guideOverlayRef.current?.clear()
      updateSelectionToolbarPosition()
      return
    }

    const aabb = getRotatedAABB({
      x: videoNode.x(),
      y: videoNode.y(),
      width: videoNode.width() * Math.abs(videoNode.scaleX()),
      height: videoNode.height() * Math.abs(videoNode.scaleY()),
      rotation: videoNode.rotation(),
    })
    const threshold =
      SNAP_THRESHOLD_SCREEN_PX /
      Math.max(0.0001, viewTransformRef.current.scale)
    const result = findDragSnaps(aabb, cache, threshold)

    if (result.deltaX !== 0 || result.deltaY !== 0) {
      videoNode.position({
        x: videoNode.x() + result.deltaX,
        y: videoNode.y() + result.deltaY,
      })
    }
    guideOverlayRef.current?.setGuides(result.guides, result.distances)

    updateSelectionToolbarPosition()
  }

  const handleDragEnd: ComponentProps<typeof Stage>["onDragEnd"] = (event) => {
    const videoNode = getVideoNodeFromTarget(event.target)
    if (!videoNode) return

    guideOverlayRef.current?.clear()
    snapCacheRef.current = null
    updateSelectionToolbarPosition()
    updateVideoTransform(videoNode.id(), {
      x: videoNode.x(),
      y: videoNode.y(),
    })
  }

  const registerVideoNode = useCallback(
    (id: string, node: Konva.Image | null) => {
      if (node) {
        videoNodeMapRef.current.set(id, node)
      } else {
        videoNodeMapRef.current.delete(id)
      }
      registerTimelineCanvasNode(id, node)

      if (id === selectedItemIdRef.current) {
        setNodeVersion((version) => version + 1)
      }

      if (id === hoveredIdRef.current) {
        updateHoverOutline()
      }
    },
    [registerTimelineCanvasNode, updateHoverOutline]
  )

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === 1) {
      event.preventDefault()
    }
  }

  const handleStageMouseLeave = () => {
    clearHoverOutline()
    endPan()
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
        <>
          <div
            ref={artboardBackdropRef}
            aria-hidden="true"
            className="pointer-events-none absolute top-0 left-0 z-0 bg-white shadow-[0_18px_40px_rgba(0,0,0,0.14)]"
            style={{
              width: artboard.width,
              height: artboard.height,
              transformOrigin: "0 0",
              willChange: "transform",
            }}
          />
          <Stage
            ref={stageRef}
            width={viewportSize.width}
            height={viewportSize.height}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={endPan}
            onMouseLeave={handleStageMouseLeave}
            onTap={handleTap}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            style={{ position: "relative", zIndex: 1 }}
          >
          <Layer listening={false}>
            <Group>
              <ArtboardBackground artboard={artboard} />
              <ArtboardGrain artboard={artboard} />
              <ArtboardPixelGrid artboard={artboard} />
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
                onMouseDown={(event) => {
                  event.cancelBubble = true
                  selectArtboard()
                }}
                onTap={(event) => {
                  event.cancelBubble = true
                  selectArtboard()
                }}
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
                    shouldPlayAudio={video.id === primaryAudioVideoId}
                    contentLayerRef={contentLayerRef}
                    onNodeChange={registerVideoNode}
                    onVideoElementChange={registerTimelineVideoElement}
                    onVideoSeeked={onTimelineVideoSeeked}
                  />
                ))}
              </Group>
              <Rect
                x={0}
                y={0}
                width={artboard.width}
                height={artboard.height}
                stroke="rgba(0,0,0,0.10)"
                strokeWidth={1}
                strokeScaleEnabled={false}
                perfectDrawEnabled={false}
                shadowForStrokeEnabled={false}
                listening={false}
              />
            </Group>
          </Layer>
          <Layer listening={false}>
            <SnapGuideOverlay ref={guideOverlayRef} />
          </Layer>
          <Layer ref={overlayLayerRef}>
            <Rect
              ref={hoverOutlineRef}
              listening={false}
              visible={false}
              stroke={HOVER_OUTLINE_STROKE}
              strokeWidth={HOVER_OUTLINE_STROKE_WIDTH}
              strokeScaleEnabled={false}
              perfectDrawEnabled={false}
              shadowForStrokeEnabled={false}
            />
            <Rect
              x={0}
              y={0}
              width={artboard.width}
              height={artboard.height}
              listening={false}
              visible={selectedItemId === ARTBOARD_SELECTION_ID}
              stroke={HOVER_OUTLINE_STROKE}
              strokeWidth={HOVER_OUTLINE_STROKE_WIDTH}
              strokeScaleEnabled={false}
              perfectDrawEnabled={false}
              shadowForStrokeEnabled={false}
            />
            <SelectedVideoTransformer
              selectedItemId={
                selectedVideoIsTimelineVisible ? selectedItemId : null
              }
              selectedVideo={selectedTimelineVideo}
              isLocked={selectedTimelineVideo?.locked ?? false}
              nodeVersion={nodeVersion}
              nodeMapRef={videoNodeMapRef}
              onTransformFrame={updateSelectionToolbarPosition}
              onTransformEnd={updateVideoTransform}
              artboard={artboard}
              videos={visibleVideos}
              viewTransform={viewTransform}
              viewportSize={viewportSize}
              isSnapDisabledRef={isSnapDisabledRef}
              guideOverlayRef={guideOverlayRef}
              onRotationStart={showRotationReadout}
              onRotationFrame={updateRotationReadout}
              onRotationEnd={hideRotationReadout}
            />
          </Layer>
          </Stage>
        </>
      ) : null}
      <SelectionToolbar
        ref={selectionToolbarRef}
        selectedVideo={selectedTimelineVideo}
        onToggleLock={setVideoLocked}
        onDuplicate={duplicateVideo}
        onDelete={deleteVideo}
      />
      <div
        ref={rotationReadoutRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute bottom-4 left-1/2 z-50 min-w-16 -translate-x-1/2 rounded-full border border-border/70 bg-popover px-3 py-1.5 text-center text-sm leading-none font-medium text-foreground shadow-lg ring-1 ring-border/40"
      />
    </div>
  )
}
