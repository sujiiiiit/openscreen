"use client"

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Titlebar } from "@/components/ui/titlebar"
import { EditorCanvasProvider } from "@/components/editor/canvas/provider"
import EditorSidebar from "@/components/editor/sidebar"
import EditorMain from "@/components/editor/main"
import EditorFooter from "@/components/editor/footer"

export default function Page() {
  return (
    <TooltipProvider>
      <EditorCanvasProvider>
        <div className="flex h-dvh w-dvw flex-col overflow-hidden">
          <Titlebar />
          <div className="min-h-0 flex-1">
            <ResizablePanelGroup orientation="vertical">
              <ResizablePanel>
                <section className="flex h-full flex-row">
                  <EditorSidebar />
                  <EditorMain />
                </section>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={31} minSize={30} maxSize={60}>
                <EditorFooter />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </div>
      </EditorCanvasProvider>
    </TooltipProvider>
  )
}
