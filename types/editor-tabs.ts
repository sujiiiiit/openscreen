import type { ReactNode } from "react"

export type TabId =
  | "background"
  | "cursor"
  | "zoom"
  | "video"
  | "subtitle"
  | "audio"

export type TabItem = {
  id: TabId
  label: string
  icon: ReactNode
  content: ReactNode
}
