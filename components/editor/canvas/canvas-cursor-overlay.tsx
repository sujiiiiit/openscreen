"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Image as KonvaImage } from "react-konva"
import type Konva from "konva"

import type { CursorSetId } from "@/lib/cursors/cursor-manifest"
import { resolveCursorAsset } from "@/lib/cursors/cursor-set"
import {
  buildRawTrack,
  buildSmoothedTrack,
  rawSamplesFromMoves,
  sampleCursorAtTime,
  type SmoothedCursorTrack,
} from "@/lib/cursors/cursor-track"
import type { CanvasVideoItem } from "@/types/editor-canvas"

import {
  useEditorCanvasMedia,
  useEditorCanvasTimeline,
  useEditorCanvasTimelineActions,
} from "./provider"
import { getVideoCoverCrop } from "./video-cover-crop"

// Cursor set + size. `macos` per the chosen default; the box height is the
// rendered SVG height in *display points* (the cursor coordinate space) before
// it is scaled into artboard pixels — purely cosmetic, tune to taste. Position
// and hotspot alignment are exact regardless of this value.
const CURSOR_SET: CursorSetId = "macos"
const CURSOR_BOX_HEIGHT_POINTS = 52
const CURSOR_SCALE = 1
// Spring easing of the cursor path. OFF = the cursor lands exactly on every
// captured sample (no transition/lag) so you can judge raw capture accuracy;
// flip to true to re-enable Screen Studio-style smoothing.
const CURSOR_SMOOTHING = false

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

/** Derive the project folder from a recording asset's file:// objectUrl. */
function projectFolderFromObjectUrl(objectUrl: string): string | null {
  if (!objectUrl.startsWith("file:")) return null
  try {
    const pathname = decodeURIComponent(new URL(objectUrl).pathname)
    const slash = pathname.lastIndexOf("/")
    return slash > 0 ? pathname.slice(0, slash) : null
  } catch {
    return null
  }
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
    const track = trackRef.current
    if (!node || !video || !track) return

    const layer = node.getLayer()

    // Timeline time → screen recording source time → recording-relative ms.
    const sourceSeconds = clip
      ? timelineSeconds - clip.start + clip.sourceIn
      : timelineSeconds
    const sample = sampleCursorAtTime(track, sourceSeconds * 1000)
    if (!sample) {
      if (node.visible()) {
        node.visible(false)
        layer?.batchDraw()
      }
      return
    }

    const asset = resolveCursorAsset(sample.cursorId, CURSOR_SET)
    if (!asset) {
      node.visible(false)
      layer?.batchDraw()
      return
    }

    const iw = video.intrinsicWidth || 1
    const ih = video.intrinsicHeight || 1
    const dw = track.displayWidth || iw
    const dh = track.displayHeight || ih

    // Display point → source pixel → cover-crop → node-local → artboard.
    const crop = getVideoCoverCrop(
      { width: iw, height: ih },
      { width: video.width, height: video.height },
    )
    const sx = (sample.x / dw) * iw
    const sy = (sample.y / dh) * ih
    const localX = ((sx - crop.cropX) / crop.cropWidth) * video.width
    const localY = ((sy - crop.cropY) / crop.cropHeight) * video.height
    const onScreen =
      localX >= 0 && localX <= video.width && localY >= 0 && localY <= video.height

    const rad = (video.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const artboardX = video.x + localX * cos - localY * sin
    const artboardY = video.y + localX * sin + localY * cos

    // Uniform px-per-display-point scale (cover crop preserves aspect, so the
    // x and y scales coincide).
    const scale = (iw / dw) * (video.width / crop.cropWidth)
    const renderHeight = CURSOR_BOX_HEIGHT_POINTS * CURSOR_SCALE * scale
    const aspect = asset.size[1] > 0 ? asset.size[0] / asset.size[1] : 1
    const renderWidth = renderHeight * aspect

    if (currentUrlRef.current !== asset.url) {
      currentUrlRef.current = asset.url
      setImage(loadCursorImage(asset.url))
    }
    node.size({ width: renderWidth, height: renderHeight })
    // Offset so the hotspot pixel sits exactly on the artboard point; rotation
    // then pivots around the hotspot, matching the recorded pointer.
    node.offset({
      x: asset.hotspot[0] * renderWidth,
      y: asset.hotspot[1] * renderHeight,
    })
    node.position({ x: artboardX, y: artboardY })
    node.rotation(video.rotation)
    node.visible(onScreen)
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
      if (cancelled || !data || data.moves.length === 0) return
      const samples = rawSamplesFromMoves(data.moves, data.processTimeStartMs)
      trackRef.current = CURSOR_SMOOTHING
        ? buildSmoothedTrack(samples, data.displayWidth, data.displayHeight)
        : buildRawTrack(samples, data.displayWidth, data.displayHeight)
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
