"use client"

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import Konva from "konva"
import { Image as KonvaImage } from "react-konva"

import {
  CANVAS_NODE_NAME,
  VIDEO_NODE_NAME,
} from "@/components/editor/canvas/canvas-node-constants"
import { getVideoCoverCrop } from "@/components/editor/canvas/video-cover-crop"
import {
  clampSquircleRadius,
  computeSquircleCornerParams,
  tracePathOrRect,
  type SquircleCornerParams,
} from "@/lib/squircle"
import type { CanvasVideoItem } from "@/types/editor-canvas"

// Videos stay as live HTMLVideoElement sources: no canvas cache, no transcoding,
// and no intermediate bitmap resize. Zoom preserves available source detail, but
// it cannot invent pixels beyond the file's intrinsic resolution.
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: unknown) => void
  ) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

type CanvasVideoNodeProps = {
  video: CanvasVideoItem
  isPanMode: boolean
  shouldPlayAudio: boolean
  contentLayerRef: RefObject<Konva.Layer | null>
  onNodeChange: (id: string, node: Konva.Image | null) => void
  onVideoElementChange: (id: string, element: HTMLVideoElement | null) => void
  onVideoSeeked: (
    id: string,
    element: HTMLVideoElement,
    redrawLayer: () => void
  ) => void
}

