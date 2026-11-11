import type { CSSProperties } from "react"

declare module "react" {
  interface CSSProperties {
    WebkitAppRegion?: "drag" | "no-drag"
  }
}

export const DRAG: CSSProperties = { WebkitAppRegion: "drag" }
export const NO_DRAG: CSSProperties = { WebkitAppRegion: "no-drag" }
