"use client"

import { useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { FileUploadIcon } from "@hugeicons/core-free-icons"

import {
  useEditorCanvasActions,
  useEditorCanvasMedia,
} from "@/components/editor/canvas/provider"
import { Button } from "@/components/ui/button"

export function BackgroundPanel() {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const { addVideoFile } = useEditorCanvasActions()
  const { importError, selectedVideo, videos } = useEditorCanvasMedia()
  const latestVideo = videos.at(-1) ?? null
  const visibleVideo = selectedVideo ?? latestVideo

  const handleVideoChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ""

    if (!file) return

    setIsAdding(true)
    try {
      await addVideoFile(file)
    } finally {
      setIsAdding(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="sr-only"
        onChange={handleVideoChange}
      />
      <Button
        type="button"
        variant="outline"
        disabled={isAdding}
        onClick={() => inputRef.current?.click()}
        className="w-full justify-start"
      >
        <HugeiconsIcon icon={FileUploadIcon} data-icon="inline-start" />
        {isAdding ? "Adding video" : "Add video"}
      </Button>
      {visibleVideo ? (
        <div className="flex flex-col gap-1 rounded-md border bg-muted/35 p-3">
          <p className="truncate text-xs font-medium">
            {visibleVideo.fileName}
          </p>
          <p className="text-xs text-muted-foreground">
            {visibleVideo.intrinsicWidth} x {visibleVideo.intrinsicHeight}
          </p>
        </div>
      ) : null}
      {importError ? (
        <p className="text-xs text-destructive">{importError}</p>
      ) : null}
    </div>
  )
}
