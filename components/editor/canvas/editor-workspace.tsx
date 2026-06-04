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
import dynamic from "next/dynamic"
import Konva from "konva"
import { Group, Layer, Rect, Stage } from "react-konva"

import { ArtboardBackground } from "@/components/editor/canvas/artboard-background"
import { ArtboardGrain } from "@/components/editor/canvas/artboard-grain"
import { ArtboardPixelGrid } from "@/components/editor/canvas/artboard-pixel-grid"
import { CanvasCursorOverlay } from "@/components/editor/canvas/canvas-cursor-overlay"
import { CanvasVideoNode } from "@/components/editor/canvas/canvas-video-node"
import { PreviewControls } from "@/components/editor/canvas/preview-controls"
import {
  IDENTITY_ZOOM_CAMERA,
  applyZoomCamera,
  sampleZoomCameraAtTime,
  zoomCamerasEqual,
  type ZoomCamera,
} from "@/components/editor/canvas/zoom-scene"
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
  useEditorHistory,
} from "@/components/editor/canvas/provider"
import {
  hasZoomModifier,
  isEditableTarget,
  snapViewTransformToScreenPixels,
} from "@/components/editor/canvas/view-transform-utils"
import {
  clampWorkspaceView,
  getPreviewFillTransform,
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
  type CanvasZoomClip,
  type CanvasVideoItem,
  type EditorArtboard,
  type ViewTransform,
} from "@/types/editor-canvas"
import { useSidebarTabsContext } from "@/components/editor/sidebar/tabs-provider"
import {
  createRadialZoomBlurRenderer,
  type RadialZoomBlurRenderer,
} from "@/lib/motion-blur/radial-zoom-blur"
import { isPixiCanvasEnabled } from "@/components/editor/canvas/pixi/config"

