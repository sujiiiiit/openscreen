import type { CanvasVideoItem } from "@/types/editor-canvas"

/**
 * Resolve the source URL map handed to the export window from the current
 * in-memory canvas state.
 *
 * `ProjectSummary.assetUrlsByVideoId` is computed only when a project is
 * loaded in main. A freshly recorded project starts with `project.state ===
 * null`, so that map is empty until the next reload even though the renderer
 * has already synthesized screen/camera video items with valid file:// URLs.
 */
export function buildExportAssetUrlsByVideoId(
  videos: readonly CanvasVideoItem[],
  projectAssetUrlsByVideoId: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const video of videos) {
    const liveUrl = video.objectUrl
    const persistedUrl = projectAssetUrlsByVideoId[video.id]
    const url = liveUrl || persistedUrl
    if (url) result[video.id] = url
  }

  return result
}
