import { BrowserWindow, app, dialog, ipcMain } from "electron"
import {
  promises as fs,
  readFileSync,
  statSync,
  type Dirent,
} from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import type {
  RecordingFiles,
  RecordingManifest,
  RecordingOutputMetadata,
} from "@openscreen/mac-addon"

import { writeJsonAtomic } from "./fs-utils"
import {
  CURRENT_PROJECT_STATE_VERSION,
  parseProjectState,
  type ProjectStateV1,
  type SaveProjectStateResult,
} from "./project-schema"

const PROJECT_STATE_FILE_NAME = "project.json"

// IMPORTANT: the exported types below are mirrored in `types/api.d.ts`. Edits
// here MUST be reflected there.
export type ProjectAssetRole = "screen" | "camera"

export type ProjectRecordingType =
  | "display"
  | "window"
  | "region"
  | "application"

export interface ProjectAssetAudioTrack {
  source: "systemAudio" | "microphone"
  sampleRate?: number
  channelCount?: number
}

export interface ProjectAsset {
  role: ProjectAssetRole
  fileName: string
  filePath: string
  fileUrl: string
  fileSize: number
  durationMs?: number
  width?: number
  height?: number
  codec?: string
  audioTracks: ProjectAssetAudioTrack[]
}

export interface ProjectSummary {
  id: string
  name: string
  path: string
  createdAtUnixMs: number
  recordingType: ProjectRecordingType | null
  assets: ProjectAsset[]
  state: ProjectStateV1 | null
  /**
   * For every video id in `state?.videos`, the resolved absolute `file://`
   * URL the renderer should feed to a `<video>` element. Computed in main so
   * the renderer never builds file URLs from a relative path. Missing entry
   * = the underlying file was not present when the project was loaded.
   */
  assetUrlsByVideoId: Record<string, string>
}

interface RegisterProjectsHandlersOptions {
  getMainWindow: () => BrowserWindow | null
  getLatestRecordingDir: () => string | null
}

export function projectsRoot(): string {
  return path.join(app.getPath("documents"), "openscreen")
}

// Sticky "active project" — the folder the user last explicitly opened
// (settings menu "Open project") or last successfully recorded into.
// Persists in-memory across renderer reloads AND on disk across app
// restarts, so refreshing the editor window always returns the user to the
// project they were working on, not "the newest folder by mtime". Cleared
// implicitly (replaced) by another open / record action.
//
// Alongside the absolute `path` we persist the recording's `sessionId` so a
// project folder that was moved or renamed can be re-found by identity (a
// scan over the projects root) instead of silently falling back to "newest
// by mtime" — which may be a different project entirely.
const ACTIVE_PROJECT_FILE = "active-project.json"

interface ActiveProjectRecord {
  path: string
  sessionId: string | null
}

// `undefined` means we haven't tried to read the on-disk value yet; `null`
// means we read it and there is no active project. Avoids paying the disk
// read on every `getLatest` call.
let activeProject: ActiveProjectRecord | null | undefined = undefined

function activeProjectFilePath(): string {
  return path.join(app.getPath("userData"), ACTIVE_PROJECT_FILE)
}

function readPersistedActiveProject(): ActiveProjectRecord | null {
  try {
    const raw = readFileSync(activeProjectFilePath(), "utf-8")
    const parsed = JSON.parse(raw) as {
      path?: unknown
      sessionId?: unknown
    } | null
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.path === "string" &&
      parsed.path.length > 0
    ) {
      return {
        path: parsed.path,
        // Legacy `{ path }` files (pre-sessionId) read as identity-less.
        sessionId:
          typeof parsed.sessionId === "string" && parsed.sessionId.length > 0
            ? parsed.sessionId
            : null,
      }
    }
  } catch {
    // Missing or unreadable — first launch or fresh userData.
  }
  return null
}

async function persistActiveProject(
  value: ActiveProjectRecord | null
): Promise<void> {
  try {
    await writeJsonAtomic(activeProjectFilePath(), {
      path: value?.path ?? null,
      sessionId: value?.sessionId ?? null,
    })
  } catch (error) {
    // Best-effort. A failed write means the next refresh might fall back to
    // "latest by mtime", but never loses unsaved editor state. Warn
    // unconditionally — a silently stale active project is confusing to
    // debug in production.
    console.warn("[projects] failed to persist active project", error)
  }
}

