import { BrowserWindow, app, dialog, ipcMain } from "electron"
import {
  promises as fs,
  readFileSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import type {
  RecordingFiles,
  RecordingManifest,
  RecordingOutputMetadata,
} from "@openscreen/mac-addon"

import {
  CURRENT_PROJECT_STATE_VERSION,
  parseProjectState,
  type ImportAssetPayload,
  type ImportAssetResult,
  type ProjectStateV1,
  type SaveProjectStateResult,
} from "./project-schema"

const PROJECT_STATE_FILE_NAME = "project.json"
const IMPORTED_ASSETS_DIR = path.join("assets", "videos")

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
const ACTIVE_PROJECT_FILE = "active-project.json"

// `undefined` means we haven't tried to read the on-disk value yet; `null`
// means we read it and there is no active project. Avoids paying the disk
// read on every `getLatest` call.
let activeProjectPath: string | null | undefined = undefined

function activeProjectFilePath(): string {
  return path.join(app.getPath("userData"), ACTIVE_PROJECT_FILE)
}

function readPersistedActiveProjectPath(): string | null {
  try {
    const raw = readFileSync(activeProjectFilePath(), "utf-8")
    const parsed = JSON.parse(raw) as { path?: unknown }
    if (parsed && typeof parsed.path === "string" && parsed.path.length > 0) {
      return parsed.path
    }
  } catch {
    // Missing or unreadable — first launch or fresh userData.
  }
  return null
}

function persistActiveProjectPath(value: string | null): void {
  try {
    writeFileSync(
      activeProjectFilePath(),
      JSON.stringify({ path: value }, null, 2)
    )
  } catch (error) {
    // Best-effort. A failed write means the next refresh might fall back to
    // "latest by mtime", but never loses unsaved editor state.
    if (process.env.NODE_ENV === "development") {
      console.warn("[projects] failed to persist active project path", error)
    }
  }
}

function getActiveProjectPath(): string | null {
  if (activeProjectPath === undefined) {
    activeProjectPath = readPersistedActiveProjectPath()
  }
  return activeProjectPath
}

function clearActiveProjectPath(): void {
  activeProjectPath = null
  persistActiveProjectPath(null)
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
  activeProjectPath = folder
  persistActiveProjectPath(folder)
  return summary
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

// Crash-safe write: render the JSON next to its target, then `rename` it on
// top. POSIX `rename` is atomic on the same filesystem, so even an unplugged
// laptop will see either the previous good `project.json` or the new one —
// never a half-flushed file. Any failure path unlinks the tmp so we don't
// accumulate orphan `.tmp` files on a disk that's full or read-only.
async function writeJsonAtomic(
  target: string,
  payload: unknown
): Promise<void> {
  const dir = path.dirname(target)
  await fs.mkdir(dir, { recursive: true })
  const tmpName = `.${path.basename(target)}.${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.tmp`
  const tmp = path.join(dir, tmpName)
  const serialized = JSON.stringify(payload, null, 2) + os.EOL
  try {
    await fs.writeFile(tmp, serialized, "utf8")
    await fs.rename(tmp, target)
  } catch (error) {
    try {
      await fs.unlink(tmp)
    } catch {
      // best-effort cleanup — tmp may not exist if writeFile threw before
      // the file descriptor was created.
    }
    throw error
  }
}

// A name composed solely of dots ('.', '..', '...') still passes the
// allowlist regex (`.` is allowed), so we reject those explicitly to keep
// callers from writing to a parent dir or a hidden-cwd ancestor even though
// `isPathInside` would also reject the resulting path.
function isAllDots(value: string): boolean {
  return value.length > 0 && /^\.+$/.test(value)
}

function sanitizeFileName(input: string): string {
  // Strip path separators and reserved characters so a hostile filename can't
  // escape `<folder>/assets/videos/<id>/`. We keep a generous allowlist of
  // ASCII filename chars and collapse the rest to underscores.
  const trimmed = input.trim().replace(/[\\/]/g, "_")
  const cleaned = trimmed.replace(/[^A-Za-z0-9._\- ]+/g, "_").slice(0, 200)
  if (!cleaned || isAllDots(cleaned)) return "video.mp4"
  return cleaned
}

function sanitizeAssetId(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100)
  if (!cleaned || isAllDots(cleaned)) return "asset"
  return cleaned
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  )
}

