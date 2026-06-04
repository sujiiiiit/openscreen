"use client"

import { HugeiconsIcon } from "@hugeicons/react"
import {
  CloudLoadingIcon,
  CloudSavingDone01Icon,
} from "@hugeicons/core-free-icons"

import { useEditorCanvasSaveStatus } from "@/components/editor/canvas/provider"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { Button } from "../ui/button"

const TOOLTIP_LABEL = {
  saving: "Saving changes locally",
  saved: "Changes saved locally",
  error: "Couldn't save changes locally",
} as const

export function SaveStatusIndicator({ className }: { className?: string }) {
  const { status, error } = useEditorCanvasSaveStatus()

  // `idle` means no project is loaded yet — the indicator has nothing
  // meaningful to communicate, so we hide instead of flashing a placeholder.
  if (status === "idle") return null

  const isError = status === "error"
  const icon = status === "saving" ? CloudLoadingIcon : CloudSavingDone01Icon
  const label = isError ? TOOLTIP_LABEL.error : TOOLTIP_LABEL[status]

  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <Button
            {...props}
            variant="ghost"
            size="icon-sm"
            className={cn("rounded-md", className)}
          >
            <HugeiconsIcon
              icon={icon}
              className={cn(
                status === "saving" && "animate-pulse"
              )}
            />
          </Button>
        )}
      />
      <TooltipContent side="bottom">
        {label}
        {isError && error ? (
          <span className="text-muted-foreground/80 block max-w-xs truncate">
            {error}
          </span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}
