/**
 * Base parameters for an action.
 * @export
 * @interface TimelineAction
 */
export interface TimelineAction {
  /** Action ID */
  id: string;
  /** Action start time */
  start: number;
  /** Action end time */
  end: number;
  /** ID of the effect associated with this action */
  effectId: string;

  /** Whether the action is selected */
  selected?: boolean;
  /** Whether the action is resizable */
  flexible?: boolean;
  /** Whether the action is movable */
  movable?: boolean;
  /** Whether the action is disabled from running */
  disable?: boolean;

  /** Lower bound for the action's start time */
  minStart?: number;
  /** Upper bound for the action's end time */
  maxEnd?: number;

  /** Extra class name applied to the action's root element (merged via tailwind-merge) */
  className?: string;
}

/**
 * Base parameters for a row of actions.
 * @export
 * @interface TimelineRow
 */
export interface TimelineRow {
  /** Row ID */
  id: string;
  /** Actions contained in this row */
  actions: TimelineAction[];
  /** Custom row height */
  rowHeight?: number;
  /** Whether the row is selected */
  selected?: boolean;
  /** Extra class names applied to the row */
  classNames?: string[];
}
