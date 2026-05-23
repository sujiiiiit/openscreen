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
  computeBorderParams,
  computeShadowParams,
  computeSquircleParams,
  drawCanvasVideoFrame,
} from "@/components/editor/canvas/video-scene-draw"
import { tracePathOrRect } from "@/lib/squircle"
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

  // Destructure every field consumed by the compute helpers so the
  // useMemo dep lists are literally the values they read. This both keeps
  // the memos cheap (the playback hot path mutates other fields like
  // currentTime / hidden bookkeeping which don't need to invalidate
  // appearance params) AND lets react-hooks/exhaustive-deps continue
  // checking us — no eslint-disable needed.
  const {
    width,
    height,
    cornerRadius,
    cornerSmoothing,
    borderWidth,
    borderColor,
    borderOffset,
    borderAlignment,
    shadowColor,
    shadowBlur,
    shadowOffsetX,
    shadowOffsetY,
    shadowSpread,
  } = video

  const squircleParams = useMemo(
    () =>
      computeSquircleParams({
        width,
        height,
        cornerRadius,
        cornerSmoothing,
      }),
    [width, height, cornerRadius, cornerSmoothing],
  )
  const borderParams = useMemo(
    () =>
      computeBorderParams({
        width,
        height,
        cornerRadius,
        cornerSmoothing,
        borderWidth,
        borderColor,
        borderOffset,
        borderAlignment,
      }),
    [
      width,
      height,
      cornerRadius,
      cornerSmoothing,
      borderWidth,
      borderColor,
      borderOffset,
      borderAlignment,
    ],
  )
  const shadowParams = useMemo(
    () =>
      computeShadowParams({
        width,
        height,
        cornerRadius,
        cornerSmoothing,
        shadowColor,
        shadowBlur,
        shadowOffsetX,
        shadowOffsetY,
        shadowSpread,
      }),
    [
      width,
      height,
      cornerRadius,
      cornerSmoothing,
      shadowColor,
      shadowBlur,
      shadowOffsetX,
      shadowOffsetY,
      shadowSpread,
    ],
  )

  const drawSquircleVideo = useCallback(
    (context: Konva.Context, shape: Konva.Shape) => {
      const image = (shape as Konva.Image).image()
      const width = shape.width()
      const height = shape.height()
      if (!image || width <= 0 || height <= 0) return

      const konvaImage = shape as Konva.Image
      const cropWidth = konvaImage.cropWidth()
      const cropHeight = konvaImage.cropHeight()
      drawCanvasVideoFrame(
        context,
        image,
        width,
        height,
        cropWidth && cropHeight
          ? {
              x: konvaImage.cropX(),
              y: konvaImage.cropY(),
              width: cropWidth,
              height: cropHeight,
            }
          : null,
        squircleParams,
        borderParams,
        shadowParams,
      )
    },
    [squircleParams, borderParams, shadowParams]
  )

  const drawSquircleHit = useCallback(
    (context: Konva.Context, shape: Konva.Shape) => {
      const width = shape.width()
      const height = shape.height()
      if (width <= 0 || height <= 0) return

      // Hit area follows the node body — the same squircle Konva uses for the
      // fill path. The border is purely visual; clicks past the node bounds
      // still fall through to whatever sits underneath. Keeps the node's
      // selectable region stable as the user tunes border width / offset.
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
