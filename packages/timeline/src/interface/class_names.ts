import { createContext, useContext } from 'react';

export interface TimelineSlotClassNames {
  /** <Timeline> root div */
  root?: string;
  /** <TimeArea> ruler container */
  timeArea?: string;
  /** Individual tick */
  timeUnit?: string;
  /** Major tick */
  timeUnitBig?: string;
  /** Numeric label rendered on major ticks */
  timeUnitScale?: string;
  /** Interactive overlay across the time area */
  timeAreaInteract?: string;
  /** <EditArea> container */
  editArea?: string;
  /** Each row's outer div (in addition to per-row TimelineRow.classNames) */
  editRow?: string;
  /** Row drag handle */
  editRowDragHandle?: string;
  /** Placeholder row shown during a row drag */
  editRowPlaceholder?: string;
  /** Per-action root (in addition to per-action TimelineAction.className) */
  action?: string;
  /** Playhead vertical line body */
  cursor?: string;
  /** Playhead diamond on top */
  cursorTop?: string;
  /** Hit area around the playhead */
  cursorArea?: string;
  /** Container for snap guide lines */
  dragLineContainer?: string;
  /** Individual snap guide line */
  dragLine?: string;
  /** Row reorder drag overlay */
  dragPreview?: string;
  /** Row insertion indicator */
  insertionLine?: string;
}

export const TimelineClassNamesContext = createContext<TimelineSlotClassNames>({});

export const useTimelineClassNames = () => useContext(TimelineClassNamesContext);
