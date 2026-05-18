"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type Konva from "konva"

import {
  type ArtboardPresetId,
  AUTO_ARTBOARD_PRESET_ID,
  clampWorkspaceView,
  DEFAULT_ARTBOARD_PRESET_ID,
  getArtboardPreset,
  getFitViewTransform,
  resolveAutoArtboard,
} from "@/lib/editor-canvas"
import { useProject } from "@/components/editor/project/provider"
import type {
  CanvasTimelineClip,
  CanvasSize,
  CanvasVideoCropShape,
  CanvasVideoItem,
  CanvasVideoRole,
  CanvasVideoTransformPatch,
  EditorArtboard,
  ViewTransform,
} from "@/types/editor-canvas"
import type { ProjectAsset } from "@/types/api"

const DEFAULT_VIEWPORT_SIZE: CanvasSize = { width: 0, height: 0 }
const DEFAULT_ARTBOARD_PRESET = getArtboardPreset(DEFAULT_ARTBOARD_PRESET_ID)
const DEFAULT_ARTBOARD: EditorArtboard = {
  presetId: DEFAULT_ARTBOARD_PRESET.id,
  width: DEFAULT_ARTBOARD_PRESET.width,
  height: DEFAULT_ARTBOARD_PRESET.height,
}
const DEFAULT_VIEW_TRANSFORM = getFitViewTransform(
  DEFAULT_VIEWPORT_SIZE,
  DEFAULT_ARTBOARD
)
const DUPLICATED_VIDEO_OFFSET = 48
const CAMERA_DEFAULT_DIAMETER = 240
const CAMERA_DEFAULT_MARGIN = 32
const TIMELINE_MIN_CLIP_DURATION_SECONDS = 1 / 30
// Explicit seeks (user scrub, play-from-new-position, clip activation) snap to
// the target unless the element is already within this many seconds.
const TIMELINE_FORCE_SEEK_EPSILON_SECONDS = 0.002
// During natural playback secondary videos are left alone unless they drift
// past this much. Setting this above typical rAF jitter prevents the
// constant-seek loop that used to make the master video flicker frames back
// and forth.
const TIMELINE_PLAYBACK_DRIFT_SECONDS = 0.25
// When the playhead lands on the very end of the timeline, treat any clip
// whose end is within this many seconds of the timeline duration as still
// "displaying its last frame" so the canvas does not flash blank at the end.
const TIMELINE_END_HOLD_EPSILON_SECONDS = 1e-3
const TIMELINE_STATE_COMMIT_INTERVAL_MS = 80
const TIMELINE_ZOOM_MIN = 0.35
const TIMELINE_ZOOM_MAX = 4
const TIMELINE_ZOOM_STEP = 1.25

type AddRemoteVideoInput = {
  id?: string
  url: string
  fileName: string
  intrinsicWidth: number
  intrinsicHeight: number
  durationMs?: number
  role: "screen" | "camera"
  cropShape?: CanvasVideoCropShape
  placement?: Partial<Pick<CanvasVideoItem, "x" | "y" | "width" | "height">>
  shouldAbort?: () => boolean
}

type VideoMetadata = {
  width: number
  height: number
  durationMs: number
}

type TimelineResizeDirection = "left" | "right"

type TimelineTickSubscriber = (time: number) => void

type HoverTimeSubscriber = (time: number | null) => void

type HoverSeekState = {
  targetSourceTime: number
  hoverTimelineTime: number
  issuedAt: number
  timeoutId: number
}

type TimelineVisibilityWindow = {
  start: number
  end: number
}

type EditorCanvasContextValue = {
  videos: CanvasVideoItem[]
  selectedItemId: string | null
  selectedVideo: CanvasVideoItem | null
  timelineClips: CanvasTimelineClip[]
  selectedTimelineClip: CanvasTimelineClip | null
  timelineTime: number
  timelineDuration: number
  timelineZoom: number
  isTimelineFit: boolean
  timelineFitRequestId: number
  timelineVisibleVideoIds: ReadonlySet<string>
  isTimelinePlaying: boolean
  isHoverPreviewActive: boolean
  primaryAudioVideoId: string | null
  viewportSize: CanvasSize
  artboard: EditorArtboard
  viewTransform: ViewTransform
  importError: string | null
  addVideoFile: (file: File) => Promise<void>
  addRemoteVideo: (input: AddRemoteVideoInput) => Promise<string | null>
  selectItem: (id: string | null) => void
  updateVideoTransform: (id: string, patch: CanvasVideoTransformPatch) => void
  setVideoLocked: (id: string, locked: boolean) => void
  duplicateVideo: (id: string) => void
  deleteVideo: (id: string) => void
  setArtboardPreset: (id: ArtboardPresetId) => void
  setViewportSize: (size: CanvasSize) => void
  setViewTransform: (transform: ViewTransform) => void
  fitArtboardToViewport: () => void
  registerTimelineVideoElement: (
    id: string,
    element: HTMLVideoElement | null
  ) => void
  registerTimelineCanvasNode: (id: string, node: Konva.Image | null) => void
  onTimelineVideoSeeked: (
    id: string,
    element: HTMLVideoElement,
    redrawLayer: () => void
  ) => void
  updateHoverPreviewTime: (time: number | null) => void
  subscribeHoverTime: (subscriber: HoverTimeSubscriber) => () => void
  setTimelineTime: (time: number) => void
  playTimeline: () => void
  pauseTimeline: () => void
  toggleTimelinePlayback: () => void
  zoomTimelineIn: () => void
  zoomTimelineOut: () => void
  fitTimelineToWidth: () => void
  moveTimelineClip: (id: string, start: number, end: number) => void
  resizeTimelineClip: (
    id: string,
    start: number,
    end: number,
    direction: TimelineResizeDirection
  ) => void
  subscribeTimelineTicks: (subscriber: TimelineTickSubscriber) => () => void
}

type EditorCanvasMediaContextValue = Pick<
  EditorCanvasContextValue,
  "videos" | "selectedItemId" | "selectedVideo" | "importError"
>

type EditorCanvasArtboardContextValue = Pick<
  EditorCanvasContextValue,
  "artboard"
>

type EditorCanvasViewContextValue = Pick<
  EditorCanvasContextValue,
  "viewportSize" | "viewTransform"
>

type EditorCanvasTimelineContextValue = Pick<
  EditorCanvasContextValue,
  | "timelineClips"
  | "selectedTimelineClip"
  | "timelineTime"
  | "timelineDuration"
  | "timelineZoom"
  | "isTimelineFit"
  | "timelineFitRequestId"
  | "timelineVisibleVideoIds"
  | "isTimelinePlaying"
  | "isHoverPreviewActive"
  | "primaryAudioVideoId"
>

type EditorCanvasActionsContextValue = Pick<
  EditorCanvasContextValue,
  | "addVideoFile"
  | "addRemoteVideo"
  | "selectItem"
  | "updateVideoTransform"
  | "setVideoLocked"
  | "duplicateVideo"
  | "deleteVideo"
  | "setArtboardPreset"
  | "setViewportSize"
  | "setViewTransform"
  | "fitArtboardToViewport"
>

type EditorCanvasTimelineActionsContextValue = Pick<
  EditorCanvasContextValue,
  | "registerTimelineVideoElement"
  | "registerTimelineCanvasNode"
  | "onTimelineVideoSeeked"
  | "updateHoverPreviewTime"
  | "subscribeHoverTime"
  | "setTimelineTime"
  | "playTimeline"
  | "pauseTimeline"
  | "toggleTimelinePlayback"
  | "zoomTimelineIn"
  | "zoomTimelineOut"
  | "fitTimelineToWidth"
  | "moveTimelineClip"
  | "resizeTimelineClip"
  | "subscribeTimelineTicks"
>

const EditorCanvasMediaContext =
  createContext<EditorCanvasMediaContextValue | null>(null)
const EditorCanvasArtboardContext =
  createContext<EditorCanvasArtboardContextValue | null>(null)
const EditorCanvasViewContext =
  createContext<EditorCanvasViewContextValue | null>(null)
const EditorCanvasActionsContext =
  createContext<EditorCanvasActionsContextValue | null>(null)
const EditorCanvasTimelineContext =
  createContext<EditorCanvasTimelineContextValue | null>(null)
const EditorCanvasTimelineActionsContext =
  createContext<EditorCanvasTimelineActionsContextValue | null>(null)

function readVideoMetadata(objectUrl: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video")

    const cleanup = () => {
      video.removeEventListener("loadedmetadata", handleLoadedMetadata)
      video.removeEventListener("error", handleError)
      video.removeAttribute("src")
      video.load()
    }

    const handleLoadedMetadata = () => {
      const width = video.videoWidth
      const height = video.videoHeight
      const durationMs =
        Number.isFinite(video.duration) && video.duration > 0
          ? Math.round(video.duration * 1000)
          : 0

      if (!width || !height) {
        cleanup()
        reject(new Error("The selected video does not expose a valid size."))
        return
      }

      cleanup()
      resolve({ width, height, durationMs })
    }

    const handleError = () => {
      cleanup()
      reject(new Error("The selected video could not be loaded."))
    }

    video.preload = "metadata"
    video.muted = true
    video.playsInline = true
    video.addEventListener("loadedmetadata", handleLoadedMetadata)
    video.addEventListener("error", handleError)
    video.src = objectUrl
    video.load()
  })
}