async function importVideoAsset(
  folder: string,
  payload: ImportAssetPayload
): Promise<ImportAssetResult> {
  if (!folder) throw new Error("Project folder is required to import an asset.")
  const id = sanitizeAssetId(payload.id)
  const fileName = sanitizeFileName(payload.fileName)
  const relativeDir = path.join(IMPORTED_ASSETS_DIR, id)
  const targetDir = path.join(folder, relativeDir)
  const targetFile = path.join(targetDir, fileName)
  if (!isPathInside(folder, targetFile)) {
    throw new Error("Refusing to write asset outside the project folder.")
  }
  await fs.mkdir(targetDir, { recursive: true })
  const buffer = Buffer.from(payload.bytes)
  await fs.writeFile(targetFile, buffer)
  const relativePath = path.join(relativeDir, fileName)
  return {
    relativePath,
    fileUrl: pathToFileURL(targetFile).toString(),
    fileSize: buffer.byteLength,
  }
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

// Cursor metadata for one recording, resolved from its `recording.json` +
// input sidecars. Coordinates are display-relative logical points; sample by
// the screen video's source time (currentTime × 1000 ≈ processTimeMs − start).
export interface CursorTrackData {
  moves: CursorMoveSample[]
  clicks: CursorClickSample[]
  processTimeStartMs: number
  displayWidth: number
  displayHeight: number
}

async function loadCursorTrackData(
  folder: string
): Promise<CursorTrackData | null> {
  const manifestPath = await findManifestPath(folder)
  if (!manifestPath) return null
  const manifest = await readManifest(manifestPath)
  if (!manifest) return null

  const input = (manifest.outputs ?? []).find(
    (output) => output.source === "input"
  )
  if (!input) return null

  const movesPath = resolveAssetPath(
    folder,
    manifest.files?.mouseMoves ?? input.mouseMovesFilename
  )
  if (!movesPath) return null
  const moves = await readJsonArray<CursorMoveSample>(movesPath)
  if (!moves || moves.length === 0) return null
  const clicksPath = resolveAssetPath(
    folder,
    manifest.files?.mouseClicks ?? input.mouseClicksFilename
  )
  const clicks = clicksPath
    ? ((await readJsonArray<CursorClickSample>(clicksPath)) ?? [])
    : []

  return {
    moves,
    clicks,
    processTimeStartMs: resolveCursorProcessTimeStart(manifest, input, moves),
    displayWidth: input.displayBoundsPoints?.width ?? 0,
    displayHeight: input.displayBoundsPoints?.height ?? 0,
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
      // folder has been deleted out from under us, clear the slot and fall
      // through to the legacy "newest by mtime" path.
      const active = getActiveProjectPath()
      if (active) {
        const loaded = await loadProjectFromFolder(active)
        if (loaded) return loaded
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
      try {
        await fs.access(folderPath)
      } catch {
        return { ok: false, reason: "folder-missing" }
      }
      const stamped: ProjectStateV1 = {
        ...validated,
        updatedAtUnixMs: Date.now(),
      }
      const target = path.join(folderPath, PROJECT_STATE_FILE_NAME)
      try {
        await writeJsonAtomic(target, stamped)
        return { ok: true, writtenAtUnixMs: stamped.updatedAtUnixMs }
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : "write-failed"
        return { ok: false, reason }
      }
    }
  )

  ipcMain.handle(
    "projects:importAsset",
    async (
      _event,
      folderPath: string,
      payload: ImportAssetPayload
    ): Promise<ImportAssetResult> => {
      if (typeof folderPath !== "string" || !folderPath) {
        throw new Error("Project folder is required to import an asset.")
      }
      if (
        !payload ||
        typeof payload.id !== "string" ||
        typeof payload.fileName !== "string" ||
        !(payload.bytes instanceof ArrayBuffer)
      ) {
        throw new Error("Invalid import-asset payload.")
      }
      return importVideoAsset(folderPath, payload)
    }
  )
}
