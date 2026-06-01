"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CameraVideoIcon,
  ComputerVideoIcon,
  FitToScreenIcon,
  MinusSignIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PlusSignIcon,
  PreviousIcon,
  SearchAreaIcon,
  Video01Icon,
} from "@hugeicons/core-free-icons"
import { Timeline, type TimelineState } from "@openscreen/timeline"
import type { TimelineAction, TimelineRow } from "@openscreen/timeline-engine"

import {
  useEditorCanvasActions,
  useEditorCanvasMedia,
  useEditorCanvasTimeline,
  useEditorCanvasTimelineActions,
} from "@/components/editor/canvas/provider"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  MIN_ZOOM_CLIP_SECONDS,
  placeZoomSpan,
  zoomSpanOverlaps,
} from "@/lib/zoom-clips"
import type {
  CanvasTimelineClip,
  CanvasVideoItem,
  CanvasVideoRole,
  CanvasZoomClip,
} from "@/types/editor-canvas"

const START_LEFT = 30
const ROW_HEIGHT = 46
const MIN_CLIP_DURATION_SECONDS = 1 / 30
const ENABLE_TIMELINE_GRID_SNAP = true
const ENABLE_TIMELINE_AUXILIARY_LINE_SNAP = true
const ENABLE_TIMELINE_AUTO_SCROLL = true
const TIMELINE_SKIP_SECONDS = 5
const TIMELINE_MIN_RULER_LABEL_GAP = 160
const TIMELINE_MAX_RULER_LABEL_GAP = 260
const TIMELINE_FIT_RIGHT_PADDING = 12
const TIMELINE_PACKAGE_TRAILING_SCALE_COUNT = 5
const TIMELINE_SCALE_STEPS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600,
  43200, 86400,
]
const TIMELINE_LABEL_STRIDES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 60]

// Dedicated Zoom track. Always the last (bottom) row when a timeline exists.
const ZOOM_ROW_ID = "zoom"
// Default size of a click-added zoom clip as a fixed **on-screen pixel width**
// (responsive to zoom), instead of a fixed number of seconds: the duration it
// represents scales with the timeline zoom, but the chip always looks the same
// size. Converted to seconds at the current `scaleWidth`/`scale` and floored at
// `MIN_ZOOM_CLIP_SECONDS` (the floor is what you get when zoomed in far enough
// that this width would be sub-minimum). Resize handles adjust it afterward.
const DEFAULT_ZOOM_CLIP_PIXELS = 120
// Vertical layout used to place the hover-ghost overlay over the zoom lane.
// The ruler is `h-8` (32px) and the edit area is `mt-3` (12px) below it; rows
// are a uniform ROW_HEIGHT. Assumes no vertical scroll (the footer timeline is
// sized to show its handful of lanes — documented in docs/editor-canvas.md).
const TIMELINE_RULER_HEIGHT = 32
const TIMELINE_EDIT_AREA_MARGIN_TOP = 12
// Inset so the ghost block doesn't touch the lane edges (matches the clip
// padding `action: "bg-transparent p-1"`).
const ZOOM_GHOST_INSET = 4
// Content density for the hover ghost. The box itself can be subpixel-small,
// but a fixed 16px icon inside a tiny gap reads like overlap, so only show
// content that can fit inside the current rendered width.
const ZOOM_GHOST_ICON_MIN_WIDTH = 20
const ZOOM_GHOST_LABEL_MIN_WIDTH = 76

const TIMELINE_EFFECTS = {
  screen: { id: "screen", name: "Screen" },
  camera: { id: "camera", name: "Camera" },
  media: { id: "media", name: "Media" },
  zoom: { id: "zoom", name: "Zoom" },
}

const ROLE_META: Record<
  CanvasVideoRole,
  {
    icon: typeof ComputerVideoIcon
    accentClassName: string
    selectedClassName: string
  }
> = {
  screen: {
    icon: ComputerVideoIcon,
    accentClassName: "border-sky-300/40 bg-sky-400/15 text-sky-50",
    selectedClassName:
      "border-sky-200 bg-sky-400/35 text-sky-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]",
  },
  camera: {
    icon: CameraVideoIcon,
    accentClassName: "border-emerald-300/40 bg-emerald-400/15 text-emerald-50",
    selectedClassName:
      "border-emerald-200 bg-emerald-400/35 text-emerald-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]",
  },
  media: {
    icon: Video01Icon,
    accentClassName: "border-amber-300/40 bg-amber-400/15 text-amber-50",
    selectedClassName:
      "border-amber-200 bg-amber-400/35 text-amber-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]",
  },
}

type EditorTimelineAction = TimelineAction & {
  kind: "video"
  videoId: string
  role: CanvasVideoRole
  fileName: string
  sourceIn: number
  sourceOut: number
}

type EditorZoomAction = TimelineAction & {
  kind: "zoom"
  zoomClipId: string
  scale: number
  enabled: boolean
}

type EditorAction = EditorTimelineAction | EditorZoomAction