function getActiveProject(): ActiveProjectRecord | null {
  if (activeProject === undefined) {
    activeProject = readPersistedActiveProject()
  }
  return activeProject
}

function clearActiveProjectPath(): void {
  activeProject = null
  void persistActiveProject(null)
}

async function readManifestForFolder(
  folder: string
): Promise<RecordingManifest | null> {
  const manifestPath = await findManifestPath(folder)
  if (!manifestPath) return null
  return readManifest(manifestPath)
}

// The single "the user is opening this project" entry point. Anything that
// surfaces a project in the editor — menu, titlebar picker, programmatic
// open IPC, or a successful recording stop — should funnel through here so
// the choice is persisted (in-memory + on disk) and survives a window
// refresh. Returns the loaded `ProjectSummary` on success, `null` on
// invalid / missing project so callers can short-circuit.
export async function setActiveProjectFromFolder(
  folder: string
): Promise<ProjectSummary | null> {
  if (!folder) return null
  const summary = await loadProjectFromFolder(folder)
  if (!summary) return null
  const manifest = await readManifestForFolder(folder)
  activeProject = {
    path: folder,
    sessionId:
      typeof manifest?.sessionId === "string" && manifest.sessionId.length > 0
        ? manifest.sessionId
        : null,
  }
  await persistActiveProject(activeProject)
  return summary
}

// Identity recovery: the stored active path went stale (folder moved,
// renamed, or on a re-mounted volume) but we know which recording session it
// held. Scan the projects root for the folder whose manifest carries that
// sessionId. Only runs on the stale-path miss, never on the hot path.
async function findProjectFolderBySessionId(
  sessionId: string
): Promise<string | null> {
  const root = projectsRoot()
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const folder = path.join(root, entry.name)
    const manifest = await readManifestForFolder(folder)
    if (manifest?.sessionId === sessionId) return folder
  }
  return null
}

// Per-folder write serialization for `project.json`. A single renderer
// already serializes its own autosaves, but two editor windows on the same
// project would otherwise interleave between the `fs.access` check and the
// atomic write — last-writer-wins is unavoidable for whole-file state, but
// the writes themselves must not race. The chain tail swallows rejections so
// one failed save never poisons subsequent saves; callers still receive the
// rejection through the returned promise.
const saveChainByFolder = new Map<string, Promise<void>>()

function withFolderSaveLock<T>(
  folder: string,
  task: () => Promise<T>
): Promise<T> {
  const prev = saveChainByFolder.get(folder) ?? Promise.resolve()
  const run = prev.then(task)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  saveChainByFolder.set(folder, tail)
  void tail.then(() => {
    if (saveChainByFolder.get(folder) === tail) {
      saveChainByFolder.delete(folder)
    }
  })
  return run
}

async function readProjectState(
  folder: string
): Promise<ProjectStateV1 | null> {
  const target = path.join(folder, PROJECT_STATE_FILE_NAME)
  try {
    const raw = await fs.readFile(target, "utf8")
    const parsed: unknown = JSON.parse(raw)
    return parseProjectState(parsed)
  } catch {
    return null
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  )
}

async function findManifestPath(folder: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true })
    const manifestEntry = entries.find(
      (entry) => entry.isFile() && entry.name.endsWith("recording.json")
    )
    return manifestEntry ? path.join(folder, manifestEntry.name) : null
  } catch {
    return null
  }
}

async function readManifest(
  manifestPath: string
): Promise<RecordingManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath, "utf8")
    return JSON.parse(raw) as RecordingManifest
  } catch {
    return null
  }
}

async function readJsonArray<T>(filePath: string): Promise<T[] | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8")
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : null
  } catch {
    return null
  }
}

function resolveCursorProcessTimeStart(
  manifest: RecordingManifest,
  input: RecordingOutputMetadata,
  moves: CursorMoveSample[]
): number {
  const candidate =
    input.session?.processTimeStartMs ?? manifest.hostStartMs ?? 0
  if (!Number.isFinite(candidate)) return 0

  const firstMoveMs = moves.reduce((min, move) => {
    return Number.isFinite(move.processTimeMs)
      ? Math.min(min, move.processTimeMs)
      : min
  }, Infinity)

  // Current sidecars use absolute process timestamps and subtract the input
  // session start. Older sidecars were already recording-relative; subtracting a
  // large host start from those would make every move/click negative and erase
  // the cursor press animation.
  if (Number.isFinite(firstMoveMs) && candidate > firstMoveMs + 1000) return 0
  return candidate
}

