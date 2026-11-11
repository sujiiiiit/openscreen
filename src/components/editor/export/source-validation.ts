import type { ProjectStateV1 } from "@/types/api"

export function findMissingActiveSourceVideoIds(
  state: ProjectStateV1,
  assetUrlsByVideoId: Record<string, string>,
): string[] {
  const missing: string[] = []
  const seen = new Set<string>()

  for (const clip of state.timelineClips) {
    if (clip.end <= clip.start) continue
    if (seen.has(clip.videoId)) continue
    seen.add(clip.videoId)
    if (!assetUrlsByVideoId[clip.videoId]) missing.push(clip.videoId)
  }

  return missing
}

export function formatExportSourceList(
  state: ProjectStateV1,
  videoIds: readonly string[],
): string {
  const videoNameById = new Map(
    state.videos.map((video) => [video.id, video.fileName || video.id]),
  )

  return videoIds
    .map((videoId) => videoNameById.get(videoId) ?? videoId)
    .join(", ")
}
