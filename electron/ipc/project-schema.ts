// IMPORTANT: this schema is the source of truth for `project.json` — the
// editor-state file we autosave next to each project's `recording.json`. The
// renderer-facing copies in `types/api.d.ts` MUST mirror these exports until
// we collapse the two tsconfig roots into a shared workspace.
//
// Schema versioning rule: never mutate an existing version's shape. Add a new
// `ProjectStateV{N}` type, bump `CURRENT_PROJECT_STATE_VERSION`, and extend
// `parseProjectState` with a migration branch.

export type ProjectStateVersion = 1

export const CURRENT_PROJECT_STATE_VERSION: ProjectStateVersion = 1

export type ProjectArtboardPresetId =
  | "wide"
  | "vertical"
  | "portrait"
  | "standard"
  | "square"
  | "auto"

export type ProjectArtboardBackground =
  | { type: "color"; value: string }
  | { type: "wallpaper"; value: string; blurRadius?: number }

const CURSOR_SET_IDS = [
  "custom-1",
  "custom-10",
  "custom-11",
  "custom-12",
  "custom-13",
  "custom-14",
  "custom-15",
  "custom-16",
  "custom-17",
  "custom-18",
  "custom-19",
  "custom-2",
  "custom-20",
  "custom-3",
  "custom-4",
  "custom-5",
  "custom-6",
  "custom-7",
  "custom-8",
  "custom-9",
  "halloween",
  "macos",
  "macos-tahoe",
  "touch",
] as const

export type ProjectCursorSetId = (typeof CURSOR_SET_IDS)[number]

export interface ProjectArtboard {
  presetId: ProjectArtboardPresetId
  width: number
  height: number
  background: ProjectArtboardBackground | null
  padding: number
  grain: number
  // Master switch for the custom cursor overlay. Optional + defaulted to true
  // for old project.json files so existing projects keep rendering the cursor.
  cursorCustomRenderingEnabled?: boolean
  // Bundled cursor style. Optional + defaulted to macOS for old project.json
  // files and hand-edited invalid values.
  cursorSetId?: ProjectCursorSetId
  // Recorded-cursor render-size multiplier (1 = reference-frame base size,
  // independent from later screen-video resize/scale).
  // Optional: absent in pre-feature project.json files, defaulted by
  // `parseArtboard` so old projects keep loading without a version bump.
  cursorSizeMultiplier?: number
  // Cursor motion-blur intensity, 0..1 (0 = off). Optional + defaulted by
  // `parseArtboard`, same back-compat rationale as cursorSizeMultiplier.
  cursorMotionBlur?: number
  // Cursor motion-blur renderer backend. Optional + defaulted to 'gpu' for
  // old project.json files.
  cursorMotionBlurBackend?: "gpu" | "cpu"
  // Cursor path smoothing preset. Optional + defaulted to 'default' for old
  // project.json files.
  cursorSmoothingMode?: "rapid" | "quick" | "default" | "slow"
  // Target cursor scale while a captured click is pressed. Optional + defaulted
  // to the current shipped 0.88 for old project.json files.
  cursorClickPressScale?: number
  // Force every captured cursor id to render as the themed pointer. Optional +
  // defaulted to false for old project.json files.
  cursorAlwaysUsePointer?: boolean
}

export type ProjectVideoRole = "screen" | "camera" | "media"

export type ProjectBorderAlignment = "inside" | "center" | "outside"

export type ProjectVideoSource =
  | { kind: "recording"; assetRole: "screen" | "camera" }
  | { kind: "imported"; relativePath: string; fileSize: number }