// One captured pointer-move sample from `mousemoves-0.json` (Screen
// Studio-shaped). Only the fields the cursor overlay needs are typed.
export interface CursorMoveSample {
  processTimeMs: number
  x: number
  y: number
  cursorId?: string
  type?: string
}

export interface CursorClickSample {
  processTimeMs: number
  x: number
  y: number
  cursorId?: string
  type?: string
  button?: number | string
}

// One TYPING keystroke from `keystrokes-0.json`, reduced to its timestamp.
// Main classifies keyDowns (drops shortcuts / Escape / F-keys) and forwards
// only the time — the typed characters never leave the main process, because
// the editor only needs *when* typing happened (cursor hide + auto-zoom).
export interface TypingKeySample {
  processTimeMs: number
}

// One text-caret rect from `typingcaret-0.json` (Accessibility read after a
// keyDown). Display-relative logical points, top-left origin — same space as
// the mouse samples. `source` "element" = the focused field's frame (the app
// couldn't report an exact caret).
export interface TypingCaretSample {
  processTimeMs: number
  x: number
  y: number
  width: number
  height: number
  source: "caret" | "element"
}

// Cursor metadata for one recording, resolved from its `recording.json` +
// input sidecars. Coordinates are display-relative logical points; sample by
// the screen video's source time (currentTime × 1000 ≈ processTimeMs − start).
export interface CursorTrackData {
  moves: CursorMoveSample[]
  clicks: CursorClickSample[]
  processTimeStartMs: number
  displayWidth: number
  displayHeight: number
  // Present only when the recording captured keystrokes (`typing`) and, with
  // Accessibility, caret rects (`caret`). Both sorted by processTimeMs.
  typing?: TypingKeySample[]
  caret?: TypingCaretSample[]
}

interface RawKeyStrokeSample {
  processTimeMs?: unknown
  type?: unknown
  character?: unknown
  activeModifiers?: unknown
}

interface RawCaretSample {
  processTimeMs?: unknown
  x?: unknown
  y?: unknown
  width?: unknown
  height?: unknown
  source?: unknown
}

// Whether a recorded keyDown is TYPING (edits or moves the text caret) rather
// than a shortcut / non-text key. Command/Control chords are shortcuts; Escape
// and the F-key private-use range (NSF1FunctionKey…NSF35FunctionKey) never
// touch text. Arrows / Home / End / Delete stay: they move the caret.
export function isTypingKeyStroke(sample: RawKeyStrokeSample): boolean {
  if (sample.type !== "keyDown") return false
  const mods = Array.isArray(sample.activeModifiers)
    ? sample.activeModifiers
    : []
  if (mods.includes("command") || mods.includes("control")) return false
  const character =
    typeof sample.character === "string" ? sample.character : ""
  if (character.length === 0) return false
  const code = character.charCodeAt(0)
  if (code === 0x1b) return false
  if (code >= 0xf704 && code <= 0xf726) return false
  return true
}

async function loadTypingSamples(
  folder: string,
  candidate: string | undefined
): Promise<TypingKeySample[] | undefined> {
  const filePath = resolveAssetPath(folder, candidate)
  if (!filePath) return undefined
  const raw = await readJsonArray<RawKeyStrokeSample>(filePath)
  if (!raw) return undefined
  const typing: TypingKeySample[] = []
  for (const sample of raw) {
    if (!isTypingKeyStroke(sample)) continue
    const t = sample.processTimeMs
    if (typeof t !== "number" || !Number.isFinite(t)) continue
    typing.push({ processTimeMs: t })
  }
  return typing.sort((a, b) => a.processTimeMs - b.processTimeMs)
}

async function loadCaretSamples(
  folder: string,
  candidate: string | undefined
): Promise<TypingCaretSample[] | undefined> {
  const filePath = resolveAssetPath(folder, candidate)
  if (!filePath) return undefined
  const raw = await readJsonArray<RawCaretSample>(filePath)
  if (!raw) return undefined
  const isNum = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v)
  const caret: TypingCaretSample[] = []
  for (const sample of raw) {
    const { processTimeMs, x, y, width, height } = sample
    if (!isNum(processTimeMs) || !isNum(x) || !isNum(y)) continue
    if (!isNum(width) || !isNum(height) || width < 0 || height <= 0) continue
    caret.push({
      processTimeMs,
      x,
      y,
      width,
      height,
      source: sample.source === "element" ? "element" : "caret",
    })
  }
  return caret.sort((a, b) => a.processTimeMs - b.processTimeMs)
}