function getCoverVideoPlacement(
  metadata: CanvasSize,
  artboardSize: CanvasSize
) {
  const coverScale = Math.max(
    artboardSize.width / metadata.width,
    artboardSize.height / metadata.height
  )
  const width = metadata.width * coverScale
  const height = metadata.height * coverScale

  return {
    x: (artboardSize.width - width) / 2,
    y: (artboardSize.height - height) / 2,
    width,
    height,
  }
}

function relayoutVideoForArtboard(
  video: CanvasVideoItem,
  prev: CanvasSize,
  next: CanvasSize
): CanvasVideoItem {
  if (prev.width <= 0 || prev.height <= 0) return video

  if (video.role === "screen") {
    const cover = getCoverVideoPlacement(
      { width: video.intrinsicWidth, height: video.intrinsicHeight },
      next
    )
    return { ...video, ...cover }
  }

  const scaleX = next.width / prev.width
  const scaleY = next.height / prev.height
  const uniformScale = Math.min(scaleX, scaleY)

  if (video.role === "camera") {
    const nextWidth = video.width
    const nextHeight = video.height
    const targetX = video.x * scaleX
    const targetY = video.y * scaleY
    const clampedX = Math.max(0, Math.min(next.width - nextWidth, targetX))
    const clampedY = Math.max(0, Math.min(next.height - nextHeight, targetY))
    return {
      ...video,
      x: clampedX,
      y: clampedY,
      width: nextWidth,
      height: nextHeight,
    }
  }

  const nextWidth = video.width * uniformScale
  const nextHeight = video.height * uniformScale
  const targetX = video.x * uniformScale
  const targetY = video.y * uniformScale
  const clampedX = Math.max(0, Math.min(next.width - nextWidth, targetX))
  const clampedY = Math.max(0, Math.min(next.height - nextHeight, targetY))
  return {
    ...video,
    x: clampedX,
    y: clampedY,
    width: nextWidth,
    height: nextHeight,
  }
}

