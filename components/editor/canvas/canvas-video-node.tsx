"use client"

import {
  memo,
  useCallback,
  useEffect,
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
import type { CanvasVideoItem } from "@/types/editor-canvas"

// Konva.Image does not natively support non-rectangular masking, but Shape's
// sceneFunc/hitFunc props accept overrides. Replicating Konva.Image's draw
// inside an elliptical clip lets the camera render and hit-test as a circle
// while remaining a Konva.Image instance — the transformer and event code
// still recognize it.
function drawEllipticalVideo(context: Konva.Context, shape: Konva.Shape): void {
  const image = (shape as Konva.Image).image()
  const width = shape.width()
  const height = shape.height()
  if (!image || width <= 0 || height <= 0) return

  context.beginPath()
  context.ellipse(
    width / 2,
    height / 2,
    width / 2,
    height / 2,
    0,
    0,
    Math.PI * 2
  )
  context.closePath()
  context.fillStrokeShape(shape)
  context.save()
  context.beginPath()
  context.ellipse(
    width / 2,
    height / 2,
    width / 2,
    height / 2,
    0,
    0,
    Math.PI * 2
  )
  context.closePath()
  context.clip()

  const cropWidth = (shape as Konva.Image).cropWidth()
  const cropHeight = (shape as Konva.Image).cropHeight()
  if (cropWidth && cropHeight) {
    context.drawImage(
      image as CanvasImageSource,
      (shape as Konva.Image).cropX(),
      (shape as Konva.Image).cropY(),
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
}

function drawEllipticalHit(context: Konva.Context, shape: Konva.Shape): void {
  const width = shape.width()
  const height = shape.height()
  if (width <= 0 || height <= 0) return
  context.beginPath()
  context.ellipse(
    width / 2,
    height / 2,
    width / 2,
    height / 2,
    0,
    0,
    Math.PI * 2
  )
  context.closePath()
  context.fillStrokeShape(shape)
}

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

  const isCircle = video.cropShape === "circle"

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
      sceneFunc={isCircle ? drawEllipticalVideo : undefined}
      hitFunc={isCircle ? drawEllipticalHit : undefined}
    />
  )
}

export const CanvasVideoNode = memo(CanvasVideoNodeComponent)
