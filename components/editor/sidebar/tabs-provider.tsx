"use client"

import { createContext, useContext, type ReactNode } from "react"

import { useSidebarTabs } from "@/hooks/use-sidebar-tabs"
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
