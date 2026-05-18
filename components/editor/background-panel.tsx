"use client"

import { useId, useState } from "react"

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
  const [enabled, setEnabled] = useState(true)

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
    </section>
  )
}