// Every null return path warns with a reason: cursor data silently failing
// to load is otherwise indistinguishable from "this recording has no input
// capture", and the symptom (no cursor in preview AND export) is far from
// the cause.
function warnCursorUnavailable(folder: string, reason: string): null {
  console.warn("[projects] cursor data unavailable:", folder, "—", reason)
  return null
}

async function loadCursorTrackData(
  folder: string
): Promise<CursorTrackData | null> {
  const manifestPath = await findManifestPath(folder)
  if (!manifestPath) return warnCursorUnavailable(folder, "no recording.json")
  const manifest = await readManifest(manifestPath)
  if (!manifest) {
    return warnCursorUnavailable(folder, "unreadable recording.json")
  }

  const input = (manifest.outputs ?? []).find(
    (output) => output.source === "input"
  )
  // No input entry is normal for recordings made before input capture
  // existed — not worth a warning.
  if (!input) return null

  const movesPath = resolveAssetPath(
    folder,
    manifest.files?.mouseMoves ?? input.mouseMovesFilename
  )
  if (!movesPath) {
    return warnCursorUnavailable(folder, "manifest names no mousemoves file")
  }
  const moves = await readJsonArray<CursorMoveSample>(movesPath)
  if (!moves) {
    return warnCursorUnavailable(folder, "mousemoves sidecar unreadable/corrupt")
  }
  if (moves.length === 0) {
    return warnCursorUnavailable(folder, "mousemoves sidecar is empty")
  }
  const clicksPath = resolveAssetPath(
    folder,
    manifest.files?.mouseClicks ?? input.mouseClicksFilename
  )
  const clicks = clicksPath
    ? ((await readJsonArray<CursorClickSample>(clicksPath)) ?? [])
    : []

  // A zero/garbage display size would silently break all cursor placement
  // math downstream (positions are normalized against display bounds).
  const displayWidth = input.displayBoundsPoints?.width ?? 0
  const displayHeight = input.displayBoundsPoints?.height ?? 0
  if (
    !Number.isFinite(displayWidth) ||
    !Number.isFinite(displayHeight) ||
    displayWidth <= 0 ||
    displayHeight <= 0
  ) {
    return warnCursorUnavailable(folder, "invalid displayBoundsPoints")
  }

  const rawClockStart =
    input.session?.processTimeStartMs ?? manifest.hostStartMs
  if (rawClockStart !== undefined && !Number.isFinite(rawClockStart)) {
    // Non-finite clock anchors are coerced to 0 below — visible here so a
    // corrupt manifest clock doesn't masquerade as an old-format sidecar.
    console.warn(
      "[projects] cursor manifest clock anchor is non-finite:",
      folder
    )
  }

  // Typing sidecars are optional extras: a missing/corrupt file just means
  // no typing behavior for this recording, never a cursor-load failure.
  const typing = await loadTypingSamples(
    folder,
    manifest.files?.keyStrokes ?? input.keyStrokesFilename
  )
  const caret = await loadCaretSamples(
    folder,
    manifest.files?.typingCaret ?? input.typingCaretFilename
  )

  return {
    moves,
    clicks,
    processTimeStartMs: resolveCursorProcessTimeStart(manifest, input, moves),
    displayWidth,
    displayHeight,
    ...(typing ? { typing } : {}),
    ...(caret ? { caret } : {}),
  }
}

function resolveAssetPath(
  folder: string,
  candidate: string | undefined
): string | null {
  if (!candidate) return null
  return path.isAbsolute(candidate) ? candidate : path.join(folder, candidate)
}

async function statSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath)
    return stat.size
  } catch {
    return 0
  }
}

function pickOutput(
  outputs: RecordingOutputMetadata[],
  source: RecordingOutputMetadata["source"]
): RecordingOutputMetadata | undefined {
  return outputs.find((output) => output.source === source)
}

function getPositiveDurationMs(
  durationMs: number | undefined
): number | undefined {
  return typeof durationMs === "number" &&
    Number.isFinite(durationMs) &&
    durationMs > 0
    ? durationMs
    : undefined
}

