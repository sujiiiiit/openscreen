"use client"

import { useId, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { FileUploadIcon } from "@hugeicons/core-free-icons"

import {
  useEditorCanvasActions,
  useEditorCanvasMedia,
} from "@/components/editor/canvas/provider"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Tabs,
  TabsContent,
  TabsContents,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { WallpaperGrid } from "@/components/editor/background/wallpaper-grid"
import { ColorGrid } from "@/components/editor/background/color-grid"

const BACKGROUND_TABS = [
  { value: "wallpaper", label: "Wallpaper" },
  { value: "color", label: "Color" },
  { value: "gradient", label: "Gradient" },
] as const

export function BackgroundPanel() {
  const switchId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [enabled, setEnabled] = useState(true)
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
    <section className="flex w-full flex-col gap-4">
      <header className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold select-none">Background</h3>
          <Switch
            id={switchId}
            size="sm"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
        <p className="text-xs text-muted-foreground select-none">
          Adjust canvas fill, gradients, and overlays for your recording surface.
        </p>
      </header>
      <Tabs defaultValue="wallpaper">
        <TabsList aria-label="Background style" className="justify-start gap-1">
          {BACKGROUND_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContents className="min-h-24">
          <TabsContent value="wallpaper">
            <WallpaperGrid />
          </TabsContent>
          <TabsContent value="gradient">
            <p className="text-xs text-muted-foreground">
              Gradient options coming soon.
            </p>
          </TabsContent>
          <TabsContent value="color">
            <ColorGrid />
          </TabsContent>
        </TabsContents>
      </Tabs>
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
    </section>
  )
}
