"use client"

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"
import Konva from "konva"
import { Transformer } from "react-konva"
import type { Rect } from "konva/lib/shapes/Rect"

import {
  MIN_VIDEO_NODE_SIZE,
  SNAP_THRESHOLD_SCREEN_PX,
  VIDEO_ROTATION_SNAPS,
  VIDEO_TRANSFORMER_ANCHOR_STROKE_WIDTH,
  VIDEO_TRANSFORMER_ANCHORS,
  VIDEO_TRANSFORMER_BORDER_STROKE_WIDTH,
  VIDEO_TRANSFORMER_CORNER_ANCHOR_SIZE,
  VIDEO_TRANSFORMER_ROTATE_ANCHOR_ANGLE,
  VIDEO_TRANSFORMER_ROTATE_ANCHOR_SIZE,
  VIDEO_TRANSFORMER_ROTATE_ANCHOR_OFFSET,
  VIDEO_TRANSFORMER_SIDE_ANCHOR_LENGTH,
  VIDEO_TRANSFORMER_SIDE_ANCHOR_THICKNESS,
} from "@/components/editor/canvas/canvas-node-constants"
import type { SnapGuideOverlayHandle } from "@/components/editor/canvas/snap-guide-overlay"
import { applyVideoCoverCrop } from "@/components/editor/canvas/video-cover-crop"
import { PIXEL_GRID_SETTINGS } from "@/lib/editor-canvas"
import {
  buildSnapCache,
  findResizeSnap,
  viewportArtboardAABB,
  type ResizeAnchor,
  type SnapCache,
} from "@/lib/editor-canvas-snap"
import type {
  CanvasSize,
  CanvasVideoItem,
  CanvasVideoTransformPatch,
  EditorArtboard,
  ViewTransform,
} from "@/types/editor-canvas"

const TRANSFORMER_ACCENT = "#8b5cf6"
const TRANSFORMER_ANCHOR_STROKE = "#9ca3af"
const TRANSFORMER_ANCHOR_FILL = "#ffffff"
const TRANSFORMER_ICON_STROKE = "#000000"
const ROTATE_ICON_VIEWBOX_SIZE = 24
const ROTATE_ICON_SIZE = 18
const ROTATE_ICON_STROKE_WIDTH = 2
const ROTATE_ICON_PATHS = [
  "M3.05493 13C3.01863 12.6717 3 12.338 3 12C3 7.02944 7.02944 3 12 3C14.8273 3 17.35 4.30367 19 6.34267M20.9451 11C20.9814 11.3283 21 11.662 21 12C21 16.9706 16.9706 21 12 21C9.17273 21 6.64996 19.6963 5 17.6573",
  "M16 7H17C18.4142 7 19.1213 7 19.5607 6.56066C20 6.12132 20 5.41421 20 4V3",
  "M8 17H7C5.58579 17 4.87868 17 4.43934 17.4393C4 17.8787 4 18.5858 4 20V21",
] as const

const ROTATE_CURSOR = "grab"

const HORIZONTAL_SIDE_ANCHORS = new Set(["top-center", "bottom-center"])
const VERTICAL_SIDE_ANCHORS = new Set(["middle-left", "middle-right"])

function getAnchorName(anchor: Rect) {
  return anchor.name().split(" ")[0]
}

function styleTransformerAnchor(anchor: Rect) {
  const anchorName = getAnchorName(anchor)

  anchor.setAttrs({
    fill: TRANSFORMER_ANCHOR_FILL,
    stroke: TRANSFORMER_ANCHOR_STROKE,
    strokeWidth: VIDEO_TRANSFORMER_ANCHOR_STROKE_WIDTH,
    shadowEnabled: false,
  })

  if (anchorName === "rotater") {
    anchor.setAttrs({
      width: VIDEO_TRANSFORMER_ROTATE_ANCHOR_SIZE,
      height: VIDEO_TRANSFORMER_ROTATE_ANCHOR_SIZE,
      offsetX: VIDEO_TRANSFORMER_ROTATE_ANCHOR_SIZE / 2,
      offsetY: VIDEO_TRANSFORMER_ROTATE_ANCHOR_SIZE / 2,
      cornerRadius: VIDEO_TRANSFORMER_ROTATE_ANCHOR_SIZE / 2,
      sceneFunc: drawRotateAnchor,
    })
    return
  }

  if (HORIZONTAL_SIDE_ANCHORS.has(anchorName)) {
    anchor.setAttrs({
      width: VIDEO_TRANSFORMER_SIDE_ANCHOR_LENGTH,
      height: VIDEO_TRANSFORMER_SIDE_ANCHOR_THICKNESS,
      offsetX: VIDEO_TRANSFORMER_SIDE_ANCHOR_LENGTH / 2,
      offsetY: VIDEO_TRANSFORMER_SIDE_ANCHOR_THICKNESS / 2,
      cornerRadius: VIDEO_TRANSFORMER_SIDE_ANCHOR_THICKNESS / 2,
    })
    return
  }

  if (VERTICAL_SIDE_ANCHORS.has(anchorName)) {
    anchor.setAttrs({
      width: VIDEO_TRANSFORMER_SIDE_ANCHOR_THICKNESS,
      height: VIDEO_TRANSFORMER_SIDE_ANCHOR_LENGTH,
      offsetX: VIDEO_TRANSFORMER_SIDE_ANCHOR_THICKNESS / 2,
      offsetY: VIDEO_TRANSFORMER_SIDE_ANCHOR_LENGTH / 2,
      cornerRadius: VIDEO_TRANSFORMER_SIDE_ANCHOR_THICKNESS / 2,
    })
    return
  }

  anchor.setAttrs({
    width: VIDEO_TRANSFORMER_CORNER_ANCHOR_SIZE,
    height: VIDEO_TRANSFORMER_CORNER_ANCHOR_SIZE,
    offsetX: VIDEO_TRANSFORMER_CORNER_ANCHOR_SIZE / 2,
    offsetY: VIDEO_TRANSFORMER_CORNER_ANCHOR_SIZE / 2,
    cornerRadius: VIDEO_TRANSFORMER_CORNER_ANCHOR_SIZE / 2,
  })
}

