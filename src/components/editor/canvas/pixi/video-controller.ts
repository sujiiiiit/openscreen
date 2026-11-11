import type { CanvasVideoItem, NodeTransform } from "@/types/editor-canvas"

import type { CanvasScene } from "./scene"
import type { NodeAppearance } from "./video-appearance"

type VideoFrameCallbackMetadata = {
  mediaTime?: number
  presentedFrames?: number
}
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameCallbackMetadata) => void
  ) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

/**
 * A duck-typed stand-in for the `Konva.Image` the provider transport registers
 * per video. The provider only calls `.visible()`, `.listening()`, and
 * `.getLayer().batchDraw()` on it (verified), so routing those to a per-node
 * Pixi frame upload keeps the transport (visibility windowing, seek redraws)
 * running with the same redraw contract as Konva.
 */
export type PixiNodeHandle = {
  visible(value?: boolean): boolean | void
  listening(value?: boolean): boolean | void
  getLayer(): { batchDraw: () => void }
}

const COMMON_FRAME_RATES = [24, 25, 30, 48, 50, 60, 90, 120]
const FPS_SAMPLE_TARGET = 8

function snapToCommonFps(rawFps: number) {
  for (const rate of COMMON_FRAME_RATES) {
    if (Math.abs(rawFps - rate) <= rate * 0.05) return rate
  }
  return Math.round(rawFps)
}

function transformOf(video: CanvasVideoItem): NodeTransform {
  return {
    x: video.x,
    y: video.y,
    width: video.width,
    height: video.height,
    rotation: video.rotation,
  }
}

function appearanceOf(video: CanvasVideoItem): NodeAppearance {
  return {
    cornerRadius: video.cornerRadius,
    cornerSmoothing: video.cornerSmoothing,
    borderWidth: video.borderWidth,
    borderColor: video.borderColor,
    borderOffset: video.borderOffset,
    borderAlignment: video.borderAlignment,
  }
}

type VideoEntry = {
  video: CanvasVideoItem
  el: VideoWithFrameCallback
  registered: boolean
  mounted: boolean
  playing: boolean
  detachListeners: () => void
}

type VideoControllerOptions = {
  scene: CanvasScene
  registerElement: (id: string, element: HTMLVideoElement | null) => void
  registerNode: (id: string, node: PixiNodeHandle | null) => void
  onSeeked: (
    id: string,
    element: HTMLVideoElement,
    redrawLayer: (afterDraw?: () => void) => void
  ) => void
  onFpsMeasured: (id: string, fps: number) => void
}

/**
 * Owns the per-video `<video>` elements + their Pixi sprite nodes and bridges
 * them to openscreen's playback transport (which lives in the provider and is
 * unchanged). It mirrors the old Konva `CanvasVideoNode`: create the element,
 * mount a cover-cropped sprite on metadata, run the playback render loop +
 * FPS measurement off `requestVideoFrameCallback`, and hand every `seeked`
 * event back to the provider with a lockstep redraw callback.
 *
 * The actual clock/seek/coalescing logic stays in the provider; this controller
 * only creates/registers elements and turns transport callbacks into Pixi
 * scene renders.
 */
export class VideoController {
  private readonly scene: CanvasScene
  private readonly registerElement: VideoControllerOptions["registerElement"]
  private readonly registerNode: VideoControllerOptions["registerNode"]
  private readonly onSeeked: VideoControllerOptions["onSeeked"]
  private readonly onFpsMeasured: VideoControllerOptions["onFpsMeasured"]

  private readonly entries = new Map<string, VideoEntry>()
  private primaryAudioVideoId: string | null = null
  /** Number of elements currently playing; drives the scene's continuous loop. */
  private playingCount = 0
  private destroyed = false

  constructor(options: VideoControllerOptions) {
    this.scene = options.scene
    this.registerElement = options.registerElement
    this.registerNode = options.registerNode
    this.onSeeked = options.onSeeked
    this.onFpsMeasured = options.onFpsMeasured
  }

