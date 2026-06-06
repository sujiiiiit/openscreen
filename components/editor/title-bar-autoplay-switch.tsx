"use client"

import { useEffect, useState } from "react"

import {
  getAutoplayOnOpenEnabled,
  setAutoplayOnOpenEnabled,
} from "@/components/editor/canvas/autoplay-preference"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { NO_DRAG } from "@/lib/window-drag"

/**
 * Titlebar switch toggling autoplay-on-open ("Autoplay"). ON (default):
 * opening a project starts playback once the first video element is ready
 * (see "Autoplay on open" in the canvas provider). OFF: projects open
 * paused. The canvas provider reads the flag at fire time, so the toggle
 * applies to the very next open without a reload.
 */
export function TitleBarAutoplaySwitch() {
  // SSR has no localStorage, so the first client render must match the
  // server-rendered default; the persisted value is synced in after
  // hydration (one benign flip when the user saved a non-default).
  const [enabled, setEnabled] = useState(true)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot post-hydration sync from localStorage
    setEnabled(getAutoplayOnOpenEnabled())
  }, [])
  const applyEnabled = (value: boolean) => {
    setEnabled(value)
    setAutoplayOnOpenEnabled(value)
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <label
            {...props}
            className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground select-none"
            style={NO_DRAG}
          >
            <span>Autoplay</span>
            <Switch
              size="sm"
              checked={enabled}
              onCheckedChange={applyEnabled}
              aria-label="Autoplay on open"
            />
          </label>
        )}
      />
      <TooltipContent side="bottom">
        {enabled
          ? "Starts playback when a project opens"
          : "Projects open paused"}
      </TooltipContent>
    </Tooltip>
  )
}
