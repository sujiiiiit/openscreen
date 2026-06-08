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
import type { PixiNodeHandle } from "./pixi/video-controller"
import { getAutoplayOnOpenEnabled } from "@/components/editor/canvas/autoplay-preference"

import {
  type ArtboardPresetId,
  AUTO_ARTBOARD_PRESET_ID,
  clampWorkspaceView,
  DEFAULT_ARTBOARD_PRESET_ID,
  getArtboardPreset,
  getFitViewTransform,
  resolveAutoArtboard,
  resolveAutoSourceDims,
} from "@/lib/editor-canvas"
import { useProject } from "@/components/editor/project/provider"
import type {
  ArtboardBackground,
  CanvasTimelineClip,
  CanvasZoomClip,
  CanvasZoomClipPatch,
  CanvasSize,
  CanvasVideoAppearancePatch,
  CanvasVideoItem,
  CanvasVideoRole,
  CanvasVideoSource,
  CursorSetId,
  CursorSmoothingMode,
  EditorArtboard,
  EditorSaveStatus,
  ViewTransform,
} from "@/types/editor-canvas"
import { ARTBOARD_SELECTION_ID } from "@/types/editor-canvas"
import type { ProjectAsset, ProjectStateV1, ProjectSummary } from "@/types/api"
import {
  PROJECT_STATE_AUTOSAVE_DEBOUNCE_MS,
  PROJECT_STATE_AUTOSAVE_RETRY_MS,
  fingerprintProjectState,
  projectClipToCanvasClip,
  projectVideoToCanvasVideo,
  projectZoomClipToCanvasClip,
  serializeProjectState,
} from "@/components/editor/canvas/persistence"
import {
  clampZoomMove,
  clampZoomResize,
  createZoomClipId,
  normalizeZoomClips,
  placeZoomSpan,
  sanitizeZoomClipPatch,
  withZoomClipDefaults,
  zoomRadialBlurSettingsEqual,
  zoomTransitionSettingsEqual,
} from "@/lib/zoom-clips"
import {
  applyHistoryCommit,
  canRedoHistory,
  canUndoHistory,
  createEmptyHistory,
  getRedoTargetEntry,
  getUndoTargetEntry,
  type EditorHistory,
  type HistoryCommitTag,
} from "@/components/editor/canvas/history"
import {
  CURSOR_CLICK_PRESS_SCALE_DEFAULT,
  CURSOR_MOTION_BLUR_DEFAULT,
  CURSOR_MOTION_ROTATION_DEFAULT,
  CURSOR_SET_DEFAULT,
  CURSOR_SMOOTHING_MODE_DEFAULT,
  CURSOR_SIZE_DEFAULT,
  CURSOR_SIZE_MAX,
  CURSOR_SIZE_MIN,
  clampCursorClickPressScale,
  clampCursorMotionBlur,
  clampCursorMotionRotation,
  clampCursorSetId,
  clampCursorSmoothingMode,
  projectFolderFromObjectUrl,
} from "@/components/editor/canvas/cursor-scene"
import { autoZoomClicksFromCursorData } from "@/components/editor/canvas/auto-zoom-scene"
import { buildAutoZoomClips } from "@/lib/auto-zoom/zoom-detect"
import {
  ARTBOARD_PADDING_MAX,
  applyAutoLayout,
  computeVideoPlacement,
} from "@/lib/video-placement"

const DEFAULT_VIEWPORT_SIZE: CanvasSize = { width: 0, height: 0 }
const DEFAULT_ARTBOARD_PRESET = getArtboardPreset(DEFAULT_ARTBOARD_PRESET_ID)
const DEFAULT_ARTBOARD: EditorArtboard = {
  presetId: DEFAULT_ARTBOARD_PRESET.id,
  width: DEFAULT_ARTBOARD_PRESET.width,
  height: DEFAULT_ARTBOARD_PRESET.height,
  background: null,
  grain: 0,
  padding: 0,
  backgroundEnabled: true,
  cursorCustomRenderingEnabled: true,
  cursorSetId: CURSOR_SET_DEFAULT,
  cursorSizeMultiplier: CURSOR_SIZE_DEFAULT,
  cursorMotionBlur: CURSOR_MOTION_BLUR_DEFAULT,
  cursorMotionRotation: CURSOR_MOTION_ROTATION_DEFAULT,
  cursorSmoothingMode: CURSOR_SMOOTHING_MODE_DEFAULT,
  cursorClickPressScale: CURSOR_CLICK_PRESS_SCALE_DEFAULT,
  cursorAlwaysUsePointer: false,
}
const DEFAULT_VIEW_TRANSFORM = getFitViewTransform(
  DEFAULT_VIEWPORT_SIZE,
  DEFAULT_ARTBOARD
)
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
// Frame-step granularity. Source fps is measured per element during playback
// via requestVideoFrameCallback (see `registerTimelineVideoFps`) and is
// session-only — intentionally NOT persisted. Until a clip has played at least
// once we step at this default, which matches the recorder's 60 fps output.
const DEFAULT_TIMELINE_FPS = 60
const TIMELINE_ZOOM_MIN = 0.35
const TIMELINE_ZOOM_MAX = 4
const TIMELINE_ZOOM_STEP = 1.25

