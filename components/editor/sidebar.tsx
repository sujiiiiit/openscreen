"use client";

import { useMemo } from "react";
import { motion } from "motion/react";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  BackgroundIcon,
  EaseInOutIcon,
  Video01Icon,
  VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { CursorIcon, SubtitleIcon } from "@/components/ui/icons";
import { useSidebarTabs } from "@/hooks/use-sidebar-tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { type TabItem, type TabId } from "@/types/editor-tabs";

function TabContentPlaceholder({ label }: { label: string }) {
  return (
    <div className="text-xs text-muted-foreground">
      {label} content placeholder
    </div>
  );
}

const TAB_ITEMS: TabItem[] = [
  {
    id: "background",
    label: "Background",
    icon: <HugeiconsIcon icon={BackgroundIcon} className="size-4" />,
    content: <TabContentPlaceholder label="Background" />,
  },
  {
    id: "cursor",
    label: "Cursor",
    icon: <CursorIcon className="size-4" />,
    content: <TabContentPlaceholder label="Cursor" />,
  },
  {
    id: "video",
    label: "Video",
    icon: <HugeiconsIcon icon={Video01Icon} className="size-4" />,
    content: <TabContentPlaceholder label="Video" />,
  },
  {
    id: "subtitle",
    label: "Subtitle",
    icon: <SubtitleIcon className="size-4" />,
    content: <TabContentPlaceholder label="Subtitle" />,
  },
  {
    id: "audio",
    label: "Audio",
    icon: <HugeiconsIcon icon={VolumeHighIcon} className="size-4" />,
    content: <TabContentPlaceholder label="Audio" />,
  },
  {
    id: "transition",
    label: "Transition",
    icon: <HugeiconsIcon icon={EaseInOutIcon} className="size-4" />,
    content: <TabContentPlaceholder label="Transition" />,
  },
];

export default function EditorSidebar() {
  const tabs = useMemo(() => TAB_ITEMS, []);
  const { activeTab, selectTab, toggle, isOpen } = useSidebarTabs<TabId>(
    tabs[0].id,
  );
  const activeIndex = tabs.findIndex((item) => item.id === activeTab);
  const safeActiveIndex = activeIndex === -1 ? 0 : activeIndex;

  return (
    <aside className="h-full border-r relative bg-background">
      <div className="flex h-full flex-row">
        <ScrollArea className="h-full p-2">
          <div className="flex flex-col items-center gap-4">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTab;

              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => selectTab(tab.id)}
                  className="group flex w-full flex-col items-center gap-1 outline-none"
                >
                  <span className="relative">
                    {isActive && (
                      <motion.span
                        layoutId="sidebar-tab-indicator"
                        className="absolute inset-0 z-1 rounded-md bg-tertiary"
                        transition={{
                          type: "spring",
                          stiffness: 380,
                          damping: 32,
                        }}
                      />
                    )}
                    <span
                      className={cn(
                        "relative inline-flex size-9 items-center justify-center rounded-md text-foreground transition-colors",
                        isActive
                          ? "z-2 [&_svg]:text-tertiary-foreground"
                          : "group-hover:bg-tertiary group-hover:[&_svg]:text-tertiary-foreground",
                      )}
                    >
                      {tab.icon}
                    </span>
                  </span>
                  <motion.span
                    layout
                    className={"text-[10px] transition-colors select-none"}
                  >
                    {tab.label}
                  </motion.span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
        <motion.div
          className="relative h-full shrink-0"
          animate={{ width: isOpen ? 360 : 0 }}
          initial={false}
          transition={{ type: "spring", stiffness: 260, damping: 32 }}
          style={{ overflow: "hidden" }}
        >
          <motion.div
            className="absolute inset-0 h-full w-90"
            animate={{
              opacity: isOpen ? 1 : 0,
              x: isOpen ? 0 : 24,
            }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
            style={{ pointerEvents: isOpen ? "auto" : "none" }}
          >
            <div className="relative h-full overflow-hidden">
              {tabs.map((tab, index) => {
                const offset = index - safeActiveIndex;
                const isActive = offset === 0;

                return (
                  <motion.div
                    key={tab.id}
                    initial={false}
                    animate="animate"
                    variants={{
                      animate: (value: number) => ({
                        opacity: value === 0 ? 1 : 0,
                        y: value * 36,
                        scale: value === 0 ? 1 : 0.98,
                      }),
                    }}
                    custom={offset}
                    transition={{
                      type: "spring",
                      stiffness: 260,
                      damping: 30,
                    }}
                    className={`absolute inset-0 ${isActive ? "z-10" : "z-0"}`}
                    style={{
                      pointerEvents: isActive && isOpen ? "auto" : "none",
                    }}
                  >
                    <ScrollArea className="w-full h-full">
                      <div className="w-full space-y-6 p-4">{tab.content}</div>
                    </ScrollArea>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        </motion.div>

        <Tooltip>
          <TooltipTrigger
            onClick={toggle}
            aria-label={isOpen ? "Collapse sidebar" : "Expand sidebar"}
            className="absolute top-1/2 -right-3 z-10 -translate-y-1/2 py-4 bg-background border rounded-full outline-0"
          >
            {isOpen ? (
              <HugeiconsIcon icon={ArrowLeft01Icon} className="size-5"/>
            ) : (
              <HugeiconsIcon icon={ArrowRight01Icon} className="size-5"/>
            )}
          </TooltipTrigger>
          <TooltipContent side="right">
            {isOpen ? "Collapse" : "Expand"}
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
