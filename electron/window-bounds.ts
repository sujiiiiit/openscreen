import { readFileSync } from "node:fs"
import * as path from "node:path"
import { BrowserWindow, app, screen } from "electron"

import { writeJsonAtomic } from "./ipc/fs-utils"

// Persist user-positioned window bounds across app restarts. App-chrome
// preference (like the sidebar-tab localStorage slot) — deliberately NOT
// part of project.json: window placement belongs to the machine/session,
// not to a project.
//
// Scope: the editor window (position + size), the camera preview
// (position + size), and the recorder bar / export window (position only —
// their sizes are fixed by windowConfigs). Fullscreen/maximized states are
// intentionally not restored; bounds captured while in those states are
// skipped so a fullscreen quit doesn't persist screen-sized bounds.

export type WindowBoundsKey = "editor" | "camera" | "recorderBar" | "export"

export interface PersistedBounds {
  x: number
  y: number
  width: number
  height: number
}

type BoundsFile = Partial<Record<WindowBoundsKey, PersistedBounds>>

const WINDOW_BOUNDS_FILE = "window-bounds.json"
const SAVE_DEBOUNCE_MS = 500
// A restored window must overlap a live display's work area by at least
// this much to count as reachable; otherwise (monitor unplugged, display
// rearranged) the caller falls back to its default placement.
const MIN_VISIBLE_WIDTH = 40
const MIN_VISIBLE_HEIGHT = 20

function boundsFilePath(): string {
  return path.join(app.getPath("userData"), WINDOW_BOUNDS_FILE)
}

// `undefined` = not read yet; reads lazily once, then writes keep it fresh.
let cache: BoundsFile | undefined

function isValidBounds(value: unknown): value is PersistedBounds {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y) &&
    Number.isFinite(candidate.width) &&
    Number.isFinite(candidate.height) &&
    (candidate.width as number) > 0 &&
    (candidate.height as number) > 0
  )
}

function readBoundsFile(): BoundsFile {
  if (cache !== undefined) return cache
  cache = {}
  try {
    const raw = readFileSync(boundsFilePath(), "utf-8")
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object") {
      for (const key of [
        "editor",
        "camera",
        "recorderBar",
        "export",
      ] as WindowBoundsKey[]) {
        const value = (parsed as Record<string, unknown>)[key]
        if (isValidBounds(value)) cache[key] = value
      }
    }
  } catch {
    // Missing or unreadable — first launch or fresh userData.
  }
  return cache
}

// Writes are serialized through a promise chain: several windows can flush
// their debounced saves in the same tick and the atomic temp+rename writes
// must not interleave on the shared file.
let writeChain: Promise<void> = Promise.resolve()

function persistBoundsFile(): void {
  const snapshot = { ...readBoundsFile() }
  writeChain = writeChain
    .then(() => writeJsonAtomic(boundsFilePath(), snapshot))
    .catch((error) => {
      // Best-effort: a failed write means the next launch uses default
      // placement — never blocks the UI.
      console.warn("[window-bounds] failed to persist window bounds", error)
    })
}

function intersectsAnyDisplay(bounds: PersistedBounds): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    const overlapW =
      Math.min(bounds.x + bounds.width, area.x + area.width) -
      Math.max(bounds.x, area.x)
    const overlapH =
      Math.min(bounds.y + bounds.height, area.y + area.height) -
      Math.max(bounds.y, area.y)
    return overlapW >= MIN_VISIBLE_WIDTH && overlapH >= MIN_VISIBLE_HEIGHT
  })
}

/**
 * Saved bounds for a window slot, or null when nothing was saved or the
 * saved bounds no longer touch a connected display (the caller should run
 * its default placement).
 */
export function getSavedBounds(key: WindowBoundsKey): PersistedBounds | null {
  const saved = readBoundsFile()[key]
  if (!saved) return null
  if (!intersectsAnyDisplay(saved)) return null
  return saved
}

/**
 * Track a window's move/resize events and persist its bounds (debounced).
 * `persistSize: false` records the position but keeps the size out of the
 * file — fixed-size windows (recorder bar, export) restore size from
 * windowConfigs so a config change wins over a stale persisted size.
 */
export function rememberWindowBounds(
  win: BrowserWindow,
  key: WindowBoundsKey,
  options: { persistSize: boolean }
): void {
  let timer: NodeJS.Timeout | null = null

  const capture = () => {
    if (win.isDestroyed()) return
    if (win.isFullScreen() || win.isMaximized() || win.isMinimized()) return
    const bounds = win.getBounds()
    const file = readBoundsFile()
    const previous = file[key]
    file[key] = options.persistSize
      ? { ...bounds }
      : {
          x: bounds.x,
          y: bounds.y,
          width: previous?.width ?? bounds.width,
          height: previous?.height ?? bounds.height,
        }
    persistBoundsFile()
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      capture()
    }, SAVE_DEBOUNCE_MS)
  }

  win.on("move", schedule)
  win.on("resize", schedule)
  win.on("closed", () => {
    // Flush a pending capture so a move-then-close still persists. The
    // window is destroyed at this point; capture() reads nothing from it —
    // rely on the last scheduled state instead by capturing just before
    // teardown via the 'close' event below.
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  })
  // 'close' fires while the window is still alive — flush the debounce here.
  win.on("close", () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
      capture()
    }
  })
}
