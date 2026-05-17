import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { promises as fs, statSync, type Dirent } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  RecordingFiles,
  RecordingManifest,
  RecordingOutputMetadata,
} from '@openscreen/mac-addon'

// IMPORTANT: the exported types below are mirrored in `types/api.d.ts`. Edits
// here MUST be reflected there.
export type ProjectAssetRole = 'screen' | 'camera'

export interface ProjectAssetAudioTrack {
  source: 'systemAudio' | 'microphone'
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
  assets: ProjectAsset[]
}

interface RegisterProjectsHandlersOptions {
  getMainWindow: () => BrowserWindow | null
  getLatestRecordingDir: () => string | null
}

function projectsRoot(): string {
  return path.join(app.getPath('documents'), 'openscreen')
}

async function findManifestPath(folder: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true })
    const manifestEntry = entries.find(
      (entry) => entry.isFile() && entry.name.endsWith('recording.json'),
    )
    return manifestEntry ? path.join(folder, manifestEntry.name) : null
  } catch {
    return null
  }
}

async function readManifest(manifestPath: string): Promise<RecordingManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath, 'utf8')
    return JSON.parse(raw) as RecordingManifest
  } catch {
    return null
  }
}

function resolveAssetPath(folder: string, candidate: string | undefined): string | null {
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
  source: RecordingOutputMetadata['source'],
): RecordingOutputMetadata | undefined {
  return outputs.find((output) => output.source === source)
}

async function buildAsset(
  role: ProjectAssetRole,
  filePath: string,
  primary: RecordingOutputMetadata | undefined,
  audioTracks: ProjectAssetAudioTrack[],
): Promise<ProjectAsset> {
  const fileSize = await statSize(filePath)
  return {
    role,
    fileName: path.basename(filePath),
    filePath,
    fileUrl: pathToFileURL(filePath).toString(),
    fileSize,
    durationMs: primary?.durationMs,
    width: primary?.width,
    height: primary?.height,
    codec: primary?.codec,
    audioTracks,
  }
}

async function loadProjectFromFolder(folder: string): Promise<ProjectSummary | null> {
  const manifestPath = await findManifestPath(folder)
  if (!manifestPath) return null

  const manifest = await readManifest(manifestPath)
  if (!manifest) return null

  const files: RecordingFiles | undefined = manifest.files
  const outputs = manifest.outputs ?? []

  const audioTracks: ProjectAssetAudioTrack[] = outputs
    .filter((output) => output.muxedInto === 'screen')
    .map((output) => ({
      source: output.source as ProjectAssetAudioTrack['source'],
      sampleRate: output.sampleRate,
      channelCount: output.channelCount,
    }))

  const assets: ProjectAsset[] = []

  const screenPath = resolveAssetPath(folder, files?.screen)
  if (screenPath) {
    assets.push(
      await buildAsset('screen', screenPath, pickOutput(outputs, 'screen'), audioTracks),
    )
  }

  const cameraPath = resolveAssetPath(folder, files?.camera)
  if (cameraPath) {
    assets.push(await buildAsset('camera', cameraPath, pickOutput(outputs, 'camera'), []))
  }

  return {
    id: path.basename(folder),
    name: path.basename(folder),
    path: folder,
    createdAtUnixMs: manifest.startedAtUnixMs ?? Date.now(),
    assets,
  }
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

export function registerProjectsHandlers(options: RegisterProjectsHandlersOptions): void {
  ipcMain.handle('projects:getLatest', async (): Promise<ProjectSummary | null> => {
    const hinted = options.getLatestRecordingDir()
    if (hinted) {
      const loaded = await loadProjectFromFolder(hinted)
      if (loaded) return loaded
    }
    const folder = await findLatestProjectFolder()
    if (!folder) return null
    return loadProjectFromFolder(folder)
  })

  ipcMain.handle(
    'projects:open',
    async (_event, folderPath: string): Promise<ProjectSummary | null> => {
      if (typeof folderPath !== 'string' || !folderPath) return null
      return loadProjectFromFolder(folderPath)
    },
  )

  ipcMain.handle('projects:pickAndOpen', async (): Promise<ProjectSummary | null> => {
    const parent = options.getMainWindow()
    const defaultPath = projectsRoot()
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          title: 'Open project',
          defaultPath,
          properties: ['openDirectory'],
        })
      : await dialog.showOpenDialog({
          title: 'Open project',
          defaultPath,
          properties: ['openDirectory'],
        })

    if (result.canceled || result.filePaths.length === 0) return null
    return loadProjectFromFolder(result.filePaths[0])
  })
}
