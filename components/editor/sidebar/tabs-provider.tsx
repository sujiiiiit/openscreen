"use client"

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react"

import { useSidebarTabs } from "@/hooks/use-sidebar-tabs"
import {
  getSidebarTabPersistEnabled,
  readSidebarTabPreference,
  SIDEBAR_TAB_PERSIST_CHANGE_EVENT,
  writeSidebarTabPreference,
} from "@/components/editor/sidebar/tab-preference"
import type { TabId } from "@/types/editor-tabs"

type SidebarTabsContextValue = ReturnType<typeof useSidebarTabs<TabId>>

const SidebarTabsContext = createContext<SidebarTabsContextValue | null>(null)

export function SidebarTabsProvider({
  initialTab = "background",
  defaultOpen = true,
  children,
}: {
  initialTab?: TabId
  defaultOpen?: boolean
  children: ReactNode
}) {
  const value = useSidebarTabs<TabId>(initialTab, { defaultOpen })
  const { activeTab, isOpen, restore } = value
  // SSR has no localStorage, so the first client render must match the
  // prerendered defaults; the stored tab is restored in a one-shot effect.
  const restoredRef = useRef(false)
  // Mirrors the titlebar "Remember tab" switch (kept in sync via the change
  // event below). A ref, not state — it only gates writes, never rendering.
  const persistEnabledRef = useRef(true)
  // Latest state for the change-event listener, which must write the current
  // tab through on re-enable without re-subscribing on every tab change.
  const activeTabRef = useRef(activeTab)
  const isOpenRef = useRef(isOpen)
  useEffect(() => {
    activeTabRef.current = activeTab
  }, [activeTab])
  useEffect(() => {
    isOpenRef.current = isOpen
  }, [isOpen])

  // Persist effect — declared BEFORE the restore effect on purpose. On mount
  // it runs first with `restoredRef` still false and skips, so the pre-restore
  // defaults never clobber the stored value. Every later change (tab select,
  // collapse/expand, selection-bridge routing) writes through while the
  // titlebar switch is on.
  useEffect(() => {
    if (!restoredRef.current) return
    if (!persistEnabledRef.current) return
    writeSidebarTabPreference({ tab: activeTab, isOpen })
  }, [activeTab, isOpen])

  useEffect(() => {
    persistEnabledRef.current = getSidebarTabPersistEnabled()
    if (persistEnabledRef.current) {
      const stored = readSidebarTabPreference()
      if (stored) restore(stored.tab, stored.isOpen)
    }
    restoredRef.current = true
  }, [restore])

  // Titlebar switch sync. On enable, capture the current state immediately so
  // a restart right after toggling restores what the user is looking at; on
  // disable, `setSidebarTabPersistEnabled(false)` already cleared the entry —
  // only the gate ref needs updating.
  useEffect(() => {
    const onPersistChange = () => {
      const enabled = getSidebarTabPersistEnabled()
      persistEnabledRef.current = enabled
      if (enabled) {
        writeSidebarTabPreference({
          tab: activeTabRef.current,
          isOpen: isOpenRef.current,
        })
      }
    }
    window.addEventListener(SIDEBAR_TAB_PERSIST_CHANGE_EVENT, onPersistChange)
    return () =>
      window.removeEventListener(
        SIDEBAR_TAB_PERSIST_CHANGE_EVENT,
        onPersistChange
      )
  }, [])

  return (
    <SidebarTabsContext.Provider value={value}>
      {children}
    </SidebarTabsContext.Provider>
  )
}

export function useSidebarTabsContext(): SidebarTabsContextValue {
  const value = useContext(SidebarTabsContext)
  if (!value) {
    throw new Error(
      "useSidebarTabsContext must be used within a SidebarTabsProvider"
    )
  }
  return value
}