export interface ProjectVideo {
  id: string
  fileName: string
  source: ProjectVideoSource
  /**
   * Whether the video is currently placed on the canvas / timeline. Optional
   * for back-compat: a missing value (every project written before this field
   * existed) means `true`. `false` marks a video the user removed from the
   * canvas — it stays in the project (and in this array) so the Video tab can
   * offer to add it back, but renders no canvas node and has no timeline clip.
   */
  onCanvas?: boolean
  intrinsicWidth: number
  intrinsicHeight: number
  durationMs: number
  role: ProjectVideoRole
  x: number
  y: number
  width: number
  height: number
  rotation: number
  locked: boolean
  cornerRadius: number
  cornerSmoothing: number
  borderWidth: number
  borderColor: string
  borderOffset: number
  borderAlignment: ProjectBorderAlignment
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
  shadowSpread: number
}

export interface ProjectTimelineClip {
  id: string
  videoId: string
  start: number
  end: number
  sourceIn: number
  sourceOut: number
}

export interface ProjectStateV1 {
  version: 1
  artboard: ProjectArtboard
  videos: ProjectVideo[]
  timelineClips: ProjectTimelineClip[]
  updatedAtUnixMs: number
}

export type ProjectState = ProjectStateV1

export interface ImportAssetPayload {
  id: string
  fileName: string
  bytes: ArrayBuffer
}

export interface ImportAssetResult {
  relativePath: string
  fileUrl: string
  fileSize: number
}

export type SaveProjectStateResult =
  | { ok: true; writtenAtUnixMs: number }
  | { ok: false; reason: string }

