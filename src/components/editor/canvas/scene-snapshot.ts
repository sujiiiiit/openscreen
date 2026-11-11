/**
 * Module-level bridge between the mounted PixiJS canvas and React panels that
 * want a one-shot rasterization of the artboard composition (e.g. the Zoom
 * tab's focus preview). `PixiCanvas` registers the live scene's capture
 * function on mount and unregisters it on unmount; consumers call
 * `captureSceneSnapshot` and get `null` when no canvas is mounted.
 *
 * Kept outside the `EditorCanvasProvider` context on purpose: the provider
 * owns serializable editor state, while this is an imperative escape hatch to
 * the renderer — routing it through context would re-render consumers for a
 * value that never changes meaningfully.
 */

export type SceneSnapshotProvider = (
  targetWidth: number
) => HTMLCanvasElement | null

let provider: SceneSnapshotProvider | null = null

export function registerSceneSnapshotProvider(
  fn: SceneSnapshotProvider
): () => void {
  provider = fn
  return () => {
    if (provider === fn) provider = null
  }
}

/**
 * Rasterize the current artboard composition to a canvas no wider than
 * `targetWidth`. Returns null when no PixiJS canvas is mounted (or the scene
 * is being torn down).
 */
export function captureSceneSnapshot(
  targetWidth: number
): HTMLCanvasElement | null {
  return provider ? provider(targetWidth) : null
}
