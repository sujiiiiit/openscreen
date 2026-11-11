import type {
  CanvasSize,
  CanvasVideoItem,
  PixelGridSettings,
  ViewTransform,
} from "@/types/editor-canvas"

export const MIN_WORKSPACE_ZOOM = 0.1
export const MAX_WORKSPACE_ZOOM = 250
export const WORKSPACE_ZOOM_STEP = 1.18
export const WORKSPACE_WHEEL_ZOOM_DELTA = 60
export const WORKSPACE_PINCH_ZOOM_DELTA = 16
export const ARTBOARD_FIT_PADDING = 96
export const WORKSPACE_PAN_MARGIN = 120
export const WORKSPACE_MIN_VISIBLE_PIXELS = 120
export const PIXEL_GRID_SETTINGS: PixelGridSettings = {
  enabled: true,
  unit: 1,
  majorUnit: 10,
  visibleFromScale: 4,
  opacity: 0.36,
  color: "rgba(25, 25, 25, 0.38)",
  majorOpacity: 0.52,
  majorColor: "rgba(25, 25, 25, 0.46)",
  role: "visual-only",
}

export const ARTBOARD_PRESETS = [
  {
    id: "wide",
    label: "Wide",
    ratioLabel: "16:9",
    width: 1920,
    height: 1080,
  },
  {
    id: "vertical",
    label: "Vertical",
    ratioLabel: "9:16",
    width: 1080,
    height: 1920,
  },
  {
    id: "standard",
    label: "Standard",
    ratioLabel: "4:3",
    width: 1440,
    height: 1080,
  },
  {
    id: "portrait",
    label: "Portrait",
    ratioLabel: "4:5",
    width: 1080,
    height: 1350,
  },
  {
    id: "square",
    label: "Square",
    ratioLabel: "1:1",
    width: 1080,
    height: 1080,
  },
] as const

export const AUTO_ARTBOARD_PRESET_ID = "auto" as const

export type FixedArtboardPresetId = (typeof ARTBOARD_PRESETS)[number]["id"]
export type ArtboardPresetId =
  | FixedArtboardPresetId
  | typeof AUTO_ARTBOARD_PRESET_ID

export const DEFAULT_ARTBOARD_PRESET_ID: ArtboardPresetId = "wide"

export function getArtboardPreset(id: ArtboardPresetId) {
  if (id === AUTO_ARTBOARD_PRESET_ID) return ARTBOARD_PRESETS[0]
  return (
    ARTBOARD_PRESETS.find((preset) => preset.id === id) ?? ARTBOARD_PRESETS[0]
  )
}

/**
 * The source dims the Auto preset resolves against: the screen recording's
 * pixel size when hydration captured it, else the screen-role canvas video's
 * intrinsic size, else the first on-canvas video with a known intrinsic size
 * (imported videos), else null — `resolveAutoArtboard` then falls back to
 * Wide. Shared by `setArtboardPreset` and the artboard preset dropdown so the
 * advertised Auto size always matches what selecting Auto actually applies.
 */
export function resolveAutoSourceDims(
  screenSourceDims: { width: number; height: number } | null,
  videos: readonly CanvasVideoItem[]
): { width: number; height: number } | null {
  if (screenSourceDims) return screenSourceDims
  const hasDims = (video: CanvasVideoItem) =>
    video.intrinsicWidth > 0 && video.intrinsicHeight > 0
  const candidate =
    videos.find((video) => video.role === "screen" && hasDims(video)) ??
    videos.find(hasDims)
  return candidate
    ? { width: candidate.intrinsicWidth, height: candidate.intrinsicHeight }
    : null
}

export function resolveAutoArtboard(source: {
  width?: number
  height?: number
} | null): { width: number; height: number } {
  const sourceWidth = source?.width
  const sourceHeight = source?.height
  if (
    typeof sourceWidth === "number" &&
    sourceWidth > 0 &&
    typeof sourceHeight === "number" &&
    sourceHeight > 0
  ) {
    return { width: sourceWidth, height: sourceHeight }
  }
  return { width: ARTBOARD_PRESETS[0].width, height: ARTBOARD_PRESETS[0].height }
}