function createCanvasId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }

  return `canvas-item-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createTimelineClipId(videoId: string) {
  return `${videoId}:clip`
}

function getVideoDurationSeconds(video: Pick<CanvasVideoItem, "durationMs">) {
  const duration = video.durationMs / 1000
  return Number.isFinite(duration) && duration > 0
    ? duration
    : TIMELINE_MIN_CLIP_DURATION_SECONDS
}

function createTimelineClip(video: CanvasVideoItem): CanvasTimelineClip {
  const duration = getVideoDurationSeconds(video)
  return {
    id: createTimelineClipId(video.id),
    videoId: video.id,
    start: 0,
    end: duration,
    sourceIn: 0,
    sourceOut: duration,
  }
}

function buildVideoById(videos: CanvasVideoItem[]) {
  return new Map(videos.map((video) => [video.id, video]))
}

function buildTimelineClipByVideoId(clips: CanvasTimelineClip[]) {
  return new Map(clips.map((clip) => [clip.videoId, clip]))
}

function areSetsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>) {
  if (left.size !== right.size) return false

  for (const value of left) {
    if (!right.has(value)) return false
  }

  return true
}

function clampTimelineTime(time: number, duration: number) {
  if (!Number.isFinite(time)) return 0
  return Math.min(Math.max(0, time), Math.max(0, duration))
}

export function EditorCanvasProvider({ children }: { children: ReactNode }) {
  const [videos, setVideos] = useState<CanvasVideoItem[]>([])
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [artboard, setArtboard] = useState<EditorArtboard>(DEFAULT_ARTBOARD)
  const [viewportSize, setViewportSizeState] = useState<CanvasSize>(
    DEFAULT_VIEWPORT_SIZE
  )
  const [viewTransform, setViewTransformState] = useState<ViewTransform>(
    DEFAULT_VIEW_TRANSFORM
  )
  const [importError, setImportError] = useState<string | null>(null)
  const [timelineClips, setTimelineClips] = useState<CanvasTimelineClip[]>([])
  const [timelineTime, setTimelineTimeState] = useState(0)
  const [timelineZoom, setTimelineZoom] = useState(1)
  const [isTimelineFit, setIsTimelineFit] = useState(true)
  const [timelineFitRequestId, setTimelineFitRequestId] = useState(0)
  const [timelineVisibleVideoIds, setTimelineVisibleVideoIds] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const [isTimelinePlaying, setIsTimelinePlaying] = useState(false)
  const [isHoverPreviewActive, setIsHoverPreviewActive] = useState(false)

  const objectUrlsRef = useRef(new Set<string>())
  const videosRef = useRef(videos)
  const videoByIdRef = useRef(buildVideoById(videos))
  const timelineClipsRef = useRef(timelineClips)
  const timelineClipByVideoIdRef = useRef(
    buildTimelineClipByVideoId(timelineClips)
  )
  const timelineTimeRef = useRef(timelineTime)
  const timelineDurationRef = useRef(0)
  const isTimelinePlayingRef = useRef(isTimelinePlaying)
  const timelineVideoElementsRef = useRef(new Map<string, HTMLVideoElement>())
  const timelineCanvasNodesRef = useRef(new Map<string, Konva.Image>())
  const timelineVisibleVideoIdsRef = useRef<ReadonlySet<string>>(new Set())
  const timelineVisibilityWindowRef = useRef<TimelineVisibilityWindow | null>(
    null
  )
  const timelineTickSubscribersRef = useRef(new Set<TimelineTickSubscriber>())
  const timelinePlaybackFrameRef = useRef<number | null>(null)
  const timelinePreviousFrameMsRef = useRef<number | null>(null)
  const timelineLastStateCommitMsRef = useRef(0)
  // Hover preview pipeline state. All refs so a stream of mouse moves doesn't
  // re-render the React tree; `isHoverPreviewActive` is the single observable
  // bit a consumer needs (for ghost-cursor mounting).
  const hoverPreviewTimeRef = useRef<number | null>(null)
  const hoverPreviewActiveRef = useRef(false)
  const hoverFrameRef = useRef<number | null>(null)
  const hoverSeekStateRef = useRef(new Map<string, HoverSeekState>())
  const hoverTimeSubscribersRef = useRef(new Set<HoverTimeSubscriber>())
  const primaryAudioVideoIdRef = useRef<string | null>(null)
  const selectedItemIdRef = useRef(selectedItemId)
  const viewportSizeRef = useRef(viewportSize)
  const artboardRef = useRef(artboard)
  const viewTransformRef = useRef(viewTransform)
  const hasCustomViewRef = useRef(false)
  const sourceVideoDimsRef = useRef<{ width: number; height: number } | null>(
    null
  )
  const hydratedProjectIdRef = useRef<string | null>(null)
  const hydrationGenerationRef = useRef(0)

  const commitVideosRef = useCallback((nextVideos: CanvasVideoItem[]) => {
    videosRef.current = nextVideos
    videoByIdRef.current = buildVideoById(nextVideos)
    timelineVisibilityWindowRef.current = null
  }, [])

  const commitTimelineClipsRef = useCallback(
    (nextClips: CanvasTimelineClip[]) => {
      timelineClipsRef.current = nextClips
      timelineClipByVideoIdRef.current = buildTimelineClipByVideoId(nextClips)
      timelineVisibilityWindowRef.current = null
    },
    []
  )

  useEffect(() => {
    commitVideosRef(videos)
  }, [commitVideosRef, videos])

  useEffect(() => {
    commitTimelineClipsRef(timelineClips)
  }, [commitTimelineClipsRef, timelineClips])

  useEffect(() => {
    timelineTimeRef.current = timelineTime
  }, [timelineTime])

  useEffect(() => {
    isTimelinePlayingRef.current = isTimelinePlaying
  }, [isTimelinePlaying])

  useEffect(() => {
    selectedItemIdRef.current = selectedItemId
  }, [selectedItemId])

  useEffect(() => {
    viewportSizeRef.current = viewportSize
  }, [viewportSize])

  useEffect(() => {
    artboardRef.current = artboard
  }, [artboard])

  useEffect(() => {
    viewTransformRef.current = viewTransform
  }, [viewTransform])

  const timelineDuration = useMemo(() => {
    const clipDuration = timelineClips.reduce(
      (duration, clip) => Math.max(duration, clip.end),
      0
    )

    return Math.max(TIMELINE_MIN_CLIP_DURATION_SECONDS, clipDuration)
  }, [timelineClips])

  const primaryAudioVideoId = useMemo(
    () => videos.find((video) => video.role === "screen")?.id ?? null,
    [videos]
  )

  useEffect(() => {
    primaryAudioVideoIdRef.current = primaryAudioVideoId
  }, [primaryAudioVideoId])

  useEffect(() => {
    timelineDurationRef.current = timelineDuration
    // The visibility cache encodes "next clip boundary"; the timeline-end
    // hold also depends on the duration, so invalidate whenever it shifts.
    timelineVisibilityWindowRef.current = null
  }, [timelineDuration])

  useEffect(() => {
    const objectUrls = objectUrlsRef.current
    const hoverSeekState = hoverSeekStateRef.current
    const hoverTimeSubscribers = hoverTimeSubscribersRef.current

    return () => {
      if (timelinePlaybackFrameRef.current !== null) {
        cancelAnimationFrame(timelinePlaybackFrameRef.current)
        timelinePlaybackFrameRef.current = null
      }
      if (hoverFrameRef.current !== null) {
        cancelAnimationFrame(hoverFrameRef.current)
        hoverFrameRef.current = null
      }
      hoverSeekState.forEach((entry) => {
        window.clearTimeout(entry.timeoutId)
      })
      hoverSeekState.clear()
      hoverTimeSubscribers.clear()
      objectUrls.forEach((objectUrl) => {
        URL.revokeObjectURL(objectUrl)
      })
      objectUrls.clear()
    }
  }, [])

  const notifyTimelineSubscribers = useCallback((time: number) => {
    timelineTickSubscribersRef.current.forEach((subscriber) => {
      subscriber(time)
    })
  }, [])

  const resolveTimelineFrame = useCallback((videoId: string, time: number) => {
    const clip = timelineClipByVideoIdRef.current.get(videoId)
    const video = videoByIdRef.current.get(videoId)
    if (!clip || !video) return null

    const sourceDuration = getVideoDurationSeconds(video)
    const sourceIn = Math.max(0, Math.min(clip.sourceIn, sourceDuration))
    const sourceOut = Math.max(
      sourceIn,
      Math.min(clip.sourceOut, sourceDuration)
    )
    const timelineEnd = timelineDurationRef.current
    const isPlayingThroughClip = time >= clip.start && time < clip.end
    // When the playhead lands on the very end of the timeline, keep any clip
    // that ends there visible and sample its trimmed-out frame instead of
    // jumping back to sourceIn. Without this the longest clip would hide as
    // soon as time === clip.end and the canvas would flash blank.
    const isHoldingLastFrame =
      !isPlayingThroughClip &&
      time >= clip.start &&
      time >= clip.end - TIMELINE_END_HOLD_EPSILON_SECONDS &&
      clip.end >= timelineEnd - TIMELINE_END_HOLD_EPSILON_SECONDS
    const active = isPlayingThroughClip || isHoldingLastFrame
    const sourceTime = isPlayingThroughClip
      ? sourceIn + (time - clip.start)
      : isHoldingLastFrame
        ? Math.max(sourceIn, sourceOut - TIMELINE_END_HOLD_EPSILON_SECONDS)
        : sourceIn

    return {
      active,
      sourceTime: Math.max(sourceIn, Math.min(sourceTime, sourceOut)),
      sourceDuration,
    }
  }, [])

  const commitTimelineVisibleVideoIds = useCallback(
    (nextVisibleIds: ReadonlySet<string>) => {
      if (areSetsEqual(timelineVisibleVideoIdsRef.current, nextVisibleIds)) {
        return
      }

      timelineVisibleVideoIdsRef.current = nextVisibleIds
      setTimelineVisibleVideoIds(nextVisibleIds)
    },
    []
  )

  const setTimelineCanvasNodeVisibility = useCallback(
    (videoId: string, isVisible: boolean) => {
      const node = timelineCanvasNodesRef.current.get(videoId)
      if (!node) return

      let didChange = false
      if (node.visible() !== isVisible) {
        node.visible(isVisible)
        didChange = true
      }
      if (node.listening() !== isVisible) {
        node.listening(isVisible)
        didChange = true
      }

      if (didChange) {
        node.getLayer()?.batchDraw()
      }
    },
    []
  )

  const getTimelineVisibilitySnapshot = useCallback((time: number) => {
    const visibleIds = new Set<string>()
    const videoById = videoByIdRef.current
    const timelineEnd = timelineDurationRef.current
    const isAtTimelineEnd = time >= timelineEnd - TIMELINE_END_HOLD_EPSILON_SECONDS
    let stableStart = 0
    let stableEnd = Number.POSITIVE_INFINITY

    timelineClipsRef.current.forEach((clip) => {
      if (!videoById.has(clip.videoId)) return

      if (clip.start <= time && clip.start > stableStart) {
        stableStart = clip.start
      } else if (clip.start > time && clip.start < stableEnd) {
        stableEnd = clip.start
      }

      if (clip.end <= time && clip.end > stableStart) {
        stableStart = clip.end
      } else if (clip.end > time && clip.end < stableEnd) {
        stableEnd = clip.end
      }

      const isPlayingThroughClip = time >= clip.start && time < clip.end
      const isHoldingLastFrame =
        isAtTimelineEnd &&
        time >= clip.start &&
        clip.end >= timelineEnd - TIMELINE_END_HOLD_EPSILON_SECONDS
      if (isPlayingThroughClip || isHoldingLastFrame) {
        visibleIds.add(clip.videoId)
      }
    })

    return {
      visibleIds,
      visibilityWindow: {
        start: stableStart,
        end: stableEnd,
      },
    }
  }, [])

  const syncTimelineVisibility = useCallback(
    (time: number) => {
      const currentVisibleIds = timelineVisibleVideoIdsRef.current
      const visibilityWindow = timelineVisibilityWindowRef.current
      if (
        visibilityWindow &&
        time >= visibilityWindow.start &&
        time < visibilityWindow.end
      ) {
        return currentVisibleIds
      }

      const { visibleIds: nextVisibleIds, visibilityWindow: nextWindow } =
        getTimelineVisibilitySnapshot(time)
      timelineVisibilityWindowRef.current = nextWindow

      if (areSetsEqual(currentVisibleIds, nextVisibleIds)) {
        return currentVisibleIds
      }

      currentVisibleIds.forEach((videoId) => {
        if (!nextVisibleIds.has(videoId)) {
          setTimelineCanvasNodeVisibility(videoId, false)
        }
      })
      nextVisibleIds.forEach((videoId) => {
        if (!currentVisibleIds.has(videoId)) {
          setTimelineCanvasNodeVisibility(videoId, true)
        }
      })
      commitTimelineVisibleVideoIds(nextVisibleIds)

      return nextVisibleIds
    },
    [
      commitTimelineVisibleVideoIds,
      getTimelineVisibilitySnapshot,
      setTimelineCanvasNodeVisibility,
    ]
  )

  const getSeekableTimelineSourceTime = useCallback(
    (element: HTMLVideoElement, sourceTime: number, sourceDuration: number) => {
      const elementDuration =
        Number.isFinite(element.duration) && element.duration > 0
          ? element.duration
          : sourceDuration

      return elementDuration > 0 && sourceTime >= elementDuration
        ? Math.max(0, elementDuration - 0.001)
        : sourceTime
    },
    []
  )

  const shouldDrawTimelineVideoFrame = useCallback(
    (videoId: string, element: HTMLVideoElement) => {
      if (isTimelinePlayingRef.current) return true

      const frame = resolveTimelineFrame(videoId, timelineTimeRef.current)
      if (!frame?.active) return false

      const seekableTime = getSeekableTimelineSourceTime(
        element,
        frame.sourceTime,
        frame.sourceDuration
      )

      return (
        Math.abs(element.currentTime - seekableTime) <=
        TIMELINE_FORCE_SEEK_EPSILON_SECONDS
      )
    },
    [getSeekableTimelineSourceTime, resolveTimelineFrame]
  )

  const safeSeekElement = useCallback(
    (element: HTMLVideoElement, seekableTime: number) => {
      try {
        element.currentTime = seekableTime
      } catch {
        // Some browsers reject currentTime before metadata is fully ready.
      }
    },
    []
  )

  const safePlayElement = useCallback((element: HTMLVideoElement) => {
    if (!element.paused) return
    const playPromise = element.play()
    if (playPromise) {
      playPromise.catch(() => {
        element.pause()
      })
    }
  }, [])

  // Snap a single element to the timeline target. Used for explicit user
  // actions (scrub, play, clip edits) and for clips that just became active.
  const seekElementToTimeline = useCallback(
    (
      videoId: string,
      element: HTMLVideoElement,
      time: number,
      shouldPlay: boolean
    ) => {
      const frame = resolveTimelineFrame(videoId, time)
      if (!frame || !frame.active) {
        if (!element.paused) element.pause()
        return
      }

      if (element.playbackRate !== 1) element.playbackRate = 1
      const seekableTime = getSeekableTimelineSourceTime(
        element,
        frame.sourceTime,
        frame.sourceDuration
      )
      if (
        Math.abs(element.currentTime - seekableTime) >
        TIMELINE_FORCE_SEEK_EPSILON_SECONDS
      ) {
        safeSeekElement(element, seekableTime)
      }

      if (shouldPlay) {
        safePlayElement(element)
      } else if (!element.paused) {
        element.pause()
      }
    },
    [
      getSeekableTimelineSourceTime,
      resolveTimelineFrame,
      safePlayElement,
      safeSeekElement,
    ]
  )

  // Hands-off sync during natural playback. Only re-seeks when drift grows
  // larger than typical rAF jitter, so the master video plays smoothly without
  // being yanked back and forth each frame.
  const driftCorrectElement = useCallback(
    (videoId: string, element: HTMLVideoElement, time: number) => {
      const frame = resolveTimelineFrame(videoId, time)
      if (!frame || !frame.active) {
        if (!element.paused) element.pause()
        return
      }

      if (element.playbackRate !== 1) element.playbackRate = 1
      safePlayElement(element)

      const seekableTime = getSeekableTimelineSourceTime(
        element,
        frame.sourceTime,
        frame.sourceDuration
      )
      if (
        Math.abs(element.currentTime - seekableTime) >
        TIMELINE_PLAYBACK_DRIFT_SECONDS
      ) {
        safeSeekElement(element, seekableTime)
      }
    },
    [
      getSeekableTimelineSourceTime,
      resolveTimelineFrame,
      safePlayElement,
      safeSeekElement,
    ]
  )

  const notifyHoverTimeSubscribers = useCallback((time: number | null) => {
    hoverTimeSubscribersRef.current.forEach((subscriber) => {
      subscriber(time)
    })
  }, [])

  // Drops the in-flight bookkeeping for a single video element. Used when a
  // clip transitions out of visibility mid-hover and when a hover seek either
  // lands cleanly or is recognised as stale.
  const clearHoverEntry = useCallback((videoId: string) => {
    const entry = hoverSeekStateRef.current.get(videoId)
    if (!entry) return
    window.clearTimeout(entry.timeoutId)
    hoverSeekStateRef.current.delete(videoId)
  }, [])

  // Kills every hover seek + cancels the pending rAF. Called from any
  // committed write path so the committed pipeline always owns currentTime
  // alone. Also flips the public hover-active bit so the ghost cursor
  // unmounts.
  const cancelInFlightHoverSeeks = useCallback(() => {
    hoverSeekStateRef.current.forEach((entry) => {
      window.clearTimeout(entry.timeoutId)
    })
    hoverSeekStateRef.current.clear()
    if (hoverFrameRef.current !== null) {
      cancelAnimationFrame(hoverFrameRef.current)
      hoverFrameRef.current = null
    }
    if (hoverPreviewActiveRef.current) {
      hoverPreviewActiveRef.current = false
      setIsHoverPreviewActive(false)
    }
    hoverPreviewTimeRef.current = null
  }, [])

  // Explicit sync. Visibility flips first, then every element is seeked to the
  // target, then visible elements are played or paused per shouldPlay.
  //
  // Every committed write goes through here, so it's also the single place
  // where the hover pipeline gets cancelled. Hover state is cleared *before*
  // the seek loop so the new committed-time `seeked` events route through
  // the committed-only branch of `onTimelineVideoSeeked`.
  const syncTimelineMedia = useCallback(
    (time: number, shouldPlay: boolean) => {
      const hadHover = hoverPreviewActiveRef.current
      cancelInFlightHoverSeeks()
      if (hadHover) notifyHoverTimeSubscribers(null)

      const currentVisibleIds = timelineVisibleVideoIdsRef.current
      const nextVisibleIds = syncTimelineVisibility(time)

      currentVisibleIds.forEach((videoId) => {
        if (nextVisibleIds.has(videoId)) return
        const element = timelineVideoElementsRef.current.get(videoId)
        if (element && !element.paused) element.pause()
      })

      nextVisibleIds.forEach((videoId) => {
        const element = timelineVideoElementsRef.current.get(videoId)
        if (!element) return
        seekElementToTimeline(videoId, element, time, shouldPlay)
      })
    },
    [
      cancelInFlightHoverSeeks,
      notifyHoverTimeSubscribers,
      seekElementToTimeline,
      syncTimelineVisibility,
    ]
  )

  // Per-frame sync during playback. Hands the master video alone (it's already
  // the clock) and only drift-corrects secondary videos. Newly-active clips
  // still get a precise seek so they enter at the right frame.
  const syncTimelineMediaPlayback = useCallback(
    (time: number, masterVideoId: string | null) => {
      const currentVisibleIds = timelineVisibleVideoIdsRef.current
      const nextVisibleIds = syncTimelineVisibility(time)

      currentVisibleIds.forEach((videoId) => {
        if (nextVisibleIds.has(videoId)) return
        const element = timelineVideoElementsRef.current.get(videoId)
        if (element && !element.paused) element.pause()
      })

      nextVisibleIds.forEach((videoId) => {
        const element = timelineVideoElementsRef.current.get(videoId)
        if (!element) return

        if (!currentVisibleIds.has(videoId)) {
          seekElementToTimeline(videoId, element, time, true)
          return
        }

        if (videoId === masterVideoId) {
          if (element.playbackRate !== 1) element.playbackRate = 1
          safePlayElement(element)
          return
        }

        driftCorrectElement(videoId, element, time)
      })
    },
    [
      driftCorrectElement,
      safePlayElement,
      seekElementToTimeline,
      syncTimelineVisibility,
    ]
  )

  // The master video is the playing element whose clip currently covers the
  // playhead; its native currentTime drives the timeline cursor so naturally
  // played frames are never yanked back. Prefer the primary audio video so
  // the audible source stays in sync with the cursor.
  const getMasterPlaybackVideoId = useCallback((time: number) => {
    const visibleIds = timelineVisibleVideoIdsRef.current
    if (visibleIds.size === 0) return null

    const primaryId = primaryAudioVideoIdRef.current
    if (primaryId && visibleIds.has(primaryId)) {
      const clip = timelineClipByVideoIdRef.current.get(primaryId)
      if (clip && time >= clip.start && time < clip.end) return primaryId
    }

    for (const videoId of visibleIds) {
      const clip = timelineClipByVideoIdRef.current.get(videoId)
      if (clip && time >= clip.start && time < clip.end) return videoId
    }
    return null
  }, [])

  // Issues exactly one hover-driven seek for one video element. The caller
  // must have already confirmed there is no in-flight entry for this id. A
  // safety timeout force-clears the entry if `seeked` never fires (rare; e.g.
  // when the browser coalesces a new currentTime write that lands on the same
  // frame).
  const issueHoverSeek = useCallback(
    (
      videoId: string,
      element: HTMLVideoElement,
      targetSourceTime: number,
      hoverTimelineTime: number
    ) => {
      const timeoutId = window.setTimeout(() => {
        const stalled = hoverSeekStateRef.current.get(videoId)
        if (!stalled) return
        hoverSeekStateRef.current.delete(videoId)
        const layer = timelineCanvasNodesRef.current.get(videoId)?.getLayer()
        layer?.batchDraw()
      }, 250)
      hoverSeekStateRef.current.set(videoId, {
        targetSourceTime,
        hoverTimelineTime,
        issuedAt: performance.now(),
        timeoutId,
      })
      safeSeekElement(element, targetSourceTime)
    },
    [safeSeekElement]
  )

  // One hover frame: bring visibility up to date, pause any element that just
  // exited the visible set, then schedule one in-flight seek per visible
  // element that's off-target. Self-rescheduling is intentionally avoided —
  // the rAF body runs once per `updateHoverPreviewTime` and the
  // `onTimelineVideoSeeked` handler reissues if the hover ref has moved past
  // the in-flight target.
  const runHoverTick = useCallback(() => {
    hoverFrameRef.current = null
    if (!hoverPreviewActiveRef.current) return
    const time = hoverPreviewTimeRef.current
    if (time === null) return

    const previousVisibleIds = timelineVisibleVideoIdsRef.current
    const nextVisibleIds = syncTimelineVisibility(time)

    previousVisibleIds.forEach((videoId) => {
      if (nextVisibleIds.has(videoId)) return
      clearHoverEntry(videoId)
      const element = timelineVideoElementsRef.current.get(videoId)
      if (element && !element.paused) element.pause()
    })

    nextVisibleIds.forEach((videoId) => {
      const element = timelineVideoElementsRef.current.get(videoId)
      if (!element) return
      const frame = resolveTimelineFrame(videoId, time)
      if (!frame || !frame.active) {
        clearHoverEntry(videoId)
        if (!element.paused) element.pause()
        return
      }

      const seekableTime = getSeekableTimelineSourceTime(
        element,
        frame.sourceTime,
        frame.sourceDuration
      )
      if (!element.paused) element.pause()
      if (
        Math.abs(element.currentTime - seekableTime) <=
        TIMELINE_FORCE_SEEK_EPSILON_SECONDS
      ) {
        clearHoverEntry(videoId)
        return
      }
      if (hoverSeekStateRef.current.has(videoId)) return
      issueHoverSeek(videoId, element, seekableTime, time)
    })
  }, [
    clearHoverEntry,
    getSeekableTimelineSourceTime,
    issueHoverSeek,
    resolveTimelineFrame,
    syncTimelineVisibility,
  ])

  const scheduleHoverTick = useCallback(() => {
    if (hoverFrameRef.current !== null) return
    hoverFrameRef.current = requestAnimationFrame(() => {
      runHoverTick()
    })
  }, [runHoverTick])

  // Single entrypoint for the consumer. Honoured only while paused; null
  // input snaps the canvas back to the committed frame.
  const updateHoverPreviewTime = useCallback(
    (time: number | null) => {
      if (isTimelinePlayingRef.current) return

      if (time === null) {
        if (!hoverPreviewActiveRef.current) return
        cancelInFlightHoverSeeks()
        notifyHoverTimeSubscribers(null)
        // syncTimelineMedia also calls cancelInFlightHoverSeeks but it's
        // already a no-op by this point; the syncTimelineMedia call is what
        // re-flips visibility back to committed and seeks every visible
        // element to the committed frame.
        syncTimelineMedia(timelineTimeRef.current, false)
        return
      }

      const clamped = clampTimelineTime(time, timelineDurationRef.current)
      hoverPreviewTimeRef.current = clamped
      if (!hoverPreviewActiveRef.current) {
        hoverPreviewActiveRef.current = true
        setIsHoverPreviewActive(true)
      }
      notifyHoverTimeSubscribers(clamped)
      scheduleHoverTick()
    },
    [
      cancelInFlightHoverSeeks,
      notifyHoverTimeSubscribers,
      scheduleHoverTick,
      syncTimelineMedia,
    ]
  )

  const subscribeHoverTime = useCallback((subscriber: HoverTimeSubscriber) => {
    hoverTimeSubscribersRef.current.add(subscriber)
    subscriber(hoverPreviewTimeRef.current)
    return () => {
      hoverTimeSubscribersRef.current.delete(subscriber)
    }
  }, [])

  // Single seek-completion gate. The canvas-video-node hands every `seeked`
  // event through here and we decide whether it counts as a valid hover paint
  // or a committed paint. Either way the redrawLayer callback is what
  // actually triggers the Konva batchDraw, so the canvas component stays
  // unaware of hover vs committed.
  const onTimelineVideoSeeked = useCallback(
    (
      videoId: string,
      element: HTMLVideoElement,
      redrawLayer: () => void
    ) => {
      const entry = hoverSeekStateRef.current.get(videoId)
      if (entry) {
        window.clearTimeout(entry.timeoutId)
        hoverSeekStateRef.current.delete(videoId)
        const matched =
          Math.abs(element.currentTime - entry.targetSourceTime) <=
          TIMELINE_FORCE_SEEK_EPSILON_SECONDS
        if (!matched) return // Stale hover seek — drop the paint.
        redrawLayer()

        // If the hover ref has moved past this entry's target, reissue
        // immediately so the canvas keeps catching up without waiting for
        // the next rAF.
        if (!hoverPreviewActiveRef.current) return
        const liveHoverTime = hoverPreviewTimeRef.current
        if (liveHoverTime === null || liveHoverTime === entry.hoverTimelineTime) {
          return
        }
        const frame = resolveTimelineFrame(videoId, liveHoverTime)
        if (!frame || !frame.active) return
        const liveTarget = getSeekableTimelineSourceTime(
          element,
          frame.sourceTime,
          frame.sourceDuration
        )
        if (
          Math.abs(element.currentTime - liveTarget) <=
          TIMELINE_FORCE_SEEK_EPSILON_SECONDS
        ) {
          return
        }
        issueHoverSeek(videoId, element, liveTarget, liveHoverTime)
        return
      }

      if (shouldDrawTimelineVideoFrame(videoId, element)) {
        redrawLayer()
      }
    },
    [
      getSeekableTimelineSourceTime,
      issueHoverSeek,
      resolveTimelineFrame,
      shouldDrawTimelineVideoFrame,
    ]
  )

  // If the page goes hidden mid-hover, drop the preview state entirely so
  // queued seeked events don't paint stale frames after the user returns.
  useEffect(() => {
    if (typeof document === "undefined") return
    const handleVisibilityChange = () => {
      if (!document.hidden) return
      if (!hoverPreviewActiveRef.current) return
      cancelInFlightHoverSeeks()
      notifyHoverTimeSubscribers(null)
      syncTimelineMedia(timelineTimeRef.current, isTimelinePlayingRef.current)
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [cancelInFlightHoverSeeks, notifyHoverTimeSubscribers, syncTimelineMedia])

  useEffect(() => {
    const clampedTime = clampTimelineTime(
      timelineTimeRef.current,
      timelineDuration
    )
    if (clampedTime === timelineTimeRef.current) return

    timelineTimeRef.current = clampedTime
    setTimelineTimeState(clampedTime)
    notifyTimelineSubscribers(clampedTime)
    syncTimelineMedia(clampedTime, isTimelinePlayingRef.current)
  }, [notifyTimelineSubscribers, syncTimelineMedia, timelineDuration])

  const setTimelineTime = useCallback(
    (time: number) => {
      const clampedTime = clampTimelineTime(time, timelineDurationRef.current)
      if (
        Math.abs(timelineTimeRef.current - clampedTime) <=
        TIMELINE_FORCE_SEEK_EPSILON_SECONDS
      ) {
        syncTimelineMedia(clampedTime, isTimelinePlayingRef.current)
        return
      }

      timelineTimeRef.current = clampedTime
      setTimelineTimeState(clampedTime)
      notifyTimelineSubscribers(clampedTime)
      syncTimelineMedia(clampedTime, isTimelinePlayingRef.current)
    },
    [notifyTimelineSubscribers, syncTimelineMedia]
  )

  const pauseTimeline = useCallback(() => {
    if (timelinePlaybackFrameRef.current !== null) {
      cancelAnimationFrame(timelinePlaybackFrameRef.current)
      timelinePlaybackFrameRef.current = null
    }

    timelinePreviousFrameMsRef.current = null
    isTimelinePlayingRef.current = false
    setIsTimelinePlaying(false)
    const time = timelineTimeRef.current
    setTimelineTimeState(time)
    notifyTimelineSubscribers(time)
    syncTimelineMedia(time, false)
  }, [notifyTimelineSubscribers, syncTimelineMedia])

  const playTimeline = useCallback(() => {
    if (isTimelinePlayingRef.current) return

    const duration = timelineDurationRef.current
    const startTime =
      timelineTimeRef.current >= duration
        ? 0
        : clampTimelineTime(timelineTimeRef.current, duration)

    timelineTimeRef.current = startTime
    setTimelineTimeState(startTime)
    notifyTimelineSubscribers(startTime)
    isTimelinePlayingRef.current = true
    setIsTimelinePlaying(true)
    timelinePreviousFrameMsRef.current = null
    timelineLastStateCommitMsRef.current = 0
    syncTimelineMedia(startTime, true)

    const tick = (now: number) => {
      if (!isTimelinePlayingRef.current) return

      const previousMs = timelinePreviousFrameMsRef.current
      const elapsedSeconds =
        previousMs == null
          ? 0
          : Math.min(1, Math.max(0, now - previousMs) / 1000)
      timelinePreviousFrameMsRef.current = now

      // Prefer the master video's native currentTime as the clock; this keeps
      // the cursor in lockstep with the actual frames being painted and stops
      // rAF jitter from spawning corrective seeks.
      const masterId = getMasterPlaybackVideoId(timelineTimeRef.current)
      let nextTime = timelineTimeRef.current + elapsedSeconds
      if (masterId) {
        const masterElement = timelineVideoElementsRef.current.get(masterId)
        const masterClip = timelineClipByVideoIdRef.current.get(masterId)
        if (
          masterElement &&
          masterClip &&
          !masterElement.paused &&
          Number.isFinite(masterElement.currentTime)
        ) {
          const projected =
            masterClip.start + (masterElement.currentTime - masterClip.sourceIn)
          // Only trust the master clock when it's near the rAF projection; a
          // wild jump (e.g., after a tab-visibility gap) keeps the rAF
          // estimate so the cursor doesn't snap unexpectedly.
          if (Math.abs(projected - nextTime) <= TIMELINE_PLAYBACK_DRIFT_SECONDS) {
            nextTime = projected
          }
        }
      }
      nextTime = clampTimelineTime(nextTime, timelineDurationRef.current)

      timelineTimeRef.current = nextTime
      notifyTimelineSubscribers(nextTime)
      syncTimelineMediaPlayback(nextTime, masterId)

      if (
        now - timelineLastStateCommitMsRef.current >=
        TIMELINE_STATE_COMMIT_INTERVAL_MS
      ) {
        timelineLastStateCommitMsRef.current = now
        setTimelineTimeState(nextTime)
      }

      if (nextTime >= timelineDurationRef.current) {
        isTimelinePlayingRef.current = false
        setIsTimelinePlaying(false)
        setTimelineTimeState(nextTime)
        syncTimelineMedia(nextTime, false)
        timelinePlaybackFrameRef.current = null
        timelinePreviousFrameMsRef.current = null
        return
      }

      timelinePlaybackFrameRef.current = requestAnimationFrame(tick)
    }

    timelinePlaybackFrameRef.current = requestAnimationFrame(tick)
  }, [
    getMasterPlaybackVideoId,
    notifyTimelineSubscribers,
    syncTimelineMedia,
    syncTimelineMediaPlayback,
  ])

  const toggleTimelinePlayback = useCallback(() => {
    if (isTimelinePlayingRef.current) {
      pauseTimeline()
      return
    }

    playTimeline()
  }, [pauseTimeline, playTimeline])

  const zoomTimelineIn = useCallback(() => {
    setIsTimelineFit(false)
    setTimelineZoom((current) =>
      Math.min(TIMELINE_ZOOM_MAX, current * TIMELINE_ZOOM_STEP)
    )
  }, [])

  const zoomTimelineOut = useCallback(() => {
    setIsTimelineFit(false)
    setTimelineZoom((current) =>
      Math.max(TIMELINE_ZOOM_MIN, current / TIMELINE_ZOOM_STEP)
    )
  }, [])

  const fitTimelineToWidth = useCallback(() => {
    setIsTimelineFit(true)
    setTimelineFitRequestId((requestId) => requestId + 1)
  }, [])

  const registerTimelineVideoElement = useCallback(
    (id: string, element: HTMLVideoElement | null) => {
      if (element) {
        timelineVideoElementsRef.current.set(id, element)
        seekElementToTimeline(
          id,
          element,
          timelineTimeRef.current,
          isTimelinePlayingRef.current
        )
        return
      }

      timelineVideoElementsRef.current.delete(id)
    },
    [seekElementToTimeline]
  )

  const registerTimelineCanvasNode = useCallback(
    (id: string, node: Konva.Image | null) => {
      timelineVisibilityWindowRef.current = null

      if (node) {
        timelineCanvasNodesRef.current.set(id, node)
        setTimelineCanvasNodeVisibility(
          id,
          resolveTimelineFrame(id, timelineTimeRef.current)?.active ?? false
        )
        syncTimelineVisibility(timelineTimeRef.current)
        return
      }

      timelineCanvasNodesRef.current.delete(id)
      const nextVisibleIds = new Set(timelineVisibleVideoIdsRef.current)
      if (nextVisibleIds.delete(id)) {
        commitTimelineVisibleVideoIds(nextVisibleIds)
      }
    },
    [
      commitTimelineVisibleVideoIds,
      resolveTimelineFrame,
      setTimelineCanvasNodeVisibility,
      syncTimelineVisibility,
    ]
  )

  const subscribeTimelineTicks = useCallback(
    (subscriber: TimelineTickSubscriber) => {
      timelineTickSubscribersRef.current.add(subscriber)
      subscriber(timelineTimeRef.current)

      return () => {
        timelineTickSubscribersRef.current.delete(subscriber)
      }
    },
    []
  )

  useEffect(() => {
    syncTimelineMedia(timelineTimeRef.current, isTimelinePlayingRef.current)
  }, [syncTimelineMedia, timelineClips, videos])

  const setViewportSize = useCallback((size: CanvasSize) => {
    const nextSize = {
      width: Math.max(0, Math.floor(size.width)),
      height: Math.max(0, Math.floor(size.height)),
    }

    if (
      viewportSizeRef.current.width === nextSize.width &&
      viewportSizeRef.current.height === nextSize.height
    ) {
      return
    }

    setViewportSizeState((current) =>
      current.width === nextSize.width && current.height === nextSize.height
        ? current
        : nextSize
    )

    viewportSizeRef.current = nextSize
    if (!hasCustomViewRef.current) {
      const fitTransform = getFitViewTransform(nextSize, artboardRef.current)
      viewTransformRef.current = fitTransform
      setViewTransformState(fitTransform)
      return
    }

    const clampedTransform = clampWorkspaceView(
      viewTransformRef.current,
      nextSize,
      artboardRef.current
    )
    viewTransformRef.current = clampedTransform
    setViewTransformState(clampedTransform)
  }, [])

  const setViewTransform = useCallback((transform: ViewTransform) => {
    hasCustomViewRef.current = true
    const clampedTransform = clampWorkspaceView(
      transform,
      viewportSizeRef.current,
      artboardRef.current
    )
    viewTransformRef.current = clampedTransform
    setViewTransformState((current) =>
      current.scale === clampedTransform.scale &&
      current.x === clampedTransform.x &&
      current.y === clampedTransform.y
        ? current
        : clampedTransform
    )
  }, [])

  const fitArtboardToViewport = useCallback(() => {
    hasCustomViewRef.current = false
    const fitTransform = getFitViewTransform(
      viewportSizeRef.current,
      artboardRef.current
    )
    viewTransformRef.current = fitTransform
    setViewTransformState(fitTransform)
  }, [])

  const setArtboardPreset = useCallback(
    (id: ArtboardPresetId) => {
      let nextArtboard: EditorArtboard
      if (id === AUTO_ARTBOARD_PRESET_ID) {
        const auto = resolveAutoArtboard(sourceVideoDimsRef.current)
        nextArtboard = {
          presetId: AUTO_ARTBOARD_PRESET_ID,
          width: auto.width,
          height: auto.height,
        }
      } else {
        const preset = getArtboardPreset(id)
        nextArtboard = {
          presetId: preset.id,
          width: preset.width,
          height: preset.height,
        }
      }

      const prevArtboard = artboardRef.current
      artboardRef.current = nextArtboard
      hasCustomViewRef.current = false
      setArtboard(nextArtboard)
      const fitTransform = getFitViewTransform(
        viewportSizeRef.current,
        nextArtboard
      )
      viewTransformRef.current = fitTransform
      setViewTransformState(fitTransform)

      if (
        prevArtboard.width === nextArtboard.width &&
        prevArtboard.height === nextArtboard.height
      ) {
        return
      }

      setVideos((current) => {
        let didChange = false
        const nextVideos = current.map((video) => {
          const adjusted = relayoutVideoForArtboard(
            video,
            prevArtboard,
            nextArtboard
          )
          if (adjusted !== video) didChange = true
          return adjusted
        })
        if (!didChange) return current
        commitVideosRef(nextVideos)
        return nextVideos
      })
    },
    [commitVideosRef]
  )

  const moveTimelineClip = useCallback(
    (id: string, start: number) => {
      let didChange = false
      setTimelineClips((current) => {
        const nextClips = current.map((clip) => {
          if (clip.id !== id) return clip

          const visibleDuration = Math.max(
            TIMELINE_MIN_CLIP_DURATION_SECONDS,
            clip.end - clip.start
          )
          const nextStart = Math.max(0, Number.isFinite(start) ? start : 0)
          const nextClip = {
            ...clip,
            start: nextStart,
            end: nextStart + visibleDuration,
          }

          const changed =
            nextClip.start !== clip.start || nextClip.end !== clip.end
          if (changed) didChange = true

          return changed ? nextClip : clip
        })

        if (!didChange) return current
        commitTimelineClipsRef(nextClips)
        return nextClips
      })
      if (didChange) {
        syncTimelineMedia(
          timelineTimeRef.current,
          isTimelinePlayingRef.current
        )
      }
    },
    [commitTimelineClipsRef, syncTimelineMedia]
  )

  const resizeTimelineClip = useCallback(
    (
      id: string,
      start: number,
      end: number,
      direction: TimelineResizeDirection
    ) => {
      let didChange = false
      setTimelineClips((current) => {
        const nextClips = current.map((clip) => {
          if (clip.id !== id) return clip

          const video = videoByIdRef.current.get(clip.videoId)
          const sourceDuration = video
            ? getVideoDurationSeconds(video)
            : Math.max(clip.sourceOut, TIMELINE_MIN_CLIP_DURATION_SECONDS)
          let nextClip = clip

          if (direction === "left") {
            const desiredDuration = Math.max(
              TIMELINE_MIN_CLIP_DURATION_SECONDS,
              clip.end - start
            )
            const maxDuration = Math.max(
              TIMELINE_MIN_CLIP_DURATION_SECONDS,
              clip.sourceOut
            )
            const duration = Math.min(desiredDuration, maxDuration)
            nextClip = {
              ...clip,
              start: clip.end - duration,
              sourceIn: clip.sourceOut - duration,
            }
          } else {
            const desiredDuration = Math.max(
              TIMELINE_MIN_CLIP_DURATION_SECONDS,
              end - clip.start
            )
            const maxDuration = Math.max(
              TIMELINE_MIN_CLIP_DURATION_SECONDS,
              sourceDuration - clip.sourceIn
            )
            const duration = Math.min(desiredDuration, maxDuration)
            nextClip = {
              ...clip,
              end: clip.start + duration,
              sourceOut: clip.sourceIn + duration,
            }
          }

          const changed =
            nextClip.start !== clip.start ||
            nextClip.end !== clip.end ||
            nextClip.sourceIn !== clip.sourceIn ||
            nextClip.sourceOut !== clip.sourceOut
          if (changed) didChange = true

          return changed ? nextClip : clip
        })

        if (!didChange) return current
        commitTimelineClipsRef(nextClips)
        return nextClips
      })
      if (didChange) {
        syncTimelineMedia(
          timelineTimeRef.current,
          isTimelinePlayingRef.current
        )
      }
    },
    [commitTimelineClipsRef, syncTimelineMedia]
  )

  const addVideoFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("video/")) {
        setImportError("Choose a video file to add it to the canvas.")
        return
      }

      const objectUrl = URL.createObjectURL(file)
      objectUrlsRef.current.add(objectUrl)

      try {
        const metadata = await readVideoMetadata(objectUrl)
        const placement = getCoverVideoPlacement(metadata, artboardRef.current)
        const id = createCanvasId()
        const item: CanvasVideoItem = {
          id,
          fileName: file.name,
          objectUrl,
          intrinsicWidth: metadata.width,
          intrinsicHeight: metadata.height,
          durationMs: metadata.durationMs,
          rotation: 0,
          locked: false,
          cropShape: "rect",
          role: "media",
          ...placement,
        }

        setVideos((current) => {
          const nextVideos = [...current, item]
          commitVideosRef(nextVideos)
          return nextVideos
        })
        setTimelineClips((current) => {
          const clip = createTimelineClip(item)
          const nextClips = [...current, clip]
          commitTimelineClipsRef(nextClips)
          return nextClips
        })
        selectedItemIdRef.current = id
        setSelectedItemId(id)
        setImportError(null)
      } catch (error) {
        objectUrlsRef.current.delete(objectUrl)
        URL.revokeObjectURL(objectUrl)
        setImportError(
          error instanceof Error
            ? error.message
            : "The selected video could not be loaded."
        )
      }
    },
    [commitTimelineClipsRef, commitVideosRef]
  )

  const addRemoteVideo = useCallback(
    async (input: AddRemoteVideoInput): Promise<string | null> => {
      if (
        !input.url ||
        !Number.isFinite(input.intrinsicWidth) ||
        !Number.isFinite(input.intrinsicHeight) ||
        input.intrinsicWidth <= 0 ||
        input.intrinsicHeight <= 0
      ) {
        return null
      }

      const desiredId = input.id ?? createCanvasId()
      if (videosRef.current.some((video) => video.id === desiredId)) {
        return desiredId
      }

      const inputDurationMs =
        typeof input.durationMs === "number" &&
        Number.isFinite(input.durationMs)
          ? input.durationMs
          : 0
      let durationMs = Math.max(0, inputDurationMs)

      if (durationMs <= 0) {
        try {
          const metadata = await readVideoMetadata(input.url)
          if (input.shouldAbort?.()) return null
          durationMs = metadata.durationMs
        } catch {
          if (input.shouldAbort?.()) return null
          durationMs = 0
        }
      }

      if (input.shouldAbort?.()) return null

      if (videosRef.current.some((video) => video.id === desiredId)) {
        return null
      }

      const artboardSize = artboardRef.current
      const cropShape: CanvasVideoCropShape =
        input.cropShape ?? (input.role === "camera" ? "circle" : "rect")

      let placement: { x: number; y: number; width: number; height: number }
      if (input.role === "camera") {
        const width = input.placement?.width ?? CAMERA_DEFAULT_DIAMETER
        const height = input.placement?.height ?? CAMERA_DEFAULT_DIAMETER
        const x =
          input.placement?.x ??
          artboardSize.width - width - CAMERA_DEFAULT_MARGIN
        const y =
          input.placement?.y ??
          artboardSize.height - height - CAMERA_DEFAULT_MARGIN
        placement = { x, y, width, height }
      } else {
        const cover = getCoverVideoPlacement(
          { width: input.intrinsicWidth, height: input.intrinsicHeight },
          artboardSize
        )
        placement = {
          x: input.placement?.x ?? cover.x,
          y: input.placement?.y ?? cover.y,
          width: input.placement?.width ?? cover.width,
          height: input.placement?.height ?? cover.height,
        }
      }

      const role: CanvasVideoRole =
        input.role === "screen" || input.role === "camera"
          ? input.role
          : "media"

      const item: CanvasVideoItem = {
        id: desiredId,
        fileName: input.fileName,
        objectUrl: input.url,
        intrinsicWidth: input.intrinsicWidth,
        intrinsicHeight: input.intrinsicHeight,
        durationMs,
        rotation: 0,
        locked: false,
        cropShape,
        role,
        ...placement,
      }

      setVideos((current) => {
        if (current.some((video) => video.id === desiredId)) return current
        const nextVideos = [...current, item]
        commitVideosRef(nextVideos)
        return nextVideos
      })
      setTimelineClips((current) => {
        if (current.some((clip) => clip.videoId === desiredId)) return current
        const nextClips = [...current, createTimelineClip(item)]
        commitTimelineClipsRef(nextClips)
        return nextClips
      })
      return desiredId
    },
    [commitTimelineClipsRef, commitVideosRef]
  )

  const selectItem = useCallback((id: string | null) => {
    selectedItemIdRef.current = id
    setSelectedItemId((current) => (current === id ? current : id))
  }, [])

  const updateVideoTransform = useCallback(
    (id: string, patch: CanvasVideoTransformPatch) => {
      setVideos((current) => {
        let didChange = false
        const nextVideos = current.map((video) => {
          if (video.id !== id) return video
          if (video.locked) return video

          const nextVideo = { ...video, ...patch }
          didChange =
            nextVideo.x !== video.x ||
            nextVideo.y !== video.y ||
            nextVideo.width !== video.width ||
            nextVideo.height !== video.height ||
            nextVideo.rotation !== video.rotation

          return didChange ? nextVideo : video
        })

        if (!didChange) return current

        commitVideosRef(nextVideos)
        return nextVideos
      })
    },
    [commitVideosRef]
  )

  const setVideoLocked = useCallback(
    (id: string, locked: boolean) => {
      setVideos((current) => {
        let didChange = false
        const nextVideos = current.map((video) => {
          if (video.id !== id || video.locked === locked) return video

          didChange = true
          return {
            ...video,
            locked,
          }
        })

        if (!didChange) return current

        commitVideosRef(nextVideos)
        return nextVideos
      })
    },
    [commitVideosRef]
  )

  const duplicateVideo = useCallback(
    (id: string) => {
      const currentVideos = videosRef.current
      const selectedIndex = currentVideos.findIndex((video) => video.id === id)
      const selectedVideo = currentVideos[selectedIndex]
      if (!selectedVideo) return

      const duplicate: CanvasVideoItem = {
        ...selectedVideo,
        id: createCanvasId(),
        x: selectedVideo.x + DUPLICATED_VIDEO_OFFSET,
        y: selectedVideo.y + DUPLICATED_VIDEO_OFFSET,
      }
      const nextVideos = [
        ...currentVideos.slice(0, selectedIndex + 1),
        duplicate,
        ...currentVideos.slice(selectedIndex + 1),
      ]

      commitVideosRef(nextVideos)
      selectedItemIdRef.current = duplicate.id
      const selectedClip = timelineClipsRef.current.find(
        (clip) => clip.videoId === selectedVideo.id
      )
      const duplicateClip: CanvasTimelineClip = selectedClip
        ? {
            ...selectedClip,
            id: createTimelineClipId(duplicate.id),
            videoId: duplicate.id,
          }
        : createTimelineClip(duplicate)
      const nextClips = [...timelineClipsRef.current, duplicateClip]
      commitTimelineClipsRef(nextClips)
      setVideos(nextVideos)
      setTimelineClips(nextClips)
      setSelectedItemId(duplicate.id)
    },
    [commitTimelineClipsRef, commitVideosRef]
  )

  const deleteVideo = useCallback(
    (id: string) => {
      const currentVideos = videosRef.current
      const deletedVideo = currentVideos.find((video) => video.id === id)
      if (!deletedVideo) return

      const nextVideos = currentVideos.filter((video) => video.id !== id)
      const objectUrlStillUsed = nextVideos.some(
        (video) => video.objectUrl === deletedVideo.objectUrl
      )

      if (!objectUrlStillUsed) {
        objectUrlsRef.current.delete(deletedVideo.objectUrl)
        URL.revokeObjectURL(deletedVideo.objectUrl)
      }

      commitVideosRef(nextVideos)
      const nextClips = timelineClipsRef.current.filter(
        (clip) => clip.videoId !== id
      )
      commitTimelineClipsRef(nextClips)
      setVideos(nextVideos)
      setTimelineClips(nextClips)

      if (selectedItemIdRef.current === id) {
        selectedItemIdRef.current = null
        setSelectedItemId(null)
      }
    },
    [commitTimelineClipsRef, commitVideosRef]
  )

  const selectedVideo = useMemo(
    () => videos.find((video) => video.id === selectedItemId) ?? null,
    [selectedItemId, videos]
  )

  const selectedTimelineClip = useMemo(
    () =>
      selectedItemId
        ? (timelineClips.find((clip) => clip.videoId === selectedItemId) ??
          null)
        : null,
    [selectedItemId, timelineClips]
  )

  const mediaValue = useMemo<EditorCanvasMediaContextValue>(
    () => ({
      videos,
      selectedItemId,
      selectedVideo,
      importError,
    }),
    [importError, selectedItemId, selectedVideo, videos]
  )

  const artboardValue = useMemo<EditorCanvasArtboardContextValue>(
    () => ({
      artboard,
    }),
    [artboard]
  )

  const viewValue = useMemo<EditorCanvasViewContextValue>(
    () => ({
      viewportSize,
      viewTransform,
    }),
    [viewTransform, viewportSize]
  )

  const timelineValue = useMemo<EditorCanvasTimelineContextValue>(
    () => ({
      timelineClips,
      selectedTimelineClip,
      timelineTime,
      timelineDuration,
      timelineZoom,
      isTimelineFit,
      timelineFitRequestId,
      timelineVisibleVideoIds,
      isTimelinePlaying,
      isHoverPreviewActive,
      primaryAudioVideoId,
    }),
    [
      isHoverPreviewActive,
      isTimelineFit,
      isTimelinePlaying,
      primaryAudioVideoId,
      selectedTimelineClip,
      timelineFitRequestId,
      timelineVisibleVideoIds,
      timelineClips,
      timelineDuration,
      timelineTime,
      timelineZoom,
    ]
  )

  const actionsValue = useMemo<EditorCanvasActionsContextValue>(
    () => ({
      addVideoFile,
      addRemoteVideo,
      selectItem,
      updateVideoTransform,
      setVideoLocked,
      duplicateVideo,
      deleteVideo,
      setArtboardPreset,
      setViewportSize,
      setViewTransform,
      fitArtboardToViewport,
    }),
    [
      addVideoFile,
      addRemoteVideo,
      selectItem,
      updateVideoTransform,
      setVideoLocked,
      duplicateVideo,
      deleteVideo,
      setArtboardPreset,
      setViewportSize,
      setViewTransform,
      fitArtboardToViewport,
    ]
  )

  const timelineActionsValue = useMemo<EditorCanvasTimelineActionsContextValue>(
    () => ({
      registerTimelineVideoElement,
      registerTimelineCanvasNode,
      onTimelineVideoSeeked,
      updateHoverPreviewTime,
      subscribeHoverTime,
      setTimelineTime,
      playTimeline,
      pauseTimeline,
      toggleTimelinePlayback,
      zoomTimelineIn,
      zoomTimelineOut,
      fitTimelineToWidth,
      moveTimelineClip,
      resizeTimelineClip,
      subscribeTimelineTicks,
    }),
    [
      fitTimelineToWidth,
      registerTimelineCanvasNode,
      registerTimelineVideoElement,
      onTimelineVideoSeeked,
      updateHoverPreviewTime,
      subscribeHoverTime,
      setTimelineTime,
      playTimeline,
      pauseTimeline,
      toggleTimelinePlayback,
      zoomTimelineIn,
      zoomTimelineOut,
      moveTimelineClip,
      resizeTimelineClip,
      subscribeTimelineTicks,
    ]
  )

  const { project } = useProject()

  useEffect(() => {
    if (!project) return
    if (hydratedProjectIdRef.current === project.id) return

    const findAsset = (role: ProjectAsset["role"]) =>
      project.assets.find((asset) => asset.role === role) ?? null

    const screenAsset = findAsset("screen")
    const cameraAsset = findAsset("camera")

    if (!screenAsset && !cameraAsset) return

    if (
      hydratedProjectIdRef.current !== null &&
      hydratedProjectIdRef.current !== project.id
    ) {
      const previousBlobs = Array.from(objectUrlsRef.current)
      objectUrlsRef.current.clear()
      for (const url of previousBlobs) URL.revokeObjectURL(url)
      if (timelinePlaybackFrameRef.current !== null) {
        cancelAnimationFrame(timelinePlaybackFrameRef.current)
        timelinePlaybackFrameRef.current = null
      }
      commitVideosRef([])
      commitTimelineClipsRef([])
      timelineCanvasNodesRef.current.forEach((node) => {
        node.visible(false)
        node.listening(false)
        node.getLayer()?.batchDraw()
      })
      commitTimelineVisibleVideoIds(new Set())
      timelineTimeRef.current = 0
      isTimelinePlayingRef.current = false
      selectedItemIdRef.current = null
      setVideos([])
      setTimelineClips([])
      setTimelineTimeState(0)
      setIsTimelinePlaying(false)
      setSelectedItemId(null)
    }

    if (
      screenAsset &&
      typeof screenAsset.width === "number" &&
      typeof screenAsset.height === "number" &&
      screenAsset.width > 0 &&
      screenAsset.height > 0
    ) {
      sourceVideoDimsRef.current = {
        width: screenAsset.width,
        height: screenAsset.height,
      }

      // Display captures inherit the source's aspect via the Auto preset so
      // the recording fills the artboard with no letterboxing. Window /
      // region / application captures fall back to the Wide 16:9 preset —
      // those source shapes are arbitrary and would otherwise produce an
      // odd-shaped artboard.
      const useAuto = project.recordingType === "display"
      const nextArtboard: EditorArtboard = useAuto
        ? (() => {
            const auto = resolveAutoArtboard(sourceVideoDimsRef.current)
            return {
              presetId: AUTO_ARTBOARD_PRESET_ID,
              width: auto.width,
              height: auto.height,
            }
          })()
        : (() => {
            const preset = getArtboardPreset(DEFAULT_ARTBOARD_PRESET_ID)
            return {
              presetId: preset.id,
              width: preset.width,
              height: preset.height,
            }
          })()
      artboardRef.current = nextArtboard
      hasCustomViewRef.current = false
      setArtboard(nextArtboard)
      const fit = getFitViewTransform(viewportSizeRef.current, nextArtboard)
      viewTransformRef.current = fit
      setViewTransformState(fit)
    }

    hydrationGenerationRef.current += 1
    const hydrationGeneration = hydrationGenerationRef.current
    const shouldAbort = () =>
      hydrationGenerationRef.current !== hydrationGeneration

    if (
      screenAsset &&
      typeof screenAsset.width === "number" &&
      typeof screenAsset.height === "number" &&
      screenAsset.width > 0 &&
      screenAsset.height > 0
    ) {
      void addRemoteVideo({
        id: `${project.id}:screen`,
        url: screenAsset.fileUrl,
        fileName: screenAsset.fileName,
        intrinsicWidth: screenAsset.width,
        intrinsicHeight: screenAsset.height,
        durationMs: screenAsset.durationMs,
        role: "screen",
        shouldAbort,
      })
    }

    if (
      cameraAsset &&
      typeof cameraAsset.width === "number" &&
      typeof cameraAsset.height === "number" &&
      cameraAsset.width > 0 &&
      cameraAsset.height > 0
    ) {
      void addRemoteVideo({
        id: `${project.id}:camera`,
        url: cameraAsset.fileUrl,
        fileName: cameraAsset.fileName,
        intrinsicWidth: cameraAsset.width,
        intrinsicHeight: cameraAsset.height,
        durationMs: cameraAsset.durationMs,
        role: "camera",
        shouldAbort,
      })
    }

    hydratedProjectIdRef.current = project.id
  }, [
    addRemoteVideo,
    commitTimelineClipsRef,
    commitTimelineVisibleVideoIds,
    commitVideosRef,
    project,
  ])

  return (
    <EditorCanvasActionsContext.Provider value={actionsValue}>
      <EditorCanvasTimelineActionsContext.Provider value={timelineActionsValue}>
        <EditorCanvasMediaContext.Provider value={mediaValue}>
          <EditorCanvasTimelineContext.Provider value={timelineValue}>
            <EditorCanvasArtboardContext.Provider value={artboardValue}>
              <EditorCanvasViewContext.Provider value={viewValue}>
                {children}
              </EditorCanvasViewContext.Provider>
            </EditorCanvasArtboardContext.Provider>
          </EditorCanvasTimelineContext.Provider>
        </EditorCanvasMediaContext.Provider>
      </EditorCanvasTimelineActionsContext.Provider>
    </EditorCanvasActionsContext.Provider>
  )
}

function useRequiredEditorCanvasContext<T>(
  context: T | null,
  contextName: string
) {
  if (!context) {
    throw new Error(`${contextName} must be used within EditorCanvasProvider.`)
  }

  return context
}

export function useEditorCanvasMedia() {
  return useRequiredEditorCanvasContext(
    useContext(EditorCanvasMediaContext),
    "useEditorCanvasMedia"
  )
}

export function useEditorCanvasArtboard() {
  return useRequiredEditorCanvasContext(
    useContext(EditorCanvasArtboardContext),
    "useEditorCanvasArtboard"
  )
}

export function useEditorCanvasView() {
  return useRequiredEditorCanvasContext(
    useContext(EditorCanvasViewContext),
    "useEditorCanvasView"
  )
}

export function useEditorCanvasActions() {
  return useRequiredEditorCanvasContext(
    useContext(EditorCanvasActionsContext),
    "useEditorCanvasActions"
  )
}

export function useEditorCanvasTimeline() {
  return useRequiredEditorCanvasContext(
    useContext(EditorCanvasTimelineContext),
    "useEditorCanvasTimeline"
  )
}

export function useEditorCanvasTimelineActions() {
  return useRequiredEditorCanvasContext(
    useContext(EditorCanvasTimelineActionsContext),
    "useEditorCanvasTimelineActions"
  )
}

export function useEditorCanvas(): EditorCanvasContextValue {
  return {
    ...useEditorCanvasMedia(),
    ...useEditorCanvasTimeline(),
    ...useEditorCanvasArtboard(),
    ...useEditorCanvasView(),
    ...useEditorCanvasActions(),
    ...useEditorCanvasTimelineActions(),
  }
}
