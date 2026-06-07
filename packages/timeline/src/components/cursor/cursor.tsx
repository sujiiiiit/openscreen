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
  maxCursorTime,
  deltaScrollLeft,
  draggingCursorRef,
  onCursorDragStart,
  onCursorDrag,
  onCursorDragEnd,
}) => {
  const rowRnd = useRef<RowRndApi>(null);
  const draggingLeft = useRef<undefined | number>(undefined);
  const slots = useTimelineClassNames();

  /**
   * Right-edge bound for the cursor in viewport pixels. Capped by the visible
   * timeline width, the maxScaleCount-derived ruler edge, and (when finite)
   * the maxCursorTime-derived end-of-content edge — whichever is smallest.
   */
  const getMaxRightInViewport = (scroll: number) => {
    const scaleRight = maxScaleCount * scaleWidth + startLeft - scroll;
    const cursorTimeRight = Number.isFinite(maxCursorTime)
      ? parserTimeToPixel(maxCursorTime, { startLeft, scaleWidth, scale }) - scroll
      : Number.POSITIVE_INFINITY;
    return Math.min(timelineWidth, scaleRight, cursorTimeRight);
  };

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
        right: getMaxRightInViewport(scrollLeft),
      }}
      deltaScrollLeft={deltaScrollLeft}
      enableDragging={!disableDrag}
      enableResizing={false}
      onDragStart={() => {
        if (draggingCursorRef) draggingCursorRef.current = true;
        onCursorDragStart && onCursorDragStart(cursorTime);
        draggingLeft.current = parserTimeToPixel(cursorTime, { startLeft, scaleWidth, scale }) - scrollLeft;
        rowRnd.current?.updateLeft(draggingLeft.current);
      }}
      onDragEnd={() => {
        const time = parserPixelToTime((draggingLeft.current || 0) + scrollLeft, { startLeft, scale, scaleWidth });
        const clampedTime = Number.isFinite(maxCursorTime) ? Math.min(time, maxCursorTime) : time;
        setCursor({ time: clampedTime });
        onCursorDragEnd && onCursorDragEnd(clampedTime);
        draggingLeft.current = undefined;
        if (draggingCursorRef) draggingCursorRef.current = false;
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
        // Also clamp on the right so the playhead cannot pass the configured
        // maxCursorTime (set by callers to the longest clip's end). Without
        // this the internal drag state would silently advance past the cap
        // even if the consumer pulled the cursor back via setTime.
        if (Number.isFinite(maxCursorTime)) {
          const maxRight =
            parserTimeToPixel(maxCursorTime, { startLeft, scaleWidth, scale }) - scrollLeft;
          if ((draggingLeft.current || 0) > maxRight) {
            draggingLeft.current = maxRight;
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
          // The line is a 2px background (halved to 1px by the cursor-body
          // scaleX(0.5) transform), not borders, so it can fade: solid for
          // the top 65%, then to transparent — the tail of a full-height
          // seek line shouldn't compete with the clips it crosses. Consumers
          // theme it via a `from-*` color in the `cursor` slot.
          'timeline-editor-cursor-body absolute top-0 box-border h-full w-0.5 cursor-ew-resize bg-gradient-to-b from-timeline-cursor from-65% to-transparent',
          slots.cursor,
        )}
      >
        {/* Inverted teardrop / location-pin: a circular bulb on top tapering to
            a sharp point at the bottom. The point sits at the path's horizontal
            centre (x = width/2), so the `.timeline-editor-cursor-top` transform
            keeps it pinned exactly on the seek line. `currentColor` lets the
            consumer theme the fill via the `cursorTop` slot. The body spans the
            full timeline height (`top-0 h-full`), so the 1px seek line runs up
            through the ruler, and the pin head sits at the very top of the
            line (`top-0`, inside the ruler) — the classic NLE look. The head
            covers a ruler label only while the playhead is directly over it.
            Must match the hover ghost cursor's pin offset in
            timeline-panel.tsx so the two seek indicators align. */}
        <svg
          className={cn('timeline-editor-cursor-top absolute top-0 left-1/2 m-auto text-sky-400', slots.cursorTop)}
          width="12"
          height="22"
          viewBox="0 0 12 22"
          fill="none"
        >
          {/* Teardrop with a curvature-matched bulb→tail seam: the tail cubics
              start with the same curvature as the bulb arcs (G2-continuous at
              x=0/12, y=6.2), tapering gradually to a crisp needle tip at
              (6,22). Keep in sync with the hover ghost pin in
              timeline-panel.tsx. */}
          <path
            d="M6 0C9.3 0 12 2.8 12 6.2C12 10.8 6.7 16.5 6 22C5.3 16.5 0 10.8 0 6.2C0 2.8 2.7 0 6 0Z"
            fill="currentColor"
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
