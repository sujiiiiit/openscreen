import React, { FC, useEffect, useRef } from 'react';
import { ScrollSync } from 'react-virtualized';
import { useTimelineClassNames } from '../../interface/class_names';
import { CommonProp } from '../../interface/common_prop';
import { cn } from '../../utils/cn';
import { parserPixelToTime, parserTimeToPixel } from '../../utils/deal_data';
import { RowDnd } from '../row_rnd/row_rnd';
import { RowRndApi } from '../row_rnd/row_rnd_interface';

/** Animation timeline component props */
export type CursorProps = CommonProp & {
  /** Horizontal scroll offset from the left */
  scrollLeft: number;
  /** Set the cursor position */
  setCursor: (param: { left?: number; time?: number }) => boolean;
  /** Ref to the timeline area dom node */
  areaRef: React.RefObject<HTMLDivElement | null>;
  /** Adjust scrollLeft by a delta */
  deltaScrollLeft?: (delta: number) => void;
  /** Ref to the scroll sync instance (TODO: temporary workaround for scrollLeft not syncing during drag) */
  scrollSync: React.RefObject<ScrollSync | null>;
};

export const Cursor: FC<CursorProps> = ({
  disableDrag,
  cursorTime,
  setCursor,
  startLeft,
  timelineWidth,
  scaleWidth,
  scale,
  scrollLeft,
  scrollSync,
  areaRef,
  maxScaleCount,
  deltaScrollLeft,
  onCursorDragStart,
  onCursorDrag,
  onCursorDragEnd,
}) => {
  const rowRnd = useRef<RowRndApi>(null);
  const draggingLeft = useRef<undefined | number>(undefined);
  const slots = useTimelineClassNames();

  useEffect(() => {
    if (typeof draggingLeft.current === 'undefined') {
      // When not dragging, update the cursor position from the incoming props
      rowRnd.current?.updateLeft(parserTimeToPixel(cursorTime, { startLeft, scaleWidth, scale }) - scrollLeft);
    }
  }, [cursorTime, startLeft, scaleWidth, scale, scrollLeft]);

  return (
    <RowDnd
      start={startLeft}
      ref={rowRnd}
      parentRef={areaRef}
      bounds={{
        left: 0,
        right: Math.min(timelineWidth, maxScaleCount * scaleWidth + startLeft - scrollLeft),
      }}
      deltaScrollLeft={deltaScrollLeft}
      enableDragging={!disableDrag}
      enableResizing={false}
      onDragStart={() => {
        onCursorDragStart && onCursorDragStart(cursorTime);
        draggingLeft.current = parserTimeToPixel(cursorTime, { startLeft, scaleWidth, scale }) - scrollLeft;
        rowRnd.current?.updateLeft(draggingLeft.current);
      }}
      onDragEnd={() => {
        const time = parserPixelToTime((draggingLeft.current || 0) + scrollLeft, { startLeft, scale, scaleWidth });
        setCursor({ time });
        onCursorDragEnd && onCursorDragEnd(time);
        draggingLeft.current = undefined;
      }}
      onDrag={({ left }, scroll = 0) => {
        const scrollLeft = scrollSync.current?.state.scrollLeft || 0;

        if (!scroll || scrollLeft === 0) {
          // While dragging, clamp left to its minimum value
          if (left < startLeft - scrollLeft) draggingLeft.current = startLeft - scrollLeft;
          else draggingLeft.current = left;
        } else {
          // While auto-scrolling, clamp left to its minimum value
          if ((draggingLeft.current || 0) < startLeft - scrollLeft - scroll) {
            draggingLeft.current = startLeft - scrollLeft - scroll;
          }
        }
        rowRnd.current?.updateLeft(draggingLeft.current || 0);
        const time = parserPixelToTime((draggingLeft.current || 0) + scrollLeft, { startLeft, scale, scaleWidth });
        setCursor({ time });
        onCursorDrag && onCursorDrag(time);
        return false;
      }}
    >
      <div
        className={cn(
          'timeline-editor-cursor-body absolute top-8 box-border h-[calc(100%-32px)] cursor-ew-resize border-l border-r border-timeline-cursor',
          slots.cursor,
        )}
      >
        <svg
          className={cn('timeline-editor-cursor-top absolute top-0 left-1/2 m-auto', slots.cursorTop)}
          width="8"
          height="12"
          viewBox="0 0 8 12"
          fill="none"
        >
          <path
            d="M0 1C0 0.447715 0.447715 0 1 0H7C7.55228 0 8 0.447715 8 1V9.38197C8 9.76074 7.786 10.107 7.44721 10.2764L4.44721 11.7764C4.16569 11.9172 3.83431 11.9172 3.55279 11.7764L0.552786 10.2764C0.214002 10.107 0 9.76074 0 9.38197V1Z"
            fill="#5297FF"
          />
        </svg>
        <div
          className={cn(
            'absolute top-0 left-1/2 h-full w-4 -translate-x-1/2 cursor-ew-resize',
            slots.cursorArea,
          )}
        />
      </div>
    </RowDnd>
  );
};