// `parseProjectState` accepts arbitrary JSON and returns a fully-typed state
// or `null` when the input cannot be coerced into the current schema. It is
// deliberately conservative: anything off-shape falls back to "no saved
// state" so the renderer synthesises fresh defaults instead of crashing.
export function parseProjectState(input: unknown): ProjectStateV1 | null {
  if (!isRecord(input)) return null
  const version = input["version"]
  if (version !== 1) return null

  const artboard = parseArtboard(input["artboard"])
  if (!artboard) return null

  const videos = parseArray(input["videos"], parseVideo)
  if (!videos) return null

  const timelineClips = parseArray(input["timelineClips"], parseTimelineClip)
  if (!timelineClips) return null

  const updatedAtUnixMs =
    typeof input["updatedAtUnixMs"] === "number" &&
    Number.isFinite(input["updatedAtUnixMs"])
      ? (input["updatedAtUnixMs"] as number)
      : Date.now()

  return {
    version: 1,
    artboard,
    videos,
    timelineClips,
    updatedAtUnixMs,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function parseArray<T>(
  value: unknown,
  parseItem: (item: unknown) => T | null
): T[] | null {
  if (!Array.isArray(value)) return null
  const out: T[] = []
  for (const raw of value) {
    const parsed = parseItem(raw)
    if (!parsed) return null
    out.push(parsed)
  }
  return out
}

const ARTBOARD_PRESET_IDS: ProjectArtboardPresetId[] = [
  "wide",
  "vertical",
  "portrait",
  "standard",
  "square",
  "auto",
]

const CURSOR_SMOOTHING_MODES = ["rapid", "quick", "default", "slow"] as const

function parseArtboard(value: unknown): ProjectArtboard | null {
  if (!isRecord(value)) return null
  const presetId = value["presetId"]
  if (
    typeof presetId !== "string" ||
    !ARTBOARD_PRESET_IDS.includes(presetId as ProjectArtboardPresetId)
  ) {
    return null
  }
  if (
    !isFiniteNumber(value["width"]) ||
    !isFiniteNumber(value["height"]) ||
    !isFiniteNumber(value["padding"]) ||
    !isFiniteNumber(value["grain"])
  ) {
    return null
  }

  const background = parseBackground(value["background"])
  if (background === undefined) return null

  // Cursor size is optional + defaulted (not part of the reject set above) so
  // pre-feature project.json files keep loading. Clamp to the supported range;
  // bounds mirror cursor-scene.ts CURSOR_SIZE_MIN/MAX (kept in sync by hand —
  // the renderer module can't be imported into the main process).
  const cursorSizeMultiplier = (() => {
    const raw = value["cursorSizeMultiplier"]
    // Default (absent/invalid) mirrors cursor-scene.ts CURSOR_SIZE_DEFAULT (2.7)
    // so legacy projects open at the same size as new ones. Clamp to [1, 4]
    // mirrors CURSOR_SIZE_MIN/MAX (hand-synced — renderer module can't import).
    if (!isFiniteNumber(raw)) return 2.7
    return Math.min(4, Math.max(1, raw))
  })()

  // Cursor motion-blur intensity is optional + defaulted (same back-compat
  // rationale). Default (absent/invalid) mirrors cursor-scene.ts
  // CURSOR_MOTION_BLUR_DEFAULT (0.6); clamp to [0, 1] (hand-synced — the
  // renderer module can't be imported into the main process).
  const cursorMotionBlur = (() => {
    const raw = value["cursorMotionBlur"]
    if (!isFiniteNumber(raw)) return 0.6
    return Math.min(1, Math.max(0, raw))
  })()

  // Renderer backend is optional + defaulted. Unknown values fall back to GPU
  // so old and hand-edited projects keep loading.
  const cursorMotionBlurBackend =
    value["cursorMotionBlurBackend"] === "cpu" ? "cpu" : "gpu"
  const cursorCustomRenderingEnabled =
    value["cursorCustomRenderingEnabled"] === false ? false : true
  const cursorSetId = CURSOR_SET_IDS.includes(
    value["cursorSetId"] as ProjectCursorSetId
  )
    ? (value["cursorSetId"] as ProjectCursorSetId)
    : "macos"
  const cursorSmoothingMode = CURSOR_SMOOTHING_MODES.includes(
    value["cursorSmoothingMode"] as (typeof CURSOR_SMOOTHING_MODES)[number]
  )
    ? (value["cursorSmoothingMode"] as (typeof CURSOR_SMOOTHING_MODES)[number])
    : "default"
  const cursorClickPressScale = (() => {
    const raw = value["cursorClickPressScale"]
    // Default mirrors cursor-scene.ts CURSOR_CLICK_PRESS_SCALE_DEFAULT (0.88);
    // clamp to [0.5, 1]. `1` disables the press shrink.
    if (!isFiniteNumber(raw)) return 0.88
    return Math.min(1, Math.max(0.5, raw))
  })()
  const cursorAlwaysUsePointer = value["cursorAlwaysUsePointer"] === true

  return {
    presetId: presetId as ProjectArtboardPresetId,
    width: value["width"] as number,
    height: value["height"] as number,
    background,
    padding: value["padding"] as number,
    grain: value["grain"] as number,
    cursorCustomRenderingEnabled,
    cursorSetId,
    cursorSizeMultiplier,
    cursorMotionBlur,
    cursorMotionBlurBackend,
    cursorSmoothingMode,
    cursorClickPressScale,
    cursorAlwaysUsePointer,
  }
}

function parseBackground(
  value: unknown
): ProjectArtboardBackground | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const type = value["type"]
  const raw = value["value"]
  if (typeof raw !== "string") return undefined
  if (type === "color") {
    return { type: "color", value: raw }
  }
  if (type === "wallpaper") {
    const blurRadius = value["blurRadius"]
    return {
      type: "wallpaper",
      value: raw,
      blurRadius: isFiniteNumber(blurRadius) ? blurRadius : undefined,
    }
  }
  return undefined
}

const VIDEO_ROLES: ProjectVideoRole[] = ["screen", "camera", "media"]
const BORDER_ALIGNMENTS: ProjectBorderAlignment[] = [
  "inside",
  "center",
  "outside",
]

function parseVideo(value: unknown): ProjectVideo | null {
  if (!isRecord(value)) return null
  const id = value["id"]
  const fileName = value["fileName"]
  const role = value["role"]
  const borderColor = value["borderColor"]
  const shadowColor = value["shadowColor"]
  const borderAlignment = value["borderAlignment"]

  if (typeof id !== "string" || !id) return null
  if (typeof fileName !== "string") return null
  if (
    typeof role !== "string" ||
    !VIDEO_ROLES.includes(role as ProjectVideoRole)
  ) {
    return null
  }
  if (typeof borderColor !== "string") return null
  if (typeof shadowColor !== "string") return null
  if (
    typeof borderAlignment !== "string" ||
    !BORDER_ALIGNMENTS.includes(borderAlignment as ProjectBorderAlignment)
  ) {
    return null
  }
  const numericFields = [
    "intrinsicWidth",
    "intrinsicHeight",
    "durationMs",
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "cornerRadius",
    "cornerSmoothing",
    "borderWidth",
    "borderOffset",
    "shadowBlur",
    "shadowOffsetX",
    "shadowOffsetY",
    "shadowSpread",
  ] as const
  for (const field of numericFields) {
    if (!isFiniteNumber(value[field])) return null
  }
  const locked = value["locked"]
  if (typeof locked !== "boolean") return null

  const source = parseVideoSource(value["source"])
  if (!source) return null

  // Optional, tolerant: only a real `false` detaches the video. Anything else
  // (missing field on legacy files, or `true`) leaves it on the canvas.
  const onCanvasRaw = value["onCanvas"]
  const onCanvas = typeof onCanvasRaw === "boolean" ? onCanvasRaw : undefined

  return {
    id,
    fileName,
    source,
    onCanvas,
    intrinsicWidth: value["intrinsicWidth"] as number,
    intrinsicHeight: value["intrinsicHeight"] as number,
    durationMs: value["durationMs"] as number,
    role: role as ProjectVideoRole,
    x: value["x"] as number,
    y: value["y"] as number,
    width: value["width"] as number,
    height: value["height"] as number,
    rotation: value["rotation"] as number,
    locked,
    cornerRadius: value["cornerRadius"] as number,
    cornerSmoothing: value["cornerSmoothing"] as number,
    borderWidth: value["borderWidth"] as number,
    borderColor,
    borderOffset: value["borderOffset"] as number,
    borderAlignment: borderAlignment as ProjectBorderAlignment,
    shadowColor,
    shadowBlur: value["shadowBlur"] as number,
    shadowOffsetX: value["shadowOffsetX"] as number,
    shadowOffsetY: value["shadowOffsetY"] as number,
    shadowSpread: value["shadowSpread"] as number,
  }
}

function parseVideoSource(value: unknown): ProjectVideoSource | null {
  if (!isRecord(value)) return null
  const kind = value["kind"]
  if (kind === "recording") {
    const assetRole = value["assetRole"]
    if (assetRole !== "screen" && assetRole !== "camera") return null
    return { kind: "recording", assetRole }
  }
  if (kind === "imported") {
    const relativePath = value["relativePath"]
    const fileSize = value["fileSize"]
    if (typeof relativePath !== "string" || !relativePath) return null
    if (!isFiniteNumber(fileSize)) return null
    return { kind: "imported", relativePath, fileSize }
  }
  return null
}

function parseTimelineClip(value: unknown): ProjectTimelineClip | null {
  if (!isRecord(value)) return null
  if (typeof value["id"] !== "string" || !value["id"]) return null
  if (typeof value["videoId"] !== "string" || !value["videoId"]) return null
  if (
    !isFiniteNumber(value["start"]) ||
    !isFiniteNumber(value["end"]) ||
    !isFiniteNumber(value["sourceIn"]) ||
    !isFiniteNumber(value["sourceOut"])
  ) {
    return null
  }
  return {
    id: value["id"] as string,
    videoId: value["videoId"] as string,
    start: value["start"] as number,
    end: value["end"] as number,
    sourceIn: value["sourceIn"] as number,
    sourceOut: value["sourceOut"] as number,
  }
}
