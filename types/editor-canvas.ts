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

export type CanvasVideoCropShape = "rect" | "circle"

export type CanvasVideoRole = "screen" | "camera" | "media"

export type CanvasVideoItem = {
  id: string
  fileName: string
  objectUrl: string
  intrinsicWidth: number
  intrinsicHeight: number
  durationMs: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
  locked: boolean
  cropShape: CanvasVideoCropShape
  role: CanvasVideoRole
}

export type CanvasVideoTransformPatch = Partial<
  Pick<CanvasVideoItem, "x" | "y" | "width" | "height" | "rotation">
>

export type CanvasTimelineClip = {
  id: string
  videoId: string
  start: number
  end: number
  sourceIn: number
  sourceOut: number
}