function CanvasVideoNodeComponent({
  video,
  isPanMode,
  shouldPlayAudio,
  contentLayerRef,
  onNodeChange,
  onVideoElementChange,
  onVideoSeeked,
}: CanvasVideoNodeProps) {
  const imageRef = useRef<Konva.Image | null>(null)
  const videoElementRef = useRef<VideoWithFrameCallback | null>(null)
  const [renderableVideo, setRenderableVideo] =
    useState<CanvasImageSource | null>(null)
  const isVideoReady = renderableVideo !== null

  useEffect(() => {
    const element = document.createElement("video") as VideoWithFrameCallback
    element.muted = true
    element.loop = false
    element.playsInline = true
    element.preload = "auto"
    element.src = video.objectUrl
    videoElementRef.current = element
    let isRegistered = false

    const markReady = () => {
      setRenderableVideo(element)
      if (!isRegistered) {
        isRegistered = true
        onVideoElementChange(video.id, element)
      }
      contentLayerRef.current?.batchDraw()
    }

    element.addEventListener("loadedmetadata", markReady)
    element.addEventListener("loadeddata", markReady)
    element.load()

    return () => {
      if (isRegistered) {
        onVideoElementChange(video.id, null)
      }
      videoElementRef.current = null
      element.pause()
      element.removeEventListener("loadedmetadata", markReady)
      element.removeEventListener("loadeddata", markReady)
      element.removeAttribute("src")
      element.load()
    }
  }, [contentLayerRef, onVideoElementChange, video.id, video.objectUrl])

  useEffect(() => {
    const element = videoElementRef.current
    if (!element) return

    element.muted = !shouldPlayAudio
  }, [shouldPlayAudio])

  useEffect(() => {
    const layer = contentLayerRef.current
    const videoElement = videoElementRef.current
    if (!layer || !videoElement || !isVideoReady) return

    const supportsFrameCallback = Boolean(videoElement.requestVideoFrameCallback)
    let frameCallbackId: number | null = null
    let animation: Konva.Animation | null = supportsFrameCallback
      ? null
      : new Konva.Animation(() => undefined, layer)
    let cancelled = false

    const stopRedrawLoop = () => {
      if (frameCallbackId !== null) {
        videoElement.cancelVideoFrameCallback?.(frameCallbackId)
        frameCallbackId = null
      }
      animation?.stop()
    }

    const scheduleFrameCallback = () => {
      if (
        cancelled ||
        frameCallbackId !== null ||
        videoElement.paused ||
        videoElement.ended
      ) {
        return
      }

      frameCallbackId =
        videoElement.requestVideoFrameCallback?.(() => {
          frameCallbackId = null
          if (cancelled) return

          layer.batchDraw()
          scheduleFrameCallback()
        }) ?? null
    }

    // Hand every paused-state `seeked` event back to the provider; it owns
    // the decision between "this frame matches the committed playhead"
    // (drop or paint), "this frame matches a hover target" (paint), or
    // "stale seek — drop". The provider triggers the layer redraw via the
    // callback so this component stays unaware of hover vs committed.
    const redrawLayer = () => {
      layer.batchDraw()
    }
    const drawGatedFrame = () => {
      onVideoSeeked(video.id, videoElement, redrawLayer)
    }

    const startRedrawLoop = () => {
      if (cancelled) return
      if (supportsFrameCallback) {
        scheduleFrameCallback()
      } else {
        animation?.start()
      }
    }

    const handlePauseOrEnd = () => {
      stopRedrawLoop()
      drawGatedFrame()
    }

    videoElement.addEventListener("play", startRedrawLoop)
    videoElement.addEventListener("playing", startRedrawLoop)
    videoElement.addEventListener("pause", handlePauseOrEnd)
    videoElement.addEventListener("ended", handlePauseOrEnd)
    videoElement.addEventListener("seeked", drawGatedFrame)

    if (!videoElement.paused && !videoElement.ended) {
      startRedrawLoop()
    }

    return () => {
      cancelled = true
      stopRedrawLoop()
      animation = null
      videoElement.removeEventListener("play", startRedrawLoop)
      videoElement.removeEventListener("playing", startRedrawLoop)
      videoElement.removeEventListener("pause", handlePauseOrEnd)
      videoElement.removeEventListener("ended", handlePauseOrEnd)
      videoElement.removeEventListener("seeked", drawGatedFrame)
    }
  }, [contentLayerRef, isVideoReady, onVideoSeeked, video.id])

  const setImageNode = useCallback(
    (node: Konva.Image | null) => {
      imageRef.current = node
      onNodeChange(video.id, node)
    },
    [onNodeChange, video.id]
  )

  // Squircle params are independent of width/height in principle, but the
  // effective radius is clamped against the current box's shorter side so we
  // recompute when geometry changes. The memo means steady-state playback
  // never reruns the trig — only an actual radius / smoothing / size change
  // does — and the same constants are reused across every decoded frame.
  const squircleParams = useMemo<SquircleCornerParams | null>(() => {
    if (video.cornerRadius <= 0) return null
    const safeRadius = clampSquircleRadius(
      video.width,
      video.height,
      video.cornerRadius
    )
    if (safeRadius <= 0) return null
    return computeSquircleCornerParams(safeRadius, video.cornerSmoothing)
  }, [
    video.cornerRadius,
    video.cornerSmoothing,
    video.width,
    video.height,
  ])

  // The custom sceneFunc clips the video bitmap to the squircle so the
  // rounded corners disappear. When `cornerRadius === 0` the trace collapses
  // to `ctx.rect(0,0,w,h)` and clipping is skipped entirely — the entire
  // path is one canvas call and effectively free.
  const drawSquircleVideo = useCallback(
    (context: Konva.Context, shape: Konva.Shape) => {
      const image = (shape as Konva.Image).image()
      const width = shape.width()
      const height = shape.height()
      if (!image || width <= 0 || height <= 0) return

      context.save()
      context.beginPath()
      tracePathOrRect(context, width, height, squircleParams)
      context.closePath()
      // Only clip when we actually rounded the corners. A full-rect clip is
      // a no-op visually but still costs the canvas a state push — skip it.
      if (squircleParams !== null) {
        context.clip()
      }

      const konvaImage = shape as Konva.Image
      const cropWidth = konvaImage.cropWidth()
      const cropHeight = konvaImage.cropHeight()
      if (cropWidth && cropHeight) {
        context.drawImage(
          image as CanvasImageSource,
          konvaImage.cropX(),
          konvaImage.cropY(),
          cropWidth,
          cropHeight,
          0,
          0,
          width,
          height
        )
      } else {
        context.drawImage(image as CanvasImageSource, 0, 0, width, height)
      }
      context.restore()
    },
    [squircleParams]
  )

  const drawSquircleHit = useCallback(
    (context: Konva.Context, shape: Konva.Shape) => {
      const width = shape.width()
      const height = shape.height()
      if (width <= 0 || height <= 0) return

      context.beginPath()
      tracePathOrRect(context, width, height, squircleParams)
      context.closePath()
      context.fillStrokeShape(shape)
    },
    [squircleParams]
  )

  if (!isVideoReady) return null

  const coverCrop = getVideoCoverCrop(
    {
      width: video.intrinsicWidth,
      height: video.intrinsicHeight,
    },
    {
      width: video.width,
      height: video.height,
    }
  )

  // We always go through the custom sceneFunc so the same code path handles
  // radius = 0 (plain rect) and radius > 0 (squircle). This keeps the draw
  // pipeline identical for every video and lets the screen → camera → media
  // mix share one render path.
  return (
    <KonvaImage
      ref={setImageNode}
      id={video.id}
      name={`${CANVAS_NODE_NAME} ${VIDEO_NODE_NAME}`}
      image={renderableVideo}
      x={video.x}
      y={video.y}
      width={video.width}
      height={video.height}
      cropX={coverCrop.cropX}
      cropY={coverCrop.cropY}
      cropWidth={coverCrop.cropWidth}
      cropHeight={coverCrop.cropHeight}
      rotation={video.rotation}
      draggable={!isPanMode && !video.locked}
      perfectDrawEnabled={false}
      sceneFunc={drawSquircleVideo}
      hitFunc={drawSquircleHit}
    />
  )
}

export const CanvasVideoNode = memo(CanvasVideoNodeComponent)