function getProjectDurationMs(
  outputs: RecordingOutputMetadata[]
): number | undefined {
  const durationMs = outputs.reduce((longest, output) => {
    const outputDurationMs = getPositiveDurationMs(output.durationMs)
    return outputDurationMs ? Math.max(longest, outputDurationMs) : longest
  }, 0)

  return durationMs > 0 ? durationMs : undefined
}

async function buildAsset(
  role: ProjectAssetRole,
  filePath: string,
  primary: RecordingOutputMetadata | undefined,
  audioTracks: ProjectAssetAudioTrack[],
  fallbackDurationMs?: number
): Promise<ProjectAsset> {
  const fileSize = await statSize(filePath)
  return {
    role,
    fileName: path.basename(filePath),
    filePath,
    fileUrl: pathToFileURL(filePath).toString(),
    fileSize,
    durationMs:
      getPositiveDurationMs(primary?.durationMs) ?? fallbackDurationMs,
    width: primary?.width,
    height: primary?.height,
    codec: primary?.codec,
    audioTracks,
  }
}

async function loadProjectFromFolder(
  folder: string
): Promise<ProjectSummary | null> {
  const manifestPath = await findManifestPath(folder)
  if (!manifestPath) return null

  const manifest = await readManifest(manifestPath)
  if (!manifest) return null

  const files: RecordingFiles | undefined = manifest.files
  const outputs = manifest.outputs ?? []
  const projectDurationMs = getProjectDurationMs(outputs)

  const audioTracks: ProjectAssetAudioTrack[] = outputs
    .filter((output) => output.muxedInto === "screen")
    .map((output) => ({
      source: output.source as ProjectAssetAudioTrack["source"],
      sampleRate: output.sampleRate,
      channelCount: output.channelCount,
    }))

  const assets: ProjectAsset[] = []

  const screenPath = resolveAssetPath(folder, files?.screen)
  if (screenPath) {
    assets.push(
      await buildAsset(
        "screen",
        screenPath,
        pickOutput(outputs, "screen"),
        audioTracks,
        projectDurationMs
      )
    )
  }

  const cameraPath = resolveAssetPath(folder, files?.camera)
  if (cameraPath) {
    assets.push(
      await buildAsset(
        "camera",
        cameraPath,
        pickOutput(outputs, "camera"),
        [],
        projectDurationMs
      )
    )
  }

  const recordingType: ProjectRecordingType | null = (() => {
    const raw = manifest.target?.type
    if (
      raw === "display" ||
      raw === "window" ||
      raw === "region" ||
      raw === "application"
    ) {
      return raw
    }
    return null
  })()

  const state = await readProjectState(folder)
  const assetUrlsByVideoId = await resolveAssetUrlsForState(
    folder,
    state,
    assets
  )

  return {
    id: path.basename(folder),
    name: path.basename(folder),
    path: folder,
    createdAtUnixMs: manifest.startedAtUnixMs ?? Date.now(),
    recordingType,
    assets,
    state,
    assetUrlsByVideoId,
  }
}

async function resolveAssetUrlsForState(
  folder: string,
  state: ProjectStateV1 | null,
  assets: ProjectAsset[]
): Promise<Record<string, string>> {
  if (!state) return {}
  const assetByRole = new Map<ProjectAssetRole, ProjectAsset>()
  for (const asset of assets) assetByRole.set(asset.role, asset)

  const result: Record<string, string> = {}
  for (const video of state.videos) {
    const source = video.source
    if (source.kind === "recording") {
      const asset = assetByRole.get(source.assetRole)
      if (asset) result[video.id] = asset.fileUrl
      continue
    }
    if (source.kind === "imported") {
      const absolute = path.join(folder, source.relativePath)
      if (!isPathInside(folder, absolute)) continue
      try {
        await fs.access(absolute)
        result[video.id] = pathToFileURL(absolute).toString()
      } catch {
        // file missing — renderer treats absence as "unresolved"
      }
    }
  }
  return result
}

async function findLatestProjectFolder(): Promise<string | null> {
  const root = projectsRoot()
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return null
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(root, entry.name)
      let mtimeMs = 0
      try {
        mtimeMs = statSync(fullPath).mtimeMs
      } catch {
        mtimeMs = 0
      }
      return { path: fullPath, mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const candidate of candidates) {
    const manifest = await findManifestPath(candidate.path)
    if (manifest) return candidate.path
  }
  return null
}

