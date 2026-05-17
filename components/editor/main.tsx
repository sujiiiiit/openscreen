"use client"

import dynamic from "next/dynamic"

const EditorWorkspace = dynamic(
  () => import("@/components/editor/canvas/editor-workspace"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
        Loading canvas
      </div>
    ),
  }
)

export default function EditorMain() {
  return (
    <div className="min-w-0 flex-1">
      <EditorWorkspace />
    </div>
  )
}
