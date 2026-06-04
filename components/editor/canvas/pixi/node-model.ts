import type { CanvasNode, CanvasVideoItem } from "@/types/editor-canvas"

/**
 * Map a persisted {@link CanvasVideoItem} to the in-memory {@link CanvasNode} the
 * Pixi scene + pure transform math operate on. This is a READ-SIDE derivation
 * only — never serialized — so `project.json` stays byte-compatible. openscreen
 * uses object-fit cover (recomputed from size + intrinsic), so `contentTransform`
 * is left undefined and flips default to false.
 */
export function canvasNodeFromVideo(video: CanvasVideoItem): CanvasNode {
  return {
    id: video.id,
    type: "video",
    locked: video.locked,
    x: video.x,
    y: video.y,
    width: video.width,
    height: video.height,
    rotation: video.rotation,
    flipX: false,
    flipY: false,
  }
}
