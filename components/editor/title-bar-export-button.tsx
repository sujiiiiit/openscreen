"use client"

import { useCallback } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Share03Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { NO_DRAG } from "@/lib/window-drag"
import { useProject } from "@/components/editor/project/provider"
import {
  useEditorCanvasArtboard,
  useEditorCanvasMedia,
  useEditorCanvasTimeline,
} from "@/components/editor/canvas/provider"
import { serializeProjectState } from "@/components/editor/canvas/persistence"
import { defaultExportSettings } from "@/lib/editor-project/export-settings"

export function TitleBarExportButton() {
  const { project } = useProject()
  const { videos } = useEditorCanvasMedia()
  const { artboard } = useEditorCanvasArtboard()
  const { timelineClips } = useEditorCanvasTimeline()

  const isExportable =
    project !== null && timelineClips.length > 0 && videos.length > 0

  const handleExport = useCallback(() => {
    if (!project || !isExportable) return
    const api = window.api?.export
    if (!api) return
    const state = serializeProjectState(artboard, videos, timelineClips)
    void api.openWindow({
      settings: defaultExportSettings(),
      state,
      assetUrlsByVideoId: project.assetUrlsByVideoId,
      outputBaseName: project.name,
    })
  }, [project, isExportable, artboard, videos, timelineClips])

  const tooltipMessage = !project
    ? "Open a project to export."
    : !isExportable
      ? "Add clips to the timeline to export."
      : "Export…"

  return (
    <Button
      variant="default"
      size="sm"
      aria-label="Export video"
      style={NO_DRAG}
      disabled={!isExportable}
      onClick={handleExport}
    >
      <HugeiconsIcon icon={Share03Icon} />
      Export
    </Button>
  )
}
