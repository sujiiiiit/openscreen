"use client"

import { useCallback, useEffect, useRef } from "react"
import { Image as KonvaImage } from "react-konva"
import type Konva from "konva"

import type { SmoothedCursorTrack } from "@/lib/cursors/cursor-track"
import type { CanvasVideoItem } from "@/types/editor-canvas"

import {
  createSpriteMotionBlurRenderer,
  type SpriteMotionBlurRenderer,
} from "@/lib/motion-blur/sprite-motion-blur"

import {
  buildCursorTrack,
  computeCursorBlur,
  placeCursor,
  projectFolderFromObjectUrl,
} from "./cursor-scene"
import {
  useEditorCanvasArtboard,
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
  const { artboard } = useEditorCanvasArtboard()
  const { timelineClips, timelineTime } = useEditorCanvasTimeline()
  const { subscribeTimelineTicks, subscribeHoverTime } =
    useEditorCanvasTimelineActions()

  const cursorSizeMultiplier = artboard.cursorSizeMultiplier
  const cursorMotionBlur = artboard.cursorMotionBlur

  const screenVideo = videos.find((video) => video.role === "screen") ?? null
  const screenClip = screenVideo
    ? timelineClips.find((clip) => clip.videoId === screenVideo.id) ?? null
    : null

  const imageRef = useRef<Konva.Image | null>(null)
  // The cursor node's image (sharp SVG or GPU-blurred canvas), its size, offset,
  // position and visibility are all driven imperatively in `place()` — nothing
  // about the cursor touches React on the per-frame hot path.
  const rendererRef = useRef<SpriteMotionBlurRenderer | null>(null)
  // Latest `place` for the SVG-load redraw closure (avoids `place` referencing
  // itself). Kept current via an effect below.
  const placeRef = useRef<(seconds: number) => void>(() => {})
  const trackRef = useRef<SmoothedCursorTrack | null>(null)
  const videoRef = useRef<CanvasVideoItem | null>(screenVideo)
  const clipRef = useRef(screenClip)
  const sizeRef = useRef(cursorSizeMultiplier)
  const motionBlurRef = useRef(cursorMotionBlur)
  const currentUrlRef = useRef<string | null>(null)
  // Last committed playhead time the cursor was placed at. Lets the ruler
  // hover-scrub preview restore the exact committed position when the hover
  // ends, independent of the debounced `timelineTime` React state.
  const lastCommittedTimeRef = useRef(timelineTime)

  // Keep the geometry/clip/size/blur the tick closure reads current without
  // re-subscribing. Synced in an effect (not during render) so it satisfies the
  // refs rule; it has no deps so it runs after every commit, ahead of the tick
  // subscription and the paused re-place effect declared below.
  useEffect(() => {
    videoRef.current = screenVideo
    clipRef.current = screenClip
    sizeRef.current = cursorSizeMultiplier
    motionBlurRef.current = cursorMotionBlur
  })

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
    const placement = placeCursor(track, video, sourceSeconds, {
      sizeMultiplier: sizeRef.current,
    })
    if (!placement) {
      if (node.visible()) {
        node.visible(false)
        layer?.batchDraw()
      }
      return
    }

    const svg = loadCursorImage(placement.url)
    currentUrlRef.current = placement.url
    // An SVG fetched this frame may not be decoded yet; redraw once it loads so
    // it (and any blur) appears without waiting for the next tick.
    if (!svg.complete) {
      svg.addEventListener(
        "load",
        () => placeRef.current(lastCommittedTimeRef.current),
        { once: true },
      )
    }

    // Motion blur: derive the smear from how fast the cursor moved, then render
    // it on the GPU (CPU fallback) and inject the result via `node.image()`.
    // No per-frame `node.cache()` / Konva filter — that was the lag. A still
    // pointer (or no renderer / undecoded svg) just draws the sharp SVG.
    const blur =
      placement.onScreen
        ? computeCursorBlur(track, video, sourceSeconds, {
            intensity: motionBlurRef.current,
            sizeMultiplier: sizeRef.current,
          })
        : null
    const renderer = rendererRef.current
    if (blur && renderer && svg.complete) {
      const { canvas, padding } = renderer.render(
        svg,
        placement.width,
        placement.height,
        blur,
      )
      node.image(canvas)
      node.size({
        width: placement.width + 2 * padding,
        height: placement.height + 2 * padding,
      })
      // Shift the hotspot offset by the blur margin so the pointer stays pinned.
      node.offset({
        x: placement.offsetX + padding,
        y: placement.offsetY + padding,
      })
    } else {
      node.image(svg)
      node.size({ width: placement.width, height: placement.height })
      // Offset so the hotspot pixel sits exactly on the artboard point; rotation
      // then pivots around the hotspot, matching the recorded pointer.
      node.offset({ x: placement.offsetX, y: placement.offsetY })
    }
    node.position({ x: placement.x, y: placement.y })
    node.rotation(placement.rotation)
    node.visible(placement.onScreen)
    layer?.batchDraw()
  }, [])

  useEffect(() => {
    placeRef.current = place
  }, [place])

  // One persistent sprite-blur renderer (GPU, CPU fallback) for the cursor's
  // lifetime. Created on the client; torn down on unmount.
  useEffect(() => {
    const renderer = createSpriteMotionBlurRenderer()
    rendererRef.current = renderer
    return () => {
      renderer.destroy()
      rendererRef.current = null
    }
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
    return subscribeTimelineTicks((time) => {
      lastCommittedTimeRef.current = time
      place(time)
    })
  }, [subscribeTimelineTicks, place])

  // Ruler hover-scrub preview: while the timeline previews a hovered frame
  // (without committing the playhead), sample the cursor at the hovered time so
  // it tracks the previewed frame exactly like the video does. On hover-end
  // (`null`) restore the committed position. Mirrors the video frame's hover
  // preview, which is driven from the same channel.
  useEffect(() => {
    return subscribeHoverTime((time) => {
      place(
        time === null || !Number.isFinite(time)
          ? lastCommittedTimeRef.current
          : time
      )
    })
  }, [subscribeHoverTime, place])

  // Re-place when paused and the geometry, committed playhead, or cursor size
  // changes (so dragging the size slider updates the preview immediately).
  useEffect(() => {
    lastCommittedTimeRef.current = timelineTime
    place(timelineTime)
  }, [
    place,
    timelineTime,
    cursorSizeMultiplier,
    cursorMotionBlur,
    screenVideo?.x,
    screenVideo?.y,
    screenVideo?.width,
    screenVideo?.height,
    screenVideo?.rotation,
  ])

  if (!screenVideo) return null

  return (
    // `image` is driven imperatively in `place()` (sharp SVG or blurred canvas),
    // so the prop is intentionally undefined (cast to satisfy the required type).
    <KonvaImage
      ref={imageRef}
      image={undefined as unknown as CanvasImageSource}
      listening={false}
      perfectDrawEnabled={false}
    />
  )
}
