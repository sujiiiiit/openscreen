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
  ArtboardBackground,
  CanvasTimelineClip,
  CanvasSize,
  CanvasVideoAppearancePatch,
  CanvasVideoItem,
  CanvasVideoRole,
  CanvasVideoSource,
  CanvasVideoTransformPatch,
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
  serializeProjectState,
} from "@/components/editor/canvas/persistence"
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

const DEFAULT_VIEWPORT_SIZE: CanvasSize = { width: 0, height: 0 }
const DEFAULT_ARTBOARD_PRESET = getArtboardPreset(DEFAULT_ARTBOARD_PRESET_ID)
const DEFAULT_ARTBOARD: EditorArtboard = {
  presetId: DEFAULT_ARTBOARD_PRESET.id,
  width: DEFAULT_ARTBOARD_PRESET.width,
  height: DEFAULT_ARTBOARD_PRESET.height,
  background: null,
  grain: 0,
  padding: 0,
}
const ARTBOARD_PADDING_MAX = 500
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
  fileSize?: number
  intrinsicWidth: number
  intrinsicHeight: number
  durationMs?: number
  role: "screen" | "camera"
  source: CanvasVideoSource
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
  updateVideoAppearance: (id: string, patch: CanvasVideoAppearancePatch) => void
  setVideoLocked: (id: string, locked: boolean) => void
  duplicateVideo: (id: string) => void
  deleteVideo: (id: string) => void
  setArtboardPreset: (id: ArtboardPresetId) => void
  setArtboardBackground: (background: ArtboardBackground | null) => void
  setArtboardGrain: (grain: number) => void
  setArtboardPadding: (padding: number) => void
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
  | "updateVideoAppearance"
  | "setVideoLocked"
  | "duplicateVideo"
  | "deleteVideo"
  | "setArtboardPreset"
  | "setArtboardBackground"
  | "setArtboardGrain"
  | "setArtboardPadding"
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

