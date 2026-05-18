import type { ArtboardPresetId } from "@/lib/editor-canvas"

export type CanvasSize = {
  width: number
  height: number
}

export type ArtboardBackground =
  | { type: "wallpaper"; value: string; blurRadius?: number }
  | { type: "color"; value: string }

export type EditorArtboard = CanvasSize & {
  presetId: ArtboardPresetId
  background: ArtboardBackground | null
  grain: number
  padding: number
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

export type CanvasVideoRole = "screen" | "camera" | "media"

export type CanvasVideoItem = {
  id: string
  fileName: string
  objectUrl: string
  /** Source file size in bytes. `0` when unknown (e.g. remote stream). */
  fileSize: number
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
}

export type CanvasVideoTransformPatch = Partial<
  Pick<CanvasVideoItem, "x" | "y" | "width" | "height" | "rotation">
>

export type CanvasVideoAppearancePatch = Partial<
  Pick<CanvasVideoItem, "cornerRadius" | "cornerSmoothing">
>

export type CanvasTimelineClip = {
  id: string
  videoId: string
  start: number
  end: number
  sourceIn: number
  sourceOut: number
}
