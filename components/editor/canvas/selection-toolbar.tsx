"use client"

import { forwardRef, memo, type MouseEventHandler } from "react"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import {
  CopyPlusIcon,
  Delete02Icon,
  SquareLock01Icon,
  SquareUnlock01Icon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { CanvasVideoItem } from "@/types/editor-canvas"

type SelectionToolbarProps = {
  selectedVideo: CanvasVideoItem | null
  onToggleLock: (id: string, locked: boolean) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
}

type SelectionToolbarButtonProps = {
  label: string
  icon: IconSvgElement
  shortcut?: string
  onClick?: MouseEventHandler<HTMLButtonElement>
  active?: boolean
  disabled?: boolean
  destructive?: boolean
}

function SelectionToolbarButton({
  label,
  icon,
  shortcut,
  onClick,
  active = false,
  disabled = false,
  destructive = false,
}: SelectionToolbarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant={destructive ? "destructive-ghost" : "ghost"}
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className={cn(
              "rounded-full text-foreground",
              active && "bg-primary/15 text-primary hover:bg-primary/20"
            )}
          />
        }
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} color="currentColor" />
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
        {shortcut ? (
          <kbd
            data-slot="kbd"
            className="ml-1 bg-background/15 px-1.5 py-0.5 font-sans text-[10px] text-background"
          >
            {shortcut}
          </kbd>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}

export const SelectionToolbar = memo(
  forwardRef<HTMLDivElement, SelectionToolbarProps>(
    ({ selectedVideo, onToggleLock, onDuplicate, onDelete }, ref) => {
      if (!selectedVideo) return null

      return (
        <div
          ref={ref}
          className="absolute top-0 left-0 z-50 flex h-11 items-center gap-1 rounded-full border border-border/70 bg-popover px-2 shadow-xl ring-1 ring-border/40 will-change-transform"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <SelectionToolbarButton
            label={selectedVideo.locked ? "Unlock" : "Lock"}
            icon={selectedVideo.locked ? SquareLock01Icon : SquareUnlock01Icon}
            shortcut="⇧⌘L"
            active={selectedVideo.locked}
            onClick={() =>
              onToggleLock(selectedVideo.id, !selectedVideo.locked)
            }
          />
          {!selectedVideo.locked ? (
            <>
              <SelectionToolbarButton
                label="Duplicate"
                icon={CopyPlusIcon}
                shortcut="⌘D"
                onClick={() => onDuplicate(selectedVideo.id)}
              />
              <SelectionToolbarButton
                label="Delete"
                icon={Delete02Icon}
                shortcut="⌫"
                destructive
                onClick={() => onDelete(selectedVideo.id)}
              />
            </>
          ) : null}
        </div>
      )
    }
  )
)

SelectionToolbar.displayName = "SelectionToolbar"
