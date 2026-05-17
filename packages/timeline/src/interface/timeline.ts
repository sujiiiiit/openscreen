import { Emitter, EventTypes, ITimelineEngine } from '@openscreen/timeline-engine';
import React, { ReactNode } from 'react';
import { OnScrollParams } from 'react-virtualized';
import { TimelineAction, TimelineRow } from '@openscreen/timeline-engine';
import { TimelineEffect } from '@openscreen/timeline-engine';
import { TimelineSlotClassNames } from './class_names';

export interface EditData {
  /**
   * @description Timeline editor data
   */
  editorData: TimelineRow[];
  /**
   * @description Map of timeline action effects
   */
  effects: Record<string, TimelineEffect>;
  /**
   * @description Range covered by a single scale tick (> 0)
   * @default 1
   */
  scale?: number;
  /**
   * @description Minimum number of scale ticks (>= 1)
   * @default 20
   */
  minScaleCount?: number;
  /**
   * @description Maximum number of scale ticks (>= minScaleCount)
   * @default Infinity
   */
  maxScaleCount?: number;
  /**
   * @description Number of subdivisions per scale tick (positive integer)
   * @default 10
   */
  scaleSplitCount?: number;
  /**
   * @description Display width of a single scale tick in pixels (> 0)
   * @default 160
   */
  scaleWidth?: number;
  /**
   * @description Left offset where the scale starts in pixels (>= 0)
   * @default 20
   */
  startLeft?: number;
  /**
   * @description Default height of each edit row in pixels (> 0)
   * @default 32
   */
  rowHeight?: number;
  /**
   * @description Whether to snap movement to the grid
   * @default false
   */
  gridSnap?: boolean;
  /**
   * @description Whether to enable drag guide-line snapping
   * @default false
   */
  dragLine?: boolean;
  /**
   * @description Whether to hide the cursor
   * @default false
   */
  hideCursor?: boolean;
  /**
   * @description Disable dragging across all action regions
   * @default false
   */
  disableDrag?: boolean;
  /**
   * @description Disable dragging across all rows
   * @default false
   */
  enableRowDrag?: boolean;
  /**
   * @description Timeline engine instance; falls back to the built-in engine when omitted
   */
  engine?: ITimelineEngine;
  /**
   * @description Custom renderer for the action region
   */
  getActionRender?: (action: TimelineAction, row: TimelineRow) => ReactNode;
  /**
   * @description Custom renderer for the scale ticks
   */
  getScaleRender?: (scale: number) => ReactNode;
  /**
   * @description Move start callback
   */
  onActionMoveStart?: (params: { action: TimelineAction; row: TimelineRow }) => void;
  /**
   * @description Move callback (return false to cancel the move)
   */
  onActionMoving?: (params: { action: TimelineAction; row: TimelineRow; start: number; end: number }) => void | boolean;
  /**
   * @description Move end callback (return false to suppress onChange)
   */
  onActionMoveEnd?: (params: { action: TimelineAction; row: TimelineRow; start: number; end: number }) => void;
  /**
   * @description Resize start callback
   */
  onActionResizeStart?: (params: { action: TimelineAction; row: TimelineRow; dir: 'right' | 'left' }) => void;
  /**
   * @description Resize callback (return false to cancel the resize)
   */
  onActionResizing?: (params: { action: TimelineAction; row: TimelineRow; start: number; end: number; dir: 'right' | 'left' }) => void | boolean;
  /**
   * @description Resize end callback (return false to suppress onChange)
   */
  onActionResizeEnd?: (params: { action: TimelineAction; row: TimelineRow; start: number; end: number; dir: 'right' | 'left' }) => void;
  /**
   * @description Row click callback
   */
  onClickRow?: (
    e: React.MouseEvent<HTMLElement, MouseEvent>,
    param: {
      row: TimelineRow;
      time: number;
    },
  ) => void;
  /**
   * @description Action click callback
   */
  onClickAction?: (
    e: React.MouseEvent<HTMLElement, MouseEvent>,
    param: {
      action: TimelineAction;
      row: TimelineRow;
      time: number;
    },
  ) => void;
  /**
   * @description Action click callback (not invoked when a drag is triggered)
   */
  onClickActionOnly?: (
    e: React.MouseEvent<HTMLElement, MouseEvent>,
    param: {
      action: TimelineAction;
      row: TimelineRow;
      time: number;
    },
  ) => void;
  /**
   * @description Row double-click callback
   */
  onDoubleClickRow?: (
    e: React.MouseEvent<HTMLElement, MouseEvent>,
    param: {
      row: TimelineRow;
      time: number;
    },
  ) => void;
  /**
   * @description Action double-click callback
   */
  onDoubleClickAction?: (
    e: React.MouseEvent<HTMLElement, MouseEvent>,
    param: {
      action: TimelineAction;
      row: TimelineRow;
      time: number;
    },
  ) => void;
  /**
   * @description Row context-menu callback
   */
  onContextMenuRow?: (
    e: React.MouseEvent<HTMLElement, MouseEvent>,
    param: {
      row: TimelineRow;
      time: number;
    },
  ) => void;
  /**
   * @description Action context-menu callback
   */
  onContextMenuAction?: (
    e: React.MouseEvent<HTMLElement, MouseEvent>,
    param: {
      action: TimelineAction;
      row: TimelineRow;
      time: number;
    },
  ) => void;
  /**
   * @description Returns the list of action IDs whose guide lines should be displayed. Computed at move/resize start. By default returns all actions except the one currently being moved.
   */
  getAssistDragLineActionIds?: (params: { action: TimelineAction; editorData: TimelineRow[]; row: TimelineRow }) => string[];
  /**
   * @description Cursor drag start event
   */
  onCursorDragStart?: (time: number) => void;
  /**
   * @description Cursor drag end event
   */
  onCursorDragEnd?: (time: number) => void;
  /**
   * @description Cursor drag event
   */
  onCursorDrag?: (time: number) => void;
  /**
   * @description Time area click event; returning false prevents the time from being set
   */
  onClickTimeArea?: (time: number, e: React.MouseEvent<HTMLDivElement, MouseEvent>) => boolean | undefined;
  /**
   * @description Row drag start callback
   * @param params row is the row being dragged
   */
  onRowDragStart?: (params: { row: TimelineRow }) => void;
  /**
   * @description Row drag end callback
   * @param params row is the dragged row; editorData is the new row order after the drag
   * @returns
   */
  onRowDragEnd?: (params: { row: TimelineRow; editorData: TimelineRow[] }) => void;
}

