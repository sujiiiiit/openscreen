"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import { PlayIcon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { NO_DRAG } from "@/lib/window-drag"
import { useProject } from "@/components/editor/project/provider"
import {
  useEditorCanvasActions,
  useEditorCanvasMedia,
  useEditorCanvasTimeline,
} from "@/components/editor/canvas/provider"

export function TitleBarPreviewButton() {
  const { project } = useProject()
  const { videos } = useEditorCanvasMedia()
  const { timelineClips, timelineDuration } = useEditorCanvasTimeline()
  const { enterPreview } = useEditorCanvasActions()

  const canPreview =
    project !== null &&
    timelineClips.length > 0 &&
    videos.length > 0 &&
    timelineDuration > 0

  return (
    <Button
      variant="outline"
      size="sm"
      aria-label="Preview"
      style={NO_DRAG}
      disabled={!canPreview}
      onClick={() => enterPreview()}
    >
      <HugeiconsIcon icon={PlayIcon} />
      Preview
    </Button>
  )
}