export function registerProjectsHandlers(
  options: RegisterProjectsHandlersOptions
): void {
  ipcMain.handle(
    "projects:getLatest",
    async (): Promise<ProjectSummary | null> => {
      // Sticky active path wins over "latest recording" so a window refresh
      // always returns to the project the user explicitly opened. If the
      // path went stale but we know the recording's sessionId, try to
      // re-find the moved/renamed folder by identity before giving up —
      // this is recovery of the *same* project the user had open, not a
      // fallback promotion, so it doesn't violate the "getLatest never
      // promotes" invariant. Only when identity recovery also fails do we
      // clear the slot and fall through to the legacy "newest by mtime"
      // path.
      const active = getActiveProject()
      if (active) {
        const loaded = await loadProjectFromFolder(active.path)
        if (loaded) return loaded
        if (active.sessionId) {
          const recovered = await findProjectFolderBySessionId(
            active.sessionId
          )
          if (recovered) {
            const reopened = await setActiveProjectFromFolder(recovered)
            if (reopened) return reopened
          }
        }
        clearActiveProjectPath()
      }
      const hinted = options.getLatestRecordingDir()
      if (hinted) {
        const loaded = await loadProjectFromFolder(hinted)
        if (loaded) return loaded
      }
      const folder = await findLatestProjectFolder()
      if (!folder) return null
      return loadProjectFromFolder(folder)
    }
  )

  ipcMain.handle(
    "projects:open",
    async (_event, folderPath: string): Promise<ProjectSummary | null> => {
      if (typeof folderPath !== "string" || !folderPath) return null
      // Promote the opened folder to the sticky active project so a window
      // refresh (or app restart) returns here instead of falling back to
      // the previous active project / newest-by-mtime.
      return setActiveProjectFromFolder(folderPath)
    }
  )

  ipcMain.handle(
    "projects:pickAndOpen",
    async (event): Promise<ProjectSummary | null> => {
      const parent =
        BrowserWindow.fromWebContents(event.sender) ?? options.getMainWindow()
      const defaultPath = projectsRoot()
      const result = parent
        ? await dialog.showOpenDialog(parent, {
            title: "Open project",
            defaultPath,
            properties: ["openDirectory"],
          })
        : await dialog.showOpenDialog({
            title: "Open project",
            defaultPath,
            properties: ["openDirectory"],
          })

      if (result.canceled || result.filePaths.length === 0) return null
      // Same sticky promotion as `projects:open` — the titlebar folder
      // button uses this IPC, so without it a refresh after the user picks a
      // new project snaps back to whatever was active before.
      return setActiveProjectFromFolder(result.filePaths[0])
    }
  )

  // Read-only: load a recording's captured cursor track (mouse moves + display
  // bounds) from its input sidecars. Never promotes the active project.
  ipcMain.handle(
    "projects:getCursorData",
    async (_event, folderPath: string): Promise<CursorTrackData | null> => {
      if (typeof folderPath !== "string" || !folderPath) return null
      return loadCursorTrackData(folderPath)
    }
  )

  ipcMain.handle(
    "projects:saveState",
    async (
      _event,
      folderPath: string,
      state: ProjectStateV1
    ): Promise<SaveProjectStateResult> => {
      if (typeof folderPath !== "string" || !folderPath) {
        return { ok: false, reason: "missing-folder" }
      }
      if (!state || state.version !== CURRENT_PROJECT_STATE_VERSION) {
        return { ok: false, reason: "unsupported-version" }
      }
      const validated = parseProjectState(state)
      if (!validated) {
        return { ok: false, reason: "invalid-state" }
      }
      // Validation is pure and runs outside the lock; the filesystem
      // sequence (existence check → timestamp → atomic write) is serialized
      // per folder. The timestamp is stamped inside the lock so write order
      // on disk matches `updatedAtUnixMs` order.
      return withFolderSaveLock(folderPath, async () => {
        try {
          await fs.access(folderPath)
        } catch {
          return { ok: false, reason: "folder-missing" } as const
        }
        const stamped: ProjectStateV1 = {
          ...validated,
          updatedAtUnixMs: Date.now(),
        }
        const target = path.join(folderPath, PROJECT_STATE_FILE_NAME)
        try {
          await writeJsonAtomic(target, stamped)
          return {
            ok: true,
            writtenAtUnixMs: stamped.updatedAtUnixMs,
          } as const
        } catch (cause) {
          const reason =
            cause instanceof Error ? cause.message : "write-failed"
          return { ok: false, reason } as const
        }
      })
    }
  )

}
