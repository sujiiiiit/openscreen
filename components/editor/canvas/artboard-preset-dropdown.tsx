"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  AspectRatioIcon,
  RectangularIcon,
  SquareIcon,
} from "@hugeicons/core-free-icons"

import {
  useEditorCanvasActions,
  useEditorCanvasArtboard,
  useEditorCanvasMedia,
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
  AUTO_ARTBOARD_PRESET_ID,
  resolveAutoArtboard,
  resolveAutoSourceDims,
  type ArtboardPresetId,
  type FixedArtboardPresetId,
} from "@/lib/editor-canvas"

// Landscape rectangle for Wide; the same rectangle rotated 90° reads as the
// portrait-orientation presets (Vertical, Portrait); square for the rest.
const PRESET_ICONS: Record<
  FixedArtboardPresetId,
  { icon: typeof SquareIcon; className?: string }
> = {
  wide: { icon: RectangularIcon },
  vertical: { icon: RectangularIcon, className: "rotate-90" },
  portrait: { icon: RectangularIcon, className: "rotate-90" },
  standard: { icon: SquareIcon },
  square: { icon: SquareIcon },
}

// The Auto row resolves what Auto would apply right now — the screen
// recording's source size, else the on-canvas video's intrinsic size
// (imported videos), else the Wide fallback. Shown even while a fixed preset
// is active, so the menu reads as the concrete size Auto would apply rather
// than the abstract "Match source". Same chain `setArtboardPreset` applies.
//
// Lives in its own component rendered inside `DropdownMenuContent` (unmounted
// while the menu is closed), so the `videos` subscription — which churns on
// every canvas video edit — only re-renders this row while the menu is
// actually open, never the closed titlebar control.
function AutoArtboardRadioItem() {
  const { sourceVideoDims } = useEditorCanvasArtboard()
  const { videos } = useEditorCanvasMedia()
  const autoSize = resolveAutoArtboard(
    resolveAutoSourceDims(sourceVideoDims, videos)
  )
  return (
    <DropdownMenuRadioItem
      value={AUTO_ARTBOARD_PRESET_ID}
      closeOnClick
      icon={<HugeiconsIcon icon={AspectRatioIcon} />}
      text="Auto"
      subtext={`${autoSize.width} × ${autoSize.height}`}
    />
  )
}

export function ArtboardPresetDropdown() {
  const { artboard } = useEditorCanvasArtboard()
  const { setArtboardPreset } = useEditorCanvasActions()
  const isAuto = artboard.presetId === AUTO_ARTBOARD_PRESET_ID
  const fixedPreset = !isAuto
    ? ARTBOARD_PRESETS.find((preset) => preset.id === artboard.presetId)
    : null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        <HugeiconsIcon icon={AspectRatioIcon} />
        <span>{isAuto ? "Auto" : (fixedPreset?.label ?? "Wide")}</span>
        <span className="text-muted-foreground">
          {isAuto
            ? `${artboard.width} × ${artboard.height}`
            : (fixedPreset?.ratioLabel ?? "16:9")}
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
          <AutoArtboardRadioItem key={AUTO_ARTBOARD_PRESET_ID} />
          {ARTBOARD_PRESETS.map((preset) => (
            <DropdownMenuRadioItem
              key={preset.id}
              value={preset.id}
              closeOnClick
              icon={
                <HugeiconsIcon
                  icon={PRESET_ICONS[preset.id].icon}
                  className={PRESET_ICONS[preset.id].className}
                />
              }
              text={preset.label}
              subtext={preset.ratioLabel}
            />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
