import type { ReactNode } from "react";

export type TabId =
  | "background"
  | "cursor"
  | "video"
  | "subtitle"
  | "audio"
  | "transition"
  | "assets";

export type TabItem = {
  id: TabId;
  label: string;
  icon: ReactNode;
  content: ReactNode;
};