export function clampWorkspaceZoom(scale: number) {
  return Math.min(MAX_WORKSPACE_ZOOM, Math.max(MIN_WORKSPACE_ZOOM, scale))
}

function clampAxis(
  position: number,
  viewportLength: number,
  contentLength: number,
  scale: number
) {
  const scaledContentLength = contentLength * scale

  if (scaledContentLength <= viewportLength) {
    const center = (viewportLength - scaledContentLength) / 2
    const allowance = WORKSPACE_PAN_MARGIN

    return Math.min(center + allowance, Math.max(center - allowance, position))
  }

  const visibleStrip = Math.min(
    WORKSPACE_MIN_VISIBLE_PIXELS,
    viewportLength * 0.4,
    scaledContentLength
  )
  const min = visibleStrip - scaledContentLength
  const max = viewportLength - visibleStrip

  return Math.min(max, Math.max(min, position))
}

export function clampWorkspaceView(
  viewTransform: ViewTransform,
  viewportSize: CanvasSize,
  artboardSize: CanvasSize
): ViewTransform {
  const scale = clampWorkspaceZoom(viewTransform.scale)

  if (
    viewportSize.width <= 0 ||
    viewportSize.height <= 0 ||
    artboardSize.width <= 0 ||
    artboardSize.height <= 0
  ) {
    return { scale, x: viewTransform.x, y: viewTransform.y }
  }

  return {
    scale,
    x: clampAxis(
      viewTransform.x,
      viewportSize.width,
      artboardSize.width,
      scale
    ),
    y: clampAxis(
      viewTransform.y,
      viewportSize.height,
      artboardSize.height,
      scale
    ),
  }
}

export function getZoomedViewTransform(
  viewTransform: ViewTransform,
  point: { x: number; y: number },
  scale: number
): ViewTransform {
  const nextScale = clampWorkspaceZoom(scale)
  const worldPoint = {
    x: (point.x - viewTransform.x) / viewTransform.scale,
    y: (point.y - viewTransform.y) / viewTransform.scale,
  }

  return {
    scale: nextScale,
    x: point.x - worldPoint.x * nextScale,
    y: point.y - worldPoint.y * nextScale,
  }
}

export function getFitViewTransform(
  viewportSize: CanvasSize,
  artboardSize: CanvasSize
): ViewTransform {
  if (
    viewportSize.width <= 0 ||
    viewportSize.height <= 0 ||
    artboardSize.width <= 0 ||
    artboardSize.height <= 0
  ) {
    return { scale: 1, x: 0, y: 0 }
  }

  const availableWidth = Math.max(1, viewportSize.width - ARTBOARD_FIT_PADDING)
  const availableHeight = Math.max(
    1,
    viewportSize.height - ARTBOARD_FIT_PADDING
  )
  const scale = clampWorkspaceZoom(
    Math.min(
      availableWidth / artboardSize.width,
      availableHeight / artboardSize.height
    )
  )

  return {
    scale,
    x: (viewportSize.width - artboardSize.width * scale) / 2,
    y: (viewportSize.height - artboardSize.height * scale) / 2,
  }
}

// Like getFitViewTransform but with zero padding: the artboard fills as much of
// the viewport as it can while preserving aspect ratio. Used by fullscreen
// preview, where letterbox bars (not a fixed margin) frame the composition.
export function getPreviewFillTransform(
  viewportSize: CanvasSize,
  artboardSize: CanvasSize
): ViewTransform {
  if (
    viewportSize.width <= 0 ||
    viewportSize.height <= 0 ||
    artboardSize.width <= 0 ||
    artboardSize.height <= 0
  ) {
    return { scale: 1, x: 0, y: 0 }
  }

  const scale = clampWorkspaceZoom(
    Math.min(
      viewportSize.width / artboardSize.width,
      viewportSize.height / artboardSize.height
    )
  )

  return {
    scale,
    x: (viewportSize.width - artboardSize.width * scale) / 2,
    y: (viewportSize.height - artboardSize.height * scale) / 2,
  }
}
