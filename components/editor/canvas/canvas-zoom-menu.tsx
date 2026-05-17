"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  FitToScreenIcon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "@hugeicons/core-free-icons"

import {
  useEditorCanvasActions,
  useEditorCanvasView,
} from "@/components/editor/canvas/provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  getZoomedViewTransform,
  WORKSPACE_ZOOM_STEP,
} from "@/lib/editor-canvas"

const ZOOM_PRESETS = [
  { label: "Zoom to 50%", scale: 0.5 },
  { label: "Zoom to 100%", scale: 1, shortcut: "⌘0" },
  { label: "Zoom to 200%", scale: 2 },
]

function formatZoomPercent(scale: number) {
  const percent = scale * 100

  if (percent < 10) return `${percent.toFixed(1)}%`
  if (percent < 1000) return `${Math.round(percent)}%`

  return `${Math.round(percent).toLocaleString()}%`
}

export function CanvasZoomMenu() {
  const { viewportSize, viewTransform } = useEditorCanvasView()
  const { fitArtboardToViewport, setViewTransform } = useEditorCanvasActions()
  const zoom = formatZoomPercent(viewTransform.scale)

  const zoomToScale = (scale: number) => {
    if (viewportSize.width <= 0 || viewportSize.height <= 0) return

    setViewTransform(
      getZoomedViewTransform(
        viewTransform,
        {
          x: viewportSize.width / 2,
          y: viewportSize.height / 2,
        },
        scale
      )
    )
  }

  const zoomBy = (factor: number) => {
    zoomToScale(viewTransform.scale * factor)
  }

  const activePreset = ZOOM_PRESETS.find(
    (preset) => Math.abs(viewTransform.scale - preset.scale) < 0.005
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="tabular-nums" />}
      >
        <span>Canvas {zoom}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-64"
      >
        <DropdownMenuItem
          closeOnClick
          onClick={() => zoomBy(WORKSPACE_ZOOM_STEP)}
          icon={<HugeiconsIcon icon={ZoomInAreaIcon} />}
          text="Zoom in"
          shortcut="⌘+"
        />
        <DropdownMenuItem
          closeOnClick
          onClick={() => zoomBy(1 / WORKSPACE_ZOOM_STEP)}
          icon={<HugeiconsIcon icon={ZoomOutAreaIcon} />}
          text="Zoom out"
          shortcut="⌘−"
        />
        <DropdownMenuItem
          closeOnClick
          onClick={fitArtboardToViewport}
          icon={<HugeiconsIcon icon={FitToScreenIcon} />}
          text="Zoom to fit"
          shortcut="⇧1"
        />
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={activePreset ? String(activePreset.scale) : ""}
          onValueChange={(value) => zoomToScale(Number(value))}
        >
          {ZOOM_PRESETS.map((preset) => (
            <DropdownMenuRadioItem
              key={preset.scale}
              value={String(preset.scale)}
              closeOnClick
              text={preset.label}
              shortcut={preset.shortcut}
            />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
