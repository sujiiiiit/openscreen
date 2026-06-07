"use client"

import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  Folder02Icon,
  MaximizeScreenIcon,
  MinusSignIcon,
  Square01Icon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { DRAG, NO_DRAG } from "@/lib/window-drag"
import { useProject } from "@/components/editor/project/provider"
import { HistoryControls } from "@/components/editor/history-controls"
import { SaveStatusIndicator } from "@/components/editor/save-status-indicator"
import { TitleBarPreviewButton } from "@/components/editor/title-bar-preview-button"
import { TitleBarExportButton } from "@/components/editor/title-bar-export-button"
import { TitleBarRendererMenu } from "@/components/editor/title-bar-renderer-menu"

export function Titlebar() {
  const [platform, setPlatform] = useState<NodeJS.Platform | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)
  const [isFullScreen, setIsFullScreen] = useState(false)
  const { openPicker, project } = useProject()

  useEffect(() => {
    let cancelled = false
    void window.api?.window.getState().then((state) => {
      if (cancelled) return
      setPlatform(state.platform)
      setIsMaximized(state.isMaximized)
      setIsFullScreen(state.isFullScreen)
    })
    const unsubscribe = window.api?.window.onStateChanged((state) => {
      setIsMaximized(state.isMaximized)
      setIsFullScreen(state.isFullScreen)
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  const isMac = platform === "darwin"
  // Render the spacer/buttons only once we know the platform, so we don't
  // briefly flash a Win/Linux control cluster on macOS while getState() is in
  // flight. In macOS fullscreen, AppKit hides the traffic lights, so drop the
  // reserved gap and let the header reclaim the width.
  const showWindowControls = platform !== null && !isMac
  const showMacSpacer = isMac && !isFullScreen

  return (
    <div
      className="relative flex h-11 w-full shrink-0 items-stretch border-b border-border bg-background select-none"
      style={DRAG}
    >
      {showMacSpacer && <div className="h-10 w-20 shrink-0" />}

      {project ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2">
          <div className="pointer-events-auto" style={NO_DRAG}>
            <SaveStatusIndicator />
          </div>
          <span className="max-w-[40ch] truncate text-sm text-foreground">
            {project.name}
            <span className="text-muted-foreground/70">
              .openscreen
            </span>
          </span>
        </div>
      ) : null}

      <div className="flex items-center gap-1 pr-2 pl-5" style={NO_DRAG}>
        <Tooltip>
          <TooltipTrigger
            render={(props) => (
              <Button
                {...props}
                variant="ghost"
                size="icon-sm"
                aria-label="Open project"
                className="rounded-md"
                onClick={() => {
                  void openPicker()
                }}
              >
                <HugeiconsIcon icon={Folder02Icon} />
              </Button>
            )}
          />
          <TooltipContent side="bottom">Open project</TooltipContent>
        </Tooltip>
        <HistoryControls />
      </div>

      <div
        className="ml-auto flex items-center gap-2 pr-2 pl-2"
        style={NO_DRAG}
      >
        <TitleBarRendererMenu />
        <TitleBarPreviewButton />
        <TitleBarExportButton />
      </div>

      {showWindowControls && <WindowControls isMaximized={isMaximized} />}
    </div>
  )
}

function WindowControls({ isMaximized }: { isMaximized: boolean }) {
  return (
    <div className="flex items-stretch" style={NO_DRAG}>
      <TitlebarControlButton
        ariaLabel="Minimize"
        onClick={() => window.api?.window.minimize()}
      >
        <HugeiconsIcon icon={MinusSignIcon} className="size-3.5" />
      </TitlebarControlButton>
      <TitlebarControlButton
        ariaLabel={isMaximized ? "Restore" : "Maximize"}
        onClick={() => window.api?.window.maximize()}
      >
        <HugeiconsIcon
          icon={isMaximized ? Square01Icon : MaximizeScreenIcon}
          className="size-3.5"
        />
      </TitlebarControlButton>
      <TitlebarControlButton
        ariaLabel="Close"
        onClick={() => window.api?.window.close()}
        variant="close"
      >
        <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
      </TitlebarControlButton>
    </div>
  )
}

function TitlebarControlButton({
  children,
  onClick,
  ariaLabel,
  variant = "default",
}: {
  children: React.ReactNode
  onClick: () => void
  ariaLabel: string
  variant?: "default" | "close"
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(
        "flex h-10 w-11 items-center justify-center text-foreground/70 transition-colors hover:text-foreground",
        variant === "close"
          ? "hover:bg-destructive hover:text-white"
          : "hover:bg-muted"
      )}
    >
      {children}
    </button>
  )
}
