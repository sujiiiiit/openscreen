import type {
  ProjectArtboard,
  ProjectStateV1,
  ProjectTimelineClip,
  ProjectVideo,
} from "@/types/api"
import type {
  CanvasTimelineClip,
  CanvasVideoItem,
  EditorArtboard,
} from "@/types/editor-canvas"

export const PROJECT_STATE_AUTOSAVE_DEBOUNCE_MS = 500
// How long to wait after a save error before retrying. Long enough to avoid
// a tight retry loop on a persistent failure (full disk, perms denied) but
// short enough that a transient blip self-heals before the user notices the
// red indicator and tries to "fix" it themselves.
export const PROJECT_STATE_AUTOSAVE_RETRY_MS = 5000

// Stable fingerprint of a `ProjectStateV1` that ignores `updatedAtUnixMs`,
// which is re-stamped on every save. Comparing fingerprints lets us skip a
// disk write when the hydrated state and the in-memory state would
// serialise identically (the common case immediately after fast-path
// hydration).
export function fingerprintProjectState(
  snapshot: ProjectStateV1
): string | null {
  try {
    return JSON.stringify({
      artboard: snapshot.artboard,
      videos: snapshot.videos,
      timelineClips: snapshot.timelineClips,
    })
  } catch {
    return null
  }
}

export function serializeArtboard(artboard: EditorArtboard): ProjectArtboard {
  return {
    presetId: artboard.presetId,
    width: artboard.width,
    height: artboard.height,
    background: artboard.background
      ? cloneBackground(artboard.background)
      : null,
    padding: artboard.padding,
    grain: artboard.grain,
    cursorSizeMultiplier: artboard.cursorSizeMultiplier,
  }
}

function cloneBackground(
  background: NonNullable<EditorArtboard["background"]>
): NonNullable<ProjectArtboard["background"]> {
  if (background.type === "color") {
    return { type: "color", value: background.value }
  }
  return {
    type: "wallpaper",
    value: background.value,
    blurRadius: background.blurRadius,
  }
}

// `onCanvas` is supplied by the caller rather than read from the item: the
// runtime keeps on-canvas and detached videos in two separate lists, so the
// flag is known from which list the video came from. We omit the field when
// the video is on the canvas so `project.json` stays byte-identical to the
// pre-feature format (a missing `onCanvas` already means "on canvas"), which
// keeps the post-hydration autosave fingerprint a no-op for legacy projects.
export function serializeVideo(
  video: CanvasVideoItem,
  onCanvas = true
): ProjectVideo {
  return {
    id: video.id,
    fileName: video.fileName,
    source: video.source,
    ...(onCanvas ? {} : { onCanvas: false }),
    intrinsicWidth: video.intrinsicWidth,
    intrinsicHeight: video.intrinsicHeight,
    durationMs: video.durationMs,
    role: video.role,
    x: video.x,
    y: video.y,
    width: video.width,
    height: video.height,
    rotation: video.rotation,
    locked: video.locked,
    cornerRadius: video.cornerRadius,
    cornerSmoothing: video.cornerSmoothing,
    borderWidth: video.borderWidth,
    borderColor: video.borderColor,
    borderOffset: video.borderOffset,
    borderAlignment: video.borderAlignment,
    shadowColor: video.shadowColor,
    shadowBlur: video.shadowBlur,
    shadowOffsetX: video.shadowOffsetX,
    shadowOffsetY: video.shadowOffsetY,
    shadowSpread: video.shadowSpread,
  }
}

export function serializeTimelineClip(
  clip: CanvasTimelineClip
): ProjectTimelineClip {
  return {
    id: clip.id,
    videoId: clip.videoId,
    start: clip.start,
    end: clip.end,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
  }
}

// Detached videos (removed from the canvas but still part of the project) are
// appended after the on-canvas videos so they survive a refresh. They carry
// `onCanvas: false` and have no timeline clip. The default `[]` keeps callers
// that only deal with on-canvas videos (e.g. the export snapshot) unchanged.
export function serializeProjectState(
  artboard: EditorArtboard,
  videos: CanvasVideoItem[],
  timelineClips: CanvasTimelineClip[],
  detachedVideos: CanvasVideoItem[] = []
): ProjectStateV1 {
  return {
    version: 1,
    artboard: serializeArtboard(artboard),
    videos: [
      ...videos.map((video) => serializeVideo(video, true)),
      ...detachedVideos.map((video) => serializeVideo(video, false)),
    ],
    timelineClips: timelineClips.map(serializeTimelineClip),
    updatedAtUnixMs: Date.now(),
  }
}

/**
 * Rebuild a runtime video item from its persisted record.
 *
 * `fileSize` is supplied by the caller rather than derived from `video`:
 * imported sources persist their byte size in `project.json`, but recording
 * sources do not — a recording's size is owned by its on-disk asset, which the
 * main process freshly stats on every project open. The caller resolves it
 * from the matching `ProjectAsset.fileSize`, so a recording reports its real
 * size after a reload instead of falling back to "Unknown size".
 */
export function projectVideoToCanvasVideo(
  video: ProjectVideo,
  objectUrl: string,
  fileSize: number
): CanvasVideoItem {
  return {
    id: video.id,
    fileName: video.fileName,
    objectUrl,
    fileSize,
    source: video.source,
    intrinsicWidth: video.intrinsicWidth,
    intrinsicHeight: video.intrinsicHeight,
    durationMs: video.durationMs,
    role: video.role,
    x: video.x,
    y: video.y,
    width: video.width,
    height: video.height,
    rotation: video.rotation,
    locked: video.locked,
    cornerRadius: video.cornerRadius,
    cornerSmoothing: video.cornerSmoothing,
    borderWidth: video.borderWidth,
    borderColor: video.borderColor,
    borderOffset: video.borderOffset,
    borderAlignment: video.borderAlignment,
    shadowColor: video.shadowColor,
    shadowBlur: video.shadowBlur,
    shadowOffsetX: video.shadowOffsetX,
    shadowOffsetY: video.shadowOffsetY,
    shadowSpread: video.shadowSpread,
  }
}

export function projectClipToCanvasClip(
  clip: ProjectTimelineClip
): CanvasTimelineClip {
  return {
    id: clip.id,
    videoId: clip.videoId,
    start: clip.start,
    end: clip.end,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
  }
}