function drawRotateAnchor(context: Konva.Context, shape: Konva.Shape) {
  const width = shape.width()
  const height = shape.height()
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(width, height) / 2 - 1

  context.beginPath()
  context.arc(centerX, centerY, radius, 0, Math.PI * 2, false)
  context.closePath()
  context.fillStrokeShape(shape)
  drawSvgPathIcon(context, ROTATE_ICON_PATHS, {
    x: centerX - ROTATE_ICON_SIZE / 2,
    y: centerY - ROTATE_ICON_SIZE / 2,
    size: ROTATE_ICON_SIZE,
  })
}

function drawSvgPathIcon(
  context: Konva.Context,
  paths: readonly string[],
  {
    size,
    x,
    y,
  }: {
    size: number
    x: number
    y: number
  }
) {
  const scale = size / ROTATE_ICON_VIEWBOX_SIZE
  context.save()
  context.translate(x, y)
  context.scale(scale, scale)
  context.setAttr("strokeStyle", TRANSFORMER_ICON_STROKE)
  context.setAttr("lineWidth", ROTATE_ICON_STROKE_WIDTH)
  context.setAttr("lineCap", "round")
  context.setAttr("lineJoin", "round")

  for (const path of paths) {
    context.stroke(new Path2D(path))
  }

  context.restore()
}

type SelectedVideoTransformerProps = {
  selectedItemId: string | null
  selectedVideo: CanvasVideoItem | null
  isLocked: boolean
  nodeVersion: number
  nodeMapRef: RefObject<Map<string, Konva.Image>>
  onTransformFrame: () => void
  onTransformEnd: (id: string, patch: CanvasVideoTransformPatch) => void
  artboard: EditorArtboard
  videos: CanvasVideoItem[]
  viewTransform: ViewTransform
  viewportSize: CanvasSize
  isSnapDisabledRef: RefObject<boolean>
  guideOverlayRef: RefObject<SnapGuideOverlayHandle | null>
  onRotationStart: (node: Konva.Image) => void
  onRotationFrame: (node: Konva.Image) => void
  onRotationEnd: () => void
}

