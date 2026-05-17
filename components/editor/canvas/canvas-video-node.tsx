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
function drawEllipticalVideo(
  context: Konva.Context,
  shape: Konva.Shape
): void {
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

function drawEllipticalHit(
  context: Konva.Context,
  shape: Konva.Shape
): void {
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
  contentLayerRef: RefObject<Konva.Layer | null>
  onNodeChange: (id: string, node: Konva.Image | null) => void
}

function CanvasVideoNodeComponent({
  video,
  isPanMode,
  contentLayerRef,
  onNodeChange,
}: CanvasVideoNodeProps) {
  const imageRef = useRef<Konva.Image | null>(null)
  const videoElementRef = useRef<VideoWithFrameCallback | null>(null)
  const [renderableVideo, setRenderableVideo] =
    useState<CanvasImageSource | null>(null)
  const isVideoReady = renderableVideo !== null

  useEffect(() => {
    const element = document.createElement("video") as VideoWithFrameCallback
    element.muted = true
    element.loop = true
    element.playsInline = true
    element.preload = "auto"
    element.src = video.objectUrl
    videoElementRef.current = element

    const markReady = () => {
      setRenderableVideo(element)
      contentLayerRef.current?.batchDraw()
    }

    const playVideo = () => {
      const playPromise = element.play()

      if (playPromise) {
        playPromise.catch(() => {
          // Muted local file playback should be allowed from the upload gesture,
          // but browser policy can still reject. Future timeline controls can retry.
        })
      }
    }

    element.addEventListener("loadedmetadata", markReady)
    element.addEventListener("loadeddata", markReady)
    element.addEventListener("canplay", playVideo)
    element.load()
    playVideo()

    return () => {
      videoElementRef.current = null
      element.pause()
      element.removeEventListener("loadedmetadata", markReady)
      element.removeEventListener("loadeddata", markReady)
      element.removeEventListener("canplay", playVideo)
      element.removeAttribute("src")
      element.load()
    }
  }, [contentLayerRef, video.objectUrl])

  useEffect(() => {
    const layer = contentLayerRef.current
    const videoElement = videoElementRef.current
    if (!layer || !videoElement || !isVideoReady) return

    let callbackId: number | null = null
    let animation: Konva.Animation | null = null
    let cancelled = false

    if (videoElement.requestVideoFrameCallback) {
      const scheduleFrame = () => {
        if (
          cancelled ||
          callbackId !== null ||
          videoElement.paused ||
          videoElement.ended
        ) {
          return
        }

        callbackId =
          videoElement.requestVideoFrameCallback?.(() => {
            callbackId = null
            if (cancelled) return

            layer.batchDraw()
            scheduleFrame()
          }) ?? null
      }

      const cancelFrame = () => {
        if (callbackId === null) return

        videoElement.cancelVideoFrameCallback?.(callbackId)
        callbackId = null
      }

      const drawCurrentFrame = () => layer.batchDraw()

      videoElement.addEventListener("play", scheduleFrame)
      videoElement.addEventListener("playing", scheduleFrame)
      videoElement.addEventListener("pause", cancelFrame)
      videoElement.addEventListener("seeked", drawCurrentFrame)
      scheduleFrame()

      return () => {
        cancelled = true
        cancelFrame()
        videoElement.removeEventListener("play", scheduleFrame)
        videoElement.removeEventListener("playing", scheduleFrame)
        videoElement.removeEventListener("pause", cancelFrame)
        videoElement.removeEventListener("seeked", drawCurrentFrame)
      }
    }

    animation = new Konva.Animation(() => undefined, layer)

    const syncAnimation = () => {
      if (videoElement.paused || videoElement.ended) {
        animation?.stop()
        layer.batchDraw()
        return
      }

      animation?.start()
    }

    videoElement.addEventListener("play", syncAnimation)
    videoElement.addEventListener("playing", syncAnimation)
    videoElement.addEventListener("pause", syncAnimation)
    videoElement.addEventListener("ended", syncAnimation)
    syncAnimation()

    return () => {
      cancelled = true
      animation?.stop()
      videoElement.removeEventListener("play", syncAnimation)
      videoElement.removeEventListener("playing", syncAnimation)
      videoElement.removeEventListener("pause", syncAnimation)
      videoElement.removeEventListener("ended", syncAnimation)
    }
  }, [contentLayerRef, isVideoReady])

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