function isZoomAction(action: TimelineAction): action is EditorZoomAction {
  return (action as EditorAction).kind === "zoom"
}

function formatTimelineTime(seconds: number) {
  const safeSeconds = Math.max(0, seconds)
  const totalSeconds = Math.floor(safeSeconds)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const wholeSeconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(
      wholeSeconds
    ).padStart(2, "0")}`
  }

  return `${minutes}:${String(wholeSeconds).padStart(2, "0")}`
}

function formatTimelineTimePrecise(seconds: number) {
  const safeSeconds = Math.max(0, seconds)
  const totalCs = Math.round(safeSeconds * 100)
  const hours = Math.floor(totalCs / 360_000)
  const minutes = Math.floor((totalCs % 360_000) / 6_000)
  const wholeSeconds = Math.floor((totalCs % 6_000) / 100)
  const centis = totalCs % 100

  const mm = String(minutes).padStart(2, "0")
  const ss = String(wholeSeconds).padStart(2, "0")
  const cs = String(centis).padStart(2, "0")

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${mm}:${ss}.${cs}`
  }

  return `${mm}:${ss}.${cs}`
}

function formatRulerTime(seconds: number) {
  return formatTimelineTime(Math.round(seconds))
}

function getNiceTimelineStep(minStepSeconds: number) {
  return (
    TIMELINE_SCALE_STEPS.find((step) => step >= minStepSeconds) ??
    TIMELINE_SCALE_STEPS[TIMELINE_SCALE_STEPS.length - 1]
  )
}

function getTimelineScaleSplitCount(scale: number) {
  if (scale <= 1) return 4
  if (scale <= 5) return 5
  if (scale <= 30) return 5
  return 4
}

function getNiceTimelineLabelStride(minStride: number) {
  return (
    TIMELINE_LABEL_STRIDES.find((stride) => stride >= minStride) ??
    TIMELINE_LABEL_STRIDES[TIMELINE_LABEL_STRIDES.length - 1]
  )
}

function estimateRulerLabelGap(duration: number) {
  const longestLabel = [0, duration, Math.max(duration, 3600)]
    .map((time) => formatTimelineTime(time).length)
    .reduce((longest, length) => Math.max(longest, length), 0)

  return Math.min(
    TIMELINE_MAX_RULER_LABEL_GAP,
    Math.max(TIMELINE_MIN_RULER_LABEL_GAP, longestLabel * 10 + 58)
  )
}

function getTimelineRulerLabelStride({
  duration,
  scaleWidth,
}: {
  duration: number
  scaleWidth: number
}) {
  const labelGap = estimateRulerLabelGap(duration)
  return getNiceTimelineLabelStride(
    Math.max(1, Math.ceil(labelGap / Math.max(1, scaleWidth)))
  )
}

function getDefaultTimelinePixelsPerSecond(duration: number) {
  if (duration <= 30) return 80
  if (duration <= 60) return 48
  if (duration <= 240) return 12
  if (duration <= 600) return 8
  if (duration <= 1800) return 4
  return 2
}

function getTimelineFitTarget(clips: CanvasTimelineClip[]) {
  if (clips.length === 0) {
    return {
      start: 0,
      duration: MIN_CLIP_DURATION_SECONDS,
    }
  }

  return clips.reduce(
    (longest, clip) => {
      const duration = Math.max(
        MIN_CLIP_DURATION_SECONDS,
        clip.end - clip.start
      )

      if (duration <= longest.duration) return longest

      return {
        start: Math.max(0, clip.start),
        duration,
      }
    },
    {
      start: 0,
      duration: MIN_CLIP_DURATION_SECONDS,
    }
  )
}

function getTimelineScale({
  duration,
  fitDuration,
  fitToWidth,
  viewportWidth,
  zoom,
}: {
  duration: number
  fitDuration: number
  fitToWidth: boolean
  viewportWidth: number
  zoom: number
}) {
  const safeDuration = Math.max(MIN_CLIP_DURATION_SECONDS, duration)
  const safeFitDuration = Math.max(MIN_CLIP_DURATION_SECONDS, fitDuration)
  const availableWidth = Math.max(0, viewportWidth - START_LEFT)

  if (fitToWidth && availableWidth > 0) {
    const labelSlots = Math.max(
      1,
      Math.floor(availableWidth / estimateRulerLabelGap(safeDuration))
    )
    const scale = getNiceTimelineStep(safeFitDuration / labelSlots)
    const fitScaleCount = Math.max(
      MIN_CLIP_DURATION_SECONDS,
      safeFitDuration / scale
    )
    const minScaleCount = Math.max(
      1,
      Math.ceil(safeFitDuration / scale) + TIMELINE_PACKAGE_TRAILING_SCALE_COUNT
    )
    const scaleWidth = Math.max(
      1,
      (availableWidth - TIMELINE_FIT_RIGHT_PADDING) / fitScaleCount
    )

    return {
      scale,
      scaleWidth,
      scaleSplitCount: getTimelineScaleSplitCount(scale),
      minScaleCount,
    }
  }

  const pixelsPerSecond = getDefaultTimelinePixelsPerSecond(safeDuration) * zoom
  const scale = getNiceTimelineStep(
    estimateRulerLabelGap(safeDuration) / pixelsPerSecond
  )
  const scaleWidth = scale * pixelsPerSecond

  return {
    scale,
    scaleWidth,
    scaleSplitCount: getTimelineScaleSplitCount(scale),
    minScaleCount: Math.max(20, Math.ceil(safeDuration / scale) + 2),
  }
}

