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

export function serializeVideo(video: CanvasVideoItem): ProjectVideo {
  return {
    id: video.id,
    fileName: video.fileName,
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

export function serializeProjectState(
  artboard: EditorArtboard,
  videos: CanvasVideoItem[],
  timelineClips: CanvasTimelineClip[]
): ProjectStateV1 {
  return {
    version: 1,
    artboard: serializeArtboard(artboard),
    videos: videos.map(serializeVideo),
    timelineClips: timelineClips.map(serializeTimelineClip),
    updatedAtUnixMs: Date.now(),
  }
}

export function projectVideoToCanvasVideo(
  video: ProjectVideo,
  objectUrl: string
): CanvasVideoItem {
  return {
    id: video.id,
    fileName: video.fileName,
    objectUrl,
    fileSize:
      video.source.kind === "imported" ? video.source.fileSize : 0,
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
