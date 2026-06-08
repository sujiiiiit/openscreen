import type { ArtboardPresetId } from "@/lib/editor-canvas"
import type { CursorSetId } from "@/lib/cursors/cursor-manifest"

export type { CursorSetId } from "@/lib/cursors/cursor-manifest"

export type CanvasSize = {
  width: number
  height: number
}

export type ArtboardBackground =
  | { type: "wallpaper"; value: string; blurRadius?: number }
  | { type: "color"; value: string }

export type CursorSmoothingMode = "rapid" | "quick" | "default" | "slow"

export type EditorArtboard = CanvasSize & {
  presetId: ArtboardPresetId
  background: ArtboardBackground | null
  grain: number
  padding: number
  // Master switch for the background treatment (Background tab header). When
  // false, preview and export skip painting the background fill/wallpaper and
  // grain; the stored background/grain/padding values stay persisted so they
  // come back when re-enabled. Mirrors cursorCustomRenderingEnabled.
  backgroundEnabled: boolean
  // Master switch for the custom cursor overlay. When false, preview and export
  // skip rendering the themed cursor entirely; the other cursor settings stay
  // persisted so they come back when the overlay is re-enabled.
  cursorCustomRenderingEnabled: boolean
  // The bundled cursor asset set used to resolve each captured cursor shape.
  // Shared by preview/export and persisted on the artboard.
  cursorSetId: CursorSetId
  // Recorded-cursor render-size multiplier (1 = reference-frame base size). It
  // is independent from later screen-video resize/scale. See cursor-scene.ts
  // CURSOR_SIZE_MIN/MAX. Project-level: one screen recording per project, so the
  // cursor size is global to the artboard.
  cursorSizeMultiplier: number
  // Cursor motion-blur intensity, 0..1 (0 = off). The blur velocity is derived
  // from cursor speed; this is the single user-facing amount. See cursor-scene.ts
  // CURSOR_MOTION_BLUR_DEFAULT / computeCursorBlur.
  cursorMotionBlur: number
  // Cursor side-lean amount, 0..1 (0 = off). Horizontal cursor velocity adds a
  // subtle Screen-Studio-style lean around the existing hotspot; shared by
  // preview/export. (The full direction-follow "rotation" mode was removed
  // 2026-06-06; the persisted `cursorMotionRotationMode` field is read/ignored
  // for v1 compatibility.)
  cursorMotionRotation: number
  // Cursor path smoothing preset. All modes smooth; Rapid is the lightest and
  // Slow is the softest. Shared by preview and export.
  cursorSmoothingMode: CursorSmoothingMode
  // Target cursor scale while a captured mouse button is pressed. `1` disables
  // the shrink; default is 0.78 (22 % downscale). Shared by preview and export.
  cursorClickPressScale: number
  // When true, every captured cursor id resolves to the themed pointer asset.
  // Useful when text/resize cursors are distracting. Shared by preview/export.
  cursorAlwaysUsePointer: boolean
}

export const ARTBOARD_SELECTION_ID = "__artboard__"

export type PixelGridSettings = {
  enabled: boolean
  unit: number
  majorUnit: number
  visibleFromScale: number
  opacity: number
  color: string
  majorOpacity: number
  majorColor: string
  role: "visual-only"
}

export type ViewTransform = {
  scale: number
  x: number
  y: number
}

/** The kinds of editable content that can live on the artboard. */
export type NodeType = "video" | "image" | "text" | "shape"

/**
 * A node's placement on the artboard. `(x, y)` is the top-left of the
 * axis-aligned (unrotated) box in artboard coordinates; `rotation` (radians) is
 * applied around the box's center. Placement is derived from the artboard
 * settings (`lib/video-placement.ts`); `rotation` is always 0 for new state and
 * exists so the hit-test/overlay math in `lib/node-transform.ts` stays general.
 */