function getVideoDurationSeconds(video: CanvasVideoItem) {
  const duration = video.durationMs / 1000
  return Number.isFinite(duration) && duration > 0
    ? duration
    : MIN_CLIP_DURATION_SECONDS
}

function buildTimelineRows({
  clips,
  videos,
  selectedItemId,
  zoomClips,
  selectedZoomClipId,
}: {
  clips: CanvasTimelineClip[]
  videos: CanvasVideoItem[]
  selectedItemId: string | null
  zoomClips: CanvasZoomClip[]
  selectedZoomClipId: string | null
}) {
  const clipByVideoId = new Map(clips.map((clip) => [clip.videoId, clip]))
  const roleOrder: CanvasVideoRole[] = ["screen", "camera", "media"]

  const videoRows = roleOrder.flatMap((role) => {
    const actions = videos
      .filter((video) => video.role === role)
      .flatMap((video): EditorTimelineAction[] => {
        const clip = clipByVideoId.get(video.id)
        if (!clip) return []

        const selected = selectedItemId === video.id
        return [
          {
            id: clip.id,
            kind: "video",
            videoId: video.id,
            role,
            fileName: video.fileName,
            effectId: role,
            start: clip.start,
            end: clip.end,
            sourceIn: clip.sourceIn,
            sourceOut: clip.sourceOut,
            selected,
            movable: true,
            flexible: true,
            minStart: 0,
          },
        ]
      })

    if (actions.length === 0) return []

    return [
      {
        id: role,
        rowHeight: ROW_HEIGHT,
        actions,
      } satisfies TimelineRow,
    ]
  })

  // The Zoom track is only meaningful alongside a real timeline, so it appears
  // (always, even when empty — so it can be hovered to add) only once at least
  // one video lane exists. Last row = bottom of the stack.
  if (videoRows.length === 0) return videoRows

  const zoomActions: EditorZoomAction[] = zoomClips.map((clip) => ({
    id: clip.id,
    kind: "zoom",
    zoomClipId: clip.id,
    scale: clip.scale,
    enabled: clip.enabled,
    effectId: ZOOM_ROW_ID,
    start: clip.start,
    end: clip.end,
    selected: selectedZoomClipId === clip.id,
    movable: true,
    flexible: true,
    minStart: 0,
  }))

  return [
    ...videoRows,
    {
      id: ZOOM_ROW_ID,
      rowHeight: ROW_HEIGHT,
      actions: zoomActions,
    } satisfies TimelineRow,
  ]
}

function TimelineClipRender(action: TimelineAction) {
  const timelineAction = action as EditorTimelineAction
  const meta = ROLE_META[timelineAction.role]

  return (
    <div
      className={cn(
        "flex h-full min-w-0 items-center overflow-hidden rounded-md border px-2 text-[11px] leading-none backdrop-blur-sm transition-colors",
        timelineAction.selected ? meta.selectedClassName : meta.accentClassName
      )}
    >
      <span className="min-w-0 truncate font-medium">
        {timelineAction.fileName}
      </span>
    </div>
  )
}

// Pure render (no hooks) so it can be called directly from `getActionRender`.
// Removal is via select + Delete/Backspace (editor-workspace keydown); there is
// no on-clip remove button.
function renderZoomClip(action: EditorZoomAction) {
  return (
    <div
      className={cn(
        "flex h-full min-w-0 items-center gap-1 overflow-hidden rounded-md border px-2 text-[11px] leading-none backdrop-blur-sm transition-colors",
        action.selected
          ? "border-violet-200 bg-violet-400/35 text-violet-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]"
          : action.enabled
            ? "border-violet-300/40 bg-violet-400/15 text-violet-50"
            : "border-white/10 bg-white/5 text-white/45"
      )}
    >
      <HugeiconsIcon icon={SearchAreaIcon} size={12} color="currentColor" />
      <span className="min-w-0 truncate font-medium">Zoom</span>
      <span className="ml-auto shrink-0 tabular-nums opacity-75">
        {action.enabled ? `${action.scale.toFixed(1)}x` : "Off"}
      </span>
    </div>
  )
}

