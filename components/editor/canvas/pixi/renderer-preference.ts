import type { RendererPreference } from "pixi.js"

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
export function preferredRendererBackend(): RendererPreference {
  const hasRequiredWebGPUGlobals =
    typeof globalThis !== "undefined" &&
    "GPUTextureUsage" in globalThis &&
    "GPUShaderStage" in globalThis
  return hasRequiredWebGPUGlobals ? "webgpu" : "webgl"
}

/**
 * Ordered renderer preference list for a try/init fallback loop. WebGPU is only
 * attempted when {@link preferredRendererBackend} reports its globals exist, so
 * we never hand PixiJS a WebGPU preference that would crash post-init.
 */
export function rendererPreferenceChain(): readonly RendererPreference[] {
  return preferredRendererBackend() === "webgpu"
    ? ["webgpu", "webgl"]
    : ["webgl"]
}
