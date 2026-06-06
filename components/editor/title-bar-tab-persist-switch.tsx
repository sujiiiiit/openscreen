"use client"

import { useEffect, useState } from "react"

import {
  getSidebarTabPersistEnabled,
  setSidebarTabPersistEnabled,
} from "@/components/editor/sidebar/tab-preference"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { NO_DRAG } from "@/lib/window-drag"

/**
 * Titlebar switch toggling sidebar tab persistence ("Remember tab"). ON
 * (default): the active sidebar tab + open/collapsed flag are written to
 * `localStorage` and restored on launch. OFF: nothing is written and the
 * stored entry is cleared, so the next launch opens the defaults. The
 * `SidebarTabsProvider` listens for the change event and starts/stops
 * persisting immediately — no reload needed.
 */
export function TitleBarTabPersistSwitch() {
  // SSR has no localStorage, so the first client render must match the
  // server-rendered default; the persisted value is synced in after
  // hydration (one benign flip when the user saved a non-default).
  const [enabled, setEnabled] = useState(true)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot post-hydration sync from localStorage
    setEnabled(getSidebarTabPersistEnabled())
  }, [])
  const applyEnabled = (value: boolean) => {
    setEnabled(value)
    setSidebarTabPersistEnabled(value)
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
            <span>Remember tab</span>
            <Switch
              size="sm"
              checked={enabled}
              onCheckedChange={applyEnabled}
              aria-label="Remember sidebar tab"
            />
          </label>
        )}
      />
      <TooltipContent side="bottom">
        {enabled
          ? "Reopens the last sidebar tab on launch"
          : "Sidebar opens on the Background tab each launch"}
      </TooltipContent>
    </Tooltip>
  )
}
