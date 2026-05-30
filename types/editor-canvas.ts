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

export type CursorMotionBlurBackend = "gpu" | "cpu"
export type CursorMotionRotationMode = "side-lean" | "rotation"
export type CursorSmoothingMode = "rapid" | "quick" | "default" | "slow"

export type EditorArtboard = CanvasSize & {
  presetId: ArtboardPresetId
  background: ArtboardBackground | null
  grain: number
  padding: number
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
  // Cursor motion-rotation amount, 0..1 (0 = off). Horizontal cursor velocity
  // adds a subtle lean, or full 2D motion direction adds a bounded rotation,
  // around the existing hotspot; shared by preview/export.
  cursorMotionRotation: number
  // Cursor motion-rotation behavior. Default is the Screen-Studio-style side
  // lean; rotation follows the 2D travel vector with the same amount slider.
  cursorMotionRotationMode: CursorMotionRotationMode
  // Renderer backend for cursor motion blur. GPU is the default for responsive
  // preview; CPU is kept as a project-level fallback/comparison mode.
  cursorMotionBlurBackend: CursorMotionBlurBackend
  // Cursor path smoothing preset. All modes smooth; Rapid is the lightest and
  // Slow is the softest. Shared by preview and export.
  cursorSmoothingMode: CursorSmoothingMode
  // Target cursor scale while a captured mouse button is pressed. `1` disables
  // the shrink; default is 0.88. Shared by preview and export.
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
  /**
   * Drop-shadow color as a CSS string. Alpha is baked into the color (rgba)
   * — there is no separate `shadowOpacity` field. The shadow pass is skipped
   * entirely when the parsed alpha is 0 or when every spatial field
   * (`blur`, `offsetX`, `offsetY`, `spread`) is 0.
   */
  shadowColor: string
  /** Gaussian blur radius in artboard px. `0` is a sharp cast (no falloff). */
  shadowBlur: number
  /** Horizontal shadow displacement in artboard px. Signed; positive = right. */
  shadowOffsetX: number
  /** Vertical shadow displacement in artboard px. Signed; positive = down. */
  shadowOffsetY: number
  /**
   * Silhouette spread in artboard px (Figma "spread"). Positive grows the
   * shadow caster outward before blur; negative shrinks it. The corner
   * radius shifts by the same delta so the shadow stays squircle-aligned.
   */
  shadowSpread: number
}

export type CanvasVideoTransformPatch = Partial<
  Pick<CanvasVideoItem, "x" | "y" | "width" | "height" | "rotation">
>

export type CanvasVideoAppearancePatch = Partial<
  Pick<
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