export interface TimelineState {
  /** DOM node */
  target: HTMLElement | null;
  /** Engine event listener */
  listener: Emitter<EventTypes>;
  /** Whether playback is in progress */
  isPlaying: boolean;
  /** Whether playback is paused */
  isPaused: boolean;
  /** Set the current playback time */
  setTime: (time: number) => void;
  /** Get the current playback time */
  getTime: () => number;
  /** Set the playback rate */
  setPlayRate: (rate: number) => void;
  /** Get the playback rate */
  getPlayRate: () => number;
  /** Re-render the current frame */
  reRender: () => void;
  /** Start playback */
  play: (param: {
    /** Defaults to playing from start to end; takes precedence over autoEnd */
    toTime?: number;
    /** Whether to stop automatically once playback completes */
    autoEnd?: boolean;
    /** List of action IDs to play; defaults to all when omitted */
    runActionIds?: string[];
  }) => boolean;
  /** Pause playback */
  pause: () => void;
  /** Set scrollLeft */
  setScrollLeft: (val: number) => void;
  /** Set scrollTop */
  setScrollTop: (val: number) => void;
}

/**
 * Animation editor props.
 * @export
 * @interface TimelineProp
 */
export interface TimelineEditor extends EditData {
  /**
   * @description Vertical scroll offset for the edit area (use ref.setScrollTop instead)
   * @deprecated
   */
  scrollTop?: number;
  /**
   * @description Scroll callback for the edit area (used to keep scrolling in sync with the rows)
   */
  onScroll?: (params: OnScrollParams) => void;
  /**
   * @description Whether to enable auto-scroll while dragging
   * @default false
   */
  autoScroll?: boolean;
  /**
   * @description Custom timeline style
   */
  style?: React.CSSProperties;
  /**
   * @description Class name applied to the timeline root element (merged via tailwind-merge)
   */
  className?: string;
  /**
   * @description Class names for nested slots — each is merged with the default utilities via tailwind-merge so consumer classes win
   */
  classNames?: TimelineSlotClassNames;
  /**
   * @description Whether to automatically re-render (issues an update tick whenever the data or cursor time changes)
   * @default true
   */
  autoReRender?: boolean;
  /**
   * @description Data change callback; fires after an action ends and the data changes (return false to skip the automatic engine sync and reduce overhead)
   */
  onChange?: (editorData: TimelineRow[]) => void | boolean;
}

// Utility type that marks selected properties as required
export type RequiredPick<T, K extends keyof T> = T & { [P in K]-?: T[P] };

export type RequiredEditData = RequiredPick<EditData, 'editorData' | 'effects' | 'scale' | 'scaleSplitCount' | 'scaleWidth' | 'startLeft' | 'minScaleCount' | 'maxScaleCount' | 'rowHeight'>;

export type RequiredTimelineEditor = RequiredPick<TimelineEditor, 'scrollTop'> & RequiredEditData;
