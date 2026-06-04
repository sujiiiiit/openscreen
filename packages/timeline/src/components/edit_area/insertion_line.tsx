import React, { FC } from 'react';
import { useTimelineClassNames } from '../../interface/class_names';
import { cn } from '../../utils/cn';

interface InsertionLineProps {
  /** Distance from the top */
  top: number;
  /** Whether the insertion line is visible */
  visible: boolean;
}

/**
 * Insertion line component - shows where a dragged row would be inserted.
 */
export const InsertionLine: FC<InsertionLineProps> = ({ top, visible }) => {
  const slots = useTimelineClassNames();
  if (!visible || top < 0) return null;

  return (
    <div
      className={cn('pointer-events-none absolute left-0 right-0 z-[1000] h-0.5 bg-timeline-guide', slots.insertionLine)}
      style={{ top }}
    />
  );
};
