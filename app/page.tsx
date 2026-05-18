"use client"

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Titlebar } from "@/components/ui/titlebar"
import { EditorCanvasProvider } from "@/components/editor/canvas/provider"
import { ProjectProvider } from "@/components/editor/project/provider"
import { SidebarTabsProvider } from "@/components/editor/sidebar/tabs-provider"
import EditorSidebar from "@/components/editor/sidebar"
import EditorMain from "@/components/editor/main"
import EditorFooter from "@/components/editor/footer"

export default function Page() {
  return (
    <TooltipProvider>
      <ProjectProvider>
        <EditorCanvasProvider>
          <SidebarTabsProvider>
            <div className="flex h-dvh w-dvw flex-col overflow-hidden">
              <Titlebar />
              <div className="min-h-0 flex-1">
                <ResizablePanelGroup
                  id="editor-root-layout"
                  orientation="vertical"
                >
                  <ResizablePanel
                    id="editor-workspace-panel"
                    defaultSize="69%"
                    minSize="260px"
                    style={{ overflow: "hidden" }}
                  >
                    <section className="flex h-full min-h-0 flex-row overflow-hidden">
                      <EditorSidebar />
                      <EditorMain />
                    </section>
                  </ResizablePanel>
                  <ResizableHandle aria-label="Resize workspace and timeline" />
                  <ResizablePanel
                    id="editor-timeline-panel"
                    defaultSize="31%"
                    minSize="140px"
                    maxSize="60%"
                    style={{ overflow: "hidden" }}
                  >
                    <EditorFooter />
                  </ResizablePanel>
                </ResizablePanelGroup>
              </div>
            </div>
          </SidebarTabsProvider>
        </EditorCanvasProvider>
      </ProjectProvider>
    </TooltipProvider>
  )
}
