'use client'

import { useEffect, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Cancel01Icon,
  Folder02Icon,
  MaximizeScreenIcon,
  MinusSignIcon,
  Square01Icon,
} from '@hugeicons/core-free-icons'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { DRAG, NO_DRAG } from '@/lib/window-drag'
import { useProject } from '@/components/editor/project/provider'

export function Titlebar() {
  const [platform, setPlatform] = useState<NodeJS.Platform | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)
  const [isFullScreen, setIsFullScreen] = useState(false)
  const { openPicker } = useProject()

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

  const isMac = platform === 'darwin'
  // Render the spacer/buttons only once we know the platform, so we don't
  // briefly flash a Win/Linux control cluster on macOS while getState() is in
  // flight. In macOS fullscreen, AppKit hides the traffic lights, so drop the
  // reserved gap and let the header reclaim the width.
  const showWindowControls = platform !== null && !isMac
  const showMacSpacer = isMac && !isFullScreen

  return (
    <div
      className="bg-background border-border flex h-11 w-full shrink-0 items-stretch border-b select-none"
      style={DRAG}
    >
      {showMacSpacer && <div className="h-10 w-20 shrink-0" />}

     

      <div className="flex items-center gap-1 pl-5 pr-2" style={NO_DRAG}>
        <Tooltip>
          <TooltipTrigger
            render={(props) => (
              <Button
                {...props}
                variant="ghost"
                size="icon"
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
        ariaLabel={isMaximized ? 'Restore' : 'Maximize'}
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
  variant = 'default',
}: {
  children: React.ReactNode
  onClick: () => void
  ariaLabel: string
  variant?: 'default' | 'close'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(
        'text-foreground/70 hover:text-foreground flex h-10 w-11 items-center justify-center transition-colors',
        variant === 'close'
          ? 'hover:bg-destructive hover:text-white'
          : 'hover:bg-muted',
      )}
    >
      {children}
    </button>
  )
}
