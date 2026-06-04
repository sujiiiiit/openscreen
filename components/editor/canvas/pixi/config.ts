/**
 * Migration flag for the PixiJS canvas. During the Konva → Pixi migration the
 * two canvases coexist: the Konva `<Stage>` renders by default, and the Pixi
 * canvas mounts in its place only when this flag is on. Toggle at runtime from
 * the devtools console:
 *
 *   localStorage.setItem("openscreen:pixiCanvas", "1")  // then reload
 *   localStorage.removeItem("openscreen:pixiCanvas")    // back to Konva
 *
 * The value is read once per mount (a reload applies a change). This whole file
 * is removed in the final cutover milestone, when Pixi becomes the only canvas.
 */
const PIXI_CANVAS_FLAG_KEY = "openscreen:pixiCanvas"

export function isPixiCanvasEnabled(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(PIXI_CANVAS_FLAG_KEY) === "1"
  } catch {
    return false
  }
}