export function EditorTimelineControls() {
  const { timelineClips, timelineTime, timelineDuration, isTimelinePlaying } =
    useEditorCanvasTimeline()
  const { setTimelineTime, toggleTimelinePlayback, stepTimelineFrame } =
    useEditorCanvasTimelineActions()
  const hasTimeline = timelineClips.length > 0
  const skipTimeline = useCallback(
    (deltaSeconds: number) => {
      setTimelineTime(
        Math.min(Math.max(0, timelineTime + deltaSeconds), timelineDuration)
      )
    },
    [setTimelineTime, timelineDuration, timelineTime]
  )

  return (
    <div className="flex min-w-0 items-center justify-center gap-3 select-none">
      <span className="w-[80px] text-right text-xs text-muted-foreground tabular-nums">
        {formatTimelineTimePrecise(timelineTime)}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => skipTimeline(-TIMELINE_SKIP_SECONDS)}
        disabled={!hasTimeline || timelineTime <= 0}
        aria-label={`Back ${TIMELINE_SKIP_SECONDS} seconds`}
      >
        <HugeiconsIcon icon={PreviousIcon} size={16} color="currentColor" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => stepTimelineFrame(-1)}
        disabled={!hasTimeline || timelineTime <= 0}
        aria-label="Previous frame"
        title="Previous frame (,)"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={16} color="currentColor" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={toggleTimelinePlayback}
        disabled={!hasTimeline}
        aria-label={isTimelinePlaying ? "Pause timeline" : "Play timeline"}
      >
        <HugeiconsIcon
          icon={isTimelinePlaying ? PauseIcon : PlayIcon}
          size={16}
          color="currentColor"
          fill="currentColor"
        />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => stepTimelineFrame(1)}
        disabled={!hasTimeline || timelineTime >= timelineDuration}
        aria-label="Next frame"
        title="Next frame (.)"
      >
        <HugeiconsIcon icon={ArrowRight01Icon} size={16} color="currentColor" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => skipTimeline(TIMELINE_SKIP_SECONDS)}
        disabled={!hasTimeline || timelineTime >= timelineDuration}
        aria-label={`Forward ${TIMELINE_SKIP_SECONDS} seconds`}
      >
        <HugeiconsIcon icon={NextIcon} size={16} color="currentColor" />
      </Button>
      <span className="w-[80px] text-left text-xs text-muted-foreground tabular-nums">
        {formatTimelineTimePrecise(timelineDuration)}
      </span>
    </div>
  )
}

export function EditorTimelineZoomControls() {
  const { isTimelineFit, timelineClips } = useEditorCanvasTimeline()
  const { zoomTimelineOut, zoomTimelineIn, fitTimelineToWidth } =
    useEditorCanvasTimelineActions()
  const hasTimeline = timelineClips.length > 0

  return (
    <div className="inline-flex items-center gap-1 select-none">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={zoomTimelineOut}
        disabled={!hasTimeline}
        aria-label="Zoom timeline out"
      >
        <HugeiconsIcon icon={MinusSignIcon} size={16} color="currentColor" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={fitTimelineToWidth}
        disabled={!hasTimeline}
        aria-label="Fit timeline to width"
        aria-pressed={isTimelineFit}
      >
        <HugeiconsIcon icon={FitToScreenIcon} size={16} color="currentColor" />
        Fit
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={zoomTimelineIn}
        disabled={!hasTimeline}
        aria-label="Zoom timeline in"
      >
        <HugeiconsIcon icon={PlusSignIcon} size={16} color="currentColor" />
      </Button>
    </div>
  )
}

type ZoomGhostSpan = { start: number; end: number }
type ZoomGhostSubscriber = (ghost: ZoomGhostSpan | null) => void

