import { FC, useEffect, useRef } from 'react';
import { AutoSizer, Grid, GridCellRenderer, OnScrollParams } from 'react-virtualized';
import { useTimelineClassNames } from '../../interface/class_names';
import { CommonProp } from '../../interface/common_prop';
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

/** Animation timeline component */
export const TimeArea: FC<TimeAreaProps> = ({ setCursor, maxScaleCount, maxCursorTime, hideCursor, scale, scaleWidth, scaleCount, scaleSplitCount, startLeft, scrollLeft, onClickTimeArea, onTimeAreaHover, draggingCursorRef, getScaleRender }) => {
  const gridRef = useRef<Grid>(null);
  const slots = useTimelineClassNames();
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
              ></Grid>
              <div
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
                onMouseMove={(e) => {
                  if (hideCursor || !onTimeAreaHover) return;
                  // Skip while the main cursor is being dragged so we don't
                  // emit two competing time-cursors (the drag handler already
                  // owns the cursor position for the duration of the drag).
                  if (draggingCursorRef?.current) return;
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const position = e.clientX - rect.x;
                  const left = Math.max(position + scrollLeft, startLeft);
                  if (left > maxScaleCount * scaleWidth + startLeft - scrollLeft) return;

                  const rawTime = parserPixelToTime(left, { startLeft, scale, scaleWidth });
                  const time = Number.isFinite(maxCursorTime) ? Math.min(rawTime, maxCursorTime) : rawTime;
                  onTimeAreaHover(time);
                }}
                onMouseLeave={() => {
                  if (hideCursor || !onTimeAreaHover) return;
                  onTimeAreaHover(null);
                }}
                className={cn('absolute left-0 top-0 cursor-pointer', slots.timeAreaInteract)}
              ></div>
            </>
          );
        }}
      </AutoSizer>
    </div>
  );
};
