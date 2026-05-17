"use client";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Titlebar } from "@/components/ui/titlebar";
import EditorSidebar from "@/components/editor/sidebar";
import EditorMain from "@/components/editor/main";
import EditorFooter from "@/components/editor/footer";

export default function Page() {
  return (
    <TooltipProvider>
      <div className="h-dvh w-dvw overflow-hidden flex flex-col">
        <Titlebar />
        <div className="flex-1 min-h-0">
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
    </TooltipProvider>
  );
}