export function EditorTimelinePanel() {
  const timelineRef = useRef<TimelineState | null>(null)
  const timelinePanelRef = useRef<HTMLDivElement | null>(null)
  const scrollLeftRef = useRef(0)
  const scrollTopRef = useRef(0)
  // Zoom-track hover ghost. Driven imperatively (ref + subscribers) so the
  // per-mousemove preview never re-renders the heavy <Timeline>; the only React
  // state is the mount/unmount boolean, which flips on lane enter/leave.
  const zoomGhostRef = useRef<ZoomGhostSpan | null>(null)
  const zoomGhostSubscribersRef = useRef(new Set<ZoomGhostSubscriber>())
  const isDraggingActionRef = useRef(false)
  const [isZoomGhostActive, setIsZoomGhostActive] = useState(false)
  const [timelinePanelWidth, setTimelinePanelWidth] = useState(0)
  const { videos, selectedItemId } = useEditorCanvasMedia()
  const { selectItem } = useEditorCanvasActions()
  const {
    timelineClips,
    zoomClips,
    selectedZoomClipId,
    timelineTime,
    timelineDuration,
    timelineZoom,
    isTimelineFit,
    timelineFitRequestId,
    isTimelinePlaying,
    isHoverPreviewActive,
  } = useEditorCanvasTimeline()
  const {
    setTimelineTime,
    pauseTimeline,
    moveTimelineClip,
    resizeTimelineClip,
    addZoomClip,
    moveZoomClip,
    resizeZoomClip,
    selectZoomClip,
    subscribeTimelineTicks,
    updateHoverPreviewTime,
    subscribeHoverTime,
  } = useEditorCanvasTimelineActions()

  const videoById = useMemo(
    () => new Map(videos.map((video) => [video.id, video])),
    [videos]
  )
  const clipById = useMemo(
    () => new Map(timelineClips.map((clip) => [clip.id, clip])),
    [timelineClips]
  )
  const rows = useMemo(
    () =>
      buildTimelineRows({
        clips: timelineClips,
        videos,
        selectedItemId,
        zoomClips,
        selectedZoomClipId,
      }),
    [selectedItemId, selectedZoomClipId, timelineClips, videos, zoomClips]
  )
  const hasTimeline = rows.length > 0
  const timelineFitTarget = useMemo(
    () => getTimelineFitTarget(timelineClips),
    [timelineClips]
  )
  const { scale, scaleWidth, scaleSplitCount, minScaleCount } = useMemo(
    () =>
      getTimelineScale({
        duration: timelineDuration,
        fitDuration: timelineFitTarget.duration,
        fitToWidth: isTimelineFit,
        viewportWidth: timelinePanelWidth,
        zoom: timelineZoom,
      }),
    [
      isTimelineFit,
      timelineDuration,
      timelineFitTarget.duration,
      timelinePanelWidth,
      timelineZoom,
    ]
  )
  const rulerLabelStride = useMemo(
    () =>
      getTimelineRulerLabelStride({
        duration: timelineDuration,
        scaleWidth,
      }),
    [scaleWidth, timelineDuration]
  )
  const renderRulerScale = useCallback(
    (seconds: number) => {
      const tickIndex = Math.round(seconds / scale)

      if (tickIndex > 0 && tickIndex % rulerLabelStride !== 0) {
        return null
      }

      return formatRulerTime(seconds)
    },
    [rulerLabelStride, scale]
  )
  useEffect(() => {
    const node = timelinePanelRef.current
    if (!node) return

    const resizeObserver = new ResizeObserver(([entry]) => {
      setTimelinePanelWidth(entry.contentRect.width)
    })
    resizeObserver.observe(node)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  useEffect(() => {
    return subscribeTimelineTicks((time) => {
      timelineRef.current?.setTime(time)
    })
  }, [subscribeTimelineTicks])

  useEffect(() => {
    timelineRef.current?.setTime(timelineTime)
  }, [timelineTime])

  useEffect(() => {
    if (!isTimelineFit) return

    const scrollLeft = Math.max(
      0,
      (timelineFitTarget.start / scale) * scaleWidth
    )
    timelineRef.current?.setScrollLeft(scrollLeft)
  }, [
    isTimelineFit,
    minScaleCount,
    scale,
    scaleWidth,
    timelineFitRequestId,
    timelineFitTarget.start,
  ])

  // Push a ghost span to the overlay imperatively; only the mount boolean is
  // React state and it flips solely on lane enter/leave.
  const writeZoomGhost = useCallback((ghost: ZoomGhostSpan | null) => {
    const wasActive = zoomGhostRef.current !== null
    zoomGhostRef.current = ghost
    zoomGhostSubscribersRef.current.forEach((fn) => fn(ghost))
    const isActive = ghost !== null
    if (isActive !== wasActive) setIsZoomGhostActive(isActive)
  }, [])

  const subscribeZoomGhost = useCallback((fn: ZoomGhostSubscriber) => {
    zoomGhostSubscribersRef.current.add(fn)
    fn(zoomGhostRef.current)
    return () => {
      zoomGhostSubscribersRef.current.delete(fn)
    }
  }, [])

  // Hover anywhere over the zoom lane previews a default-length block. The
  // hovered seek is the committed start; `placeZoomSpan` may shrink the right
  // edge before a neighbour so preview === committed and overlaps are impossible.
  // This is intentionally independent from the paused-only secondary hover
  // preview, so it remains available while the timeline is playing. Hidden over
  // an existing clip or mid-drag.
  const handleRowHover = useCallback(
    ({ row, time }: { row: TimelineRow; time: number | null }) => {
      if (
        row.id !== ZOOM_ROW_ID ||
        time === null ||
        isDraggingActionRef.current
      ) {
        if (zoomGhostRef.current) writeZoomGhost(null)
        return
      }
      // Fixed on-screen width → seconds at the current zoom, floored at the
      // minimum. `scaleWidth` is always ≥ 1 (see getTimelineScale).
      const defaultSeconds = Math.max(
        MIN_ZOOM_CLIP_SECONDS,
        (DEFAULT_ZOOM_CLIP_PIXELS / scaleWidth) * scale
      )
      const placed = placeZoomSpan(
        zoomClips,
        timelineDuration,
        time,
        time + defaultSeconds,
        null
      )
      writeZoomGhost(placed)
    },
    [scale, scaleWidth, timelineDuration, writeZoomGhost, zoomClips]
  )

  // Clicking the empty zoom lane commits the previewed ghost. Gated on ghost
  // visibility, which is how we avoid spurious adds: clicks on an existing clip
  // (ghost hidden) and drag-end clicks (ghost cleared on drag start) never add.
  const handleClickRow = useCallback(
    (_: unknown, { row }: { row: TimelineRow; time: number }) => {
      if (row.id !== ZOOM_ROW_ID) return
      const ghost = zoomGhostRef.current
      if (!ghost) return
      addZoomClip(ghost.start, ghost.end)
      writeZoomGhost(null)
    },
    [addZoomClip, writeZoomGhost]
  )

  const handleActionDragStart = useCallback(() => {
    isDraggingActionRef.current = true
    if (zoomGhostRef.current) writeZoomGhost(null)
  }, [writeZoomGhost])

  const handleMoveEnd = useCallback(
    ({
      action,
      start,
      end,
    }: {
      action: TimelineAction
      start: number
      end: number
    }) => {
      isDraggingActionRef.current = false
      if (isZoomAction(action)) {
        moveZoomClip(action.zoomClipId, start)
        selectZoomClip(action.zoomClipId)
        return
      }
      moveTimelineClip(action.id, start, end)
      const clip = clipById.get(action.id)
      if (clip) selectItem(clip.videoId)
    },
    [clipById, moveTimelineClip, moveZoomClip, selectItem, selectZoomClip]
  )

  const handleResizeEnd = useCallback(
    ({
      action,
      start,
      end,
      dir,
    }: {
      action: TimelineAction
      start: number
      end: number
      dir: "left" | "right"
    }) => {
      isDraggingActionRef.current = false
      if (isZoomAction(action)) {
        resizeZoomClip(action.zoomClipId, start, end, dir)
        selectZoomClip(action.zoomClipId)
        return
      }
      resizeTimelineClip(action.id, start, end, dir)
      const clip = clipById.get(action.id)
      if (clip) selectItem(clip.videoId)
    },
    [clipById, resizeTimelineClip, resizeZoomClip, selectItem, selectZoomClip]
  )

  // Real-time block (return false) so a drag can't cross into a neighbour or
  // past the timeline bounds — the "snap to neighbour" feel.
  const handleActionMoving = useCallback(
    ({
      action,
      start,
      end,
    }: {
      action: TimelineAction
      start: number
      end: number
    }) => {
      if (isZoomAction(action)) {
        if (start < 0 || end > timelineDuration + 0.0001) return false
        return !zoomSpanOverlaps(zoomClips, start, end, action.id)
      }
      return start >= 0
    },
    [timelineDuration, zoomClips]
  )

  const validateResize = useCallback(
    ({
      action,
      start,
      end,
      dir,
    }: {
      action: TimelineAction
      start: number
      end: number
      dir: "left" | "right"
    }) => {
      if (isZoomAction(action)) {
        if (end - start < MIN_ZOOM_CLIP_SECONDS) return false
        if (start < -0.0001 || end > timelineDuration + 0.0001) return false
        return !zoomSpanOverlaps(zoomClips, start, end, action.id)
      }

      const clip = clipById.get(action.id)
      if (!clip) return false

      const video = videoById.get(clip.videoId)
      if (!video) return false

      const duration = end - start
      if (duration < MIN_CLIP_DURATION_SECONDS) return false

      if (dir === "left") {
        return clip.end - start <= clip.sourceOut + 0.0001
      }

      return (
        end - clip.start <=
        getVideoDurationSeconds(video) - clip.sourceIn + 0.0001
      )
    },
    [clipById, timelineDuration, videoById, zoomClips]
  )

  const renderAction = useCallback(
    (action: TimelineAction) =>
      isZoomAction(action)
        ? renderZoomClip(action)
        : TimelineClipRender(action),
    []
  )

  const getAssistDragLineActionIds = useCallback(
    ({
      action,
      editorData,
    }: {
      action: TimelineAction
      editorData: TimelineRow[]
    }) =>
      editorData.flatMap((row) =>
        row.actions
          .filter((rowAction) => rowAction.id !== action.id)
          .map((rowAction) => rowAction.id)
      ),
    []
  )

  return (
    <div
      ref={timelinePanelRef}
      className="flex h-full min-h-0 w-full flex-col bg-transparent text-foreground select-none"
    >
      <div className="relative min-h-0 flex-1">
        {hasTimeline ? (
          <Timeline
            ref={timelineRef}
            editorData={rows}
            effects={TIMELINE_EFFECTS}
            scale={scale}
            scaleWidth={scaleWidth}
            scaleSplitCount={scaleSplitCount}
            startLeft={START_LEFT}
            minScaleCount={minScaleCount}
            maxCursorTime={timelineDuration}
            rowHeight={ROW_HEIGHT}
            autoReRender={false}
            gridSnap={ENABLE_TIMELINE_GRID_SNAP}
            dragLine={ENABLE_TIMELINE_AUXILIARY_LINE_SNAP}
            autoScroll={ENABLE_TIMELINE_AUTO_SCROLL}
            disableDrag={isTimelinePlaying}
            onChange={() => false}
            onClickTimeArea={(time) => {
              if (time > timelineDuration) {
                setTimelineTime(timelineDuration)
                timelineRef.current?.setTime(timelineDuration)
                return false
              }
              setTimelineTime(time)
              return true
            }}
            onCursorDragStart={() => {
              pauseTimeline()
              // Defense in depth: also clear any stray hover preview state in
              // case the package's draggingCursorRef suppression missed a
              // hover event that already landed.
              updateHoverPreviewTime(null)
            }}
            onTimeAreaHover={updateHoverPreviewTime}
            onRowHover={handleRowHover}
            onClickRow={handleClickRow}
            onScroll={(p) => {
              scrollLeftRef.current = p.scrollLeft
              scrollTopRef.current = p.scrollTop
            }}
            onCursorDrag={(time) => {
              const clamped = Math.min(time, timelineDuration)
              setTimelineTime(clamped)
              if (clamped !== time) {
                timelineRef.current?.setTime(clamped)
              }
            }}
            onCursorDragEnd={(time) => {
              const clamped = Math.min(time, timelineDuration)
              setTimelineTime(clamped)
              if (clamped !== time) {
                timelineRef.current?.setTime(clamped)
              }
            }}
            onClickActionOnly={(_, { action }) => {
              if (isZoomAction(action)) {
                selectZoomClip(action.zoomClipId)
                return
              }
              const clip = clipById.get(action.id)
              if (clip) selectItem(clip.videoId)
            }}
            onActionMoveStart={handleActionDragStart}
            onActionResizeStart={handleActionDragStart}
            onActionMoving={handleActionMoving}
            onActionMoveEnd={handleMoveEnd}
            onActionResizing={validateResize}
            onActionResizeEnd={handleResizeEnd}
            getAssistDragLineActionIds={getAssistDragLineActionIds}
            getActionRender={renderAction}
            getScaleRender={renderRulerScale}
            className="h-full w-full bg-transparent [--timeline-bg:transparent] [--timeline-divider:transparent] [--timeline-row:transparent]"
            classNames={{
              timeArea: "bg-transparent",
              timeUnit: "border-transparent",
              timeUnitBig:
                "after:absolute after:right-0 after:bottom-0 after:size-1 after:translate-x-1/2 after:rounded-full after:bg-white/35 after:content-['']",
              timeUnitScale:
                "text-[10px] font-medium tabular-nums text-white/45",
              timeAreaInteract: "cursor-default",
              editArea: "mt-3 bg-transparent",
              editRow: "bg-transparent [background-image:none!important]",
              action: "bg-transparent p-1",
              cursor: "border-sky-400",
              cursorTop:
                "text-sky-400 drop-shadow-[0_1px_2px_rgba(8,47,73,0.45)]",
              cursorArea: "cursor-ew-resize",
              dragLine: "border-sky-300/80",
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-white/45">
            Record or import video to build a timeline.
          </div>
        )}
        {hasTimeline && isHoverPreviewActive ? (
          <TimelineHoverGhostCursor
            startLeft={START_LEFT}
            scale={scale}
            scaleWidth={scaleWidth}
            scrollLeftRef={scrollLeftRef}
            subscribeHoverTime={subscribeHoverTime}
          />
        ) : null}
        {hasTimeline && isZoomGhostActive ? (
          <ZoomGhost
            startLeft={START_LEFT}
            scale={scale}
            scaleWidth={scaleWidth}
            viewportWidth={timelinePanelWidth}
            scrollLeftRef={scrollLeftRef}
            scrollTopRef={scrollTopRef}
            rowTop={
              TIMELINE_RULER_HEIGHT +
              TIMELINE_EDIT_AREA_MARGIN_TOP +
              (rows.length - 1) * ROW_HEIGHT
            }
            rowHeight={ROW_HEIGHT}
            subscribe={subscribeZoomGhost}
          />
        ) : null}
      </div>
    </div>
  )
}

type TimelineHoverGhostCursorProps = {
  startLeft: number
  scale: number
  scaleWidth: number
  scrollLeftRef: { current: number }
  subscribeHoverTime: (subscriber: (time: number | null) => void) => () => void
}

const TimelineHoverGhostCursor = memo(function TimelineHoverGhostCursor({
  startLeft,
  scale,
  scaleWidth,
  scrollLeftRef,
  subscribeHoverTime,
}: TimelineHoverGhostCursorProps) {
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const lastTimeRef = useRef<number | null>(null)

  const writePosition = useCallback(
    (time: number | null) => {
      const node = ghostRef.current
      if (!node) return
      if (time === null || !Number.isFinite(time)) {
        node.style.visibility = "hidden"
        return
      }
      const left =
        startLeft +
        (time / Math.max(scale, 1e-6)) * scaleWidth -
        scrollLeftRef.current
      node.style.visibility = "visible"
      node.style.transform = `translate3d(${Math.round(left)}px, 0, 0)`
    },
    [scale, scaleWidth, scrollLeftRef, startLeft]
  )

  // Re-paint when the scale or scrollLeft basis changes (zoom / panel resize)
  // using the last known hover time.
  useEffect(() => {
    writePosition(lastTimeRef.current)
  }, [writePosition])

  useEffect(() => {
    return subscribeHoverTime((time) => {
      lastTimeRef.current = time
      writePosition(time)
    })
  }, [subscribeHoverTime, writePosition])

  return (
    <div
      ref={ghostRef}
      aria-hidden="true"
      className="pointer-events-none absolute top-8 bottom-0 left-0 z-10 w-px border-l border-white/70"
      style={{ visibility: "hidden" }}
    >
      {/* Same teardrop pin as the committed playhead, in white to distinguish a
          preview position from the committed one. Centred on the line's left
          edge so the point sits on the hover line. */}
      <svg
        className="absolute top-0 left-0 -translate-x-1/2 text-white/70 drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]"
        width="12"
        height="22"
        viewBox="0 0 12 22"
        fill="none"
      >
        <path
          d="M6 22C5.5 17 0 8.5 0 6C0 2.6863 2.6863 0 6 0C9.3137 0 12 2.6863 12 6C12 8.5 6.5 17 6 22Z"
          fill="currentColor"
        />
      </svg>
    </div>
  )
})

type ZoomGhostProps = {
  startLeft: number
  scale: number
  scaleWidth: number
  viewportWidth: number
  scrollLeftRef: { current: number }
  scrollTopRef: { current: number }
  /** Top of the zoom lane within the panel (ruler + edit-area margin + rows). */
  rowTop: number
  rowHeight: number
  subscribe: (subscriber: ZoomGhostSubscriber) => () => void
}

// Translucent dashed preview of the zoom clip a click would drop. Positioned
// imperatively from the ghost subscription so hover-move never re-renders the
// timeline. Inset by ZOOM_GHOST_INSET on every side to match the committed
// clip's `p-1`.
const ZoomGhost = memo(function ZoomGhost({
  startLeft,
  scale,
  scaleWidth,
  viewportWidth,
  scrollLeftRef,
  scrollTopRef,
  rowTop,
  rowHeight,
  subscribe,
}: ZoomGhostProps) {
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const lastSpanRef = useRef<ZoomGhostSpan | null>(null)

  const writePosition = useCallback(
    (span: ZoomGhostSpan | null) => {
      const node = ghostRef.current
      if (!node) return
      if (!span) {
        node.style.visibility = "hidden"
        return
      }
      const safeScale = Math.max(scale, 1e-6)
      const rawLeft =
        startLeft +
        (span.start / safeScale) * scaleWidth -
        scrollLeftRef.current
      const rawWidth = Math.max(
        0,
        ((span.end - span.start) / safeScale) * scaleWidth
      )
      const viewportRight =
        viewportWidth > 0 ? viewportWidth : Number.POSITIVE_INFINITY
      const clippedLeft = Math.max(0, rawLeft)
      const clippedRight = Math.min(viewportRight, rawLeft + rawWidth)
      const clippedWidth = clippedRight - clippedLeft
      if (clippedWidth <= 0) {
        node.style.visibility = "hidden"
        return
      }

      const inset = clippedWidth > ZOOM_GHOST_INSET * 2 ? ZOOM_GHOST_INSET : 0
      const left = clippedLeft + inset
      const width = clippedWidth - inset * 2
      if (width <= 0) {
        node.style.visibility = "hidden"
        return
      }
      node.dataset.density =
        width >= ZOOM_GHOST_LABEL_MIN_WIDTH
          ? "label"
          : width >= ZOOM_GHOST_ICON_MIN_WIDTH
            ? "icon"
            : "marker"
      const top = rowTop - scrollTopRef.current + ZOOM_GHOST_INSET
      node.style.visibility = "visible"
      node.style.transform = `translate3d(${left.toFixed(3)}px, ${top.toFixed(
        3
      )}px, 0)`
      node.style.width = `${width.toFixed(3)}px`
      node.style.height = `${rowHeight - ZOOM_GHOST_INSET * 2}px`
    },
    [
      rowHeight,
      rowTop,
      scale,
      scaleWidth,
      scrollLeftRef,
      scrollTopRef,
      startLeft,
      viewportWidth,
    ]
  )

  // Re-place when the scale / layout basis changes (zoom, panel resize, lane
  // count) using the last known span.
  useEffect(() => {
    writePosition(lastSpanRef.current)
  }, [writePosition])

  useEffect(() => {
    return subscribe((span) => {
      lastSpanRef.current = span
      writePosition(span)
    })
  }, [subscribe, writePosition])

  return (
    <div
      ref={ghostRef}
      aria-hidden="true"
      data-density="label"
      className="group pointer-events-none absolute top-0 left-0 z-10 flex min-w-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-dashed border-violet-300/70 bg-violet-400/20 px-2 text-[11px] leading-none font-medium whitespace-nowrap text-violet-50 data-[density=icon]:gap-0 data-[density=icon]:px-0 data-[density=marker]:gap-0 data-[density=marker]:px-0"
      style={{ visibility: "hidden" }}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center group-data-[density=marker]:hidden">
        <HugeiconsIcon icon={PlusSignIcon} size={16} color="currentColor" />
      </span>
      <span className="min-w-0 truncate group-data-[density=icon]:hidden group-data-[density=marker]:hidden">
        Add Zoom
      </span>
    </div>
  )
})
