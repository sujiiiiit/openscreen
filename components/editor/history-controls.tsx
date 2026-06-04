"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import { Redo03Icon, Undo03Icon } from "@hugeicons/core-free-icons"

import { useEditorHistory } from "@/components/editor/canvas/provider"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function HistoryControls({ className }: { className?: string }) {
  const { canUndo, canRedo, undo, redo } = useEditorHistory()

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={(props) => (
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              aria-label="Undo"
              disabled={!canUndo}
              onClick={undo}
              className={cn("rounded-md", className)}
            >
              <HugeiconsIcon icon={Undo03Icon} />
            </Button>
          )}
        />
        <TooltipContent side="bottom">
          Undo
          <kbd
            data-slot="kbd"
            className="ml-1 bg-background/15 px-1.5 py-0.5 font-sans text-[10px] text-background"
          >
            ⌘Z
          </kbd>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={(props) => (
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              aria-label="Redo"
              disabled={!canRedo}
              onClick={redo}
              className={cn("rounded-md", className)}
            >
              <HugeiconsIcon icon={Redo03Icon} />
            </Button>
          )}
        />
        <TooltipContent side="bottom">
          Redo
          <kbd
            data-slot="kbd"
            className="ml-1 bg-background/15 px-1.5 py-0.5 font-sans text-[10px] text-background"
          >
            ⇧⌘Z
          </kbd>
        </TooltipContent>
      </Tooltip>
    </>
  )
}