type AddRemoteVideoInput = {
  id?: string
  url: string
  fileName: string
  fileSize?: number
  intrinsicWidth: number
  intrinsicHeight: number
  durationMs?: number
  role: "screen" | "camera"
  source: CanvasVideoSource
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

// Committed (scrub / click / skip) seek coalescing. Mirrors the hover pipeline:
// at most one seek per element is in flight at a time, and the completion
// handler reissues toward the latest committed playhead. Keeps every expensive
// long-GOP decode aimed at the newest target instead of thrashing the decoder
// with a fresh `currentTime` write on every pointermove.
type CommittedSeekState = {
  targetSourceTime: number
  timeoutId: number
}

type TimelineVisibilityWindow = {
  start: number
  end: number
}

type EditorCanvasContextValue = {
  videos: CanvasVideoItem[]
  /**
   * Videos that belong to the project but are not currently on the canvas /
   * timeline (the user removed them). The Video tab lists these alongside the
   * on-canvas videos and offers an "Add" action to put them back.
   */
  detachedVideos: CanvasVideoItem[]
  selectedItemId: string | null
  selectedVideo: CanvasVideoItem | null
  timelineClips: CanvasTimelineClip[]
  selectedTimelineClip: CanvasTimelineClip | null
  zoomClips: CanvasZoomClip[]
  selectedZoomClipId: string | null
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
  /**
   * Screen-recording source pixel size the Auto preset resolves against
   * (null = no screen source this session; Auto falls back to Wide). Lets
   * chrome preview the Auto size without selecting it.
   */
  sourceVideoDims: { width: number; height: number } | null
  viewTransform: ViewTransform
  isPreviewMode: boolean
  addRemoteVideo: (input: AddRemoteVideoInput) => Promise<string | null>
  /**
   * Canvas → provider report: the recorded cursor track failed to load for
   * the current screen recording (missing/corrupt sidecars). Session-only;
   * drives the inline notice in the cursor settings panel.
   */
  reportCursorTrackUnavailable: (unavailable: boolean) => void
  selectItem: (id: string | null) => void
  updateVideoAppearance: (id: string, patch: CanvasVideoAppearancePatch) => void
  deleteVideo: (id: string) => void
  addVideoToCanvas: (id: string) => void
  setArtboardPreset: (id: ArtboardPresetId) => void
  setArtboardBackground: (background: ArtboardBackground | null) => void
  setArtboardBackgroundEnabled: (enabled: boolean) => void
  setArtboardGrain: (grain: number) => void
  setArtboardPadding: (padding: number) => void
  setCursorCustomRenderingEnabled: (enabled: boolean) => void
  setCursorSetId: (setId: CursorSetId) => void
  setCursorSizeMultiplier: (multiplier: number) => void
  setCursorSmoothingMode: (mode: CursorSmoothingMode) => void
  setCursorClickPressScale: (scale: number) => void
  setCursorAlwaysUsePointer: (enabled: boolean) => void
  setCursorMotionRotation: (amount: number) => void
  setCursorMotionBlur: (intensity: number) => void
  setViewportSize: (size: CanvasSize) => ViewTransform
  setViewTransform: (transform: ViewTransform) => void
  fitArtboardToViewport: () => void
  enterPreview: () => void
  exitPreview: () => void
  registerTimelineVideoElement: (
    id: string,
    element: HTMLVideoElement | null
  ) => void
  registerTimelineCanvasNode: (id: string, node: PixiNodeHandle | null) => void
  onTimelineVideoSeeked: (
    id: string,
    element: HTMLVideoElement,
    redrawLayer: (afterDraw?: () => void) => void
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
  addZoomClip: (start: number, end: number) => void
  moveZoomClip: (id: string, start: number) => void
  resizeZoomClip: (
    id: string,
    start: number,
    end: number,
    direction: "left" | "right"
  ) => void
  updateZoomClip: (id: string, patch: CanvasZoomClipPatch) => void
  removeZoomClip: (id: string) => void
  selectZoomClip: (id: string | null) => void
  subscribeTimelineTicks: (subscriber: TimelineTickSubscriber) => () => void
  stepTimelineFrame: (direction: number) => void
  registerTimelineVideoFps: (id: string, fps: number) => void
}

type EditorCanvasMediaContextValue = Pick<
  EditorCanvasContextValue,
  "videos" | "detachedVideos" | "selectedItemId" | "selectedVideo"
>

type EditorCanvasArtboardContextValue = Pick<
  EditorCanvasContextValue,
  "artboard" | "sourceVideoDims"
>

type EditorCanvasViewContextValue = Pick<
  EditorCanvasContextValue,
  "viewportSize" | "viewTransform" | "isPreviewMode"
>

type EditorCanvasTimelineContextValue = Pick<
  EditorCanvasContextValue,
  | "timelineClips"
  | "selectedTimelineClip"
  | "zoomClips"
  | "selectedZoomClipId"
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
  | "addRemoteVideo"
  | "reportCursorTrackUnavailable"
  | "selectItem"
  | "updateVideoAppearance"
  | "deleteVideo"
  | "addVideoToCanvas"
  | "setArtboardPreset"
  | "setArtboardBackground"
  | "setArtboardBackgroundEnabled"
  | "setArtboardGrain"
  | "setArtboardPadding"
  | "setCursorCustomRenderingEnabled"
  | "setCursorSetId"
  | "setCursorSizeMultiplier"
  | "setCursorSmoothingMode"
  | "setCursorClickPressScale"
  | "setCursorAlwaysUsePointer"
  | "setCursorMotionRotation"
  | "setCursorMotionBlur"
  | "setViewportSize"
  | "setViewTransform"
  | "fitArtboardToViewport"
  | "enterPreview"
  | "exitPreview"
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
  | "addZoomClip"
  | "moveZoomClip"
  | "resizeZoomClip"
  | "updateZoomClip"
  | "removeZoomClip"
  | "selectZoomClip"
  | "subscribeTimelineTicks"
  | "stepTimelineFrame"
  | "registerTimelineVideoFps"
>

type EditorCanvasSaveStatusContextValue = {
  status: EditorSaveStatus
  error: string | null
}

// Session-only cursor-data health for the current project. Kept in its own
// slice (not media/artboard) so the notice consumer doesn't re-render the
// hot canvas paths.
type EditorCanvasCursorDataContextValue = {
  cursorTrackUnavailable: boolean
}

type EditorCanvasHistoryContextValue = {
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
}

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
const EditorCanvasSaveStatusContext =
  createContext<EditorCanvasSaveStatusContextValue | null>(null)
const EditorCanvasCursorDataContext =
  createContext<EditorCanvasCursorDataContextValue | null>(null)
const EditorCanvasHistoryContext =
  createContext<EditorCanvasHistoryContextValue | null>(null)

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

function createCanvasId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }

  return `canvas-item-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// Per-role appearance defaults. Camera defaults to a fully-rounded squircle
// at maximum smoothing, which visually matches the prior elliptical sceneFunc
// without needing a separate `cropShape` field. Screen and media start at
// radius 0 with `cornerSmoothing = 1` (maximum smoothing) so users get an
// already-correct curve the moment they nudge the radius slider.
function createVideoAppearanceDefaults(
  role: CanvasVideoRole,
  size: CanvasSize
): Pick<
  CanvasVideoItem,
  | "cornerRadius"
  | "cornerSmoothing"
  | "borderWidth"
  | "borderColor"
  | "borderOffset"
  | "borderAlignment"
> {
  const borderDefaults: Pick<
    CanvasVideoItem,
    "borderWidth" | "borderColor" | "borderOffset" | "borderAlignment"
  > = {
    borderWidth: 0,
    borderColor: "#000000",
    borderOffset: 0,
    borderAlignment: "inside",
  }

  if (role === "camera") {
    const radius = Math.max(
      0,
      Math.floor(Math.min(size.width, size.height) / 2)
    )
    return {
      cornerRadius: radius,
      cornerSmoothing: 1,
      ...borderDefaults,
    }
  }

  return {
    cornerRadius: 0,
    cornerSmoothing: 1,
    ...borderDefaults,
  }
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

function buildTimelineClipsByVideoId(clips: CanvasTimelineClip[]) {
  const byVideoId = new Map<string, CanvasTimelineClip[]>()
  for (const clip of clips) {
    const list = byVideoId.get(clip.videoId)
    if (list) list.push(clip)
    else byVideoId.set(clip.videoId, [clip])
  }
  byVideoId.forEach((list) => {
    list.sort((a, b) => a.start - b.start || a.end - b.end)
  })
  return byVideoId
}

function isTimelineClipActiveAt(
  clip: CanvasTimelineClip,
  time: number,
  timelineEnd: number
) {
  const isPlayingThroughClip = time >= clip.start && time < clip.end
  const isHoldingLastFrame =
    !isPlayingThroughClip &&
    time >= clip.start &&
    time >= clip.end - TIMELINE_END_HOLD_EPSILON_SECONDS &&
    clip.end >= timelineEnd - TIMELINE_END_HOLD_EPSILON_SECONDS

  return isPlayingThroughClip || isHoldingLastFrame
}

function findTimelineClipAt(
  clips: readonly CanvasTimelineClip[] | undefined,
  time: number,
  timelineEnd: number
) {
  if (!clips) return null
  return (
    clips.find((clip) => isTimelineClipActiveAt(clip, time, timelineEnd)) ??
    null
  )
}

function getTimelineDurationForClips(clips: readonly CanvasTimelineClip[]) {
  if (clips.length === 0) return 0

  const clipDuration = clips.reduce(
    (duration, clip) => Math.max(duration, clip.end),
    0
  )

  return Math.max(TIMELINE_MIN_CLIP_DURATION_SECONDS, clipDuration)
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
  // Videos removed from the canvas but still part of the project. They render
  // no canvas node and have no timeline clip; only the Video tab reads them so
  // it can offer "Add" to put them back. Kept as a separate list (rather than
  // a flag on `videos`) so every existing consumer of `videos` — canvas,
  // timeline, playback, export — stays untouched and the 5000-node hot paths
  // never see a detached entry.
  const [detachedVideos, setDetachedVideos] = useState<CanvasVideoItem[]>([])
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [artboard, setArtboard] = useState<EditorArtboard>(DEFAULT_ARTBOARD)
  // Reactive mirror of `sourceVideoDimsRef` so editor chrome (the artboard
  // preset dropdown's Auto row) can show what the Auto preset would resolve
  // to without selecting it. Session-only — re-derived from the project's
  // screen asset at hydration, never persisted. Must be written wherever the
  // ref is written so the UI never disagrees with what `setArtboardPreset`
  // would actually do.
  const [sourceVideoDims, setSourceVideoDims] = useState<{
    width: number
    height: number
  } | null>(null)
  const [viewportSize, setViewportSizeState] = useState<CanvasSize>(
    DEFAULT_VIEWPORT_SIZE
  )
  const [viewTransform, setViewTransformState] = useState<ViewTransform>(
    DEFAULT_VIEW_TRANSFORM
  )
  // Session-only fullscreen preview flag. Not persisted, not in undo history.
  const [isPreviewMode, setIsPreviewMode] = useState(false)
  // Session-only: the canvas reported that cursor sidecar data could not be
  // loaded for the current screen recording. Not persisted.
  const [cursorTrackUnavailable, setCursorTrackUnavailable] = useState(false)
  const [timelineClips, setTimelineClips] = useState<CanvasTimelineClip[]>([])
  // Manual Zoom-track clips (persisted) + the session-only selected zoom clip.
  // Selection is intentionally NOT persisted (mirrors `selectedItemId`).
  const [zoomClips, setZoomClips] = useState<CanvasZoomClip[]>([])
  const [selectedZoomClipId, setSelectedZoomClipId] = useState<string | null>(
    null
  )
  const [timelineTime, setTimelineTimeState] = useState(0)
  const [timelineZoom, setTimelineZoom] = useState(1)
  const [isTimelineFit, setIsTimelineFit] = useState(true)
  const [timelineFitRequestId, setTimelineFitRequestId] = useState(0)
  const [timelineVisibleVideoIds, setTimelineVisibleVideoIds] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const [isTimelinePlaying, setIsTimelinePlaying] = useState(false)
  const [isHoverPreviewActive, setIsHoverPreviewActive] = useState(false)
  const [saveStatus, setSaveStatus] = useState<EditorSaveStatus>("idle")
  const [saveError, setSaveError] = useState<string | null>(null)
  // Reactive mirrors of `historyRef` so the future toolbar / Edit menu can
  // render disabled state. The keyboard handler reads `historyRef.current`
  // directly so a double-tap of Cmd+Z walks the cursor without waiting for
  // setState to commit.
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const objectUrlsRef = useRef(new Set<string>())
  const videosRef = useRef(videos)
  const detachedVideosRef = useRef(detachedVideos)
  const videoByIdRef = useRef(buildVideoById(videos))
  const timelineClipsRef = useRef(timelineClips)
  const timelineClipsByVideoIdRef = useRef(
    buildTimelineClipsByVideoId(timelineClips)
  )
  const zoomClipsRef = useRef(zoomClips)
  const selectedZoomClipIdRef = useRef(selectedZoomClipId)
  const timelineTimeRef = useRef(timelineTime)
  const timelineDurationRef = useRef(0)
  const isTimelinePlayingRef = useRef(isTimelinePlaying)
  const isPreviewModeRef = useRef(isPreviewMode)
  const timelineVideoElementsRef = useRef(new Map<string, HTMLVideoElement>())
  const timelineCanvasNodesRef = useRef(new Map<string, PixiNodeHandle>())
  // Per-element source frame rate, measured lazily during playback. Session-
  // only: never persisted, cleared on project switch. Drives frame-stepping.
  const videoFpsRef = useRef(new Map<string, number>())
  const timelineVisibleVideoIdsRef = useRef<ReadonlySet<string>>(new Set())
  const timelineVisibilityWindowRef = useRef<TimelineVisibilityWindow | null>(
    null
  )
  const timelineTickSubscribersRef = useRef(new Set<TimelineTickSubscriber>())
  const timelinePlaybackFrameRef = useRef<number | null>(null)
  const timelinePreviousFrameMsRef = useRef<number | null>(null)
  const timelineLastStateCommitMsRef = useRef(0)
  // Throttle for the React `timelineTime` state commit on the scrub path. The
  // playhead itself moves imperatively via the tick subscribers every move, so
  // the React mirror (consumed only by the time readout + disabled-state) can
  // lag a frame; committing it on every pointermove would re-render every
  // timeline consumer dozens of times a second and starve the seek/redraw.
  const timelineStateCommitTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null)
  const lastTimelineStateCommitMsRef = useRef(0)
  // Hover preview pipeline state. All refs so a stream of mouse moves doesn't
  // re-render the React tree; `isHoverPreviewActive` is the single observable
  // bit a consumer needs (for ghost-cursor mounting).
  const hoverPreviewTimeRef = useRef<number | null>(null)
  const hoverPreviewActiveRef = useRef(false)
  const hoverFrameRef = useRef<number | null>(null)
  const hoverSeekStateRef = useRef(new Map<string, HoverSeekState>())
  const committedSeekStateRef = useRef(new Map<string, CommittedSeekState>())
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
  // Autoplay-on-open. Hydration arms this when the freshly opened project has
  // playable media; the first timeline video element to finish loading consumes
  // it and starts playback exactly once (see `registerTimelineVideoElement`).
  // It is gated on a real element being ready rather than fired inline at
  // hydration time so playback begins from the first decoded frame instead of a
  // blank canvas, and so a project that opens with no media never auto-plays.
  // Any explicit transport action (play/pause) consumes it, so a slow-loading
  // video can never surprise the user after they've already taken control.
  const autoplayPendingRef = useRef(false)

  const { project } = useProject()
  const projectRef = useRef<ProjectSummary | null>(project)
  useEffect(() => {
    projectRef.current = project
  }, [project])

  // Autosave plumbing — every change to artboard/videos/timelineClips schedules
  // a debounced write of `project.json`. Saves are gated on hydration so we
  // never persist a half-initialised state. While one save is in flight, any
  // further changes set `autosavePendingRef` so a single follow-up fires when
  // the in-flight write completes.
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autosaveRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const autosaveInFlightRef = useRef(false)
  const autosavePendingRef = useRef(false)
  // Fingerprint of the last successful write — populated either on a
  // successful save or seeded from the loaded `project.state` during
  // fast-path hydration. Used to skip the redundant first save that the
  // autosave effect schedules immediately after `setArtboard`/`setVideos`/
  // `setTimelineClips` commit the hydrated values.
  const lastWrittenSerializedRef = useRef<string | null>(null)
  // Ref-pointer to the latest `flushAutosave` so the retry setTimeout doesn't
  // self-reference the useCallback (React Compiler can't preserve manual
  // memoisation around self-referential `useCallback`s and the lint refuses
  // it). The ref is mirrored from `flushAutosave` via an effect below.
  const flushAutosaveRef = useRef<
    ((projectPath: string) => Promise<void>) | null
  >(null)
  // Undo / redo history. The push site lives inside the autosave drain so a
  // single 500ms debounce window collapses many rapid mutations into one
  // history entry, naturally giving us "drag a slider = one undo step"
  // without per-surface wiring. `historyCommitTagRef` is set by each
  // mutating action before it touches state; the push site reads + clears it
  // and feeds it to `applyHistoryCommit`. `restoringFromHistoryRef` gates
  // the push site so undo / redo do not corrupt the cursor with a duplicate
  // snapshot of the restored state.
  const historyRef = useRef<EditorHistory>(createEmptyHistory())
  const historyCommitTagRef = useRef<HistoryCommitTag | null>(null)
  const restoringFromHistoryRef = useRef(false)
  // Slow-path hydration (fresh recording) only. While set, `pushHistoryFromAutosave`
  // drops every push — the auto-added recording is the document's starting
  // point, not an undoable edit, so undoing it (back to a blank canvas) is
  // exactly the step we suppress. The seed effect clears this flag by turning
  // the first committed recording state into the cursor-0 baseline, so the
  // blank canvas is never an undo step and the user's first edit lands at
  // cursor 1.
  const hydrationSeedPendingRef = useRef(false)
  // Armed in the slow path (first open of a fresh recording). The one-shot
  // auto-zoom effect generates zoom clips from the captured cursor/click data
  // once the screen recording and its timeline clip are committed, then clears
  // this flag. The generated clips are persisted, so later opens hit the fast
  // path and never re-detect. See docs/auto-zoom-plan.md.
  const autoZoomPendingRef = useRef(false)
  // Maps video ids to their `file://` URLs for the lifetime of the session,
  // for both imported sources (URL returned by main on import) and recording
  // sources (the asset `fileUrl` passed to `addRemoteVideo`). Used to
  // re-attach the URL when undo/redo restores a video whose id is no longer
  // in `videos`/`detachedVideos`. This is the only URL source for a freshly
  // recorded project: `project.assetUrlsByVideoId` is empty until a
  // `project.json` exists (it is computed from the saved state at project
  // open), so without this cache a restore rebuilds the recording with an
  // empty `objectUrl` and it renders blank. Holds only strings — no blob
  // memory pinned by undo.
  const sessionVideoUrlsRef = useRef(new Map<string, string>())

  // `capturedTag` must be captured at the same instant as `snapshot` and
  // passed in — never re-read from `historyCommitTagRef.current` here.
  // Reading the ref at push time races with a user action that lands its
  // tag during the IPC await between capture and push, mis-attributing the
  // racing action's tag to this snapshot.
  const pushHistoryFromAutosave = useCallback(
    (
      snapshot: ProjectStateV1,
      fingerprint: string | null,
      capturedTag: HistoryCommitTag | null
    ) => {
      if (restoringFromHistoryRef.current && capturedTag === null) {
        // No user action since restore — this autosave is just the post-
        // restore disk sync. Skip the push so we don't corrupt the cursor
        // with a duplicate snapshot of the just-restored state.
        return
      }
      // A user action raced the restore: clear the guard so this edit (and
      // any subsequent ones) push normally. The edit's snapshot lands as
      // a new history entry on top of the restored cursor.
      if (restoringFromHistoryRef.current) {
        restoringFromHistoryRef.current = false
      }
      if (hydrationSeedPendingRef.current) {
        // Slow-path hydration: drop every autosave push until the cursor-0
        // baseline is seeded (eagerly, the moment the recording commits — see
        // the seed effect below). This swallows the empty pre-add snapshots
        // (the destructive flush inside `addRemoteVideo` captures them before
        // its `setVideos` commits) so the auto-add never becomes a blank-canvas
        // undo step. Disk writes are unaffected; only the history ledger waits.
        return
      }
      const tag: HistoryCommitTag = capturedTag ?? "unknown"
      const { next, didPush } = applyHistoryCommit(
        historyRef.current,
        snapshot,
        fingerprint,
        tag,
        Date.now()
      )
      historyRef.current = next
      if (didPush) {
        const nextCanUndo = canUndoHistory(next)
        const nextCanRedo = canRedoHistory(next)
        setCanUndo((current) =>
          current === nextCanUndo ? current : nextCanUndo
        )
        setCanRedo((current) =>
          current === nextCanRedo ? current : nextCanRedo
        )
      }
    },
    []
  )

  const flushAutosave = useCallback(
    async (projectPath: string) => {
      if (autosaveInFlightRef.current) {
        autosavePendingRef.current = true
        return
      }
      autosaveInFlightRef.current = true
      // Clear any pending retry — we're saving now, so a scheduled retry would
      // duplicate work and may race with this attempt.
      if (autosaveRetryTimerRef.current !== null) {
        clearTimeout(autosaveRetryTimerRef.current)
        autosaveRetryTimerRef.current = null
      }
      setSaveStatus("saving")
      let lastError: string | null = null
      let abortedForProjectSwitch = false
      try {
        // Drain mode: keep writing as long as edits arrive while one save is in
        // flight. Each pass serialises fresh refs, so the last write always
        // reflects the latest committed state. We bail mid-drain if the user
        // switched projects — otherwise we'd write the new project's state to
        // the old project's `project.json`.
        do {
          autosavePendingRef.current = false
          if (projectRef.current?.path !== projectPath) {
            abortedForProjectSwitch = true
            break
          }
          const snapshot = serializeProjectState(
            artboardRef.current,
            videosRef.current,
            timelineClipsRef.current,
            detachedVideosRef.current,
            zoomClipsRef.current
          )
          const fingerprint = fingerprintProjectState(snapshot)
          // Snapshot the tag at the same instant as the state so a user
          // action that lands during the IPC await cannot attribute its tag
          // to this snapshot. The next drain pass will pick up the new tag.
          const capturedTag = historyCommitTagRef.current
          historyCommitTagRef.current = null
          if (
            fingerprint !== null &&
            fingerprint === lastWrittenSerializedRef.current
          ) {
            // Memory matches what's already on disk — skip the IPC, treat as
            // a successful no-op. Avoids a redundant write right after fast-
            // path hydration and any other "schedule-but-no-real-change" path.
            lastError = null
            // Still advance the history clock on no-op flushes so a
            // destructive-flush call after a stale debounce can coalesce
            // correctly — the snapshot didn't change, so this branch never
            // pushes a new entry, only refreshes the top's timestamp.
            pushHistoryFromAutosave(snapshot, fingerprint, capturedTag)
            continue
          }
          try {
            const result = await window.api?.projects.saveState(
              projectPath,
              snapshot
            )
            if (result && result.ok === false) {
              lastError = result.reason
              console.error("[provider] autosave rejected:", result.reason)
            } else {
              lastError = null
              if (fingerprint !== null) {
                lastWrittenSerializedRef.current = fingerprint
              }
            }
          } catch (cause) {
            lastError = cause instanceof Error ? cause.message : String(cause)
            console.error("[provider] autosave failed:", cause)
          }
          // Push to history regardless of disk-write outcome. History is
          // in-memory only; a transient IPC error must not silently drop a
          // ledger entry, and a successful retry will reconcile the disk side.
          pushHistoryFromAutosave(snapshot, fingerprint, capturedTag)
        } while (autosavePendingRef.current)
      } finally {
        autosaveInFlightRef.current = false
        if (abortedForProjectSwitch) {
          // Don't surface a failure for an aborted save — the user just moved
          // on; the new project's autosave will paint the indicator next.
        } else {
          setSaveError(lastError)
          setSaveStatus(lastError ? "error" : "saved")
          if (lastError) {
            // Auto-retry once after a short delay so transient I/O errors
            // (full disk that just freed, perms that just changed, USB blip)
            // self-heal without a user edit. A new edit supersedes the retry
            // because the autosave effect clears `autosaveRetryTimerRef`.
            if (autosaveRetryTimerRef.current !== null) {
              clearTimeout(autosaveRetryTimerRef.current)
            }
            autosaveRetryTimerRef.current = setTimeout(() => {
              autosaveRetryTimerRef.current = null
              if (projectRef.current?.path !== projectPath) return
              const next = flushAutosaveRef.current
              if (next) void next(projectPath)
            }, PROJECT_STATE_AUTOSAVE_RETRY_MS)
          }
        }
        // Clear the restore guard now that the post-restore autosave has
        // completed its drain. The guard is set by `undo` / `redo` and lives
        // until the next autosave finishes so multiple back-to-back drain
        // passes (e.g., a new edit immediately after restore) all skip the
        // push site for the restored state.
        restoringFromHistoryRef.current = false
      }
    },
    [pushHistoryFromAutosave]
  )

  // Synchronous flush helper used by destructive actions (delete, duplicate,
  // add, preset). Pushes the *pre-destructive* snapshot into history right
  // now (so the prior edit window becomes its own undo entry regardless of
  // whether another save is already in flight — `flushAutosave` would just
  // queue itself in that case and the boundary would be lost), then kicks
  // the drain so the snapshot lands on disk too. The destructive change
  // that follows lands as a separate entry on the next autosave fire.
  const flushAutosaveNow = useCallback(() => {
    const currentProject = projectRef.current
    if (!currentProject) return
    if (hydratedProjectIdRef.current !== currentProject.id) return
    if (autosaveTimerRef.current !== null) {
      clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
    const snapshot = serializeProjectState(
      artboardRef.current,
      videosRef.current,
      timelineClipsRef.current,
      detachedVideosRef.current,
      zoomClipsRef.current
    )
    const fingerprint = fingerprintProjectState(snapshot)
    const capturedTag = historyCommitTagRef.current
    historyCommitTagRef.current = null
    pushHistoryFromAutosave(snapshot, fingerprint, capturedTag)
    void flushAutosave(currentProject.path)
  }, [flushAutosave, pushHistoryFromAutosave])

  useEffect(() => {
    flushAutosaveRef.current = flushAutosave
  }, [flushAutosave])

  const commitVideosRef = useCallback((nextVideos: CanvasVideoItem[]) => {
    videosRef.current = nextVideos
    videoByIdRef.current = buildVideoById(nextVideos)
    timelineVisibilityWindowRef.current = null
  }, [])

  const commitDetachedVideosRef = useCallback(
    (nextDetached: CanvasVideoItem[]) => {
      detachedVideosRef.current = nextDetached
    },
    []
  )

  const commitTimelineClipsRef = useCallback(
    (nextClips: CanvasTimelineClip[]) => {
      timelineClipsRef.current = nextClips
      timelineClipsByVideoIdRef.current = buildTimelineClipsByVideoId(nextClips)
      timelineVisibilityWindowRef.current = null
    },
    []
  )

  const commitZoomClipsRef = useCallback((nextClips: CanvasZoomClip[]) => {
    zoomClipsRef.current = nextClips
  }, [])

  useEffect(() => {
    commitVideosRef(videos)
  }, [commitVideosRef, videos])

  useEffect(() => {
    commitDetachedVideosRef(detachedVideos)
  }, [commitDetachedVideosRef, detachedVideos])

  useEffect(() => {
    commitTimelineClipsRef(timelineClips)
  }, [commitTimelineClipsRef, timelineClips])

  useEffect(() => {
    commitZoomClipsRef(zoomClips)
  }, [commitZoomClipsRef, zoomClips])

  useEffect(() => {
    selectedZoomClipIdRef.current = selectedZoomClipId
  }, [selectedZoomClipId])

  useEffect(() => {
    timelineTimeRef.current = timelineTime
  }, [timelineTime])

  useEffect(() => {
    isTimelinePlayingRef.current = isTimelinePlaying
  }, [isTimelinePlaying])

  useEffect(() => {
    isPreviewModeRef.current = isPreviewMode
  }, [isPreviewMode])

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
    // An empty timeline has no duration — report 0 so the transport reads
    // 00:00.00. The minimum-clip floor only applies once at least one clip
    // exists, to guarantee a non-zero scrub range.
    return getTimelineDurationForClips(timelineClips)
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
    const committedSeekState = committedSeekStateRef.current
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
      if (timelineStateCommitTimerRef.current !== null) {
        clearTimeout(timelineStateCommitTimerRef.current)
        timelineStateCommitTimerRef.current = null
      }
      hoverSeekState.forEach((entry) => {
        window.clearTimeout(entry.timeoutId)
      })
      hoverSeekState.clear()
      committedSeekState.forEach((entry) => {
        window.clearTimeout(entry.timeoutId)
      })
      committedSeekState.clear()
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
    const timelineEnd = timelineDurationRef.current
    const clip = findTimelineClipAt(
      timelineClipsByVideoIdRef.current.get(videoId),
      time,
      timelineEnd
    )
    const video = videoByIdRef.current.get(videoId)
    if (!clip || !video) return null

    const sourceDuration = getVideoDurationSeconds(video)
    const sourceIn = Math.max(0, Math.min(clip.sourceIn, sourceDuration))
    const sourceOut = Math.max(
      sourceIn,
      Math.min(clip.sourceOut, sourceDuration)
    )
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
    const isAtTimelineEnd =
      time >= timelineEnd - TIMELINE_END_HOLD_EPSILON_SECONDS
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

  // Drops the in-flight committed-seek bookkeeping for a single element.
  const clearCommittedEntry = useCallback((videoId: string) => {
    const entry = committedSeekStateRef.current.get(videoId)
    if (!entry) return
    window.clearTimeout(entry.timeoutId)
    committedSeekStateRef.current.delete(videoId)
  }, [])

  // Issues exactly one committed seek for one element; the caller must have
  // confirmed there is no in-flight entry. A safety timeout force-clears the
  // entry and repaints if `seeked` never fires (rare; e.g. the new currentTime
  // resolved to the same frame the element already showed).
  const issueCommittedSeek = useCallback(
    (videoId: string, element: HTMLVideoElement, targetSourceTime: number) => {
      const timeoutId = window.setTimeout(() => {
        const stalled = committedSeekStateRef.current.get(videoId)
        if (!stalled) return
        committedSeekStateRef.current.delete(videoId)
        timelineCanvasNodesRef.current.get(videoId)?.getLayer()?.batchDraw()
      }, 250)
      committedSeekStateRef.current.set(videoId, {
        targetSourceTime,
        timeoutId,
      })
      safeSeekElement(element, targetSourceTime)
    },
    [safeSeekElement]
  )

  // Snap a single element to the timeline target. Used for explicit user
  // actions (scrub, click, skip, clip edits) and for clips that just became
  // active. While paused this coalesces to a single in-flight seek per element
  // (see `CommittedSeekState`): `onTimelineVideoSeeked` paints the landed frame
  // and reissues toward the latest playhead, so each expensive long-GOP decode
  // chases the newest target instead of being thrown away. When `shouldPlay` is
  // set we skip coalescing — the element is about to play and the rAF loop owns
  // the clock.
  const seekElementToTimeline = useCallback(
    (
      videoId: string,
      element: HTMLVideoElement,
      time: number,
      shouldPlay: boolean
    ) => {
      const frame = resolveTimelineFrame(videoId, time)
      if (!frame || !frame.active) {
        clearCommittedEntry(videoId)
        if (!element.paused) element.pause()
        return
      }

      if (element.playbackRate !== 1) element.playbackRate = 1
      const seekableTime = getSeekableTimelineSourceTime(
        element,
        frame.sourceTime,
        frame.sourceDuration
      )

      if (shouldPlay) {
        // Play-from-position: one precise seek, then play. No coalescing.
        clearCommittedEntry(videoId)
        if (
          Math.abs(element.currentTime - seekableTime) >
          TIMELINE_FORCE_SEEK_EPSILON_SECONDS
        ) {
          safeSeekElement(element, seekableTime)
        }
        safePlayElement(element)
        return
      }

      if (!element.paused) element.pause()
      if (
        Math.abs(element.currentTime - seekableTime) <=
        TIMELINE_FORCE_SEEK_EPSILON_SECONDS
      ) {
        // Already on target — nothing to decode; drop any stale in-flight entry.
        clearCommittedEntry(videoId)
        return
      }
      // A seek is already decoding for this element; its completion handler will
      // reissue toward the latest playhead rather than thrash a fresh write.
      if (committedSeekStateRef.current.has(videoId)) return
      issueCommittedSeek(videoId, element, seekableTime)
    },
    [
      clearCommittedEntry,
      getSeekableTimelineSourceTime,
      issueCommittedSeek,
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
      const clip = findTimelineClipAt(
        timelineClipsByVideoIdRef.current.get(primaryId),
        time,
        timelineDurationRef.current
      )
      if (clip) return primaryId
    }

    for (const videoId of visibleIds) {
      const clip = findTimelineClipAt(
        timelineClipsByVideoIdRef.current.get(videoId),
        time,
        timelineDurationRef.current
      )
      if (clip) return videoId
    }
    return null
  }, [])

  const getCurrentPlaybackTimelineTime = useCallback(() => {
    const fallbackTime = timelineTimeRef.current
    const visibleIds = timelineVisibleVideoIdsRef.current
    if (visibleIds.size === 0) return fallbackTime

    const primaryId = primaryAudioVideoIdRef.current
    const candidateIds =
      primaryId && visibleIds.has(primaryId)
        ? [
            primaryId,
            ...Array.from(visibleIds).filter(
              (videoId) => videoId !== primaryId
            ),
          ]
        : Array.from(visibleIds)

    for (const videoId of candidateIds) {
      const element = timelineVideoElementsRef.current.get(videoId)
      const clip = findTimelineClipAt(
        timelineClipsByVideoIdRef.current.get(videoId),
        fallbackTime,
        timelineDurationRef.current
      )
      if (!element || !clip || !Number.isFinite(element.currentTime)) continue

      const projectedTime = clip.start + (element.currentTime - clip.sourceIn)
      const boundedTime = Math.min(
        clip.end,
        Math.max(clip.start, projectedTime)
      )
      return clampTimelineTime(boundedTime, timelineDurationRef.current)
    }

    return fallbackTime
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

  const reissueHoverSeekToLiveTarget = useCallback(
    (
      videoId: string,
      element: HTMLVideoElement,
      landedHoverTimelineTime: number
    ) => {
      if (!hoverPreviewActiveRef.current) return
      const liveHoverTime = hoverPreviewTimeRef.current
      if (
        liveHoverTime === null ||
        Math.abs(liveHoverTime - landedHoverTimelineTime) <=
          TIMELINE_FORCE_SEEK_EPSILON_SECONDS
      ) {
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
      if (hoverSeekStateRef.current.has(videoId)) return
      issueHoverSeek(videoId, element, liveTarget, liveHoverTime)
    },
    [getSeekableTimelineSourceTime, issueHoverSeek, resolveTimelineFrame]
  )

  // Single seek-completion gate. The canvas video controller hands every
  // `seeked` event through here and we decide whether it counts as a valid
  // hover paint or a committed paint. Either way the redrawLayer callback
  // keeps the canvas component unaware of hover vs committed.
  const onTimelineVideoSeeked = useCallback(
    (
      videoId: string,
      element: HTMLVideoElement,
      redrawLayer: (afterDraw?: () => void) => void
    ) => {
      const entry = hoverSeekStateRef.current.get(videoId)
      if (entry) {
        window.clearTimeout(entry.timeoutId)
        hoverSeekStateRef.current.delete(videoId)

        // Paint the landed hover frame, then reissue toward the latest hover
        // target if the pointer has moved. A seek can settle up to a decoded
        // frame away from the requested time, so exact target matching would
        // drop useful preview frames during fast ruler hover.
        redrawLayer(() => {
          reissueHoverSeekToLiveTarget(
            videoId,
            element,
            entry.hoverTimelineTime
          )
        })
        return
      }

      const committedEntry = committedSeekStateRef.current.get(videoId)
      if (committedEntry) {
        window.clearTimeout(committedEntry.timeoutId)
        committedSeekStateRef.current.delete(videoId)
        // Paint every landed committed frame — it is a real position along the
        // scrub path, so showing it keeps the preview moving in step with the
        // drag. We deliberately do not gate on an exact match (an exact
        // `currentTime` seek can settle up to a frame from the request); the
        // reissue below converges on the live playhead.
        redrawLayer()

        // While playing, the rAF loop owns currentTime — don't reissue.
        if (isTimelinePlayingRef.current) return
        const liveTime = timelineTimeRef.current
        const frame = resolveTimelineFrame(videoId, liveTime)
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
        if (committedSeekStateRef.current.has(videoId)) return
        issueCommittedSeek(videoId, element, liveTarget)
        return
      }

      if (shouldDrawTimelineVideoFrame(videoId, element)) {
        redrawLayer()
      }
    },
    [
      getSeekableTimelineSourceTime,
      issueCommittedSeek,
      reissueHoverSeekToLiveTarget,
      resolveTimelineFrame,
      shouldDrawTimelineVideoFrame,
    ]
  )

  // Commit the React `timelineTime` mirror at once, cancelling any pending
  // throttled commit. Used by discrete transitions (play, pause, clamp) where
  // the value must land immediately.
  const commitTimelineTimeState = useCallback((time: number) => {
    if (timelineStateCommitTimerRef.current !== null) {
      clearTimeout(timelineStateCommitTimerRef.current)
      timelineStateCommitTimerRef.current = null
    }
    lastTimelineStateCommitMsRef.current = performance.now()
    setTimelineTimeState(time)
  }, [])

  // Commit the React mirror at most once per TIMELINE_STATE_COMMIT_INTERVAL_MS
  // during a scrub: the first move commits immediately, subsequent moves inside
  // the window schedule a single trailing commit of the latest value. Keeps the
  // readout tracking the drag without a per-pointermove re-render storm; the
  // playhead itself stays smooth via the tick subscribers regardless.
  const scheduleTimelineTimeState = useCallback((time: number) => {
    const now = performance.now()
    const elapsed = now - lastTimelineStateCommitMsRef.current
    if (elapsed >= TIMELINE_STATE_COMMIT_INTERVAL_MS) {
      lastTimelineStateCommitMsRef.current = now
      setTimelineTimeState(time)
      return
    }
    if (timelineStateCommitTimerRef.current !== null) return
    timelineStateCommitTimerRef.current = setTimeout(() => {
      timelineStateCommitTimerRef.current = null
      lastTimelineStateCommitMsRef.current = performance.now()
      setTimelineTimeState(timelineTimeRef.current)
    }, TIMELINE_STATE_COMMIT_INTERVAL_MS - elapsed)
  }, [])

  useEffect(() => {
    const clampedTime = clampTimelineTime(
      timelineTimeRef.current,
      timelineDuration
    )
    if (clampedTime === timelineTimeRef.current) return

    timelineTimeRef.current = clampedTime
    commitTimelineTimeState(clampedTime)
    notifyTimelineSubscribers(clampedTime)
    syncTimelineMedia(clampedTime, isTimelinePlayingRef.current)
  }, [
    commitTimelineTimeState,
    notifyTimelineSubscribers,
    syncTimelineMedia,
    timelineDuration,
  ])

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
      scheduleTimelineTimeState(clampedTime)
      notifyTimelineSubscribers(clampedTime)
      syncTimelineMedia(clampedTime, isTimelinePlayingRef.current)
    },
    [notifyTimelineSubscribers, scheduleTimelineTimeState, syncTimelineMedia]
  )

  const pauseTimeline = useCallback(() => {
    // A pause — whether from the transport button or an internal trigger
    // (page hidden, preview blurred) — settles the transport, so any pending
    // open-time autoplay is now moot and must not fire when a late video loads.
    autoplayPendingRef.current = false
    if (timelinePlaybackFrameRef.current !== null) {
      cancelAnimationFrame(timelinePlaybackFrameRef.current)
      timelinePlaybackFrameRef.current = null
    }

    timelinePreviousFrameMsRef.current = null
    isTimelinePlayingRef.current = false
    setIsTimelinePlaying(false)
    const time = getCurrentPlaybackTimelineTime()
    timelineTimeRef.current = time
    commitTimelineTimeState(time)
    notifyTimelineSubscribers(time)
    syncTimelineMedia(time, false)
  }, [
    commitTimelineTimeState,
    getCurrentPlaybackTimelineTime,
    notifyTimelineSubscribers,
    syncTimelineMedia,
  ])

  const playTimeline = useCallback(() => {
    // Playback has begun (or is already running), so the open-time autoplay is
    // fulfilled — clear it before the early return so it can't re-fire later.
    autoplayPendingRef.current = false
    if (isTimelinePlayingRef.current) return

    const duration = timelineDurationRef.current
    const startTime =
      timelineTimeRef.current >= duration
        ? 0
        : clampTimelineTime(timelineTimeRef.current, duration)

    timelineTimeRef.current = startTime
    commitTimelineTimeState(startTime)
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
        const masterClip = findTimelineClipAt(
          timelineClipsByVideoIdRef.current.get(masterId),
          timelineTimeRef.current,
          timelineDurationRef.current
        )
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
          if (
            Math.abs(projected - nextTime) <= TIMELINE_PLAYBACK_DRIFT_SECONDS
          ) {
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
    commitTimelineTimeState,
    getMasterPlaybackVideoId,
    notifyTimelineSubscribers,
    syncTimelineMedia,
    syncTimelineMediaPlayback,
  ])

  // If the page is hidden or the editor window loses focus, pause through the
  // same committed-time path as the Pause button. Space switches and occlusion
  // can throttle the renderer before `document.hidden` changes, so blur is the
  // broader safety net. This prevents rAF throttling or browser media
  // suspension from leaving the cursor clock ahead of/behind the actual video
  // frame when the app becomes visible again.
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return
    }

    const pauseHiddenPlayback = () => {
      if (!document.hidden) return

      const hadHover = hoverPreviewActiveRef.current
      if (hadHover) {
        cancelInFlightHoverSeeks()
        notifyHoverTimeSubscribers(null)
      }

      if (isTimelinePlayingRef.current) {
        pauseTimeline()
        return
      }

      if (hadHover) {
        syncTimelineMedia(timelineTimeRef.current, false)
      }
    }

    const pauseBlurredPlayback = () => {
      if (!isTimelinePlayingRef.current) return
      pauseTimeline()
    }

    document.addEventListener("visibilitychange", pauseHiddenPlayback)
    window.addEventListener("blur", pauseBlurredPlayback)
    return () => {
      document.removeEventListener("visibilitychange", pauseHiddenPlayback)
      window.removeEventListener("blur", pauseBlurredPlayback)
    }
  }, [
    cancelInFlightHoverSeeks,
    notifyHoverTimeSubscribers,
    pauseTimeline,
    syncTimelineMedia,
  ])

  const toggleTimelinePlayback = useCallback(() => {
    if (isTimelinePlayingRef.current) {
      pauseTimeline()
      return
    }

    playTimeline()
  }, [pauseTimeline, playTimeline])

  // Source frame rate at a timeline position. Prefers the primary-audio clip
  // under the playhead, then any clip under it; falls back to the recorder
  // default until a clip has played and reported its measured fps.
  const getTimelineFpsAt = useCallback((time: number) => {
    const measured = videoFpsRef.current
    const primaryId = primaryAudioVideoIdRef.current
    if (primaryId) {
      const clip = findTimelineClipAt(
        timelineClipsByVideoIdRef.current.get(primaryId),
        time,
        timelineDurationRef.current
      )
      if (clip) {
        const fps = measured.get(primaryId)
        if (fps) return fps
      }
    }
    const timelineEnd = timelineDurationRef.current
    for (const clip of timelineClipsRef.current) {
      if (isTimelineClipActiveAt(clip, time, timelineEnd)) {
        const fps = measured.get(clip.videoId)
        if (fps) return fps
      }
    }
    return DEFAULT_TIMELINE_FPS
  }, [])

  // Step the playhead by exactly one source frame. Snaps to the frame grid of
  // the clip under the playhead first, so repeated steps land on frame
  // boundaries regardless of where a free scrub left the cursor.
  const stepTimelineFrame = useCallback(
    (direction: number) => {
      const duration = timelineDurationRef.current
      if (duration <= 0) return
      if (isTimelinePlayingRef.current) pauseTimeline()
      const dir = direction < 0 ? -1 : 1
      const time = timelineTimeRef.current
      const frameDuration = 1 / getTimelineFpsAt(time)
      const currentFrame = Math.round(time / frameDuration)
      const nextTime = clampTimelineTime(
        (currentFrame + dir) * frameDuration,
        duration
      )
      setTimelineTime(nextTime)
    },
    [getTimelineFpsAt, pauseTimeline, setTimelineTime]
  )

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
        // Open-time autoplay: the project was hydrated with playable media and
        // this is the first video element to become ready. Start playback once,
        // now that there's a decodable frame and the timeline has a real
        // duration. `playTimeline` clears the flag, so additional elements
        // registering later just keep in sync (they read the live playing
        // state above) instead of restarting playback. The titlebar
        // "Autoplay" preference is read here — at fire time, not arm time —
        // so a toggle always applies to the very next open.
        if (
          autoplayPendingRef.current &&
          getAutoplayOnOpenEnabled() &&
          !isTimelinePlayingRef.current &&
          timelineDurationRef.current > 0 &&
          !(typeof document !== "undefined" && document.hidden)
        ) {
          playTimeline()
        }
        return
      }

      timelineVideoElementsRef.current.delete(id)
      clearCommittedEntry(id)
      videoFpsRef.current.delete(id)
    },
    [clearCommittedEntry, playTimeline, seekElementToTimeline]
  )

  // Records a measured source frame rate for an element (see the canvas video
  // node's playback frame-callback sampler). Session-only: held in a ref, never
  // persisted, read only by frame-stepping. Tolerant of bad inputs.
  const registerTimelineVideoFps = useCallback((id: string, fps: number) => {
    if (!Number.isFinite(fps) || fps <= 0) return
    videoFpsRef.current.set(id, fps)
  }, [])

  const registerTimelineCanvasNode = useCallback(
    (id: string, node: PixiNodeHandle | null) => {
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

  // Slow-path hydration: seed the undo baseline the instant the auto-added
  // recording commits to canvas state, rather than waiting for its debounced
  // autosave. Seeding here (not in `pushHistoryFromAutosave`) guarantees the
  // baseline is the recording-ready state before the user can interact, so
  // their very first edit lands at cursor 1 and is undoable — without ever
  // exposing the blank-canvas state as an undo step. The recording-add's own
  // autosave then matches this fingerprint and refreshes rather than appends.
  useEffect(() => {
    if (!hydrationSeedPendingRef.current) return
    if (videosRef.current.length === 0) return
    const snapshot = serializeProjectState(
      artboardRef.current,
      videosRef.current,
      timelineClipsRef.current,
      detachedVideosRef.current,
      zoomClipsRef.current
    )
    historyRef.current = {
      past: [
        {
          state: snapshot,
          fingerprint: fingerprintProjectState(snapshot),
          tag: "unknown",
          timestamp: Date.now(),
        },
      ],
      cursor: 0,
    }
    hydrationSeedPendingRef.current = false
    setCanUndo(false)
    setCanRedo(false)
  }, [videos, timelineClips])

  // One-shot auto-zoom generation. On the first open of a fresh recording the
  // slow path arms `autoZoomPendingRef`; once the screen recording and its
  // timeline clip are committed, generate zoom clips from the captured cursor /
  // click data and commit them like an ordinary edit (a single
  // `zoom-auto-generate` undo step). The output is persisted, so later opens
  // restore it via the fast path and this never runs again. Detection failures
  // (missing/corrupt sidecars) emit no clips and never block the editor.
  const runAutoZoomDetection = useCallback(async () => {
    const activeProject = project
    if (!activeProject) return
    let clips: CanvasZoomClip[] = []
    try {
      const screen = videosRef.current.find((video) => video.role === "screen")
      if (!screen || screen.source.kind !== "recording") return
      const folder =
        activeProject.path ?? projectFolderFromObjectUrl(screen.objectUrl)
      if (!folder) return
      const data = await window.api?.projects.getCursorData(folder)
      // The project may have switched during the async read.
      if (hydratedProjectIdRef.current !== activeProject.id) return
      if (!data) return
      const screenClips = timelineClipsRef.current
        .filter((clip) => clip.videoId === screen.id)
        .sort((a, b) => a.start - b.start || a.end - b.end)
      if (screenClips.length === 0) return
      const samples = autoZoomClicksFromCursorData(data, screen, screenClips, {
        width: artboardRef.current.width,
        height: artboardRef.current.height,
      })
      clips = buildAutoZoomClips(
        samples,
        getTimelineDurationForClips(timelineClipsRef.current)
      )
    } catch (error) {
      console.warn("[provider] auto-zoom generation failed:", error)
      clips = []
    } finally {
      if (hydratedProjectIdRef.current === activeProject.id && clips.length > 0) {
        historyCommitTagRef.current = "zoom-auto-generate"
        commitZoomClipsRef(clips)
        setZoomClips(clips)
      }
    }
  }, [project, commitZoomClipsRef])

  // Fire the one-shot detector once the recording's screen video AND its
  // timeline clip exist. Armed only in the slow path, so fast-path re-opens
  // (which restore the persisted clips) leave the ref false and never re-detect.
  useEffect(() => {
    if (!autoZoomPendingRef.current) return
    const screen = videosRef.current.find((video) => video.role === "screen")
    if (!screen) return
    if (!timelineClipsRef.current.some((clip) => clip.videoId === screen.id)) {
      return
    }
    autoZoomPendingRef.current = false
    void runAutoZoomDetection()
  }, [videos, timelineClips, runAutoZoomDetection])

  const setViewportSize = useCallback((size: CanvasSize): ViewTransform => {
    const nextSize = {
      width: Math.max(0, Math.floor(size.width)),
      height: Math.max(0, Math.floor(size.height)),
    }

    if (
      viewportSizeRef.current.width === nextSize.width &&
      viewportSizeRef.current.height === nextSize.height
    ) {
      return viewTransformRef.current
    }

    setViewportSizeState((current) =>
      current.width === nextSize.width && current.height === nextSize.height
        ? current
        : nextSize
    )

    viewportSizeRef.current = nextSize

    // In fullscreen preview the workspace owns the view transform imperatively
    // (a zero-padding fill-fit). Leave the persisted user transform untouched so
    // it can be restored on exit, and don't fight the imperative preview fit.
    if (isPreviewModeRef.current) return viewTransformRef.current

    if (!hasCustomViewRef.current) {
      const fitTransform = getFitViewTransform(nextSize, artboardRef.current)
      viewTransformRef.current = fitTransform
      setViewTransformState(fitTransform)
      return fitTransform
    }

    const clampedTransform = clampWorkspaceView(
      viewTransformRef.current,
      nextSize,
      artboardRef.current
    )
    viewTransformRef.current = clampedTransform
    setViewTransformState(clampedTransform)
    return clampedTransform
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

  // Pure session-state toggles. All side effects (fullscreen request/exit,
  // playback start, fill-fit transform, restore) live in the workspace effects
  // that key on `isPreviewMode`, so the provider stays DOM-free.
  const enterPreview = useCallback(() => {
    isPreviewModeRef.current = true
    setIsPreviewMode(true)
  }, [])

  const exitPreview = useCallback(() => {
    isPreviewModeRef.current = false
    setIsPreviewMode(false)
  }, [])

  const setArtboardPreset = useCallback(
    (id: ArtboardPresetId) => {
      // Preset is a destructive layout reshape (videos relayout under it) so
      // commit any prior pending debounce as its own history entry before
      // we mutate.
      flushAutosaveNow()
      historyCommitTagRef.current = "preset"
      const prevBackground = artboardRef.current.background
      const prevGrain = artboardRef.current.grain
      const prevPadding = artboardRef.current.padding
      const prevBackgroundEnabled = artboardRef.current.backgroundEnabled
      const prevCursorCustomRenderingEnabled =
        artboardRef.current.cursorCustomRenderingEnabled
      const prevCursorSetId = artboardRef.current.cursorSetId
      const prevCursorSize = artboardRef.current.cursorSizeMultiplier
      const prevCursorMotionBlur = artboardRef.current.cursorMotionBlur
      const prevCursorMotionRotation = artboardRef.current.cursorMotionRotation
      const prevCursorSmoothingMode = artboardRef.current.cursorSmoothingMode
      const prevCursorClickPressScale =
        artboardRef.current.cursorClickPressScale
      const prevCursorAlwaysUsePointer =
        artboardRef.current.cursorAlwaysUsePointer
      let nextArtboard: EditorArtboard
      if (id === AUTO_ARTBOARD_PRESET_ID) {
        // Screen-source dims when hydration captured them, else the on-canvas
        // video's intrinsic size (imported videos) — same chain the preset
        // dropdown displays, so Auto applies exactly what it advertised.
        const auto = resolveAutoArtboard(
          resolveAutoSourceDims(sourceVideoDimsRef.current, videosRef.current)
        )
        nextArtboard = {
          presetId: AUTO_ARTBOARD_PRESET_ID,
          width: auto.width,
          height: auto.height,
          background: prevBackground,
          grain: prevGrain,
          padding: prevPadding,
          backgroundEnabled: prevBackgroundEnabled,
          cursorCustomRenderingEnabled: prevCursorCustomRenderingEnabled,
          cursorSetId: prevCursorSetId,
          cursorSizeMultiplier: prevCursorSize,
          cursorMotionBlur: prevCursorMotionBlur,
          cursorMotionRotation: prevCursorMotionRotation,
          cursorSmoothingMode: prevCursorSmoothingMode,
          cursorClickPressScale: prevCursorClickPressScale,
          cursorAlwaysUsePointer: prevCursorAlwaysUsePointer,
        }
      } else {
        const preset = getArtboardPreset(id)
        nextArtboard = {
          presetId: preset.id,
          width: preset.width,
          height: preset.height,
          background: prevBackground,
          grain: prevGrain,
          padding: prevPadding,
          backgroundEnabled: prevBackgroundEnabled,
          cursorCustomRenderingEnabled: prevCursorCustomRenderingEnabled,
          cursorSetId: prevCursorSetId,
          cursorSizeMultiplier: prevCursorSize,
          cursorMotionBlur: prevCursorMotionBlur,
          cursorMotionRotation: prevCursorMotionRotation,
          cursorSmoothingMode: prevCursorSmoothingMode,
          cursorClickPressScale: prevCursorClickPressScale,
          cursorAlwaysUsePointer: prevCursorAlwaysUsePointer,
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

      // Placement is fully derived — re-run the auto layout for every video
      // against the new artboard size (see `lib/video-placement.ts`).
      setVideos((current) => {
        const nextVideos = applyAutoLayout(current, nextArtboard)
        if (nextVideos === current) return current
        commitVideosRef(nextVideos)
        return nextVideos
      })
    },
    [commitVideosRef, flushAutosaveNow]
  )

  const moveTimelineClip = useCallback(
    (id: string, start: number) => {
      historyCommitTagRef.current = "clip-move"
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
        syncTimelineMedia(timelineTimeRef.current, isTimelinePlayingRef.current)
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
      historyCommitTagRef.current = "clip-resize"
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
        syncTimelineMedia(timelineTimeRef.current, isTimelinePlayingRef.current)
      }
    },
    [commitTimelineClipsRef, syncTimelineMedia]
  )

  // --- Manual Zoom-track clips ---------------------------------------------
  // Zoom clips are output camera effects. Mutations update persisted state and
  // the workspace/export paths sample the current list by composition time.
  // Reads use the live ref so consecutive actions in one tick see fresh state.
  const selectZoomClip = useCallback((id: string | null) => {
    selectedZoomClipIdRef.current = id
    setSelectedZoomClipId((current) => (current === id ? current : id))
    // A zoom clip and a video are never co-selected: the right-panel inspector
    // and canvas Transformer key off `selectedItemId`, so clear it.
    if (id !== null) {
      selectedItemIdRef.current = null
      setSelectedItemId((current) => (current === null ? current : null))
    }
  }, [])

  const addZoomClip = useCallback(
    (start: number, end: number) => {
      const placed = placeZoomSpan(
        zoomClipsRef.current,
        timelineDurationRef.current,
        start,
        end,
        null
      )
      if (!placed) return
      const clip = withZoomClipDefaults({
        id: createZoomClipId(),
        start: placed.start,
        end: placed.end,
      })
      const next = [...zoomClipsRef.current, clip].sort(
        (a, b) => a.start - b.start
      )
      historyCommitTagRef.current = "zoom-add"
      commitZoomClipsRef(next)
      setZoomClips(next)
      selectZoomClip(clip.id)
    },
    [commitZoomClipsRef, selectZoomClip]
  )

  const moveZoomClip = useCallback(
    (id: string, start: number) => {
      const clip = zoomClipsRef.current.find((c) => c.id === id)
      if (!clip) return
      // Neighbour-aware clamp + weld (same helper as the panel's real-time
      // clamp, so dragged preview === committed span). A request that would
      // overlap slides flush against the neighbour instead of silently
      // reverting, and drag-end pixel→time float residue welds to exact
      // adjacency so flush clips abut with a zero-second gap in project.json.
      const placed = clampZoomMove(
        zoomClipsRef.current,
        Math.max(0, timelineDurationRef.current),
        clip,
        start
      )
      if (placed.start === clip.start && placed.end === clip.end) return
      historyCommitTagRef.current = "zoom-move"
      const next = zoomClipsRef.current
        .map((c) =>
          c.id === id ? { ...c, start: placed.start, end: placed.end } : c
        )
        .sort((a, b) => a.start - b.start)
      commitZoomClipsRef(next)
      setZoomClips(next)
    },
    [commitZoomClipsRef]
  )

  const resizeZoomClip = useCallback(
    (id: string, start: number, end: number, direction: "left" | "right") => {
      const clip = zoomClipsRef.current.find((c) => c.id === id)
      if (!clip) return
      // Neighbour-aware clamp + weld — see moveZoomClip. The moving edge
      // stops flush at the neighbour / timeline bound / minimum duration; the
      // anchored edge is kept exactly as committed.
      const placed = clampZoomResize(
        zoomClipsRef.current,
        Math.max(0, timelineDurationRef.current),
        clip,
        { start, end },
        direction
      )
      if (placed.start === clip.start && placed.end === clip.end) return
      historyCommitTagRef.current = "zoom-resize"
      const next = zoomClipsRef.current
        .map((c) =>
          c.id === id ? { ...c, start: placed.start, end: placed.end } : c
        )
        .sort((a, b) => a.start - b.start)
      commitZoomClipsRef(next)
      setZoomClips(next)
    },
    [commitZoomClipsRef]
  )

  const updateZoomClip = useCallback(
    (id: string, patch: CanvasZoomClipPatch) => {
      const current = zoomClipsRef.current.find((c) => c.id === id)
      if (!current) return
      const sanitized = sanitizeZoomClipPatch(patch)
      if (Object.keys(sanitized).length === 0) return
      const nextClip = withZoomClipDefaults({ ...current, ...sanitized })
      const changed =
        nextClip.enabled !== current.enabled ||
        nextClip.focus.x !== current.focus.x ||
        nextClip.focus.y !== current.focus.y ||
        nextClip.scale !== current.scale ||
        nextClip.radialBlur !== current.radialBlur ||
        !zoomRadialBlurSettingsEqual(
          nextClip.radialBlurSettings,
          current.radialBlurSettings
        ) ||
        !zoomTransitionSettingsEqual(nextClip.transition, current.transition) ||
        nextClip.easePreset !== current.easePreset
      if (!changed) return
      historyCommitTagRef.current = "zoom-settings"
      const next = zoomClipsRef.current.map((clip) =>
        clip.id === id ? nextClip : clip
      )
      commitZoomClipsRef(next)
      setZoomClips(next)
    },
    [commitZoomClipsRef]
  )

  const removeZoomClip = useCallback(
    (id: string) => {
      if (!zoomClipsRef.current.some((c) => c.id === id)) return
      historyCommitTagRef.current = "zoom-remove"
      const next = zoomClipsRef.current.filter((c) => c.id !== id)
      commitZoomClipsRef(next)
      setZoomClips(next)
      if (selectedZoomClipIdRef.current === id) {
        selectedZoomClipIdRef.current = null
        setSelectedZoomClipId(null)
      }
    },
    [commitZoomClipsRef]
  )

  // Reported by the canvas's cursor-track loader; React bails on same-value
  // sets so repeated reports are free.
  const reportCursorTrackUnavailable = useCallback((unavailable: boolean) => {
    setCursorTrackUnavailable(unavailable)
  }, [])

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

      // Placement is fully derived from the artboard settings for every role
      // (cover-fit at padding 0, padded contain-fit otherwise).
      const placement = computeVideoPlacement(
        { width: input.intrinsicWidth, height: input.intrinsicHeight },
        artboardRef.current
      )

      const role: CanvasVideoRole =
        input.role === "screen" || input.role === "camera"
          ? input.role
          : "media"

      const item: CanvasVideoItem = {
        id: desiredId,
        fileName: input.fileName,
        objectUrl: input.url,
        fileSize:
          typeof input.fileSize === "number" && Number.isFinite(input.fileSize)
            ? Math.max(0, input.fileSize)
            : 0,
        source: input.source,
        intrinsicWidth: input.intrinsicWidth,
        intrinsicHeight: input.intrinsicHeight,
        durationMs,
        rotation: 0,
        locked: false,
        role,
        ...placement,
        ...createVideoAppearanceDefaults(role, placement),
      }

      // Cache the URL so undo/redo can
      // re-attach it. Recordings need this too — a freshly recorded project
      // has no `project.json` yet, so `assetUrlsByVideoId` is empty and this
      // session cache is the only thing that survives a restore onto a snapshot
      // whose video is briefly off the canvas (e.g. delete then redo). Without
      // it the recording rebuilds with an empty URL and the canvas renders
      // blank. Then bracket the mutation with a destructive flush + tag.
      sessionVideoUrlsRef.current.set(desiredId, input.url)
      flushAutosaveNow()
      historyCommitTagRef.current = "add"
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
    [commitTimelineClipsRef, commitVideosRef, flushAutosaveNow]
  )

  const selectItem = useCallback((id: string | null) => {
    selectedItemIdRef.current = id
    setSelectedItemId((current) => (current === id ? current : id))
    // A zoom clip and a video are never co-selected; selecting a video clears
    // any zoom-clip selection.
    if (id !== null && selectedZoomClipIdRef.current !== null) {
      selectedZoomClipIdRef.current = null
      setSelectedZoomClipId(null)
    }
  }, [])

  const setArtboardGrain = useCallback((grain: number) => {
    const current = artboardRef.current
    const clamped = Math.max(0, Math.min(100, Math.round(grain)))
    if (current.grain === clamped) return
    historyCommitTagRef.current = "grain"
    const nextArtboard: EditorArtboard = { ...current, grain: clamped }
    artboardRef.current = nextArtboard
    setArtboard(nextArtboard)
  }, [])

  // Recorded-cursor render size. Pure appearance — it scales the cursor's
  // render box only; position, hotspot, and timing are unaffected (see
  // `placeCursor`), so accuracy is preserved at every size. Stored on the
  // artboard (project-level, one screen recording per project) and applied
  // identically by the editor overlay and the export pipeline.
  const setCursorSizeMultiplier = useCallback((multiplier: number) => {
    const current = artboardRef.current
    const clamped = Math.min(
      CURSOR_SIZE_MAX,
      Math.max(CURSOR_SIZE_MIN, multiplier)
    )
    if (current.cursorSizeMultiplier === clamped) return
    historyCommitTagRef.current = "cursor-size"
    const nextArtboard: EditorArtboard = {
      ...current,
      cursorSizeMultiplier: clamped,
    }
    artboardRef.current = nextArtboard
    setArtboard(nextArtboard)
  }, [])

  const setCursorSmoothingMode = useCallback((mode: CursorSmoothingMode) => {
    const current = artboardRef.current
    const clamped = clampCursorSmoothingMode(mode)
    if (current.cursorSmoothingMode === clamped) return
    historyCommitTagRef.current = "cursor-smoothing"
    const nextArtboard: EditorArtboard = {
      ...current,
      cursorSmoothingMode: clamped,
    }
    artboardRef.current = nextArtboard
    setArtboard(nextArtboard)
  }, [])

  // Target scale for the cursor while a captured click is pressed. `1` means no
  // shrink; the current default is 0.78 (22 % downscale). Stored on the artboard and passed
  // through shared `placeCursor` so preview/export agree.
  const setCursorClickPressScale = useCallback((scale: number) => {
    const current = artboardRef.current
    const clamped = clampCursorClickPressScale(scale)
    if (current.cursorClickPressScale === clamped) return
    historyCommitTagRef.current = "cursor-click-press-scale"
    const nextArtboard: EditorArtboard = {
      ...current,
      cursorClickPressScale: clamped,
    }
    artboardRef.current = nextArtboard
    setArtboard(nextArtboard)
  }, [])

  const setCursorCustomRenderingEnabled = useCallback((enabled: boolean) => {
    const current = artboardRef.current
    const nextEnabled = Boolean(enabled)
    if (current.cursorCustomRenderingEnabled === nextEnabled) return
    historyCommitTagRef.current = "cursor-custom-rendering"
    const nextArtboard: EditorArtboard = {
      ...current,
      cursorCustomRenderingEnabled: nextEnabled,
    }
    artboardRef.current = nextArtboard
    setArtboard(nextArtboard)
  }, [])

  // Master switch for the background treatment (Background tab header). Only
  // the flag flips — background/grain/padding values stay stored so they come
  // back when re-enabled (mirrors setCursorCustomRenderingEnabled).
  const setArtboardBackgroundEnabled = useCallback(
    (enabled: boolean) => {
      const current = artboardRef.current
      const nextEnabled = Boolean(enabled)
      if (current.backgroundEnabled === nextEnabled) return
      historyCommitTagRef.current = "background-enabled"
      const nextArtboard: EditorArtboard = {
        ...current,
        backgroundEnabled: nextEnabled,
      }
      artboardRef.current = nextArtboard
      setArtboard(nextArtboard)

      // The switch also turns the padding *effect* on/off (off ⇒ full-bleed
      // cover-fit): placement is derived, so re-fit every video against the
      // effective padding (`getPaddingInsetPx` reads `backgroundEnabled`) —
      // same flow as setArtboardPadding.
      setVideos((currentVideos) => {
        const nextVideos = applyAutoLayout(currentVideos, nextArtboard)
        if (nextVideos === currentVideos) return currentVideos
        commitVideosRef(nextVideos)
        return nextVideos
      })
    },
    [commitVideosRef]
  )

  const setCursorSetId = useCallback((setId: CursorSetId) => {
    const current = artboardRef.current
    const clamped = clampCursorSetId(setId)
    if (current.cursorSetId === clamped) return
    historyCommitTagRef.current = "cursor-set"
    const nextArtboard: EditorArtboard = {
      ...current,
      cursorSetId: clamped,
    }
    artboardRef.current = nextArtboard
    setArtboard(nextArtboard)
  }, [])

  const setCursorAlwaysUsePointer = useCallback((enabled: boolean) => {
    const current = artboardRef.current
    const nextEnabled = Boolean(enabled)
    if (current.cursorAlwaysUsePointer === nextEnabled) return
    historyCommitTagRef.current = "cursor-always-use-pointer"
    const nextArtboard: EditorArtboard = {
      ...current,
      cursorAlwaysUsePointer: nextEnabled,
    }
    artboardRef.current = nextArtboard
    setArtboard(nextArtboard)
  }, [])

  // Cursor motion-rotation amount (0..1). Shared placement math derives the
  // tilt from the trailing horizontal velocity, so preview/export stay in sync
  // without adding per-frame React state.
  const setCursorMotionRotation = useCallback((amount: number) => {
    const current = artboardRef.current
    const clamped = clampCursorMotionRotation(amount)
    if (current.cursorMotionRotation === clamped) return
    historyCommitTagRef.current = "cursor-motion-rotation"
    const nextArtboard: EditorArtboard = {
      ...current,
      cursorMotionRotation: clamped,
    }
    artboardRef.current = nextArtboard
    setArtboard(nextArtboard)
  }, [])

  // Cursor motion-blur intensity (0..1). The blur velocity is derived from
  // cursor speed (see cursor-scene.ts `computeCursorBlur`); this is the single
  // user-facing amount. Applied identically by the editor overlay and export.
  const setCursorMotionBlur = useCallback((intensity: number) => {
    const current = artboardRef.current
    const clamped = clampCursorMotionBlur(intensity)
    if (current.cursorMotionBlur === clamped) return
    historyCommitTagRef.current = "cursor-motion-blur"
    const nextArtboard: EditorArtboard = {
      ...current,
      cursorMotionBlur: clamped,
    }
    artboardRef.current = nextArtboard
    setArtboard(nextArtboard)
  }, [])

  const setArtboardPadding = useCallback(
    (padding: number) => {
      const current = artboardRef.current
      const clamped = Math.max(
        0,
        Math.min(ARTBOARD_PADDING_MAX, Math.round(padding))
      )
      if (current.padding === clamped) return
      historyCommitTagRef.current = "padding"
      const nextArtboard: EditorArtboard = { ...current, padding: clamped }
      artboardRef.current = nextArtboard
      setArtboard(nextArtboard)

      // Placement is fully derived — re-fit every video (all roles) to the
      // new padded inner rect (cover-fit at padding 0, contain-fit otherwise).
      setVideos((currentVideos) => {
        const nextVideos = applyAutoLayout(currentVideos, nextArtboard)
        if (nextVideos === currentVideos) return currentVideos
        commitVideosRef(nextVideos)
        return nextVideos
      })
    },
    [commitVideosRef]
  )

  const setArtboardBackground = useCallback(
    (background: ArtboardBackground | null) => {
      const current = artboardRef.current
      const prev = current.background
      const isSameBackground =
        (prev === null && background === null) ||
        (prev !== null &&
          background !== null &&
          prev.type === background.type &&
          prev.value === background.value &&
          (prev.type !== "wallpaper" ||
            background.type !== "wallpaper" ||
            (prev.blurRadius ?? 0) === (background.blurRadius ?? 0)))
      if (isSameBackground) return

      historyCommitTagRef.current = "background"
      const nextArtboard: EditorArtboard = { ...current, background }
      artboardRef.current = nextArtboard
      setArtboard(nextArtboard)
    },
    []
  )

  // Appearance updates (radius, smoothing, border). Bail out early
  // when every patched field already matches so the same slider value dragged
  // at its current position never triggers a downstream redraw.
  const updateVideoAppearance = useCallback(
    (id: string, patch: CanvasVideoAppearancePatch) => {
      historyCommitTagRef.current = "appearance"
      setVideos((current) => {
        let didChange = false
        const nextVideos = current.map((video) => {
          if (video.id !== id) return video

          const nextVideo: CanvasVideoItem = { ...video, ...patch }
          if (
            nextVideo.cornerRadius === video.cornerRadius &&
            nextVideo.cornerSmoothing === video.cornerSmoothing &&
            nextVideo.borderWidth === video.borderWidth &&
            nextVideo.borderColor === video.borderColor &&
            nextVideo.borderOffset === video.borderOffset &&
            nextVideo.borderAlignment === video.borderAlignment
          ) {
            return video
          }

          didChange = true
          return nextVideo
        })

        if (!didChange) return current

        commitVideosRef(nextVideos)
        return nextVideos
      })
    },
    [commitVideosRef]
  )

  // "Delete" from the canvas / timeline does NOT remove the video from the
  // project — it detaches it. The full item (position, size, appearance, and
  // its object URL) moves to `detachedVideos` so `addVideoToCanvas` can put it
  // back later, and so the Video tab keeps listing it. We intentionally drop
  // its timeline clip; re-adding creates a fresh full-length clip. The object
  // URL is left alive because the video is still part of the project.
  const deleteVideo = useCallback(
    (id: string) => {
      const currentVideos = videosRef.current
      const detachedVideo = currentVideos.find((video) => video.id === id)
      if (!detachedVideo) return
      // Already detached? Nothing to do (defensive against double-fire).
      if (detachedVideosRef.current.some((video) => video.id === id)) return

      flushAutosaveNow()
      historyCommitTagRef.current = "delete"

      const nextVideos = currentVideos.filter((video) => video.id !== id)
      commitVideosRef(nextVideos)
      const nextClips = timelineClipsRef.current.filter(
        (clip) => clip.videoId !== id
      )
      commitTimelineClipsRef(nextClips)
      const nextDetached = [...detachedVideosRef.current, detachedVideo]
      commitDetachedVideosRef(nextDetached)

      setVideos(nextVideos)
      setTimelineClips(nextClips)
      setDetachedVideos(nextDetached)

      if (selectedItemIdRef.current === id) {
        selectedItemIdRef.current = null
        setSelectedItemId(null)
      }
    },
    [
      commitDetachedVideosRef,
      commitTimelineClipsRef,
      commitVideosRef,
      flushAutosaveNow,
    ]
  )

  // Inverse of `deleteVideo`: put a detached video back on the canvas and
  // timeline. The stored item keeps its appearance, but placement is derived
  // — it is recomputed against the *current* artboard settings so the video
  // lands per today's padding/preset, not wherever it sat before removal. We
  // mint a fresh full-length timeline clip (the trim from before removal is
  // intentionally not preserved) and select the restored video.
  const addVideoToCanvas = useCallback(
    (id: string) => {
      const detached = detachedVideosRef.current.find(
        (video) => video.id === id
      )
      if (!detached) return
      // Guard against an id that somehow already lives on the canvas.
      if (videosRef.current.some((video) => video.id === id)) return

      // Adding is a discrete, undoable boundary — flush the prior edit window
      // as its own history entry, then tag this mutation so the next autosave
      // records the add separately.
      flushAutosaveNow()
      historyCommitTagRef.current = "add"

      const restored: CanvasVideoItem = {
        ...detached,
        ...computeVideoPlacement(
          { width: detached.intrinsicWidth, height: detached.intrinsicHeight },
          artboardRef.current
        ),
        rotation: 0,
      }
      const nextDetached = detachedVideosRef.current.filter(
        (video) => video.id !== id
      )
      commitDetachedVideosRef(nextDetached)
      const nextVideos = [...videosRef.current, restored]
      commitVideosRef(nextVideos)
      const nextClips = [
        ...timelineClipsRef.current,
        createTimelineClip(restored),
      ]
      commitTimelineClipsRef(nextClips)

      setDetachedVideos(nextDetached)
      setVideos(nextVideos)
      setTimelineClips(nextClips)

      selectedItemIdRef.current = id
      setSelectedItemId(id)
    },
    [
      commitDetachedVideosRef,
      commitTimelineClipsRef,
      commitVideosRef,
      flushAutosaveNow,
    ]
  )

  // Pure helper: pick the URL for a restored video. Recording sources come
  // from main's per-project asset map; imported sources fall back to a
  // session cache populated when the file was first imported. Returns ""
  // for missing files — the renderer keeps the broken node visible so the
  // user can see what's wrong, identical to hydration semantics.
  const resolveObjectUrlForRestore = useCallback(
    (video: ProjectStateV1["videos"][number]): string => {
      const currentProject = projectRef.current
      const existing =
        videoByIdRef.current.get(video.id) ??
        detachedVideosRef.current.find((item) => item.id === video.id)
      if (existing && existing.objectUrl) return existing.objectUrl
      const fromProject = currentProject?.assetUrlsByVideoId[video.id]
      if (fromProject) return fromProject
      // Session URL cache covers both imported and recording sources. For a
      // freshly recorded project this is the only place the URL lives —
      // `assetUrlsByVideoId` stays empty until a `project.json` exists.
      const cached = sessionVideoUrlsRef.current.get(video.id)
      if (cached) return cached
      return ""
    },
    []
  )

  // Pure helper: resolve a restored video's byte size. Imported sources carry
  // their size in the saved record; recording sources don't — their size is
  // owned by the on-disk asset (re-stat'd by main on every project open), so
  // we read it from `project.assets` by role. Without this, recordings load
  // back as 0 bytes and the video panel shows "Unknown size" after a refresh.
  // A live in-memory item (undo/redo within a session) is preferred when it
  // already resolved a non-zero size. Returns 0 when the asset is gone, which
  // the panel renders honestly as "Unknown size".
  const resolveFileSizeForRestore = useCallback(
    (video: ProjectStateV1["videos"][number]): number => {
      if (video.source.kind === "imported") return video.source.fileSize
      const existing =
        videoByIdRef.current.get(video.id) ??
        detachedVideosRef.current.find((item) => item.id === video.id)
      if (existing && existing.fileSize > 0) return existing.fileSize
      const assetRole = video.source.assetRole
      const asset = projectRef.current?.assets.find(
        (candidate) => candidate.role === assetRole
      )
      return asset?.fileSize ?? 0
    },
    []
  )

  const restoreHistorySnapshot = useCallback(
    (direction: -1 | 1) => {
      const history = historyRef.current
      const target =
        direction === -1
          ? getUndoTargetEntry(history)
          : getRedoTargetEntry(history)
      if (!target) return

      const savedState = target.state
      const savedArtboard: EditorArtboard = {
        presetId: savedState.artboard.presetId,
        width: savedState.artboard.width,
        height: savedState.artboard.height,
        background: savedState.artboard.background,
        grain: savedState.artboard.grain,
        padding: savedState.artboard.padding,
        backgroundEnabled: savedState.artboard.backgroundEnabled !== false,
        cursorCustomRenderingEnabled:
          savedState.artboard.cursorCustomRenderingEnabled !== false,
        cursorSetId: clampCursorSetId(savedState.artboard.cursorSetId),
        cursorSizeMultiplier:
          savedState.artboard.cursorSizeMultiplier ?? CURSOR_SIZE_DEFAULT,
        cursorMotionBlur:
          savedState.artboard.cursorMotionBlur ?? CURSOR_MOTION_BLUR_DEFAULT,
        cursorMotionRotation: clampCursorMotionRotation(
          savedState.artboard.cursorMotionRotation ??
            CURSOR_MOTION_ROTATION_DEFAULT
        ),
        cursorSmoothingMode: clampCursorSmoothingMode(
          savedState.artboard.cursorSmoothingMode
        ),
        cursorClickPressScale: clampCursorClickPressScale(
          savedState.artboard.cursorClickPressScale ??
            CURSOR_CLICK_PRESS_SCALE_DEFAULT
        ),
        cursorAlwaysUsePointer:
          savedState.artboard.cursorAlwaysUsePointer === true,
      }
      const toCanvasVideo = (video: ProjectStateV1["videos"][number]) =>
        projectVideoToCanvasVideo(
          video,
          resolveObjectUrlForRestore(video),
          resolveFileSizeForRestore(video)
        )
      const restoredVideos: CanvasVideoItem[] = savedState.videos
        .filter((video) => video.onCanvas !== false)
        .map(toCanvasVideo)
      const restoredDetached: CanvasVideoItem[] = savedState.videos
        .filter((video) => video.onCanvas === false)
        .map(toCanvasVideo)
      // Clips only ever belong to on-canvas videos; filter defensively so a
      // stale clip for a detached video can't slip into the live timeline.
      const restoredVideoIds = new Set(restoredVideos.map((video) => video.id))
      const restoredClips: CanvasTimelineClip[] = savedState.timelineClips
        .filter((clip) => restoredVideoIds.has(clip.videoId))
        .map(projectClipToCanvasClip)
      const restoredZoomClips = normalizeZoomClips(
        (savedState.zoomClips ?? []).map(projectZoomClipToCanvasClip),
        getTimelineDurationForClips(restoredClips)
      )

      // Prune measured-fps entries for videos the restored snapshot no
      // longer contains (on-canvas or detached). Without this, undoing past
      // an add leaves a stale fps keyed by the removed id; frame-stepping a
      // later video that reuses the id would read the wrong rate.
      const snapshotVideoIds = new Set(
        savedState.videos.map((video) => video.id)
      )
      for (const id of Array.from(videoFpsRef.current.keys())) {
        if (!snapshotVideoIds.has(id)) videoFpsRef.current.delete(id)
      }

      restoringFromHistoryRef.current = true
      historyRef.current = {
        past: history.past,
        cursor: history.cursor + direction,
      }

      const prevArtboard = artboardRef.current
      artboardRef.current = savedArtboard
      commitVideosRef(restoredVideos)
      commitDetachedVideosRef(restoredDetached)
      commitTimelineClipsRef(restoredClips)
      commitZoomClipsRef(restoredZoomClips)
      setArtboard(savedArtboard)
      setVideos(restoredVideos)
      setDetachedVideos(restoredDetached)
      setTimelineClips(restoredClips)
      setZoomClips(restoredZoomClips)
      // Drop the zoom selection if the restored set no longer contains it
      // (session-only state isn't part of the snapshot).
      if (
        selectedZoomClipIdRef.current !== null &&
        !restoredZoomClips.some((c) => c.id === selectedZoomClipIdRef.current)
      ) {
        selectedZoomClipIdRef.current = null
        setSelectedZoomClipId(null)
      }

      // If the restored artboard has different dimensions, refit the view
      // to it — matches `setArtboardPreset`'s behavior so undoing/redoing
      // a preset change leaves the canvas zoomed to fit the new size
      // instead of stranding it at the previous fit.
      if (
        prevArtboard.width !== savedArtboard.width ||
        prevArtboard.height !== savedArtboard.height
      ) {
        hasCustomViewRef.current = false
        const fitTransform = getFitViewTransform(
          viewportSizeRef.current,
          savedArtboard
        )
        viewTransformRef.current = fitTransform
        setViewTransformState(fitTransform)
      }

      // Clear selection if the previously-selected video no longer exists
      // in the restored set. Artboard selection is always valid.
      const selId = selectedItemIdRef.current
      if (
        selId !== null &&
        selId !== ARTBOARD_SELECTION_ID &&
        !restoredVideos.some((video) => video.id === selId)
      ) {
        selectedItemIdRef.current = null
        setSelectedItemId(null)
      }

      // Clamp the playhead if the restored timeline is shorter than the
      // current position. Sync media so the canvas catches up immediately.
      const newDuration = getTimelineDurationForClips(restoredClips)
      if (timelineTimeRef.current > newDuration) {
        const clamped = clampTimelineTime(timelineTimeRef.current, newDuration)
        timelineTimeRef.current = clamped
        setTimelineTimeState(clamped)
      }

      // Re-sync timeline media so the canvas reflects the restored clip timing
      // immediately. Mounted elements (same id + objectUrl across a trim/split/
      // move undo) don't re-seek on their own — `CanvasVideoNode` only seeks on
      // mount — and `syncTimelineMedia` is no longer fired by a videos/clips
      // effect, so the restore must drive it explicitly or the canvas strands a
      // stale frame and stale clip visibility until the next scrub.
      syncTimelineMedia(timelineTimeRef.current, isTimelinePlayingRef.current)

      setCanUndo(canUndoHistory(historyRef.current))
      setCanRedo(canRedoHistory(historyRef.current))
    },
    [
      commitDetachedVideosRef,
      commitTimelineClipsRef,
      commitZoomClipsRef,
      commitVideosRef,
      resolveObjectUrlForRestore,
      resolveFileSizeForRestore,
      syncTimelineMedia,
    ]
  )

  const undo = useCallback(() => {
    restoreHistorySnapshot(-1)
  }, [restoreHistorySnapshot])

  const redo = useCallback(() => {
    restoreHistorySnapshot(1)
  }, [restoreHistorySnapshot])

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
      detachedVideos,
      selectedItemId,
      selectedVideo,
    }),
    [detachedVideos, selectedItemId, selectedVideo, videos]
  )

  const artboardValue = useMemo<EditorCanvasArtboardContextValue>(
    () => ({
      artboard,
      sourceVideoDims,
    }),
    [artboard, sourceVideoDims]
  )

  const saveStatusValue = useMemo<EditorCanvasSaveStatusContextValue>(
    () => ({
      status: saveStatus,
      error: saveError,
    }),
    [saveStatus, saveError]
  )

  const cursorDataValue = useMemo<EditorCanvasCursorDataContextValue>(
    () => ({ cursorTrackUnavailable }),
    [cursorTrackUnavailable]
  )

  const historyValue = useMemo<EditorCanvasHistoryContextValue>(
    () => ({ canUndo, canRedo, undo, redo }),
    [canUndo, canRedo, undo, redo]
  )

  const viewValue = useMemo<EditorCanvasViewContextValue>(
    () => ({
      viewportSize,
      viewTransform,
      isPreviewMode,
    }),
    [isPreviewMode, viewTransform, viewportSize]
  )

  const timelineValue = useMemo<EditorCanvasTimelineContextValue>(
    () => ({
      timelineClips,
      selectedTimelineClip,
      zoomClips,
      selectedZoomClipId,
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
      zoomClips,
      selectedZoomClipId,
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
      addRemoteVideo,
      reportCursorTrackUnavailable,
      selectItem,
      updateVideoAppearance,
      deleteVideo,
      addVideoToCanvas,
      setArtboardPreset,
      setArtboardBackground,
      setArtboardBackgroundEnabled,
      setArtboardGrain,
      setArtboardPadding,
      setCursorCustomRenderingEnabled,
      setCursorSetId,
      setCursorSizeMultiplier,
      setCursorSmoothingMode,
      setCursorClickPressScale,
      setCursorAlwaysUsePointer,
      setCursorMotionRotation,
      setCursorMotionBlur,
      setViewportSize,
      setViewTransform,
      fitArtboardToViewport,
      enterPreview,
      exitPreview,
    }),
    [
      addRemoteVideo,
      reportCursorTrackUnavailable,
      selectItem,
      updateVideoAppearance,
      deleteVideo,
      addVideoToCanvas,
      setArtboardPreset,
      setArtboardBackground,
      setArtboardBackgroundEnabled,
      setArtboardGrain,
      setArtboardPadding,
      setCursorCustomRenderingEnabled,
      setCursorSetId,
      setCursorSizeMultiplier,
      setCursorSmoothingMode,
      setCursorClickPressScale,
      setCursorAlwaysUsePointer,
      setCursorMotionRotation,
      setCursorMotionBlur,
      setViewportSize,
      setViewTransform,
      fitArtboardToViewport,
      enterPreview,
      exitPreview,
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
      addZoomClip,
      moveZoomClip,
      resizeZoomClip,
      updateZoomClip,
      removeZoomClip,
      selectZoomClip,
      subscribeTimelineTicks,
      stepTimelineFrame,
      registerTimelineVideoFps,
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
      addZoomClip,
      moveZoomClip,
      resizeZoomClip,
      updateZoomClip,
      removeZoomClip,
      selectZoomClip,
      subscribeTimelineTicks,
      stepTimelineFrame,
      registerTimelineVideoFps,
    ]
  )

  useEffect(() => {
    if (!project) return
    if (hydratedProjectIdRef.current === project.id) return

    const findAsset = (role: ProjectAsset["role"]) =>
      project.assets.find((asset) => asset.role === role) ?? null

    // Reset prior project's transient state before adopting the new one.
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
      // Tear down the previous project's seek pipeline: cancel any in-flight
      // committed scrub seeks + the pending readout commit, and drop measured
      // fps (session-only) so the new project re-measures from its own clips.
      if (timelineStateCommitTimerRef.current !== null) {
        clearTimeout(timelineStateCommitTimerRef.current)
        timelineStateCommitTimerRef.current = null
      }
      committedSeekStateRef.current.forEach((entry) => {
        window.clearTimeout(entry.timeoutId)
      })
      committedSeekStateRef.current.clear()
      videoFpsRef.current.clear()
      if (autosaveTimerRef.current !== null) {
        clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
      if (autosaveRetryTimerRef.current !== null) {
        clearTimeout(autosaveRetryTimerRef.current)
        autosaveRetryTimerRef.current = null
      }
      autosavePendingRef.current = false
      // Save-status carries over between projects without this reset and can
      // strand the indicator on "saving" or "error" forever if the new
      // project never produces an edit. Wipe both the status and the
      // last-written fingerprint so the new project starts from a clean
      // slate; the hydration paths below will seed `saved` again.
      lastWrittenSerializedRef.current = null
      setSaveStatus("saved")
      setSaveError(null)
      // Each project owns its own undo stack; clear it before adopting the
      // new project so Cmd+Z in project B doesn't return project A's state.
      historyRef.current = createEmptyHistory()
      historyCommitTagRef.current = null
      restoringFromHistoryRef.current = false
      hydrationSeedPendingRef.current = false
      autoZoomPendingRef.current = false
      sessionVideoUrlsRef.current.clear()
      setCanUndo(false)
      setCanRedo(false)
      commitVideosRef([])
      commitDetachedVideosRef([])
      commitTimelineClipsRef([])
      commitZoomClipsRef([])
      timelineCanvasNodesRef.current.forEach((node) => {
        node.visible(false)
        node.listening(false)
        node.getLayer()?.batchDraw()
      })
      commitTimelineVisibleVideoIds(new Set())
      timelineTimeRef.current = 0
      isTimelinePlayingRef.current = false
      // Clear any autoplay armed by the previous project so it can't fire
      // against the incoming one before the hydration paths below re-arm it.
      autoplayPendingRef.current = false
      isPreviewModeRef.current = false
      selectedItemIdRef.current = null
      selectedZoomClipIdRef.current = null
      // Source dims belong to the previous project's screen recording — clear
      // them (ref + mirror) so a project without a screen asset resolves Auto
      // to the Wide fallback instead of the stale dims.
      sourceVideoDimsRef.current = null
      setVideos([])
      setDetachedVideos([])
      setTimelineClips([])
      setZoomClips([])
      setTimelineTimeState(0)
      setIsTimelinePlaying(false)
      setIsPreviewMode(false)
      setSelectedItemId(null)
      setSelectedZoomClipId(null)
      setSourceVideoDims(null)
      // Cursor-data health belongs to the previous project's recording; the
      // canvas re-reports for the new one once its track loads (or fails).
      setCursorTrackUnavailable(false)
    }

    hydrationGenerationRef.current += 1
    const hydrationGeneration = hydrationGenerationRef.current
    const shouldAbort = () =>
      hydrationGenerationRef.current !== hydrationGeneration

    // FAST PATH: project.json exists. We trust the saved state verbatim and
    // skip the metadata-probing hop because the saved record already carries
    // intrinsic size + duration. URLs for each video id were resolved in main
    // and arrive in `assetUrlsByVideoId`.
    if (project.state) {
      const savedState = project.state
      const savedArtboard: EditorArtboard = {
        presetId: savedState.artboard.presetId,
        width: savedState.artboard.width,
        height: savedState.artboard.height,
        background: savedState.artboard.background,
        grain: savedState.artboard.grain,
        padding: savedState.artboard.padding,
        backgroundEnabled: savedState.artboard.backgroundEnabled !== false,
        cursorCustomRenderingEnabled:
          savedState.artboard.cursorCustomRenderingEnabled !== false,
        cursorSetId: clampCursorSetId(savedState.artboard.cursorSetId),
        cursorSizeMultiplier:
          savedState.artboard.cursorSizeMultiplier ?? CURSOR_SIZE_DEFAULT,
        cursorMotionBlur:
          savedState.artboard.cursorMotionBlur ?? CURSOR_MOTION_BLUR_DEFAULT,
        cursorMotionRotation: clampCursorMotionRotation(
          savedState.artboard.cursorMotionRotation ??
            CURSOR_MOTION_ROTATION_DEFAULT
        ),
        cursorSmoothingMode: clampCursorSmoothingMode(
          savedState.artboard.cursorSmoothingMode
        ),
        cursorClickPressScale: clampCursorClickPressScale(
          savedState.artboard.cursorClickPressScale ??
            CURSOR_CLICK_PRESS_SCALE_DEFAULT
        ),
        cursorAlwaysUsePointer:
          savedState.artboard.cursorAlwaysUsePointer === true,
      }
      artboardRef.current = savedArtboard
      // Hydration is a one-shot synchronization from disk into React state —
      // the surrounding slow path performs the same pattern. Cascading-render
      // warnings don't apply when the effect's sole job is to seed state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setArtboard(savedArtboard)
      // Fast path = on-disk state matches in-memory state at this instant.
      // Surface that as "saved" so the titlebar indicator doesn't lie about
      // unwritten changes for the brief window before the first autosave
      // fires (the autosave effect will rewrite the same snapshot, which is
      // a benign no-op).
      setSaveStatus("saved")
      setSaveError(null)
      hasCustomViewRef.current = false
      const fit = getFitViewTransform(viewportSizeRef.current, savedArtboard)
      viewTransformRef.current = fit
      setViewTransformState(fit)

      const screenAsset = findAsset("screen")
      if (screenAsset?.width && screenAsset?.height) {
        sourceVideoDimsRef.current = {
          width: screenAsset.width,
          height: screenAsset.height,
        }
        setSourceVideoDims({
          width: screenAsset.width,
          height: screenAsset.height,
        })
      }

      const toCanvasVideo = (video: ProjectStateV1["videos"][number]) =>
        projectVideoToCanvasVideo(
          video,
          project.assetUrlsByVideoId[video.id] ?? "",
          resolveFileSizeForRestore(video)
        )
      // `onCanvas === false` videos were removed from the canvas but kept in
      // the project; hydrate them into the detached list so the Video tab can
      // offer to add them back. Everything else (including legacy records with
      // no `onCanvas` field) lands on the canvas.
      //
      // Placement is derived, not trusted: saved x/y/width/height/rotation are
      // recomputed from the artboard settings (`applyAutoLayout`), so legacy
      // projects with manually-positioned or rotated videos snap to the
      // settings-driven layout on load. The recomputed list feeds both React
      // state and the hydrated snapshot below, keeping the autosave
      // fingerprint in sync with memory (no redundant save on open; the disk
      // file converges on the next genuine edit).
      const restoredVideos: CanvasVideoItem[] = applyAutoLayout(
        savedState.videos
          .filter((video) => video.onCanvas !== false)
          .map(toCanvasVideo),
        savedArtboard
      )
      const restoredDetached: CanvasVideoItem[] = savedState.videos
        .filter((video) => video.onCanvas === false)
        .map(toCanvasVideo)
      commitVideosRef(restoredVideos)
      commitDetachedVideosRef(restoredDetached)
      setVideos(restoredVideos)
      setDetachedVideos(restoredDetached)

      const restoredVideoIds = new Set(restoredVideos.map((video) => video.id))
      const restoredClips: CanvasTimelineClip[] = savedState.timelineClips
        .filter((clip) => restoredVideoIds.has(clip.videoId))
        .map(projectClipToCanvasClip)
      commitTimelineClipsRef(restoredClips)
      setTimelineClips(restoredClips)

      // Zoom clips reference no video, but they are still clamped to the live
      // timeline and normalized into one non-overlapping lane. This keeps old
      // or hand-edited project.json files from resurrecting collisions.
      const restoredZoomClips = normalizeZoomClips(
        (savedState.zoomClips ?? []).map(projectZoomClipToCanvasClip),
        getTimelineDurationForClips(restoredClips)
      )
      commitZoomClipsRef(restoredZoomClips)
      setZoomClips(restoredZoomClips)

      // Seed the last-written fingerprint with the hydrated snapshot so the
      // autosave effect's immediate post-hydration run sees "no diff" and
      // skips the IPC. Without this, every project open pays an extra
      // redundant write for an indicator that briefly flashes "Saving…".
      const hydratedSnapshot = serializeProjectState(
        savedArtboard,
        restoredVideos,
        restoredClips,
        restoredDetached,
        restoredZoomClips
      )
      const hydratedFingerprint = fingerprintProjectState(hydratedSnapshot)
      lastWrittenSerializedRef.current = hydratedFingerprint

      // Seed the history baseline so the user's first edit is undoable back
      // to the loaded state. Without this, the first edit lands at cursor 0
      // and Cmd+Z has nothing to walk back to.
      const seeded = applyHistoryCommit(
        historyRef.current,
        hydratedSnapshot,
        hydratedFingerprint,
        "unknown",
        Date.now()
      )
      historyRef.current = seeded.next
      setCanUndo(false)
      setCanRedo(false)

      // Arm open-time autoplay when the restored project actually has something
      // on the timeline; the first restored video element to load consumes it.
      autoplayPendingRef.current = restoredClips.length > 0

      hydratedProjectIdRef.current = project.id
      return
    }

    // SLOW PATH: first open after recording. Synthesize defaults from
    // `project.assets` and probe the source videos for accurate duration.
    const screenAsset = findAsset("screen")
    const cameraAsset = findAsset("camera")

    if (!screenAsset && !cameraAsset) {
      hydratedProjectIdRef.current = project.id
      return
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
      setSourceVideoDims({
        width: screenAsset.width,
        height: screenAsset.height,
      })

      // Display captures inherit the source's aspect via the Auto preset so
      // the recording fills the artboard with no letterboxing. Window /
      // region / application captures fall back to the Wide 16:9 preset —
      // those source shapes are arbitrary and would otherwise produce an
      // odd-shaped artboard.
      const useAuto = project.recordingType === "display"
      const previousBackground = artboardRef.current.background
      const previousGrain = artboardRef.current.grain
      const previousPadding = artboardRef.current.padding
      const previousBackgroundEnabled = artboardRef.current.backgroundEnabled
      const previousCursorCustomRenderingEnabled =
        artboardRef.current.cursorCustomRenderingEnabled
      const previousCursorSetId = artboardRef.current.cursorSetId
      const previousCursorSize = artboardRef.current.cursorSizeMultiplier
      const previousCursorMotionBlur = artboardRef.current.cursorMotionBlur
      const previousCursorMotionRotation =
        artboardRef.current.cursorMotionRotation
      const previousCursorSmoothingMode =
        artboardRef.current.cursorSmoothingMode
      const previousCursorClickPressScale =
        artboardRef.current.cursorClickPressScale
      const previousCursorAlwaysUsePointer =
        artboardRef.current.cursorAlwaysUsePointer
      const nextArtboard: EditorArtboard = useAuto
        ? (() => {
            const auto = resolveAutoArtboard(sourceVideoDimsRef.current)
            return {
              presetId: AUTO_ARTBOARD_PRESET_ID,
              width: auto.width,
              height: auto.height,
              background: previousBackground,
              grain: previousGrain,
              padding: previousPadding,
              backgroundEnabled: previousBackgroundEnabled,
              cursorCustomRenderingEnabled:
                previousCursorCustomRenderingEnabled,
              cursorSetId: previousCursorSetId,
              cursorSizeMultiplier: previousCursorSize,
              cursorMotionBlur: previousCursorMotionBlur,
              cursorMotionRotation: previousCursorMotionRotation,
              cursorSmoothingMode: previousCursorSmoothingMode,
              cursorClickPressScale: previousCursorClickPressScale,
              cursorAlwaysUsePointer: previousCursorAlwaysUsePointer,
            }
          })()
        : (() => {
            const preset = getArtboardPreset(DEFAULT_ARTBOARD_PRESET_ID)
            return {
              presetId: preset.id,
              width: preset.width,
              height: preset.height,
              background: previousBackground,
              grain: previousGrain,
              padding: previousPadding,
              backgroundEnabled: previousBackgroundEnabled,
              cursorCustomRenderingEnabled:
                previousCursorCustomRenderingEnabled,
              cursorSetId: previousCursorSetId,
              cursorSizeMultiplier: previousCursorSize,
              cursorMotionBlur: previousCursorMotionBlur,
              cursorMotionRotation: previousCursorMotionRotation,
              cursorSmoothingMode: previousCursorSmoothingMode,
              cursorClickPressScale: previousCursorClickPressScale,
              cursorAlwaysUsePointer: previousCursorAlwaysUsePointer,
            }
          })()
      artboardRef.current = nextArtboard
      hasCustomViewRef.current = false
      setArtboard(nextArtboard)
      const fit = getFitViewTransform(viewportSizeRef.current, nextArtboard)
      viewTransformRef.current = fit
      setViewTransformState(fit)
    }

    // Defer the slow-path history baseline until the auto-added recording is
    // on the canvas. Seeding it here (with the still-empty video/clip state)
    // is what produced a blank-canvas undo step: the recording-add then
    // landed at cursor 1 and Cmd+Z walked back to the empty canvas. Instead we
    // arm `hydrationSeedPendingRef`; the seed effect above turns the first
    // committed recording state into the cursor-0 baseline, and undo only
    // starts once the user makes a change on top of it. We still seed
    // `lastWrittenSerializedRef` to avoid a redundant IPC write of the
    // still-empty state when the destructive flush inside `addRemoteVideo`
    // fires before its own setVideos.
    {
      const baselineSnapshot = serializeProjectState(
        artboardRef.current,
        videosRef.current,
        timelineClipsRef.current,
        detachedVideosRef.current,
        zoomClipsRef.current
      )
      lastWrittenSerializedRef.current =
        fingerprintProjectState(baselineSnapshot)
      hydrationSeedPendingRef.current = true
      setCanUndo(false)
      setCanRedo(false)
    }

    if (
      screenAsset &&
      typeof screenAsset.width === "number" &&
      typeof screenAsset.height === "number" &&
      screenAsset.width > 0 &&
      screenAsset.height > 0
    ) {
      // First open of a fresh recording → run auto-zoom once. The kick-off
      // effect waits until the screen video AND its timeline clip are committed.
      autoZoomPendingRef.current = true
      void addRemoteVideo({
        id: `${project.id}:screen`,
        url: screenAsset.fileUrl,
        fileName: screenAsset.fileName,
        fileSize: screenAsset.fileSize,
        intrinsicWidth: screenAsset.width,
        intrinsicHeight: screenAsset.height,
        durationMs: screenAsset.durationMs,
        role: "screen",
        source: { kind: "recording", assetRole: "screen" },
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
        fileSize: cameraAsset.fileSize,
        intrinsicWidth: cameraAsset.width,
        intrinsicHeight: cameraAsset.height,
        durationMs: cameraAsset.durationMs,
        role: "camera",
        source: { kind: "recording", assetRole: "camera" },
        shouldAbort,
      })
    }

    // Arm open-time autoplay for the fresh recording. The screen/camera videos
    // are added asynchronously above; the first to finish loading consumes the
    // flag and starts playback. A valid-dims asset is exactly what gates each
    // `addRemoteVideo` call, so reuse that test — when neither will land on the
    // canvas, the flag stays clear and an empty first-open never auto-plays.
    const hasValidDims = (asset: ProjectAsset | null) =>
      asset != null &&
      typeof asset.width === "number" &&
      typeof asset.height === "number" &&
      asset.width > 0 &&
      asset.height > 0
    autoplayPendingRef.current =
      hasValidDims(screenAsset) || hasValidDims(cameraAsset)

    hydratedProjectIdRef.current = project.id
  }, [
    addRemoteVideo,
    commitDetachedVideosRef,
    commitTimelineClipsRef,
    commitZoomClipsRef,
    commitTimelineVisibleVideoIds,
    commitVideosRef,
    project,
    resolveFileSizeForRestore,
  ])

  // Autosave: 500ms debounce on any change to artboard / videos /
  // timelineClips, plus a flush on window blur and beforeunload. Gated on
  // hydration so we never write a half-initialised state. Concurrent saves
  // are coalesced via `autosavePendingRef`.
  useEffect(() => {
    if (!project) return
    if (hydratedProjectIdRef.current !== project.id) return

    const projectPath = project.path
    if (autosaveTimerRef.current !== null) {
      clearTimeout(autosaveTimerRef.current)
    }
    // A new edit supersedes any pending retry — the user has moved on, the
    // next save will carry their newest state, and we don't want two writes
    // racing each other.
    if (autosaveRetryTimerRef.current !== null) {
      clearTimeout(autosaveRetryTimerRef.current)
      autosaveRetryTimerRef.current = null
    }
    setSaveStatus("saving")
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null
      void flushAutosave(projectPath)
    }, PROJECT_STATE_AUTOSAVE_DEBOUNCE_MS)

    return () => {
      if (autosaveTimerRef.current !== null) {
        clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
      if (autosaveRetryTimerRef.current !== null) {
        clearTimeout(autosaveRetryTimerRef.current)
        autosaveRetryTimerRef.current = null
      }
    }
  }, [
    artboard,
    videos,
    detachedVideos,
    timelineClips,
    zoomClips,
    project,
    flushAutosave,
  ])

  // Window-level flush hooks. We only react if the gate (project + hydrated)
  // passes — otherwise blur during boot would otherwise trigger an empty save.
  useEffect(() => {
    if (!project) return
    const projectPath = project.path
    const handleBlur = () => {
      if (hydratedProjectIdRef.current !== project.id) return
      if (autosaveTimerRef.current !== null) {
        clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
      void flushAutosave(projectPath)
    }
    // `beforeunload` cannot await async IPC — if there is unsaved work
    // (a pending debounce or an in-flight write), set `returnValue` so the
    // platform prompts the user before destroying the window. Closing
    // anyway loses at most the 500ms-debounced edit; the prompt nudges
    // them to wait for the indicator to settle.
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (hydratedProjectIdRef.current !== project.id) return
      const hasUnsavedWork =
        autosaveTimerRef.current !== null ||
        autosaveInFlightRef.current ||
        autosavePendingRef.current
      if (autosaveTimerRef.current !== null) {
        clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
      void flushAutosave(projectPath)
      if (hasUnsavedWork) {
        event.preventDefault()
        // Legacy spec — some browsers/Electron versions still require a
        // truthy `returnValue` to actually surface the prompt.
        event.returnValue = ""
      }
    }
    window.addEventListener("blur", handleBlur)
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => {
      window.removeEventListener("blur", handleBlur)
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [project, flushAutosave])

  return (
    <EditorCanvasActionsContext.Provider value={actionsValue}>
      <EditorCanvasTimelineActionsContext.Provider value={timelineActionsValue}>
        <EditorCanvasMediaContext.Provider value={mediaValue}>
          <EditorCanvasTimelineContext.Provider value={timelineValue}>
            <EditorCanvasArtboardContext.Provider value={artboardValue}>
              <EditorCanvasViewContext.Provider value={viewValue}>
                <EditorCanvasSaveStatusContext.Provider value={saveStatusValue}>
                  <EditorCanvasCursorDataContext.Provider
                    value={cursorDataValue}
                  >
                    <EditorCanvasHistoryContext.Provider value={historyValue}>
                      {children}
                    </EditorCanvasHistoryContext.Provider>
                  </EditorCanvasCursorDataContext.Provider>
                </EditorCanvasSaveStatusContext.Provider>
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

export function useEditorCanvasSaveStatus() {
  return useRequiredEditorCanvasContext(
    useContext(EditorCanvasSaveStatusContext),
    "useEditorCanvasSaveStatus"
  )
}

export function useEditorCanvasCursorData() {
  return useRequiredEditorCanvasContext(
    useContext(EditorCanvasCursorDataContext),
    "useEditorCanvasCursorData"
  )
}

export function useEditorHistory() {
  return useRequiredEditorCanvasContext(
    useContext(EditorCanvasHistoryContext),
    "useEditorHistory"
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