// During the Konva → Pixi migration the Pixi canvas mounts in place of the
// Konva <Stage> when the runtime flag is on (see ./pixi/config). Loaded with
// ssr:false because PixiJS initializes against the browser canvas/GPU.
const PixiCanvasDynamic = dynamic(
  () =>
    import("@/components/editor/canvas/pixi/pixi-canvas").then(
      (m) => m.PixiCanvas
    ),
  { ssr: false }
)

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
  const backgroundLayerRef = useRef<Konva.Layer | null>(null)
  const contentLayerRef = useRef<Konva.Layer | null>(null)
  const overlayLayerRef = useRef<Konva.Layer | null>(null)
  const backgroundCameraGroupRef = useRef<Konva.Group | null>(null)
  const contentCameraGroupRef = useRef<Konva.Group | null>(null)
  const zoomBlurCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const zoomBlurSourceCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const zoomBlurRendererRef = useRef<RadialZoomBlurRenderer | null>(null)
  const lastZoomCameraRef = useRef<ZoomCamera>(IDENTITY_ZOOM_CAMERA)
  const artboardBackdropRef = useRef<HTMLDivElement | null>(null)
  const selectionToolbarRef = useRef<HTMLDivElement | null>(null)
  const rotationReadoutRef = useRef<HTMLDivElement | null>(null)
  const lastAppliedTransformRef = useRef<ViewTransform | null>(null)
  const viewTransformRef = useRef<ViewTransform>({ scale: 1, x: 0, y: 0 })
  const viewportSizeRef = useRef({ width: 0, height: 0 })
  const toolbarSizeRef = useRef(DEFAULT_SELECTION_TOOLBAR_SIZE)
  const selectedItemIdRef = useRef<string | null>(null)
  const selectedZoomClipIdRef = useRef<string | null>(null)
  const selectedVideoRef = useRef<CanvasVideoItem | null>(null)
  const timelineVisibleVideoIdsRef = useRef<ReadonlySet<string>>(new Set())
  const zoomClipsRef = useRef<CanvasZoomClip[]>([])
  const timelineTimeRef = useRef(0)
  const hoverPreviewTimeRef = useRef<number | null>(null)
  const videoNodeMapRef = useRef(new Map<string, Konva.Image>())
  const isSpacePressedRef = useRef(false)
  const isPanningRef = useRef(false)
  const lastPanPointRef = useRef<{ x: number; y: number } | null>(null)
  const pendingViewTransformRef = useRef<ViewTransform | null>(null)
  const viewTransformFrameRef = useRef<number | null>(null)
  const toolbarPositionFrameRef = useRef<number | null>(null)
  const isRotatingSelectedNodeRef = useRef(false)
  const isTransformingSelectedNodeRef = useRef(false)
  const rotatingNodeRef = useRef<Konva.Image | null>(null)
  const [isSpacePressed, setIsSpacePressed] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [nodeVersion, setNodeVersion] = useState(0)
  const hoverOutlineRef = useRef<Konva.Rect | null>(null)
  const hoveredIdRef = useRef<string | null>(null)
  const isPanModeRef = useRef(false)
  const isPreviewModeRef = useRef(false)
  const prevPreviewModeRef = useRef(false)
  const guideOverlayRef = useRef<SnapGuideOverlayHandle | null>(null)
  const snapCacheRef = useRef<SnapCache | null>(null)
  const isSnapDisabledRef = useRef(false)
  const videosRef = useRef<CanvasVideoItem[]>([])
  const artboardRef = useRef<EditorArtboard | null>(null)
  const nudgeGuideClearTimerRef = useRef<number | null>(null)
  const { videos, selectedItemId, selectedVideo } = useEditorCanvasMedia()
  const {
    primaryAudioVideoId,
    timelineVisibleVideoIds,
    selectedZoomClipId,
    zoomClips,
    timelineTime,
  } = useEditorCanvasTimeline()
  const { artboard } = useEditorCanvasArtboard()
  const { viewportSize, viewTransform, isPreviewMode } = useEditorCanvasView()
  // When enabled, the PixiJS canvas replaces the Konva <Stage> (read once; a
  // reload applies a flag change). Migration scaffolding — removed at cutover.
  const pixiEnabled = useMemo(() => isPixiCanvasEnabled(), [])
  const {
    fitArtboardToViewport,
    deleteVideo,
    duplicateVideo,
    selectItem,
    setVideoLocked,
    setViewportSize,
    setViewTransform,
    updateVideoTransform,
    exitPreview,
  } = useEditorCanvasActions()
  const {
    registerTimelineCanvasNode,
    registerTimelineVideoElement,
    onTimelineVideoSeeked,
    registerTimelineVideoFps,
    stepTimelineFrame,
    setTimelineTime,
    playTimeline,
    pauseTimeline,
    toggleTimelinePlayback,
    removeZoomClip,
    subscribeTimelineTicks,
    subscribeHoverTime,
  } = useEditorCanvasTimelineActions()
  const { undo, redo } = useEditorHistory()
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

    if (isRotatingSelectedNodeRef.current || isPreviewModeRef.current) {
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

  const setZoomSourceLayerOpacity = useCallback((opacity: "0" | "1") => {
    for (const layer of [backgroundLayerRef.current, contentLayerRef.current]) {
      const canvas = (
        layer?.getCanvas() as unknown as { _canvas?: HTMLCanvasElement }
      )?._canvas
      if (canvas) canvas.style.opacity = opacity
    }
  }, [])

  const hideZoomBlurOverlay = useCallback(() => {
    const canvas = zoomBlurCanvasRef.current
    if (canvas) {
      canvas.style.visibility = "hidden"
      const ctx = canvas.getContext("2d")
      ctx?.clearRect(0, 0, canvas.width, canvas.height)
    }
    setZoomSourceLayerOpacity("1")
  }, [setZoomSourceLayerOpacity])

  const renderZoomBlurOverlay = useCallback(
    (camera: ZoomCamera) => {
      const canvas = zoomBlurCanvasRef.current
      const backgroundLayer = backgroundLayerRef.current
      const contentLayer = contentLayerRef.current
      const viewport = viewportSizeRef.current
      const artboard = artboardRef.current
      if (
        !canvas ||
        !backgroundLayer ||
        !contentLayer ||
        !artboard ||
        camera.radialBlur <= 0 ||
        viewport.width <= 0 ||
        viewport.height <= 0
      ) {
        hideZoomBlurOverlay()
        return
      }

      let renderer = zoomBlurRendererRef.current
      if (!renderer) {
        renderer = createRadialZoomBlurRenderer()
        zoomBlurRendererRef.current = renderer
      }
      if (!renderer) {
        hideZoomBlurOverlay()
        return
      }

      // The DOM blur overlay samples the layer canvases immediately. Konva's
      // batchDraw() is scheduled for the next animation frame, so force the
      // scene canvases current before cropping during an active blur frame.
      backgroundLayer.drawScene()
      contentLayer.drawScene()

      // Blur **only the artboard region**, so the blur texture *is* the artboard
      // — pixel-identical to the exporter (same center, same radius
      // normalization, same edge clamp) with no workspace margin for the streak
      // to smear into. Work in the layers' device pixels (Konva.pixelRatio, up to
      // 3x); sampling into a CSS-sized buffer used to halve the resolution and
      // visibly soften the frame the instant blur engaged.
      const backgroundCanvas = (
        backgroundLayer.getCanvas() as unknown as {
          _canvas?: HTMLCanvasElement
        }
      )._canvas
      const contentCanvas = (
        contentLayer.getCanvas() as unknown as { _canvas?: HTMLCanvasElement }
      )._canvas
      const pixelRatio = backgroundCanvas
        ? backgroundCanvas.width / Math.max(1, viewport.width)
        : Konva.pixelRatio || 1

      // The visible overlay spans the whole viewport (device px) so it lines up
      // 1:1 with the stage it temporarily replaces.
      //
      // Keep the CSS box in viewport pixels explicitly. A canvas is a replaced
      // element, so relying on `absolute inset-0` alone lets the intrinsic
      // backing-store size (`viewport * pixelRatio`) influence layout on some
      // browsers. That made the blurred artboard draw onto an oversized DOM
      // canvas, which looked like the zoomed video escaped the artboard even
      // though the Konva clip and export were correct.
      const cssWidth = `${viewport.width}px`
      const cssHeight = `${viewport.height}px`
      if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth
      if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight

      const viewW = Math.max(1, Math.round(viewport.width * pixelRatio))
      const viewH = Math.max(1, Math.round(viewport.height * pixelRatio))
      if (canvas.width !== viewW) canvas.width = viewW
      if (canvas.height !== viewH) canvas.height = viewH

      const ctx = canvas.getContext("2d")
      if (!ctx) {
        hideZoomBlurOverlay()
        return
      }

      const stage = stageRef.current
      const fallbackView = viewTransformRef.current
      const activeView = {
        x: stage?.x() ?? fallbackView.x,
        y: stage?.y() ?? fallbackView.y,
        scale: stage?.scaleX() ?? fallbackView.scale,
      }
      // Artboard rectangle on screen, in device px (integer-aligned for a crisp
      // crop + redraw).
      const boardX = Math.round(activeView.x * pixelRatio)
      const boardY = Math.round(activeView.y * pixelRatio)
      const boardW = Math.max(
        1,
        Math.round(artboard.width * activeView.scale * pixelRatio)
      )
      const boardH = Math.max(
        1,
        Math.round(artboard.height * activeView.scale * pixelRatio)
      )

      // Crop the already-drawn artboard region out of the layer canvases into a
      // dedicated, reused source canvas sized to the artboard.
      let source = zoomBlurSourceCanvasRef.current
      if (!source) {
        source = document.createElement("canvas")
        zoomBlurSourceCanvasRef.current = source
      }
      if (source.width !== boardW) source.width = boardW
      if (source.height !== boardH) source.height = boardH
      const sourceCtx = source.getContext("2d")
      if (!sourceCtx) {
        hideZoomBlurOverlay()
        return
      }
      sourceCtx.clearRect(0, 0, boardW, boardH)
      if (backgroundCanvas) {
        sourceCtx.drawImage(
          backgroundCanvas,
          boardX,
          boardY,
          boardW,
          boardH,
          0,
          0,
          boardW,
          boardH
        )
      }
      if (contentCanvas) {
        sourceCtx.drawImage(
          contentCanvas,
          boardX,
          boardY,
          boardW,
          boardH,
          0,
          0,
          boardW,
          boardH
        )
      }

      const blurred = renderer.render(source, boardW, boardH, {
        centerX: camera.radialBlurCenterX * boardW,
        centerY: camera.radialBlurCenterY * boardH,
        amount: camera.radialBlur,
        ...camera.radialBlurSettings,
      })

      ctx.clearRect(0, 0, viewW, viewH)
      ctx.drawImage(blurred, boardX, boardY)
      ctx.save()
      ctx.strokeStyle = "rgba(0,0,0,0.10)"
      ctx.lineWidth = Math.max(1, pixelRatio)
      ctx.strokeRect(
        boardX + 0.5,
        boardY + 0.5,
        Math.max(0, boardW - 1),
        Math.max(0, boardH - 1)
      )
      ctx.restore()
      canvas.style.visibility = "visible"
      setZoomSourceLayerOpacity("0")
    },
    [hideZoomBlurOverlay, setZoomSourceLayerOpacity]
  )

  const applyManualZoomAtTime = useCallback(
    (time: number) => {
      const artboard = artboardRef.current
      if (!artboard) return
      const camera = sampleZoomCameraAtTime(
        zoomClipsRef.current,
        artboard,
        time
      )
      const didChange = !zoomCamerasEqual(lastZoomCameraRef.current, camera)
      lastZoomCameraRef.current = camera

      applyZoomCamera(backgroundCameraGroupRef.current, camera)
      applyZoomCamera(contentCameraGroupRef.current, camera)
      if (didChange) {
        backgroundLayerRef.current?.batchDraw()
        contentLayerRef.current?.batchDraw()
      }
      renderZoomBlurOverlay(camera)
    },
    [renderZoomBlurOverlay]
  )

  const applyManualZoomAtPreviewTime = useCallback(() => {
    applyManualZoomAtTime(
      hoverPreviewTimeRef.current ?? timelineTimeRef.current
    )
  }, [applyManualZoomAtTime])

  const handleTimelineVideoSeeked = useCallback(
    (
      id: string,
      element: HTMLVideoElement,
      redrawLayer: (afterDraw?: () => void) => void
    ) => {
      onTimelineVideoSeeked(id, element, (afterDraw) => {
        redrawLayer(() => {
          afterDraw?.()
          renderZoomBlurOverlay(lastZoomCameraRef.current)
        })
      })
    },
    [onTimelineVideoSeeked, renderZoomBlurOverlay]
  )

  useLayoutEffect(() => {
    viewTransformRef.current = viewTransform

    // Fullscreen preview owns the stage transform imperatively (a fill-fit). Keep
    // the user transform in the ref for restore-on-exit, but don't paint it.
    if (isPreviewMode) return

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
    renderZoomBlurOverlay(lastZoomCameraRef.current)
  }, [
    applyStageViewTransform,
    isPreviewMode,
    renderZoomBlurOverlay,
    viewTransform,
  ])

  useEffect(() => {
    viewportSizeRef.current = viewportSize
    if (isRotatingSelectedNodeRef.current && rotatingNodeRef.current) {
      updateRotationReadout(rotatingNodeRef.current)
    } else {
      scheduleSelectionToolbarPosition()
    }
  }, [scheduleSelectionToolbarPosition, updateRotationReadout, viewportSize])

  // A dropped fullscreen (Esc, OS gesture) while still in preview means the user
  // wants out — mirror that back into provider state. Mount-once; reads the ref.
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (isPreviewModeRef.current && document.fullscreenElement == null) {
        exitPreview()
      }
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange)
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange)
  }, [exitPreview])

  // Preview enter/exit side effects. Enter → fullscreen the workspace + play from
  // 0. Exit → leave fullscreen, pause, and repaint the user's saved view. The
  // exit branch is guarded so initial mount (isPreviewMode already false) is a
  // no-op rather than a spurious pause.
  useEffect(() => {
    isPreviewModeRef.current = isPreviewMode
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
    applyStageViewTransform(viewTransformRef.current)
  }, [
    applyStageViewTransform,
    exitPreview,
    isPreviewMode,
    pauseTimeline,
    playTimeline,
    setTimelineTime,
  ])

  // While in preview the stage fills the (fullscreen) viewport with a zero-padding
  // contain-fit. Recomputes on the fullscreen resize and any artboard change.
  useLayoutEffect(() => {
    if (!isPreviewMode) return
    if (viewportSize.width <= 0 || viewportSize.height <= 0) return
    applyStageViewTransform(getPreviewFillTransform(viewportSize, artboard))
  }, [applyStageViewTransform, artboard, isPreviewMode, viewportSize])

  useLayoutEffect(() => {
    selectedZoomClipIdRef.current = selectedZoomClipId
  }, [selectedZoomClipId])

  useLayoutEffect(() => {
    zoomClipsRef.current = zoomClips
    applyManualZoomAtPreviewTime()
  }, [applyManualZoomAtPreviewTime, zoomClips])

  useLayoutEffect(() => {
    timelineTimeRef.current = timelineTime
    if (hoverPreviewTimeRef.current === null) {
      applyManualZoomAtTime(timelineTime)
    }
  }, [applyManualZoomAtTime, timelineTime])

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

  useLayoutEffect(() => {
    artboardRef.current = artboard
    applyManualZoomAtPreviewTime()
  }, [applyManualZoomAtPreviewTime, artboard])

  useEffect(() => {
    return subscribeTimelineTicks((time) => {
      timelineTimeRef.current = time
      if (hoverPreviewTimeRef.current === null) {
        applyManualZoomAtTime(time)
      }
    })
  }, [applyManualZoomAtTime, subscribeTimelineTicks])

  useEffect(() => {
    return subscribeHoverTime((time) => {
      hoverPreviewTimeRef.current = time
      applyManualZoomAtPreviewTime()
    })
  }, [applyManualZoomAtPreviewTime, subscribeHoverTime])

  useEffect(() => {
    return () => {
      zoomBlurRendererRef.current?.destroy()
      zoomBlurRendererRef.current = null
    }
  }, [])

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
      // Use the display's actual devicePixelRatio so the canvas backing
      // store matches the panel — without this, the video looks soft on
      // 5K/6K displays where dPR reports 3. Cap at 3 to keep memory
      // bounded on extreme multi-monitor setups; values above 3 give no
      // additional sharpness for any source video we'd realistically
      // record (3024×1964 native at dPR 3 fills a 9072×5892 backing
      // store already).
      Konva.pixelRatio = Math.min(window.devicePixelRatio || 1, 3)
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
      renderZoomBlurOverlay(lastZoomCameraRef.current)
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
    [
      applyStageViewTransform,
      artboard,
      renderZoomBlurOverlay,
      setViewTransform,
      viewportSize,
    ]
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

      // In fullscreen preview the workspace is a player: Space toggles play/pause
      // and every editor shortcut (undo, nudge, zoom, frame-step, pan) is muted.
      // Esc is handled by the browser exiting fullscreen.
      if (isPreviewModeRef.current) {
        if (event.code === "Space") {
          event.preventDefault()
          toggleTimelinePlayback()
        }
        return
      }

      // Undo / redo. Lives above the selection branch so the shortcut works
      // even when nothing is selected. Blocked during active rotation,
      // Transformer drags, and pan to avoid yanking state out from under a
      // hot-path interaction.
      if (hasZoomModifier(event) && event.code === "KeyZ") {
        if (isRotatingSelectedNodeRef.current) return
        if (isTransformingSelectedNodeRef.current) return
        if (isPanningRef.current) return
        event.preventDefault()
        if (event.shiftKey) {
          redo()
        } else {
          undo()
        }
        return
      }

      // A selected zoom clip is removed independently of any video selection
      // (the two are mutually exclusive — see the provider's select* actions).
      if (
        selectedZoomClipIdRef.current &&
        (event.code === "Delete" || event.code === "Backspace")
      ) {
        event.preventDefault()
        removeZoomClip(selectedZoomClipIdRef.current)
        return
      }

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

      // Frame-step the timeline playhead. `,` / `.` mirror common NLE bindings
      // and don't collide with the selection nudge (arrows) or zoom shortcuts.
      if (
        !hasZoomModifier(event) &&
        !event.shiftKey &&
        (event.code === "Comma" || event.code === "Period")
      ) {
        event.preventDefault()
        stepTimelineFrame(event.code === "Comma" ? -1 : 1)
        return
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
    redo,
    removeZoomClip,
    setVideoLocked,
    stepTimelineFrame,
    toggleTimelinePlayback,
    undo,
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
    if (isPreviewModeRef.current) return
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
    if (isPreviewModeRef.current) return
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
    if (isPreviewModeRef.current) return
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
    if (isPreviewModeRef.current) return
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
    if (isPreviewModeRef.current) return
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
      className={
        isPreviewMode
          ? "relative h-full w-full overflow-hidden bg-black"
          : `relative h-full w-full overflow-hidden bg-editor-workspace ${cursorClassName}`
      }
    >
      {pixiEnabled ? (
        <PixiCanvasDynamic />
      ) : viewportSize.width > 0 && viewportSize.height > 0 ? (
        <>
          {!isPreviewMode && (
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
          )}
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
            <Layer ref={backgroundLayerRef} listening={false}>
              <Group
                clipX={0}
                clipY={0}
                clipWidth={artboard.width}
                clipHeight={artboard.height}
              >
                <Group ref={backgroundCameraGroupRef}>
                  <ArtboardBackground artboard={artboard} />
                  <ArtboardGrain artboard={artboard} />
                </Group>
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
                    if (isPreviewModeRef.current) return
                    event.cancelBubble = true
                    selectArtboard()
                  }}
                  onTap={(event) => {
                    if (isPreviewModeRef.current) return
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
                  <Group ref={contentCameraGroupRef}>
                    {videos.map((video) => (
                      <CanvasVideoNode
                        key={video.id}
                        video={video}
                        isPanMode={isSpacePressed || isPanning}
                        shouldPlayAudio={video.id === primaryAudioVideoId}
                        contentLayerRef={contentLayerRef}
                        onNodeChange={registerVideoNode}
                        onVideoElementChange={registerTimelineVideoElement}
                        onVideoSeeked={handleTimelineVideoSeeked}
                        onVideoFpsMeasured={registerTimelineVideoFps}
                      />
                    ))}
                    <CanvasCursorOverlay />
                  </Group>
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
                visible={
                  selectedItemId === ARTBOARD_SELECTION_ID && !isPreviewMode
                }
                stroke={HOVER_OUTLINE_STROKE}
                strokeWidth={HOVER_OUTLINE_STROKE_WIDTH}
                strokeScaleEnabled={false}
                perfectDrawEnabled={false}
                shadowForStrokeEnabled={false}
              />
              <SelectedVideoTransformer
                selectedItemId={
                  selectedVideoIsTimelineVisible && !isPreviewMode
                    ? selectedItemId
                    : null
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
                isTransformingRef={isTransformingSelectedNodeRef}
              />
            </Layer>
          </Stage>
          <canvas
            ref={zoomBlurCanvasRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute inset-0 z-[2] h-full w-full"
          />
        </>
      ) : null}
      {!pixiEnabled && (
        <>
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
        </>
      )}
      {isPreviewMode && <PreviewControls />}
    </div>
  )
}