  /** Reconcile the live element/sprite set with the React-owned video list. */
  syncVideos(videos: CanvasVideoItem[]) {
    if (this.destroyed) return
    const seen = new Set<string>()

    for (const video of videos) {
      seen.add(video.id)
      const existing = this.entries.get(video.id)
      if (!existing) {
        this.createEntry(video)
        continue
      }
      if (existing.video.objectUrl !== video.objectUrl) {
        this.teardownEntry(video.id)
        this.createEntry(video)
        continue
      }
      existing.video = video
      if (existing.mounted) {
        this.scene.setNodeAppearance(video.id, appearanceOf(video))
        this.scene.setNodeTransform(video.id, transformOf(video))
      }
    }

    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) this.teardownEntry(id)
    }
  }

  setPrimaryAudio(primaryAudioVideoId: string | null) {
    this.primaryAudioVideoId = primaryAudioVideoId
    for (const entry of this.entries.values()) {
      entry.el.muted = entry.video.id !== primaryAudioVideoId
    }
  }

  destroy() {
    this.destroyed = true
    for (const id of [...this.entries.keys()]) this.teardownEntry(id)
    this.playingCount = 0
  }

  // ── per-video lifecycle ─────────────────────────────────────────────────────

  private createEntry(video: CanvasVideoItem) {
    const el = document.createElement("video") as VideoWithFrameCallback
    el.muted = video.id !== this.primaryAudioVideoId
    el.loop = false
    el.playsInline = true
    el.preload = "auto"
    el.src = video.objectUrl

    const entry: VideoEntry = {
      video,
      el,
      registered: false,
      mounted: false,
      playing: false,
      detachListeners: () => {},
    }
    this.entries.set(video.id, entry)

    const markReady = () => {
      if (this.destroyed || !this.entries.has(video.id)) return
      if (!entry.mounted) {
        entry.mounted = true
        this.scene.mountVideoNode(
          video.id,
          el,
          {
            width: entry.video.intrinsicWidth,
            height: entry.video.intrinsicHeight,
          },
          transformOf(entry.video),
          appearanceOf(entry.video)
        )
      }
      if (!entry.registered) {
        entry.registered = true
        this.registerElement(video.id, el)
        this.registerNode(video.id, this.makeNodeHandle(video.id))
      }
      this.scene.requestRender()
    }

    // ── playback render loop + FPS measurement (off requestVideoFrameCallback) ──
    const supportsFrameCallback = Boolean(el.requestVideoFrameCallback)
    let frameCallbackId: number | null = null
    let fpsReported = false
    let prevMediaTime: number | null = null
    let prevPresentedFrames: number | null = null
    const fpsSamples: number[] = []

    const measureFps = (metadata: VideoFrameCallbackMetadata | undefined) => {
      if (fpsReported || !metadata) return
      const { mediaTime, presentedFrames } = metadata
      if (
        typeof mediaTime !== "number" ||
        typeof presentedFrames !== "number"
      ) {
        return
      }
      if (prevMediaTime !== null && prevPresentedFrames !== null) {
        const dt = mediaTime - prevMediaTime
        const df = presentedFrames - prevPresentedFrames
        if (df > 0 && dt > 0) {
          fpsSamples.push(df / dt)
          if (fpsSamples.length >= FPS_SAMPLE_TARGET) {
            const sorted = [...fpsSamples].sort((a, b) => a - b)
            fpsReported = true
            this.onFpsMeasured(
              video.id,
              snapToCommonFps(sorted[Math.floor(sorted.length / 2)])
            )
          }
        }
      }
      prevMediaTime = mediaTime
      prevPresentedFrames = presentedFrames
    }

    const scheduleFps = () => {
      if (frameCallbackId !== null || el.paused || el.ended || fpsReported)
        return
      frameCallbackId =
        el.requestVideoFrameCallback?.((_now, metadata) => {
          frameCallbackId = null
          measureFps(metadata)
          scheduleFps()
        }) ?? null
    }

    const redrawLayer = (afterDraw?: () => void) => {
      const run = () => {
        if (this.destroyed) return
        this.scene.renderNodeNow(video.id)
        afterDraw?.()
      }
      if (supportsFrameCallback && el.requestVideoFrameCallback) {
        el.requestVideoFrameCallback(() => run())
      } else {
        run()
      }
    }

    const handlePlay = () => {
      if (!entry.playing) {
        entry.playing = true
        if (++this.playingCount === 1) this.scene.beginPlayback()
      }
      if (supportsFrameCallback) scheduleFps()
    }
    const handlePauseOrEnd = () => {
      if (entry.playing) {
        entry.playing = false
        if (--this.playingCount <= 0) {
          this.playingCount = 0
          this.scene.endPlayback()
        }
      }
      if (frameCallbackId !== null) {
        el.cancelVideoFrameCallback?.(frameCallbackId)
        frameCallbackId = null
      }
      // Paint the final/landing frame; the provider gates hover vs committed.
      this.onSeeked(video.id, el, redrawLayer)
    }
    const handleSeeked = () => {
      this.onSeeked(video.id, el, redrawLayer)
    }

    el.addEventListener("loadedmetadata", markReady)
    el.addEventListener("loadeddata", markReady)
    el.addEventListener("play", handlePlay)
    el.addEventListener("playing", handlePlay)
    el.addEventListener("pause", handlePauseOrEnd)
    el.addEventListener("ended", handlePauseOrEnd)
    el.addEventListener("seeked", handleSeeked)

    entry.detachListeners = () => {
      el.removeEventListener("loadedmetadata", markReady)
      el.removeEventListener("loadeddata", markReady)
      el.removeEventListener("play", handlePlay)
      el.removeEventListener("playing", handlePlay)
      el.removeEventListener("pause", handlePauseOrEnd)
      el.removeEventListener("ended", handlePauseOrEnd)
      el.removeEventListener("seeked", handleSeeked)
      if (frameCallbackId !== null) {
        el.cancelVideoFrameCallback?.(frameCallbackId)
        frameCallbackId = null
      }
    }

    el.load()
  }

  private teardownEntry(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)

    if (entry.playing && --this.playingCount <= 0) {
      this.playingCount = 0
      this.scene.endPlayback()
    }
    entry.detachListeners()
    if (entry.registered) {
      this.registerElement(id, null)
      this.registerNode(id, null)
    }
    if (entry.mounted) this.scene.unmountVideoNode(id)

    entry.el.pause()
    entry.el.removeAttribute("src")
    entry.el.load()
  }

  /** The provider-facing visibility/redraw handle for one node. */
  private makeNodeHandle(id: string): PixiNodeHandle {
    let visible = true
    let listening = true
    const scene = this.scene
    const layerLike = { batchDraw: () => scene.renderNodeNow(id) }
    return {
      visible(value?: boolean) {
        if (value === undefined) return visible
        visible = value
        scene.setNodeRenderable(id, value)
      },
      listening(value?: boolean) {
        if (value === undefined) return listening
        listening = value
      },
      getLayer() {
        return layerLike
      },
    }
  }
}
