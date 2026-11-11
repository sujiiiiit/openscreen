/**
 * Whether opening a project starts playback automatically ("Autoplay on
 * open") — toggled from the Settings window (Editor section). Default ON.
 *
 * Persisted in `localStorage` (app-level, not project state — it's a viewing
 * preference like the renderer backend and sidebar tab, so it deliberately
 * lives outside `project.json` and applies across projects).
 *
 * No change event is needed: the canvas provider reads the flag at the moment
 * the armed autoplay would fire (first video element ready), so a toggle
 * always takes effect on the next project open / refresh without any
 * subscription plumbing — even when toggled from the Settings window, since
 * all windows share the same origin's localStorage.
 */
export const AUTOPLAY_ON_OPEN_STORAGE_KEY = "openscreen:autoplayOnOpen"

export function getAutoplayOnOpenEnabled(): boolean {
  if (typeof window === "undefined") return true
  try {
    return (
      window.localStorage.getItem(AUTOPLAY_ON_OPEN_STORAGE_KEY) !== "off"
    )
  } catch {
    return true
  }
}

export function setAutoplayOnOpenEnabled(value: boolean): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      AUTOPLAY_ON_OPEN_STORAGE_KEY,
      value ? "on" : "off"
    )
  } catch {
    // Storage unavailable (private mode / quota) — the toggle silently lasts
    // only for this window.
  }
}
