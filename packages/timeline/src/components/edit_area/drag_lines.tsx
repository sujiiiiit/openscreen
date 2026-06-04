import React, { FC } from 'react';
import { useTimelineClassNames } from '../../interface/class_names';
import { cn } from '../../utils/cn';

export interface DragLineData {
  isMoving: boolean;
  movePositions: number[];
  assistPositions: number[];
}

export type DragLineProps = DragLineData & { scrollLeft: number };

/** Drag guide lines */
export const DragLines: FC<DragLineProps> = ({ isMoving, movePositions = [], assistPositions = [], scrollLeft }) => {
  const slots = useTimelineClassNames();
  return (
    <div className={cn('absolute top-0 left-0 h-full', slots.dragLineContainer)}>
      {isMoving &&
        movePositions
          .filter((item) => assistPositions.includes(item))
          .map((linePos, index) => (
            <div
              key={index}
              className={cn('absolute top-0 w-0 h-[99%] border-l border-dashed border-timeline-cursor/60', slots.dragLine)}
              style={{ left: linePos - scrollLeft }}
            />
          ))}
    </div>
  );
};
