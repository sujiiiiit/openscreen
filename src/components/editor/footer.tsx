"use client"

import { ArtboardPresetDropdown } from "@/components/editor/canvas/artboard-preset-dropdown"
import { CanvasZoomMenu } from "@/components/editor/canvas/canvas-zoom-menu"
import {
  EditorTimelineControls,
  EditorTimelinePanel,
  EditorTimelineZoomControls,
} from "@/components/editor/timeline-panel"

export default function EditorFooter() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <div className="grid h-12 shrink-0 grid-cols-[minmax(220px,1fr)_auto_minmax(220px,1fr)] items-center gap-3 bg-transparent px-4">
        <div className="flex min-w-0 items-center">
          <ArtboardPresetDropdown />
        </div>
        <EditorTimelineControls />
        <div className="flex min-w-0 items-center justify-end gap-4">
          <EditorTimelineZoomControls />
          <div className="flex shrink-0 justify-end">
            <CanvasZoomMenu />
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <EditorTimelinePanel />
      </div>
    </div>
  )
}
