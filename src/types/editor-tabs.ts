import type { ReactNode } from "react"

export const TAB_IDS = [
  "background",
  "cursor",
  "zoom",
  "video",
  "subtitle",
  "audio",
] as const

export type TabId = (typeof TAB_IDS)[number]

export type TabItem = {
  id: TabId
  label: string
  icon: ReactNode
  content: ReactNode
}
