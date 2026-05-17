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
import type { KonvaEventObject } from "konva/lib/Node"

import { MIN_VIDEO_NODE_SIZE } from "@/components/editor/canvas/canvas-node-constants"
import type {
  CanvasVideoItem,
  CanvasVideoTransformPatch,
} from "@/types/editor-canvas"

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
  onSelect: (id: string) => void
  onChange: (id: string, patch: CanvasVideoTransformPatch) => void
}

function CanvasVideoNodeComponent({
  video,
  isPanMode,
  contentLayerRef,
  onNodeChange,
  onSelect,
  onChange,
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

  const handleTransformEnd = () => {
    const node = imageRef.current
    if (!node) return

    const nextWidth = Math.max(
      MIN_VIDEO_NODE_SIZE,
      Math.abs(node.width() * node.scaleX())
    )
    const nextHeight = Math.max(
      MIN_VIDEO_NODE_SIZE,
      Math.abs(node.height() * node.scaleY())
    )

    node.scaleX(1)
    node.scaleY(1)
    onChange(video.id, {
      x: node.x(),
      y: node.y(),
      width: nextWidth,
      height: nextHeight,
      rotation: node.rotation(),
    })
  }

  const handlePointerDown = (event: KonvaEventObject<MouseEvent>) => {
    if (isPanMode || event.evt.button === 1) return

    event.cancelBubble = true
    onSelect(video.id)
  }

  const setImageNode = useCallback(
    (node: Konva.Image | null) => {
      imageRef.current = node
      onNodeChange(video.id, node)
    },
    [onNodeChange, video.id]
  )

  if (!isVideoReady) return null

  return (
    <KonvaImage
      ref={setImageNode}
      image={renderableVideo}
      x={video.x}
      y={video.y}
      width={video.width}
      height={video.height}
      rotation={video.rotation}
      draggable={!isPanMode}
      perfectDrawEnabled={false}
      onMouseDown={handlePointerDown}
      onTap={() => onSelect(video.id)}
      onDragStart={() => onSelect(video.id)}
      onDragEnd={(event) => {
        onChange(video.id, {
          x: event.target.x(),
          y: event.target.y(),
        })
      }}
      onTransformEnd={handleTransformEnd}
    />
  )
}

export const CanvasVideoNode = memo(CanvasVideoNodeComponent)
