import { BrowserWindow, app, ipcMain, shell } from 'electron'
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  coerceExportSettings,
  defaultExportSettings,
  exportContainerExtension,
  type ExportJobState,
  type ExportPhase,
  type ExportProgress,
  type ExportSettings,
} from './export-schema'
import type { ProjectStateV1 } from './project-schema'

// IMPORTANT: the exported types below are mirrored in `types/api.d.ts` so
// the renderer can typecheck the preload bridge without importing from
// `electron/`. Edits here MUST be reflected there.

export interface ExportStartPayload {
  settings: ExportSettings
  state: ProjectStateV1
  assetUrlsByVideoId: Record<string, string>
  outputBaseName?: string
  // Absolute project folder — lets the export stage load cursor sidecars
  // directly instead of re-deriving the folder from a video file URL.
  projectPath?: string
}

interface RegisterExportHandlersOptions {
  getExportWindow: () => BrowserWindow | null
  getEditorWindow: () => BrowserWindow | null
  openExportWindow: () => void
  closeExportWindow: () => void
  hideEditorWindow: (window?: BrowserWindow | null) => void
  showEditorWindow: (window?: BrowserWindow | null) => void
}

const EXPORT_SETTINGS_FILE = 'export-settings.json'
const EXPORT_DIR_NAME = 'exports'

// Terminal phases never transition into anything else. The renderer is the
// single driver of the state machine but multiple IPC paths (`cancel`,
// `closeWindow`, the `closed` event handler) can fire in close succession;
// gating mutations on this set keeps a stray `cancel` after `reportDone`
// from clobbering a successful export.
const TERMINAL_PHASES: ReadonlySet<ExportPhase> = new Set([
  'done',
  'error',
  'cancelled',
])

function exportSettingsFilePath(): string {
  return path.join(app.getPath('userData'), EXPORT_SETTINGS_FILE)
}

function readPersistedExportSettings(): Partial<ExportSettings> {
  try {
    const raw = readFileSync(exportSettingsFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ExportSettings>
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    // Missing or unreadable on first launch — fall back to defaults.
  }
  return {}
}

function persistExportSettings(value: ExportSettings): void {
  try {
    writeFileSync(exportSettingsFilePath(), JSON.stringify(value, null, 2))
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[export] failed to persist export settings', error)
    }
  }
}

function loadExportSettings(): ExportSettings {
  const persisted = readPersistedExportSettings()
  const settings = coerceExportSettings({
    ...defaultExportSettings(),
    ...persisted,
  })
  // Surface what coercion changed so a corrupt / hand-edited settings file
  // is debuggable. Keys absent from the file are normal defaults — silent.
  const coercedKeys = (Object.keys(persisted) as (keyof ExportSettings)[]).filter(
    (key) => persisted[key] !== undefined && settings[key] !== persisted[key]
  )
  if (coercedKeys.length > 0) {
    console.warn(
      '[export] invalid persisted export-settings values coerced:',
      Object.fromEntries(
        coercedKeys.map((key) => [
          key,
          { persisted: persisted[key], coerced: settings[key] },
        ])
      )
    )
  }
  return settings
}

let cachedExportsDir: string | null = null

export function exportsDir(): string {
  if (cachedExportsDir) return cachedExportsDir
  const dir = path.join(app.getPath('documents'), 'openscreen', EXPORT_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  cachedExportsDir = dir
  return dir
}

function timestampSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function sanitizeBaseName(input: string | undefined): string {
  if (!input) return 'export'
  const cleaned = input.trim().replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._\- ]+/g, '_').slice(0, 80)
  return cleaned || 'export'
}

function defaultProgress(): ExportProgress {
  return { framesDone: 0, framesTotal: 0, etaSeconds: null }
}

let pendingStartPayload: ExportStartPayload | null = null
let sourceEditorWindow: BrowserWindow | null = null

const state: ExportJobState = {
  phase: 'idle',
  settings: loadExportSettings(),
  progress: defaultProgress(),
  outputPath: null,
  startedAtUnixMs: null,
  lastError: null,
}

function publicState(): ExportJobState {
  return structuredClone(state)
}

function isExportActive(): boolean {
  return (
    state.phase === 'preparing' ||
    state.phase === 'encoding' ||
    state.phase === 'finalizing'
  )
}