export type NodeTransform = {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

/**
 * A node on the artboard — the in-memory canvas model the PixiJS scene and the
 * pure hit-test math operate on. It is a read-side derivation of
 * {@link CanvasVideoItem} (see `components/editor/canvas/pixi/node-model.ts`),
 * never persisted directly. Named to avoid clashing with the DOM `Node`.
 */
export type CanvasNode = {
  id: string
  type: NodeType
} & NodeTransform

/**
 * Coarse-grained label for the autosave pipeline shown in the titlebar.
 * - `idle`: no project loaded yet, indicator hidden.
 * - `saving`: a debounce timer or in-flight write is pending.
 * - `saved`: last write succeeded and there are no pending changes.
 * - `error`: last write failed; indicator turns red and the tooltip explains.
 */
export type EditorSaveStatus = "idle" | "saving" | "saved" | "error"

export type CanvasVideoRole = "screen" | "camera" | "media"

export type CanvasBorderAlignment = "inside" | "center" | "outside"

/**
 * Persistence-side description of where a video's bytes live. Imported files
 * are stored inside the project folder (`relativePath` is relative to it);
 * recording sources resolve through `recording.json` and the project's
 * `assets[]` array. The renderer never invents file paths from this — the
 * main process maps each video id to a `file://` URL when loading the
 * project (`ProjectSummary.assetUrlsByVideoId`).
 */
export type CanvasVideoSource =
  | { kind: "recording"; assetRole: "screen" | "camera" }
  | { kind: "imported"; relativePath: string; fileSize: number }

export type CanvasVideoItem = {
  id: string
  fileName: string
  objectUrl: string
  /** Source file size in bytes. `0` when unknown (e.g. remote stream). */
  fileSize: number
  /** Persistence pointer to the underlying media file. */
  source: CanvasVideoSource
  intrinsicWidth: number
  intrinsicHeight: number
  durationMs: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
  locked: boolean
  role: CanvasVideoRole
  cornerRadius: number
  cornerSmoothing: number
  /** Border stroke width in artboard px. `0` hides the border entirely. */
  borderWidth: number
  /** Border stroke color (CSS color string). */
  borderColor: string
  /**
   * Signed gap in artboard px between the node edge and the border centerline.
   * Positive pushes the border outward; negative pulls it inward. The final
   * centerline is `offset` plus the alignment delta (±width/2 for outside /
   * inside, 0 for center).
   */
  borderOffset: number
  /** Where the stroke sits relative to its (already offset) centerline. */
  borderAlignment: CanvasBorderAlignment
}

export type CanvasVideoAppearancePatch = Partial<
  Pick<
    CanvasVideoItem,
    | "cornerRadius"
    | "cornerSmoothing"
    | "borderWidth"
    | "borderColor"
    | "borderOffset"
    | "borderAlignment"
  >
>

export type CanvasTimelineClip = {
  id: string
  videoId: string
  start: number
  end: number
  sourceIn: number
  sourceOut: number
}

export type CanvasZoomFocus = {
  /** Normalized target X, where 0 = left edge and 1 = right edge. */
  x: number
  /** Normalized target Y, where 0 = top edge and 1 = bottom edge. */
  y: number
}

export type CanvasZoomTransitionCurve =
  | "linear"
  | "smoothstep"
  | "smootherstep"
  | "ease-out-cubic"

export type CanvasZoomTransitionSettings = {
  /** Legacy fraction of the clip duration spent ramping in; read for old files. */
  easeIn: number
  /** Legacy fraction of the clip duration spent ramping out; read for old files. */
  easeOut: number
  /** Legacy ramp speed multiplier; new saves use durationMs instead. */
  speed: number
  /** Milliseconds each zoom-in / zoom-out ramp should take when the clip is long enough. */
  durationMs: number
  /** Curve applied inside each ramp. */
  curve: CanvasZoomTransitionCurve
}

export type CanvasZoomRadialBlurSettings = {
  /** Pixi ZoomBlurFilter-style strength multiplier after radialBlur amount. */
  strength: number
  /** Legacy symmetric-shader field; retained for hydration but ignored now. */
  falloff: number
  /** Legacy inner-radius field; retained for hydration but ignored now. */
  centerSize: number
  /** Legacy symmetric-shader field; retained for hydration but ignored now. */
  centerSharpness: number
}

// Legacy project field kept readable for old project.json files. New editor UI
// writes explicit CanvasZoomTransitionSettings instead of these named presets.
export type CanvasZoomEasePreset = "smooth" | "snappy" | "slow"

/**
 * A manually-placed zoom segment on the timeline's dedicated Zoom track.
 * `start`/`end` are composition (timeline) seconds and represent the full
 * effect: identity -> zoom -> hold -> identity. Selecting a zoom clip is
 * session-only (provider `selectedZoomClipId`), not part of this persisted
 * shape.
 */
export type CanvasZoomClip = {
  id: string
  start: number
  end: number
  enabled: boolean
  /** User-picked anchor point; the zoom scales around this fixed artboard point. */
  focus: CanvasZoomFocus
  scale: number
  radialBlur: number
  radialBlurSettings: CanvasZoomRadialBlurSettings
  transition: CanvasZoomTransitionSettings
  easePreset: CanvasZoomEasePreset
}

export type CanvasZoomClipPatch = Partial<
  Pick<
    CanvasZoomClip,
    "enabled" | "focus" | "scale" | "radialBlur" | "easePreset"
  >
> & {
  radialBlurSettings?: Partial<CanvasZoomRadialBlurSettings>
  transition?: Partial<CanvasZoomTransitionSettings>
}
