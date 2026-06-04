import React, { useEffect, useImperativeHandle, useRef } from 'react';
import { AutoSizer, Grid, GridCellRenderer, OnScrollParams } from 'react-virtualized';
import { useTimelineClassNames } from '../../interface/class_names';
import { CommonProp } from '../../interface/common_prop';
import { PREFIX } from '../../interface/const';
import { cn } from '../../utils/cn';
import { parserPixelToTime } from '../../utils/deal_data';

/** Animation timeline component props */
export type TimeAreaProps = CommonProp & {
  /** Horizontal scroll offset from the left */
  scrollLeft: number;
  /** Scroll callback used to keep scroll positions in sync */
  onScroll: (params: OnScrollParams) => void;
  /** Set the cursor position */
  setCursor: (param: { left?: number; time?: number }) => void;
};

export interface TimeAreaHandle {
  /** Immediately sync the ruler to a new horizontal scroll offset, bypassing React state. */
  syncScrollLeft: (left: number) => void;
}

/** Animation timeline component */
export const TimeArea = React.forwardRef<TimeAreaHandle, TimeAreaProps>(({ setCursor, maxScaleCount, maxCursorTime, hideCursor, scale, scaleWidth, scaleCount, scaleSplitCount, startLeft, scrollLeft, onScroll, onClickTimeArea, getScaleRender }, ref) => {
  const gridRef = useRef<Grid>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const slots = useTimelineClassNames();

  useImperativeHandle(ref, () => ({
    syncScrollLeft: (left: number) => {
      const container = (gridRef.current as any)?._scrollingContainer as HTMLElement | undefined;
      if (container) container.scrollLeft = left;
    },
  }));

  /** Whether to render subdivision ticks */
  const showUnit = scaleSplitCount > 0;

  /** Render each cell */
  const cellRenderer: GridCellRenderer = ({ columnIndex, key, style }) => {
    const isShowScale = showUnit ? columnIndex % scaleSplitCount === 0 : true;
    const item = (showUnit ? columnIndex / scaleSplitCount : columnIndex) * scale;
    return (
      <div
        key={key}
        style={style}
        className={cn(
          'relative box-content !h-1 !bottom-0 !top-auto border-r border-white/20',
          isShowScale && '!h-2',
          slots.timeUnit,
          isShowScale && slots.timeUnitBig,
        )}
      >
        {isShowScale && (
          <div
            className={cn(
              'absolute right-0 top-0 translate-x-1/2 -translate-y-full text-white/60',
              slots.timeUnitScale,
            )}
          >
            {getScaleRender ? getScaleRender(item) : item}
          </div>
        )}
      </div>
    );
  };

  useEffect(() => {
    gridRef.current?.recomputeGridSize();
  }, [scaleWidth, startLeft]);

  // Forward wheel events from the interactive overlay to the edit area's scroll
  // container. Without this, wheeling over the ruler does nothing because the
  // overlay swallows the event before it can reach a scrollable ancestor.
  // Forwarding to the edit area (rather than the ruler's own grid) keeps the
  // existing onScroll → ScrollSync → ruler sync path as the single source of
  // truth, so horizontal and vertical scroll stay aligned without flicker.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const handleWheel = (e: WheelEvent) => {
      const root = overlay.closest(`.${PREFIX}`);
      const editGrid = root?.querySelector('.timeline-editor-edit-area .ReactVirtualized__Grid') as HTMLElement | null;
      if (!editGrid) return;
      const { deltaX, deltaY } = e;
      if (deltaX === 0 && deltaY === 0) return;
      let consumed = false;
      if (deltaX !== 0) {
        const maxX = editGrid.scrollWidth - editGrid.clientWidth;
        const nextX = Math.max(0, Math.min(maxX, editGrid.scrollLeft + deltaX));
        if (nextX !== editGrid.scrollLeft) {
          editGrid.scrollLeft = nextX;
          consumed = true;
        }
      }
      if (deltaY !== 0) {
        const maxY = editGrid.scrollHeight - editGrid.clientHeight;
        const nextY = Math.max(0, Math.min(maxY, editGrid.scrollTop + deltaY));
        if (nextY !== editGrid.scrollTop) {
          editGrid.scrollTop = nextY;
          consumed = true;
        }
      }
      if (consumed) e.preventDefault();
    };
    overlay.addEventListener('wheel', handleWheel, { passive: false });
    return () => overlay.removeEventListener('wheel', handleWheel);
  }, []);

  /** Get the column width */
  const getColumnWidth = (data: { index: number }) => {
    switch (data.index) {
      case 0:
        return startLeft;
      default:
        return showUnit ? scaleWidth / scaleSplitCount : scaleWidth;
    }
  };
  const estColumnWidth=getColumnWidth({index:1});
  return (
    <div className={cn('timeline-editor-time-area relative h-8 flex-none', slots.timeArea)}>
      <AutoSizer>
        {({ width, height }) => {
          return (
            <>
              <Grid
                ref={gridRef}
                columnCount={showUnit ? scaleCount * scaleSplitCount + 1 : scaleCount}
                columnWidth={getColumnWidth}
                estimatedColumnSize={estColumnWidth}
                rowCount={1}
                rowHeight={height}
                width={width}
                height={height}
                overscanRowCount={0}
                overscanColumnCount={10}
                cellRenderer={cellRenderer}
                scrollLeft={scrollLeft}
                onScroll={onScroll}
              ></Grid>
              <div
                ref={overlayRef}
                style={{ width, height }}
                onClick={(e) => {
                  if (hideCursor) return;
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const position = e.clientX - rect.x;
                  const left = Math.max(position + scrollLeft, startLeft);
                  if (left > maxScaleCount * scaleWidth + startLeft - scrollLeft) return;

                  const rawTime = parserPixelToTime(left, { startLeft, scale, scaleWidth });
                  const time = Number.isFinite(maxCursorTime) ? Math.min(rawTime, maxCursorTime) : rawTime;
                  const result = onClickTimeArea && onClickTimeArea(time, e);
                  if (result === false) return; // Returning false prevents the time from being set
                  setCursor({ time });
                }}
                // Hover preview emission lives on the timeline root (see
                // timeline.tsx) so it covers the ruler *and* the tracks; the
                // ruler overlay only owns click-to-seek now.
                className={cn('absolute left-0 top-0 cursor-pointer', slots.timeAreaInteract)}
              ></div>
            </>
          );
        }}
      </AutoSizer>
    </div>
  );
});
