"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Image as KonvaImage } from "react-konva"
import type Konva from "konva"

import type { SmoothedCursorTrack } from "@/lib/cursors/cursor-track"
import type { CanvasVideoItem } from "@/types/editor-canvas"

import {
  buildCursorTrack,
  placeCursor,
  projectFolderFromObjectUrl,
} from "./cursor-scene"
import {
  useEditorCanvasMedia,
  useEditorCanvasTimeline,
  useEditorCanvasTimelineActions,
} from "./provider"

// Module-level image cache shared across mounts — cursor SVGs are tiny and
// reused across every recording.
const imageCache = new Map<string, HTMLImageElement>()

function loadCursorImage(url: string): HTMLImageElement {
  const cached = imageCache.get(url)
  if (cached) return cached
  const img = new window.Image()
  img.decoding = "async"
  img.src = url
  imageCache.set(url, img)
  return img
}

/**
 * Renders the recorded cursor as a themed SVG, synced to playback. Sample by
 * the screen recording's source time (timeline time mapped through the screen
 * clip), so it stays exact while scrubbing and during export.
 */
export function CanvasCursorOverlay() {
  const { videos } = useEditorCanvasMedia()
  const { timelineClips, timelineTime } = useEditorCanvasTimeline()
  const { subscribeTimelineTicks } = useEditorCanvasTimelineActions()

  const screenVideo = videos.find((video) => video.role === "screen") ?? null
  const screenClip = screenVideo
    ? timelineClips.find((clip) => clip.videoId === screenVideo.id) ?? null
    : null

  const imageRef = useRef<Konva.Image | null>(null)
  // The cursor bitmap is React state (it changes only when the cursor *shape*
  // changes — infrequent — so it never touches the per-frame hot path).
  // Position / size / offset / visibility are driven imperatively below.
  const [image, setImage] = useState<HTMLImageElement | undefined>(undefined)
  const trackRef = useRef<SmoothedCursorTrack | null>(null)
  const videoRef = useRef<CanvasVideoItem | null>(screenVideo)
  const clipRef = useRef(screenClip)
  const currentUrlRef = useRef<string | null>(null)

  // Keep the geometry/clip the tick closure reads current without re-subscribing.
  videoRef.current = screenVideo
  clipRef.current = screenClip

  // Map a display-relative point (logical points, top-left origin) to artboard
  // coordinates, through the screen video's cover-crop and transform. Returns
  // the artboard point of the cursor hotspot plus the px-per-display-point
  // scale, or null when the point is cropped off-screen.
  const place = useCallback((timelineSeconds: number) => {
    const node = imageRef.current
    const video = videoRef.current
    const clip = clipRef.current
    if (!node || !video) return

    const layer = node.getLayer()

    // No track means no usable cursor data (missing recording file, or data
    // not yet loaded). Hide rather than leaving the node drawing its last
    // bitmap at its natural size — otherwise a video whose source URL failed
    // to resolve strands a static, mispositioned cursor on a blank canvas.
    const track = trackRef.current
    if (!track) {
      if (node.visible()) {
        node.visible(false)
        layer?.batchDraw()
      }
      return
    }

    // Timeline time → screen recording source time → recording-relative ms.
    const sourceSeconds = clip
      ? timelineSeconds - clip.start + clip.sourceIn
      : timelineSeconds
    const placement = placeCursor(track, video, sourceSeconds)
    if (!placement) {
      if (node.visible()) {
        node.visible(false)
        layer?.batchDraw()
      }
      return
    }

    if (currentUrlRef.current !== placement.url) {
      currentUrlRef.current = placement.url
      setImage(loadCursorImage(placement.url))
    }
    node.size({ width: placement.width, height: placement.height })
    // Offset so the hotspot pixel sits exactly on the artboard point; rotation
    // then pivots around the hotspot, matching the recorded pointer.
    node.offset({ x: placement.offsetX, y: placement.offsetY })
    node.position({ x: placement.x, y: placement.y })
    node.rotation(placement.rotation)
    node.visible(placement.onScreen)
    layer?.batchDraw()
  }, [])

  // Load + pre-spring the cursor track whenever the screen recording changes.
  useEffect(() => {
    trackRef.current = null
    currentUrlRef.current = null
    const objectUrl = screenVideo?.objectUrl
    if (!objectUrl || screenVideo?.source.kind !== "recording") return
    const folder = projectFolderFromObjectUrl(objectUrl)
    if (!folder) return

    let cancelled = false
    void window.api?.projects.getCursorData(folder).then((data) => {
      if (cancelled) return
      const track = buildCursorTrack(data)
      if (!track) return
      trackRef.current = track
      place(timelineTime)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenVideo?.objectUrl, screenVideo?.source.kind, place])

  // Imperative per-tick placement (no React state on the hot path).
  useEffect(() => {
    return subscribeTimelineTicks((time) => place(time))
  }, [subscribeTimelineTicks, place])

  // Re-place when paused and the geometry or committed playhead changes.
  useEffect(() => {
    place(timelineTime)
  }, [
    place,
    timelineTime,
    screenVideo?.x,
    screenVideo?.y,
    screenVideo?.width,
    screenVideo?.height,
    screenVideo?.rotation,
  ])

  if (!screenVideo) return null

  return (
    <KonvaImage
      ref={imageRef}
      image={image as CanvasImageSource}
      listening={false}
      perfectDrawEnabled={false}
    />
  )
}
