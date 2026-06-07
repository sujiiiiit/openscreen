import { TAB_IDS, type TabId } from "@/types/editor-tabs"

/**
 * Persisted sidebar tab state: the active tab plus whether the content panel
 * is expanded, so a refresh / app restart reopens the panel the user was last
 * working in.
 *
 * Persisted in `localStorage` (app-level, not project state — it's editor
 * chrome like the renderer backend preference, so it deliberately lives
 * outside `project.json` and applies across projects on this machine).
 */
export type SidebarTabPreference = {
  tab: TabId
  isOpen: boolean
}

export const SIDEBAR_TAB_STORAGE_KEY = "openscreen:sidebarTab"

/**
 * Whether sidebar tab persistence is enabled at all — toggled from the
 * Settings window (Editor section). Default ON. Stored as its own key (the
 * preference about persisting is itself app-level chrome). Turning it OFF
 * also clears the stored tab entry, so "don't persist" reliably means the
 * defaults (`background`, open) on the next launch rather than a stale
 * snapshot from when the switch was last on.
 *
 * The Settings window is a separate BrowserWindow, so the change event below
 * only reaches listeners in the window the toggle ran in; cross-window
 * listeners (the editor's `SidebarTabsProvider`) additionally watch the
 * `storage` event for this key.
 */
export const SIDEBAR_TAB_PERSIST_STORAGE_KEY = "openscreen:sidebarTabPersist"
export const SIDEBAR_TAB_PERSIST_CHANGE_EVENT =
  "openscreen:sidebar-tab-persist-change"

export function getSidebarTabPersistEnabled(): boolean {
  if (typeof window === "undefined") return true
  try {
    return (
      window.localStorage.getItem(SIDEBAR_TAB_PERSIST_STORAGE_KEY) !== "off"
    )
  } catch {
    return true
  }
}

export function setSidebarTabPersistEnabled(value: boolean): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      SIDEBAR_TAB_PERSIST_STORAGE_KEY,
      value ? "on" : "off"
    )
    if (!value) {
      window.localStorage.removeItem(SIDEBAR_TAB_STORAGE_KEY)
    }
  } catch {
    // Storage unavailable (private mode / quota) — the in-session event below
    // still applies the choice until the window closes.
  }
  window.dispatchEvent(new Event(SIDEBAR_TAB_PERSIST_CHANGE_EVENT))
}

function isTabId(value: unknown): value is TabId {
  return (
    typeof value === "string" && (TAB_IDS as readonly string[]).includes(value)
  )
}

export function readSidebarTabPreference(): SidebarTabPreference | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(SIDEBAR_TAB_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const { tab, isOpen } = parsed as { tab?: unknown; isOpen?: unknown }
    // A stored tab id that no longer exists (removed/renamed tab) drops the
    // whole entry — the provider falls back to its defaults.
    if (!isTabId(tab)) return null
    return { tab, isOpen: typeof isOpen === "boolean" ? isOpen : true }
  } catch {
    return null
  }
}

export function writeSidebarTabPreference(value: SidebarTabPreference): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage unavailable (private mode / quota) — the in-session state still
    // applies until the window closes.
  }
}
