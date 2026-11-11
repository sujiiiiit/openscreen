import { Application, type ApplicationOptions } from "pixi.js"
// Installs static (CSP-safe) uniform/UBO sync implementations. The packaged
// app's CSP has no 'unsafe-eval', and without this import PixiJS's renderer
// init throws. Owning it here means every renderer gets it — never construct
// an `Application` outside this module.
import "pixi.js/unsafe-eval"
// Fixes that polyfill's UBO sync arity bug, which zeroed every WebGPU filter's
// uniforms and turned blurred zoom frames black. See the module for details.
import "./ubo-sync-polyfill-fix"
import { rendererPreferenceChain } from "./renderer-preference"

export type PixiApplicationOptions = Omit<
  Partial<ApplicationOptions>,
  "preference"
>

/**
 * The single entry point for creating a PixiJS `Application` (editor preview
 * AND export). Walks {@link rendererPreferenceChain} — WebGPU first when the
 * user prefers it and the environment supports it, then WebGL2 — and returns
 * the first backend that initialises.
 *
 * `verify` runs after a successful init and may throw to reject that backend
 * (e.g. the export's readback probe); the attempt is torn down and the next
 * backend is tried. Throws with the last error if every backend fails.
 */
export async function createPixiApplication(
  options: PixiApplicationOptions,
  verify?: (app: Application) => void
): Promise<Application> {
  let lastError: unknown = null
  for (const preference of rendererPreferenceChain()) {
    const app = new Application()
    try {
      await app.init({ ...options, preference })
      verify?.(app)
      return app
    } catch (error) {
      lastError = error
      try {
        app.destroy({ removeView: true }, { children: true })
      } catch {
        // best-effort — a half-initialised app may not destroy cleanly
      }
    }
  }
  throw new Error(
    `Failed to initialize a PixiJS renderer (${rendererPreferenceChain().join(" → ")}): ${String(lastError)}`,
    { cause: lastError }
  )
}