export function SelectedVideoTransformer({
  selectedItemId,
  selectedVideo,
  isLocked,
  nodeVersion,
  nodeMapRef,
  onTransformFrame,
  onTransformEnd,
  artboard,
  videos,
  viewTransform,
  viewportSize,
  isSnapDisabledRef,
  guideOverlayRef,
  onRotationStart,
  onRotationFrame,
  onRotationEnd,
}: SelectedVideoTransformerProps) {
  const transformerRef = useRef<Konva.Transformer | null>(null)
  const resizeSnapCacheRef = useRef<SnapCache | null>(null)
  const artboardRef = useRef(artboard)
  const videosRef = useRef(videos)
  const viewTransformRef = useRef(viewTransform)
  const viewportSizeRef = useRef(viewportSize)

  useEffect(() => {
    artboardRef.current = artboard
  }, [artboard])

  useEffect(() => {
    videosRef.current = videos
  }, [videos])

  useEffect(() => {
    viewTransformRef.current = viewTransform
  }, [viewTransform])

  useEffect(() => {
    viewportSizeRef.current = viewportSize
  }, [viewportSize])

  const getSelectedTransformNode = () => {
    const transformer = transformerRef.current
    const node = transformer?.nodes()[0]

    return node instanceof Konva.Image ? node : null
  }

  const isRotationTransform = () =>
    transformerRef.current?.getActiveAnchor() === "rotater"

  const getTransformedFrameSize = (node: Konva.Image): CanvasSize => ({
    width: Math.max(
      MIN_VIDEO_NODE_SIZE,
      Math.abs(node.width() * node.scaleX())
    ),
    height: Math.max(
      MIN_VIDEO_NODE_SIZE,
      Math.abs(node.height() * node.scaleY())
    ),
  })

  const syncCoverCrop = (node: Konva.Image, frameSize: CanvasSize) => {
    if (!selectedVideo) return

    applyVideoCoverCrop(
      node,
      {
        width: selectedVideo.intrinsicWidth,
        height: selectedVideo.intrinsicHeight,
      },
      frameSize
    )
  }

  const handleTransformFrame = () => {
    const node = getSelectedTransformNode()

    if (node) {
      if (isRotationTransform()) {
        onRotationFrame(node)
        return
      }

      syncCoverCrop(node, getTransformedFrameSize(node))
    }

    onTransformFrame()
  }

  const commitTransform = () => {
    const node = getSelectedTransformNode()
    const wasRotating = isRotationTransform()
    resizeSnapCacheRef.current = null
    guideOverlayRef.current?.clear()
    if (!selectedItemId || !node) {
      if (wasRotating) {
        onRotationEnd()
      }
      return
    }

    const nextSize = getTransformedFrameSize(node)

    node.width(nextSize.width)
    node.height(nextSize.height)
    node.scaleX(1)
    node.scaleY(1)
    syncCoverCrop(node, nextSize)
    if (wasRotating) {
      onRotationFrame(node)
    } else {
      onTransformFrame()
    }
    onTransformEnd(selectedItemId, {
      x: node.x(),
      y: node.y(),
      width: nextSize.width,
      height: nextSize.height,
      rotation: node.rotation(),
    })

    if (wasRotating) {
      onRotationEnd()
    }
  }

  const handleTransformStart = () => {
    if (!selectedItemId) return
    const node = getSelectedTransformNode()
    if (isRotationTransform()) {
      resizeSnapCacheRef.current = null
      guideOverlayRef.current?.clear()
      if (node) {
        onRotationStart(node)
      }
      return
    }

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
    resizeSnapCacheRef.current = buildSnapCache({
      artboard: artboardRef.current,
      otherVideos: videosRef.current.filter(
        (video) => video.id !== selectedItemId
      ),
      includeRuleOfThirds: true,
      gridStep,
      viewportAABB: inflatedViewport,
    })
  }

  useLayoutEffect(() => {
    const transformer = transformerRef.current
    if (!transformer) return

    const selectedNode = selectedItemId
      ? nodeMapRef.current.get(selectedItemId)
      : null

    transformer.nodes(selectedNode ? [selectedNode] : [])
    transformer.forceUpdate()
    transformer.getLayer()?.batchDraw()
  }, [isLocked, nodeMapRef, nodeVersion, selectedItemId])

  if (!selectedItemId) return null

  return (
    <Transformer
      ref={transformerRef}
      enabledAnchors={isLocked ? [] : VIDEO_TRANSFORMER_ANCHORS}
      keepRatio
      flipEnabled={false}
      resizeEnabled={!isLocked}
      rotateEnabled={!isLocked}
      rotateLineVisible={false}
      rotationSnaps={VIDEO_ROTATION_SNAPS}
      rotationSnapTolerance={5}
      rotateAnchorAngle={VIDEO_TRANSFORMER_ROTATE_ANCHOR_ANGLE}
      rotateAnchorOffset={VIDEO_TRANSFORMER_ROTATE_ANCHOR_OFFSET}
      rotateAnchorCursor={ROTATE_CURSOR}
      anchorSize={VIDEO_TRANSFORMER_CORNER_ANCHOR_SIZE}
      anchorCornerRadius={VIDEO_TRANSFORMER_CORNER_ANCHOR_SIZE / 2}
      borderStroke={TRANSFORMER_ACCENT}
      borderStrokeWidth={VIDEO_TRANSFORMER_BORDER_STROKE_WIDTH}
      anchorFill={TRANSFORMER_ANCHOR_FILL}
      anchorStroke={TRANSFORMER_ANCHOR_STROKE}
      anchorStrokeWidth={VIDEO_TRANSFORMER_ANCHOR_STROKE_WIDTH}
      anchorStyleFunc={styleTransformerAnchor}
      onTransformStart={handleTransformStart}
      onTransform={handleTransformFrame}
      onTransformEnd={commitTransform}
      boundBoxFunc={(oldBox, newBox) => {
        if (isLocked) return oldBox

        if (
          Math.abs(newBox.width) < MIN_VIDEO_NODE_SIZE ||
          Math.abs(newBox.height) < MIN_VIDEO_NODE_SIZE
        ) {
          return oldBox
        }

        const cache = resizeSnapCacheRef.current
        if (!cache || isSnapDisabledRef.current) {
          guideOverlayRef.current?.clear()
          return newBox
        }

        const transformer = transformerRef.current
        const anchorName = transformer?.getActiveAnchor() ?? null
        const anchor =
          anchorName && anchorName !== "rotater"
            ? (anchorName as ResizeAnchor)
            : null
        if (!anchor) {
          return newBox
        }

        const threshold =
          SNAP_THRESHOLD_SCREEN_PX /
          Math.max(0.0001, viewTransformRef.current.scale)
        const snapped = findResizeSnap(
          oldBox,
          newBox,
          anchor,
          cache,
          threshold,
          true
        )
        guideOverlayRef.current?.setGuides(
          snapped.guides,
          [],
          snapped.dimensions
        )

        return snapped.box
      }}
    />
  )
}
