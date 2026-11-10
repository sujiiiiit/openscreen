import type {
  ProjectArtboard,
  ProjectStateV1,
  ProjectTimelineClip,
  ProjectVideo,
  ProjectZoomClip,
} from "@/types/api"
import type {
  CanvasTimelineClip,
  CanvasVideoItem,
  CanvasZoomClip,
  EditorArtboard,
} from "@/types/editor-canvas"
import {
  ZOOM_FOCUS_DEFAULT,
  ZOOM_MODE_DEFAULT,
  ZOOM_RADIAL_BLUR_DEFAULT,
  ZOOM_SCALE_DEFAULT,
  ZOOM_TRANSITION_DEFAULT,
  withZoomClipDefaults,
  zoomTransitionSettingsEqual,
} from "@/lib/zoom-clips"

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
      // Included so a zoom-clip edit changes the fingerprint and triggers a
      // save. Normalized to `[]` because "absent" and "present but empty"
      // are the same state: `serializeProjectState` omits the key when the
      // array is empty while a hand-rolled or round-tripped file may carry
      // an explicit `[]` — without normalization an add-then-delete cycle
      // produced one spurious save.
      zoomClips: snapshot.zoomClips ?? [],
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
    backgroundEnabled: artboard.backgroundEnabled,
    cursorCustomRenderingEnabled: artboard.cursorCustomRenderingEnabled,
    cursorSetId: artboard.cursorSetId,
    cursorSizeMultiplier: artboard.cursorSizeMultiplier,
    cursorMotionBlur: artboard.cursorMotionBlur,
    cursorMotionRotation: artboard.cursorMotionRotation,
    // `cursorMotionRotationMode` is no longer written: the direction-follow
    // "rotation" mode was removed (side lean is the only behavior). The field
    // stays optional in the v1 schema so legacy files keep parsing.
    cursorSmoothingMode: artboard.cursorSmoothingMode,
    cursorClickPressScale: artboard.cursorClickPressScale,
    cursorAlwaysUsePointer: artboard.cursorAlwaysUsePointer,
    cursorTypeStabilization: artboard.cursorTypeStabilization,
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

function serializeZoomTransition(
  transition: CanvasZoomClip["transition"]
): ProjectZoomClip["transition"] | undefined {
  if (zoomTransitionSettingsEqual(transition, ZOOM_TRANSITION_DEFAULT)) {
    return undefined
  }
  return {
    ...(transition.durationMs !== ZOOM_TRANSITION_DEFAULT.durationMs
      ? { durationMs: transition.durationMs }
      : {}),
    ...(transition.curve !== ZOOM_TRANSITION_DEFAULT.curve
      ? { curve: transition.curve }
      : {}),
  }
}

// The old per-clip zoom-blur panel exposed strength/falloff/centerSize/
// centerSharpness for the symmetric shader. The Pixi-style ZoomBlurFilter path
// now bakes the inner radius at 2%; all radialBlurSettings fields are legacy
// hydration fields and are no longer written by new saves.
// Round normalized values for tidy, stable JSON (frame-analysis rects are
// already deterministic; this just trims float noise from the serialized form).
const round4 = (value: number) => Math.round(value * 1e4) / 1e4

export function serializeZoomClip(clip: CanvasZoomClip): ProjectZoomClip {
  const normalized = withZoomClipDefaults(clip)
  const transition = serializeZoomTransition(normalized.transition)
  return {
    id: normalized.id,
    start: normalized.start,
    end: normalized.end,
    ...(normalized.enabled === false ? { enabled: false } : {}),
    ...(normalized.focus.x !== ZOOM_FOCUS_DEFAULT.x ||
    normalized.focus.y !== ZOOM_FOCUS_DEFAULT.y
      ? { focus: { x: normalized.focus.x, y: normalized.focus.y } }
      : {}),
    // Omitted when default so legacy `project.json` files stay byte-identical
    // until a clip's mode is changed away from the default.
    ...(normalized.mode !== ZOOM_MODE_DEFAULT ? { mode: normalized.mode } : {}),
    ...(normalized.scale !== ZOOM_SCALE_DEFAULT
      ? { scale: normalized.scale }
      : {}),
    ...(normalized.radialBlur !== ZOOM_RADIAL_BLUR_DEFAULT
      ? { radialBlur: normalized.radialBlur }
      : {}),
    ...(transition ? { transition } : {}),
    // Omitted when empty so legacy `project.json` files (and clips with no
    // detected content) stay byte-identical.
    ...(normalized.engagedRects.length > 0
      ? {
          engagedRects: normalized.engagedRects.map((r) => ({
            t: round4(r.t),
            rect: {
              x: round4(r.rect.x),
              y: round4(r.rect.y),
              width: round4(r.rect.width),
              height: round4(r.rect.height),
            },
          })),
        }
      : {}),
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
  detachedVideos: CanvasVideoItem[] = [],
  // Trailing optional so every existing call site (export snapshot, tests)
  // stays valid. Omitted from the output when empty so legacy `project.json`
  // files stay byte-identical until the first zoom clip is added.
  zoomClips: CanvasZoomClip[] = []
): ProjectStateV1 {
  return {
    version: 1,
    artboard: serializeArtboard(artboard),
    videos: [
      ...videos.map((video) => serializeVideo(video, true)),
      ...detachedVideos.map((video) => serializeVideo(video, false)),
    ],
    timelineClips: timelineClips.map(serializeTimelineClip),
    ...(zoomClips.length > 0
      ? { zoomClips: zoomClips.map(serializeZoomClip) }
      : {}),
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

export function projectZoomClipToCanvasClip(
  clip: ProjectZoomClip
): CanvasZoomClip {
  return withZoomClipDefaults({
    id: clip.id,
    start: clip.start,
    end: clip.end,
    enabled: clip.enabled,
    focus: clip.focus,
    mode: clip.mode,
    scale: clip.scale,
    radialBlur: clip.radialBlur,
    radialBlurSettings: clip.radialBlurSettings,
    transition: clip.transition,
    easePreset: clip.easePreset,
    engagedRects: clip.engagedRects,
  })
}