type EditorCanvasSaveStatusContextValue = {
  status: EditorSaveStatus
  error: string | null
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

// Padding is stored in artboard pixels for direct, one-to-one control. We
// still clamp against the artboard's shorter edge so the inner rect can never
// collapse to zero — leaving a 2px floor keeps `getScreenVideoPlacement`'s
// `Math.max(1, ...)` from masking a too-aggressive value.
function getPaddingInsetPx(artboard: EditorArtboard) {
  const raw = Math.max(
    0,
    Math.min(ARTBOARD_PADDING_MAX, artboard.padding ?? 0)
  )
  if (raw <= 0) return 0
  const maxInset = Math.max(0, Math.floor(Math.min(artboard.width, artboard.height) / 2) - 1)
  return Math.min(raw, maxInset)
}

function getScreenVideoPlacement(
  metadata: CanvasSize,
  artboard: EditorArtboard
) {
  const inset = getPaddingInsetPx(artboard)
  // No padding → keep cover-fit: the screen recording fills the artboard
  // edge-to-edge with whatever crop is needed. This preserves the existing
  // "auto layout" behavior for users who never touch the padding slider.
  if (inset <= 0) return getCoverVideoPlacement(metadata, artboard)

  // With padding > 0 we switch to contain-fit inside the inner rect so the
  // *entire* video is visible with breathing room on all four sides. Aspect
  // ratio is always preserved by using the smaller of the two scales.
  const innerWidth = Math.max(1, artboard.width - inset * 2)
  const innerHeight = Math.max(1, artboard.height - inset * 2)
  const containScale = Math.min(
    innerWidth / metadata.width,
    innerHeight / metadata.height
  )
  const width = metadata.width * containScale
  const height = metadata.height * containScale
  return {
    x: (artboard.width - width) / 2,
    y: (artboard.height - height) / 2,
    width,
    height,
  }
}

function relayoutVideoForArtboard(
  video: CanvasVideoItem,
  prev: CanvasSize,
  next: EditorArtboard
): CanvasVideoItem {
  if (prev.width <= 0 || prev.height <= 0) return video

  if (video.role === "screen") {
    const placement = getScreenVideoPlacement(
      { width: video.intrinsicWidth, height: video.intrinsicHeight },
      next
    )
    return { ...video, ...placement }
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

// Per-role appearance defaults. Camera defaults to a fully-rounded squircle
// at maximum smoothing, which visually matches the prior elliptical sceneFunc
// without needing a separate `cropShape` field. Screen and media start at
// radius 0 with `cornerSmoothing = 0.6` (the macOS look) so users get an
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
  | "shadowColor"
  | "shadowBlur"
  | "shadowOffsetX"
  | "shadowOffsetY"
  | "shadowSpread"
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

  // Shadow is rgba so the user can tune alpha alongside the color picker.
  // All spatial fields start at 0 so the shadow pass short-circuits until
  // the user moves a slider — no visible shadow on creation.
  const shadowDefaults: Pick<
    CanvasVideoItem,
    | "shadowColor"
    | "shadowBlur"
    | "shadowOffsetX"
    | "shadowOffsetY"
    | "shadowSpread"
  > = {
    shadowColor: "rgba(0, 0, 0, 0.25)",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowSpread: 0,
  }

  if (role === "camera") {
    const radius = Math.max(0, Math.floor(Math.min(size.width, size.height) / 2))
    return {
      cornerRadius: radius,
      cornerSmoothing: 1,
      ...borderDefaults,
      ...shadowDefaults,
    }
  }

  return {
    cornerRadius: 0,
    cornerSmoothing: 0.6,
    ...borderDefaults,
    ...shadowDefaults,
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
  const flushAutosaveRef = useRef<((projectPath: string) => Promise<void>) | null>(
    null
  )
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
  // Maps imported video ids to their `file://` URLs returned by main on
  // import. Used to re-attach the URL when undo restores a previously
  // deleted imported video whose id is no longer in `videos` or in
  // `project.assetUrlsByVideoId` (which is computed at project open).
  // Holds only strings — no blob memory pinned by undo.
  const sessionImportedUrlsRef = useRef(new Map<string, string>())

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

  const flushAutosave = useCallback(async (projectPath: string) => {
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
          timelineClipsRef.current
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
  }, [pushHistoryFromAutosave])

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
      timelineClipsRef.current
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
      // Preset is a destructive layout reshape (videos relayout under it) so
      // commit any prior pending debounce as its own history entry before
      // we mutate.
      flushAutosaveNow()
      historyCommitTagRef.current = "preset"
      const prevBackground = artboardRef.current.background
      const prevGrain = artboardRef.current.grain
      const prevPadding = artboardRef.current.padding
      let nextArtboard: EditorArtboard
      if (id === AUTO_ARTBOARD_PRESET_ID) {
        const auto = resolveAutoArtboard(sourceVideoDimsRef.current)
        nextArtboard = {
          presetId: AUTO_ARTBOARD_PRESET_ID,
          width: auto.width,
          height: auto.height,
          background: prevBackground,
          grain: prevGrain,
          padding: prevPadding,
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

      const currentProject = projectRef.current
      if (!currentProject) {
        setImportError(
          "Open a project before adding videos so the file can be saved."
        )
        return
      }
      // Snapshot the project id so we can detect a switch during the async
      // probe + copy. If the user opens a different project mid-import we
      // would otherwise attach an asset whose path lives in the old folder
      // to the new project's videos.
      const expectedProjectId = currentProject.id

      // Probe metadata from a transient blob URL — the renderer needs a URL
      // it can hand to a `<video>` element to learn the intrinsic size and
      // duration before the file is copied into the project folder.
      const probeUrl = URL.createObjectURL(file)
      let metadata: VideoMetadata
      try {
        metadata = await readVideoMetadata(probeUrl)
      } catch (error) {
        URL.revokeObjectURL(probeUrl)
        setImportError(
          error instanceof Error
            ? error.message
            : "The selected video could not be loaded."
        )
        return
      } finally {
        URL.revokeObjectURL(probeUrl)
      }

      if (projectRef.current?.id !== expectedProjectId) {
        // Project switched during the probe — drop the import silently;
        // the user has already moved on.
        return
      }

      const id = createCanvasId()
      let importResult
      try {
        const bytes = await file.arrayBuffer()
        importResult = await window.api?.projects.importAsset(
          currentProject.path,
          { id, fileName: file.name, bytes }
        )
      } catch (error) {
        setImportError(
          error instanceof Error
            ? error.message
            : "The selected video could not be copied into the project."
        )
        return
      }
      if (!importResult) {
        setImportError("The selected video could not be copied into the project.")
        return
      }

      if (projectRef.current?.id !== expectedProjectId) {
        // Project switched after the copy completed. The asset file is now
        // orphaned in the previous project's `assets/videos/<id>/` — accept
        // the leak (we have no IPC to undo the copy yet) and refuse to wire
        // the new project to a foreign file path.
        console.warn(
          "[provider] addVideoFile aborted after project switch; orphaning asset",
          importResult.relativePath
        )
        return
      }

      const placement = getCoverVideoPlacement(metadata, artboardRef.current)
      const item: CanvasVideoItem = {
        id,
        fileName: file.name,
        objectUrl: importResult.fileUrl,
        fileSize: importResult.fileSize,
        source: {
          kind: "imported",
          relativePath: importResult.relativePath,
          fileSize: importResult.fileSize,
        },
        intrinsicWidth: metadata.width,
        intrinsicHeight: metadata.height,
        durationMs: metadata.durationMs,
        rotation: 0,
        locked: false,
        role: "media",
        ...placement,
        ...createVideoAppearanceDefaults("media", placement),
      }

      // Remember the file:// URL so a later undo of a delete can re-attach
      // it without a new IPC round-trip. The map only ever holds strings.
      sessionImportedUrlsRef.current.set(id, importResult.fileUrl)
      // Add is destructive — flush any pending non-destructive edits as
      // their own history entry first, then tag this mutation so the next
      // autosave creates a separate entry for the add itself.
      flushAutosaveNow()
      historyCommitTagRef.current = "add"
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
    },
    [commitTimelineClipsRef, commitVideosRef, flushAutosaveNow]
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
        // Screen-role videos honor the artboard's padding so the hydrated
        // recording lands inside the padded inner rect (contain-fit). Other
        // media roles continue to use cover-fit since padding only describes
        // the framing of the screen recording itself.
        const fit =
          input.role === "screen"
            ? getScreenVideoPlacement(
                { width: input.intrinsicWidth, height: input.intrinsicHeight },
                artboardSize
              )
            : getCoverVideoPlacement(
                { width: input.intrinsicWidth, height: input.intrinsicHeight },
                artboardSize
              )
        placement = {
          x: input.placement?.x ?? fit.x,
          y: input.placement?.y ?? fit.y,
          width: input.placement?.width ?? fit.width,
          height: input.placement?.height ?? fit.height,
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

      // Same treatment as `addVideoFile`: cache the URL for future undo of
      // a delete (recording sources come from `assetUrlsByVideoId`; imported
      // sources from session state), and bracket the mutation with a
      // destructive flush + tag.
      if (input.source.kind === "imported") {
        sessionImportedUrlsRef.current.set(desiredId, input.url)
      }
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

      // Re-fit any screen-role videos to the new padded inner rect. Locked
      // videos are skipped on purpose — `updateVideoTransform` already treats
      // a locked video as immovable, and overriding that from a slider would
      // surprise the user. Other roles (camera, media) are untouched by
      // padding since it only frames the screen recording.
      setVideos((currentVideos) => {
        let didChange = false
        const nextVideos = currentVideos.map((video) => {
          if (video.role !== "screen") return video
          if (video.locked) return video
          const placement = getScreenVideoPlacement(
            { width: video.intrinsicWidth, height: video.intrinsicHeight },
            nextArtboard
          )
          if (
            placement.x === video.x &&
            placement.y === video.y &&
            placement.width === video.width &&
            placement.height === video.height
          ) {
            return video
          }
          didChange = true
          return { ...video, ...placement }
        })
        if (!didChange) return currentVideos
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

  const updateVideoTransform = useCallback(
    (id: string, patch: CanvasVideoTransformPatch) => {
      historyCommitTagRef.current = "transform"
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

  // Appearance updates (radius, smoothing) bypass the `locked` gate — locking
  // only prevents geometry edits. Bail out early when every patched field
  // already matches so the same slider value dragged at its current position
  // never triggers a downstream redraw.
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
            nextVideo.borderAlignment === video.borderAlignment &&
            nextVideo.shadowColor === video.shadowColor &&
            nextVideo.shadowBlur === video.shadowBlur &&
            nextVideo.shadowOffsetX === video.shadowOffsetX &&
            nextVideo.shadowOffsetY === video.shadowOffsetY &&
            nextVideo.shadowSpread === video.shadowSpread
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

  const setVideoLocked = useCallback(
    (id: string, locked: boolean) => {
      historyCommitTagRef.current = "lock"
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

      flushAutosaveNow()
      historyCommitTagRef.current = "duplicate"
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
    [commitTimelineClipsRef, commitVideosRef, flushAutosaveNow]
  )

  const deleteVideo = useCallback(
    (id: string) => {
      const currentVideos = videosRef.current
      const deletedVideo = currentVideos.find((video) => video.id === id)
      if (!deletedVideo) return

      flushAutosaveNow()
      historyCommitTagRef.current = "delete"
      const nextVideos = currentVideos.filter((video) => video.id !== id)
      const objectUrlStillUsed = nextVideos.some(
        (video) => video.objectUrl === deletedVideo.objectUrl
      )

      // `objectUrl` may now be a `file://` URL pointing into the project
      // folder — those are owned by the project, not the renderer, so we only
      // ever revoke blob: URLs created via `URL.createObjectURL`.
      if (
        !objectUrlStillUsed &&
        deletedVideo.objectUrl.startsWith("blob:") &&
        objectUrlsRef.current.has(deletedVideo.objectUrl)
      ) {
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
    [commitTimelineClipsRef, commitVideosRef, flushAutosaveNow]
  )

  // Pure helper: pick the URL for a restored video. Recording sources come
  // from main's per-project asset map; imported sources fall back to a
  // session cache populated when the file was first imported. Returns ""
  // for missing files — the renderer keeps the broken node visible so the
  // user can see what's wrong, identical to hydration semantics.
  const resolveObjectUrlForRestore = useCallback(
    (video: ProjectStateV1["videos"][number]): string => {
      const currentProject = projectRef.current
      const existing = videoByIdRef.current.get(video.id)
      if (existing && existing.objectUrl) return existing.objectUrl
      const fromProject = currentProject?.assetUrlsByVideoId[video.id]
      if (fromProject) return fromProject
      if (video.source.kind === "imported") {
        const cached = sessionImportedUrlsRef.current.get(video.id)
        if (cached) return cached
      }
      return ""
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
      }
      const restoredVideos: CanvasVideoItem[] = savedState.videos.map(
        (video) =>
          projectVideoToCanvasVideo(video, resolveObjectUrlForRestore(video))
      )
      const restoredClips: CanvasTimelineClip[] =
        savedState.timelineClips.map(projectClipToCanvasClip)

      restoringFromHistoryRef.current = true
      historyRef.current = {
        past: history.past,
        cursor: history.cursor + direction,
      }

      const prevArtboard = artboardRef.current
      artboardRef.current = savedArtboard
      commitVideosRef(restoredVideos)
      commitTimelineClipsRef(restoredClips)
      setArtboard(savedArtboard)
      setVideos(restoredVideos)
      setTimelineClips(restoredClips)

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
      const newDuration = Math.max(
        TIMELINE_MIN_CLIP_DURATION_SECONDS,
        restoredClips.reduce(
          (duration, clip) => Math.max(duration, clip.end),
          0
        )
      )
      if (timelineTimeRef.current > newDuration) {
        const clamped = clampTimelineTime(timelineTimeRef.current, newDuration)
        timelineTimeRef.current = clamped
        setTimelineTimeState(clamped)
      }

      setCanUndo(canUndoHistory(historyRef.current))
      setCanRedo(canRedoHistory(historyRef.current))
    },
    [
      commitTimelineClipsRef,
      commitVideosRef,
      resolveObjectUrlForRestore,
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

  const saveStatusValue = useMemo<EditorCanvasSaveStatusContextValue>(
    () => ({
      status: saveStatus,
      error: saveError,
    }),
    [saveStatus, saveError]
  )

  const historyValue = useMemo<EditorCanvasHistoryContextValue>(
    () => ({ canUndo, canRedo, undo, redo }),
    [canUndo, canRedo, undo, redo]
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
      updateVideoAppearance,
      setVideoLocked,
      duplicateVideo,
      deleteVideo,
      setArtboardPreset,
      setArtboardBackground,
      setArtboardGrain,
      setArtboardPadding,
      setViewportSize,
      setViewTransform,
      fitArtboardToViewport,
    }),
    [
      addVideoFile,
      addRemoteVideo,
      selectItem,
      updateVideoTransform,
      updateVideoAppearance,
      setVideoLocked,
      duplicateVideo,
      deleteVideo,
      setArtboardPreset,
      setArtboardBackground,
      setArtboardGrain,
      setArtboardPadding,
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
      sessionImportedUrlsRef.current.clear()
      setCanUndo(false)
      setCanRedo(false)
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
      }

      const restoredVideos: CanvasVideoItem[] = savedState.videos.map((video) =>
        projectVideoToCanvasVideo(
          video,
          project.assetUrlsByVideoId[video.id] ?? ""
        )
      )
      commitVideosRef(restoredVideos)
      setVideos(restoredVideos)

      const restoredClips: CanvasTimelineClip[] = savedState.timelineClips.map(
        projectClipToCanvasClip
      )
      commitTimelineClipsRef(restoredClips)
      setTimelineClips(restoredClips)

      // Seed the last-written fingerprint with the hydrated snapshot so the
      // autosave effect's immediate post-hydration run sees "no diff" and
      // skips the IPC. Without this, every project open pays an extra
      // redundant write for an indicator that briefly flashes "Saving…".
      const hydratedSnapshot = serializeProjectState(
        savedArtboard,
        restoredVideos,
        restoredClips
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

      // Display captures inherit the source's aspect via the Auto preset so
      // the recording fills the artboard with no letterboxing. Window /
      // region / application captures fall back to the Wide 16:9 preset —
      // those source shapes are arbitrary and would otherwise produce an
      // odd-shaped artboard.
      const useAuto = project.recordingType === "display"
      const previousBackground = artboardRef.current.background
      const previousGrain = artboardRef.current.grain
      const previousPadding = artboardRef.current.padding
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
            }
          })()
      artboardRef.current = nextArtboard
      hasCustomViewRef.current = false
      setArtboard(nextArtboard)
      const fit = getFitViewTransform(viewportSizeRef.current, nextArtboard)
      viewTransformRef.current = fit
      setViewTransformState(fit)
    }

    // Seed the slow-path baseline before any auto-add runs so the
    // synthesized artboard + empty video/clip state lands at cursor 0. The
    // first addRemoteVideo's autosave pushes the auto-added state at
    // cursor 1, and the user's first edit pushes cursor 2 — Cmd+Z walks
    // back through both. We also seed `lastWrittenSerializedRef` to avoid
    // a redundant IPC write of the still-empty state when the destructive
    // flush inside `addRemoteVideo` fires before its own setVideos.
    {
      const baselineSnapshot = serializeProjectState(
        artboardRef.current,
        videosRef.current,
        timelineClipsRef.current
      )
      const baselineFingerprint = fingerprintProjectState(baselineSnapshot)
      lastWrittenSerializedRef.current = baselineFingerprint
      const seeded = applyHistoryCommit(
        historyRef.current,
        baselineSnapshot,
        baselineFingerprint,
        "unknown",
        Date.now()
      )
      historyRef.current = seeded.next
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

    hydratedProjectIdRef.current = project.id
  }, [
    addRemoteVideo,
    commitTimelineClipsRef,
    commitTimelineVisibleVideoIds,
    commitVideosRef,
    project,
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
  }, [artboard, videos, timelineClips, project, flushAutosave])

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
                  <EditorCanvasHistoryContext.Provider value={historyValue}>
                    {children}
                  </EditorCanvasHistoryContext.Provider>
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
