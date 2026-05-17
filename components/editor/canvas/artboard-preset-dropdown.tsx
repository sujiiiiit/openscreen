"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  AspectRatioIcon,
  Image01Icon,
  SmartPhone01Icon,
  Square01Icon,
  Tablet01Icon,
  Tv01Icon,
} from "@hugeicons/core-free-icons"

import {
  useEditorCanvasActions,
  useEditorCanvasArtboard,
} from "@/components/editor/canvas/provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ARTBOARD_PRESETS,
  type ArtboardPresetId,
  getArtboardPreset,
} from "@/lib/editor-canvas"

const PRESET_ICONS: Record<ArtboardPresetId, typeof Tv01Icon> = {
  wide: Tv01Icon,
  vertical: SmartPhone01Icon,
  portrait: Image01Icon,
  standard: Tablet01Icon,
  square: Square01Icon,
}

export function ArtboardPresetDropdown() {
  const { artboard } = useEditorCanvasArtboard()
  const { setArtboardPreset } = useEditorCanvasActions()
  const selectedPreset = getArtboardPreset(artboard.presetId)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        <HugeiconsIcon icon={AspectRatioIcon} />
        <span>{selectedPreset.label}</span>
        <span className="text-muted-foreground">
          {selectedPreset.ratioLabel}
        </span>
        <HugeiconsIcon icon={ArrowDown01Icon} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64"
      >
        <DropdownMenuRadioGroup
          value={artboard.presetId}
          onValueChange={(value) =>
            setArtboardPreset(value as ArtboardPresetId)
          }
        >
          {ARTBOARD_PRESETS.map((preset) => (
            <DropdownMenuRadioItem
              key={preset.id}
              value={preset.id}
              closeOnClick
              icon={<HugeiconsIcon icon={PRESET_ICONS[preset.id]} />}
              text={preset.label}
              subtext={preset.ratioLabel}
            />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
