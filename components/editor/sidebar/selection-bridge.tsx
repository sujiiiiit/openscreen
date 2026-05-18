"use client"

import { useEffect, useRef } from "react"

import { useEditorCanvasMedia } from "@/components/editor/canvas/provider"
import { useSidebarTabsContext } from "@/components/editor/sidebar/tabs-provider"

/**
 * Routes every canvas/timeline selection of a video to the sidebar's "Video"
 * tab and opens the sidebar if it's collapsed. Mounted as a sibling effect —
 * no DOM output — so it does not couple the sidebar UI to the canvas state.
 *
 * Deselection (selectedItemId → null) intentionally does NOT change the tab
 * back; the user keeps the panel they were last working in. This matches the
 * agreed UX: "selection on canvas triggers Video tab; deselect leaves tab as-is".
 */
export function SidebarSelectionBridge() {
  const { selectedItemId } = useEditorCanvasMedia()
  const { activeTab, selectTab, open } = useSidebarTabsContext()
  const lastSelectedRef = useRef<string | null>(null)
  // `selectTab` toggles `isOpen` when called with the already-active tab.
  // Reading from refs avoids re-running this effect every time tab state
  // changes — we only want a fresh decision when *selection* changes.
  const activeTabRef = useRef(activeTab)
  const selectTabRef = useRef(selectTab)
  const openRef = useRef(open)

  useEffect(() => {
    activeTabRef.current = activeTab
  }, [activeTab])
  useEffect(() => {
    selectTabRef.current = selectTab
  }, [selectTab])
  useEffect(() => {
    openRef.current = open
  }, [open])

  useEffect(() => {
    const previous = lastSelectedRef.current
    lastSelectedRef.current = selectedItemId

    if (selectedItemId === null) return
    if (selectedItemId === previous) return

    if (activeTabRef.current === "video") {
      // Same tab — `selectTab("video")` would close the sidebar; call `open()`
      // instead to ensure the panel is visible without toggling state.
      openRef.current()
      return
    }
    selectTabRef.current("video")
  }, [selectedItemId])

  return null
}