function broadcastState(windowRef: BrowserWindow | null): ExportJobState {
  const snapshot = publicState()
  if (windowRef && !windowRef.isDestroyed()) {
    windowRef.webContents.send('export:stateChanged', snapshot)
  }
  return snapshot
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getSourceEditorWindow(fallback: () => BrowserWindow | null): BrowserWindow | null {
  if (sourceEditorWindow && !sourceEditorWindow.isDestroyed()) {
    return sourceEditorWindow
  }
  sourceEditorWindow = fallback()
  return sourceEditorWindow
}

export function getExportSourceEditorWindow(): BrowserWindow | null {
  return sourceEditorWindow && !sourceEditorWindow.isDestroyed()
    ? sourceEditorWindow
    : null
}

export function registerExportHandlers(options: RegisterExportHandlersOptions): void {
  ipcMain.handle('export:openWindow', (event, payload: ExportStartPayload) => {
    // If the export window is already open, just bring it forward —
    // regardless of whether an encode is in flight. We don't reset state
    // or replace the payload, since the existing window's form / progress
    // is what the user expects to come back to. Closing + reopening is
    // the way to get a fresh snapshot.
    const existing = options.getExportWindow()
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }
    sourceEditorWindow = BrowserWindow.fromWebContents(event.sender) ?? options.getEditorWindow()
    pendingStartPayload = payload && typeof payload === 'object' ? payload : null
    // Fresh window — wipe job state so we start clean.
    state.phase = 'idle'
    state.progress = defaultProgress()
    state.outputPath = null
    state.startedAtUnixMs = null
    state.lastError = null
    if (pendingStartPayload?.settings) {
      const merged = coerceExportSettings({
        ...state.settings,
        ...pendingStartPayload.settings,
      })
      state.settings = merged
    }
    options.openExportWindow()
  })

  ipcMain.handle('export:getStartPayload', () => pendingStartPayload)

  ipcMain.handle('export:getState', () => publicState())

  ipcMain.handle('export:getSettings', () => state.settings)
  ipcMain.handle(
    'export:setSettings',
    (_event, patch: Partial<ExportSettings>): ExportSettings => {
      const next = coerceExportSettings({ ...state.settings, ...patch })
      state.settings = next
      persistExportSettings(next)
      broadcastState(options.getExportWindow())
      return next
    },
  )

  ipcMain.handle(
    'export:reportProgress',
    (_event, progress: ExportProgress) => {
      if (
        !progress ||
        typeof progress.framesDone !== 'number' ||
        typeof progress.framesTotal !== 'number'
      ) {
        return
      }
      // A late progress event arriving after cancel/error/done would
      // otherwise resurrect the job. Terminal phases swallow it.
      if (TERMINAL_PHASES.has(state.phase)) return
      state.phase =
        state.phase === 'preparing' || state.phase === 'encoding'
          ? 'encoding'
          : state.phase
      state.progress = {
        framesDone: progress.framesDone,
        framesTotal: progress.framesTotal,
        etaSeconds:
          typeof progress.etaSeconds === 'number' && progress.etaSeconds >= 0
            ? progress.etaSeconds
            : null,
      }
      if (state.startedAtUnixMs === null && progress.framesDone > 0) {
        state.startedAtUnixMs = Date.now()
      }
      broadcastState(options.getExportWindow())
    },
  )

  ipcMain.handle(
    'export:reportDone',
    async (_event, bytes: ArrayBuffer): Promise<{ outputPath: string }> => {
      if (!(bytes instanceof ArrayBuffer)) {
        throw new Error('Export output payload must be an ArrayBuffer.')
      }
      // If the user clicked Cancel while finalize was in flight, the cancel
      // handler has already moved us to a terminal state. Honour that:
      // don't write the file, don't resurrect the job.
      if (TERMINAL_PHASES.has(state.phase)) {
        throw new Error(`Export is ${state.phase}; output discarded.`)
      }
      state.phase = 'finalizing'
      broadcastState(options.getExportWindow())

      const ext = exportContainerExtension(state.settings.format)
      const baseName = sanitizeBaseName(pendingStartPayload?.outputBaseName)
      const fileName = `${baseName}-${timestampSuffix()}.${ext}`
      const target = path.join(exportsDir(), fileName)
      try {
        await fs.writeFile(target, Buffer.from(bytes))
      } catch (error) {
        state.phase = 'error'
        state.lastError = errorMessage(error)
        broadcastState(options.getExportWindow())
        options.showEditorWindow(getSourceEditorWindow(options.getEditorWindow))
        throw error
      }

      state.phase = 'done'
      state.outputPath = target
      broadcastState(options.getExportWindow())
      // Editor stays hidden until the user closes the export window — they
      // see the success surface first, then the close path restores the
      // editor.
      return { outputPath: target }
    },
  )

  ipcMain.handle('export:reportError', (_event, message: string) => {
    if (TERMINAL_PHASES.has(state.phase)) return
    state.phase = 'error'
    state.lastError = typeof message === 'string' ? message : 'Export failed.'
    broadcastState(options.getExportWindow())
    options.showEditorWindow(getSourceEditorWindow(options.getEditorWindow))
  })

  ipcMain.handle('export:cancel', () => {
    // Cancel is a no-op for terminal states. The previous behaviour was to
    // flip the phase to 'cancelled' regardless, which caused a fatal bug:
    // clicking Done after a successful export flipped state.phase from
    // 'done' to 'cancelled', and the subsequent 'closed' event then
    // triggered disposeExportPendingPayload to delete the output file
    // because phase !== 'done'. Honouring terminal states stops that
    // resurrection and keeps a successful export permanent.
    if (TERMINAL_PHASES.has(state.phase)) return
    if (!isExportActive()) {
      // Idle / fresh window — nothing to cancel, but flip to a terminal
      // state so the UI surface reflects the user's intent.
      state.phase = 'cancelled'
      state.lastError = null
      broadcastState(options.getExportWindow())
      return
    }
    state.phase = 'cancelled'
    state.lastError = null
    // Best-effort: if the worker wrote a partial file we won't know its path
    // (BufferTarget is in-memory; FilePath/StreamTarget could be added in
    // v2). reportDone is the only place we touch disk, so cancellation
    // before that is a clean teardown.
    broadcastState(options.getExportWindow())
    options.showEditorWindow(getSourceEditorWindow(options.getEditorWindow))
  })

  ipcMain.handle('export:revealOutput', async (_event, target: string) => {
    if (typeof target !== 'string' || !target) return
    // Only allow revealing files inside our exports dir. Prevents a
    // compromised renderer from probing arbitrary filesystem paths.
    const root = path.resolve(exportsDir())
    const resolved = path.resolve(target)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return
    try {
      await fs.access(resolved)
      shell.showItemInFolder(resolved)
    } catch {
      // File missing — silently noop.
    }
  })

  ipcMain.handle('export:closeWindow', () => {
    // Close is purely a window operation. We deliberately do NOT touch
    // state.phase here — terminal phases (done/error/cancelled) must
    // survive the close so disposeExportPendingPayload's "did we finish
    // cleanly?" check stays correct. The window's `closed` handler in
    // main.ts calls disposeExportPendingPayload and restores the editor.
    const win = options.getExportWindow()
    if (win && !win.isDestroyed()) {
      win.close()
      return
    }
    // No window to close — make sure the editor is visible anyway.
    options.showEditorWindow(getSourceEditorWindow(options.getEditorWindow))
  })

  // The renderer-side state machine signals when it has begun the long-running
  // encode. We flip the phase + hide the editor here so the toggle is
  // centralised.
  ipcMain.handle('export:markPreparing', () => {
    state.phase = 'preparing'
    state.progress = defaultProgress()
    state.outputPath = null
    state.startedAtUnixMs = null
    state.lastError = null
    broadcastState(options.getExportWindow())
    options.hideEditorWindow(getSourceEditorWindow(options.getEditorWindow))
  })
}

/**
 * Cleanup invoked from the export window's `closed` event handler in
 * main.ts. Two responsibilities:
 *   1. Drop the pending payload reference so a future window doesn't see
 *      stale project state.
 *   2. Delete any orphan output file from an aborted finalize. We only
 *      delete when the phase is non-terminal — a `done` job is "the user's
 *      file now" and must never be touched; an `error` or `cancelled`
 *      that left state.outputPath set is also untouched because the
 *      reportDone handler only writes after a successful encode.
 *
 * Note on the previous bug fixed alongside this: the cancel IPC handler
 * used to overwrite `done → cancelled` on a stray cancel call, which made
 * the `phase !== 'done'` guard here delete a perfectly good output. That
 * is now blocked at the source (cancel refuses terminal transitions).
 */
export function disposeExportPendingPayload(): void {
  pendingStartPayload = null
  sourceEditorWindow = null
  if (
    state.outputPath &&
    state.phase !== 'done' &&
    state.phase !== 'error' &&
    state.phase !== 'cancelled'
  ) {
    try {
      rmSync(state.outputPath, { force: true })
    } catch {
      // best-effort
    }
  }
}
