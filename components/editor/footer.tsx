"use client"

import { ArtboardPresetDropdown } from "@/components/editor/canvas/artboard-preset-dropdown"
import { CanvasZoomMenu } from "@/components/editor/canvas/canvas-zoom-menu"

export default function EditorFooter() {
  return (
    <div className="flex h-full w-full flex-col border-t bg-background">
      <div className="flex h-16 shrink-0 items-center justify-between px-6">
        <ArtboardPresetDropdown />
        <div className="text-xs text-muted-foreground">
          Timeline placeholder
        </div>
        <div className="flex w-[180px] justify-end">
          <CanvasZoomMenu />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center border-t text-xs text-muted-foreground">
        Timeline placeholder
      </div>
    </div>
  )
}
