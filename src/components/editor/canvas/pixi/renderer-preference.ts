import type { RendererPreference } from "pixi.js"

/**
 * User-facing renderer backend preference for the PixiJS canvas (preview AND
 * export — both read the same value, so the encoded pixels keep coming from
 * the same backend the user previews on).
 *
 * - `"webgpu"` (default): prefer WebGPU, with the hard environment gate below
 *   still applied — a forced WebGPU choice must never crash an environment
 *   that can't actually run it.
 * - `"webgl"`: force WebGL2.
 *
 * Persisted in `localStorage` (app-level, not project state — it describes
 * the machine/runtime, not the document, so it deliberately lives outside
 * `project.json`). The editor and the Export window share the same origin, so
 * one setting covers both. Changing it dispatches
 * {@link RENDERER_BACKEND_CHANGE_EVENT}; the editor workspace listens and
 * remounts the Pixi canvas so the choice applies immediately.
 */
export type RendererBackendPreference = "webgpu" | "webgl"

export const RENDERER_BACKEND_DEFAULT: RendererBackendPreference = "webgpu"
export const RENDERER_BACKEND_STORAGE_KEY = "openscreen:rendererBackend"
export const RENDERER_BACKEND_CHANGE_EVENT = "openscreen:renderer-backend-change"

export function clampRendererBackendPreference(
  value: unknown
): RendererBackendPreference {
  return value === "webgl" ? "webgl" : RENDERER_BACKEND_DEFAULT
}

export function getRendererBackendPreference(): RendererBackendPreference {
  if (typeof window === "undefined") return RENDERER_BACKEND_DEFAULT
  try {
    return clampRendererBackendPreference(
      window.localStorage.getItem(RENDERER_BACKEND_STORAGE_KEY)
    )
  } catch {
    return RENDERER_BACKEND_DEFAULT
  }
}

export function setRendererBackendPreference(
  value: RendererBackendPreference
): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      RENDERER_BACKEND_STORAGE_KEY,
      clampRendererBackendPreference(value)
    )
  } catch {
    // Storage unavailable (private mode / quota) — the in-session event below
    // still applies the choice until the window closes.
  }
  window.dispatchEvent(new Event(RENDERER_BACKEND_CHANGE_EVENT))
}

/**
 * PixiJS's WebGPU backend reads the global `GPUTextureUsage` and `GPUShaderStage`
 * constant namespaces directly when uploading textures and building pipelines.
 *
 * Some environments expose `navigator.gpu` — enough for PixiJS to *select*
 * WebGPU and acquire an adapter during `app.init()` — yet never define those
 * global constants. Init succeeds, then the first real texture upload throws
 * `ReferenceError: GPUTextureUsage is not defined` mid-render. Because that
 * happens *after* init, an init-only try/catch fallback can't catch it (the
 * preview render loop and the export's per-frame draws both fail later).
 *
 * Gate WebGPU on the presence of the globals it actually needs. When they're
 * missing we force WebGL2, which has no such dependency. When they're present we
 * still defer to PixiJS's own adapter detection (it falls back to WebGL on its
 * own if no GPU adapter is available).
 */
function hasRequiredWebGPUGlobals(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    "GPUTextureUsage" in globalThis &&
    "GPUShaderStage" in globalThis
  )
}

/**
 * The renderer preference handed to `app.init()`: the user's backend choice,
 * with the WebGPU environment gate applied on top.
 */
function preferredRendererBackend(): RendererPreference {
  if (getRendererBackendPreference() === "webgl") return "webgl"
  return hasRequiredWebGPUGlobals() ? "webgpu" : "webgl"
}

/**
 * Ordered renderer preference list for a try/init fallback loop. WebGPU is only
 * attempted when the user prefers it AND {@link preferredRendererBackend}
 * reports its globals exist, so we never hand PixiJS a WebGPU preference that
 * would crash post-init.
 */
export function rendererPreferenceChain(): readonly RendererPreference[] {
  return preferredRendererBackend() === "webgpu"
    ? ["webgpu", "webgl"]
    : ["webgl"]
}
