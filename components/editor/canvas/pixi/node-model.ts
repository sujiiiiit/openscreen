import type { CanvasNode, CanvasVideoItem } from "@/types/editor-canvas"

/**
 * Map a persisted {@link CanvasVideoItem} to the in-memory {@link CanvasNode} the
 * Pixi scene + pure hit-test math operate on. This is a READ-SIDE derivation
 * only — never serialized — so `project.json` stays byte-compatible. Placement
 * fields come straight from the item; they are settings-derived upstream
 * (`lib/video-placement.ts`), never gesture-edited.
 */
export function canvasNodeFromVideo(video: CanvasVideoItem): CanvasNode {
  return {
    id: video.id,
    type: "video",
    x: video.x,
    y: video.y,
    width: video.width,
    height: video.height,
    rotation: video.rotation,
  }
}
