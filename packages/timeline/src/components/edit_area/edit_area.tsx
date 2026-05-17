import React, { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { AutoSizer, Grid, GridCellRenderer, OnScrollParams, ScrollParams } from 'react-virtualized';
import { TimelineRow } from '@openscreen/timeline-engine';
import { useTimelineClassNames } from '../../interface/class_names';
import { CommonProp } from '../../interface/common_prop';
import { EditData } from '../../interface/timeline';
import { cn } from '../../utils/cn';
import { parserTimeToPixel } from '../../utils/deal_data';
import { DragLines } from './drag_lines';
import { EditRow } from './edit_row';
import { useDragLine } from './hooks/use_drag_line';
import { calculateTotalHeight, getRowHeights, isValidDragTarget } from './drag_utils';
import { InsertionLine } from './insertion_line';
import { DragPreview } from './drag_preview';

export type EditAreaProps = CommonProp & {
  /** Horizontal scroll offset from the left */
  scrollLeft: number;
  /** Vertical scroll offset from the top */
  scrollTop: number;
  /** Scroll callback used to keep scroll positions in sync */
  onScroll: (params: OnScrollParams) => void;
  /** Set the editor data */
  setEditorData: (params: TimelineRow[]) => void;
  /** Adjust scrollLeft by a delta */
  deltaScrollLeft: (scrollLeft: number) => void;
};

/** edit area ref data */
export interface EditAreaState {
  domRef: React.MutableRefObject<HTMLDivElement | null>;
}

// Drag state interface
interface DragState {
  isDragging: boolean;
  draggedRow: TimelineRow | null;
  draggedIndex: number;
  targetIndex: number;
  placeholderIndex: number;
  originalData: TimelineRow[];
  insertionLine: {
    visible: boolean;
    position: 'top' | 'bottom';
    index: number;
  };
  dragPreview: {
    visible: boolean;
    top: number;
    left: number;
    width: number;
    height: number;
  };
}

const initialDragState: DragState = {
  isDragging: false,
  draggedRow: null,
  draggedIndex: -1,
  targetIndex: -1,
  placeholderIndex: -1,
  originalData: [],
  insertionLine: {
    visible: false,
    position: 'top',
    index: -1,
  },
  dragPreview: {
    visible: false,
    top: 0,
    left: 0,
    width: 0,
    height: 0,
  },
};

export const EditArea = React.forwardRef<EditAreaState, EditAreaProps>((props, ref) => {
  const {
    editorData,
    rowHeight,
    scaleWidth,
    scaleCount,
    startLeft,
    scrollLeft,
    scrollTop,
    scale,
    hideCursor = false,
    cursorTime,
    onScroll,
    dragLine,
    getAssistDragLineActionIds,
    onActionMoveEnd,
    onActionMoveStart,
    onActionMoving,
    onActionResizeEnd,
    onActionResizeStart,
    onActionResizing,
    enableRowDrag = false,
    onRowDragStart,
    onRowDragEnd,
    setEditorData,
  } = props;
  const { dragLineData, initDragLine, updateDragLine, disposeDragLine, defaultGetAssistPosition, defaultGetMovePosition } = useDragLine();
  const slots = useTimelineClassNames();
  const editAreaRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<Grid>(null);
  const heightRef = useRef(-1);
  const scrollToPositionRef = useRef({ scrollLeft, scrollTop });
  // Optional
  const onScrollParamsRef = useRef<ScrollParams>({ clientHeight: 0, clientWidth: 0, scrollHeight: 0, scrollLeft: 0, scrollTop: 0, scrollWidth: 0 });

  // Drag state
  const [dragState, setDragState] = useState<DragState>(initialDragState);

  // ref data
  useImperativeHandle(ref, () => ({
    get domRef() {
      return editAreaRef;
    },
  }));

  // Row reorder algorithm
  const reorderRows = useCallback((data: TimelineRow[], fromIndex: number, toIndex: number): TimelineRow[] => {
    const result = [...data];

    // Adjust drag sort logic to handle the case where the target sits below the source.
    // Note: no adjustment is needed when dropping past the last row (toIndex = data.length).
    if (toIndex > fromIndex && toIndex < data.length) {
      toIndex = toIndex - 1;
    }

    const [removed] = result.splice(fromIndex, 1);
    result.splice(toIndex, 0, removed);
    return result;
  }, []);

  // Compute the target index based on which row boundary the cursor is closest to
  const calculateTargetIndex = useCallback(
    (clientY: number): { index: number; position: 'top' | 'bottom' } => {
      if (!editAreaRef.current) return { index: -1, position: 'top' };

      const rect = editAreaRef.current.getBoundingClientRect();
      // Use props.scrollTop — the Grid component's scrollTop is mirrored back to props via onScroll.
      const viewportTop = clientY - rect.top + scrollToPositionRef.current.scrollTop;

      const rowCount = editorData.length;
      let currentTop = 0;

      // If the cursor is above the first row, insert above it
      if (rowCount > 0 && viewportTop < 0) {
        return { index: 0, position: 'top' };
      }
      for (let i = 0; i < rowCount; i++) {
        const currentRowHeight = editorData[i]?.rowHeight || rowHeight;
        const currentRowBottom = currentTop + currentRowHeight;

        if (viewportTop >= currentTop && viewportTop <= currentRowBottom) {
          const distanceToTop = Math.abs(viewportTop - currentTop);
          const distanceToBottom = Math.abs(viewportTop - currentRowBottom);

          if (distanceToTop < distanceToBottom) {
            return { index: i, position: 'top' };
          } else {
            return { index: i + 1, position: 'top' };
          }
        }

        currentTop = currentRowBottom;
      }

      return { index: rowCount, position: 'top' };
    },
    [editorData, rowHeight],
  );

  // Compute the drag preview position
  const calculateDragPreviewPosition = useCallback(
    (clientY: number, dragPreviewHeight: number) => {
      if (!editAreaRef.current) return 0;

      const rect = editAreaRef.current.getBoundingClientRect();
      // Use props.scrollTop — the Grid component's scrollTop is mirrored back to props via onScroll.
      let previewTop = clientY - rect.top;
      // Center the element on the cursor
      previewTop -= dragPreviewHeight / 2;

      // Clamp the preview within the edit area
      const editAreaHeight = rect.height;
      previewTop = Math.max(0, Math.min(previewTop, editAreaHeight - dragPreviewHeight));
      return previewTop;
    },
    [scrollTop],
  );

  const calculateRowAccumulatedHeight = useCallback(
    (rowIndex: number): number => {
      let accumulatedHeight = 0;
      for (let i = 0; i < rowIndex; i++) {
        accumulatedHeight += editorData[i]?.rowHeight || rowHeight;
      }
      return Math.max(0, accumulatedHeight - scrollTop);
    },
    [editorData, scrollTop, rowHeight],
  );

  // Initialize the drag state
  const initializeDragState = useCallback(
    (row: TimelineRow, rowIndex: number) => {
      const originalData = [...editorData];
      const dragPreviewHeight = row.rowHeight || rowHeight;

      // Use the helper to compute the drag preview position
      const dragPreviewTop = calculateRowAccumulatedHeight(rowIndex);
      return {
        isDragging: true,
        draggedRow: row,
        draggedIndex: rowIndex,
        targetIndex: -1,
        placeholderIndex: rowIndex,
        originalData,
        insertionLine: {
          visible: false,
          position: 'top' as const,
          index: -1,
        },
        dragPreview: {
          visible: true,
          top: dragPreviewTop,
          left: 0,
          width: 0,
          height: dragPreviewHeight,
        },
      };
    },
    [editorData, rowHeight, calculateRowAccumulatedHeight],
  );

  // Update the drag state
  const updateDragState = useCallback((currentState: DragState, targetIndex: number, previewTop: number, rowIndex: number) => {
    if (currentState.targetIndex === targetIndex && currentState.dragPreview.top === previewTop) {
      return currentState; // No change — avoid an unnecessary re-render
    }

    return {
      ...currentState,
      targetIndex,
      placeholderIndex: targetIndex > rowIndex ? targetIndex - 1 : targetIndex,
      insertionLine: {
        visible: targetIndex !== -1 && targetIndex !== rowIndex,
        position: 'top' as const,
        index: targetIndex,
      },
      dragPreview: {
        ...currentState.dragPreview,
        top: previewTop,
      },
    };
  }, []);

  // Handle drag end
  const handleDragEnd = useCallback(
    (draggedIndex: number, targetIndex: number, draggedRow: TimelineRow | null, originalData: TimelineRow[]) => {
      if (isValidDragTarget(targetIndex, draggedIndex, editorData.length)) {
        const newData = reorderRows(editorData, draggedIndex, targetIndex);
        setEditorData(newData);
        onRowDragEnd?.({ row: draggedRow!, editorData: newData });
      } else {
        setEditorData(originalData);
      }
    },
    [editorData, reorderRows, setEditorData, onRowDragEnd, isValidDragTarget],
  );

  // Handle row drag start
  const handleRowDragStart = useCallback(
    (row: TimelineRow, rowIndex: number) => {
      if (!enableRowDrag) return;

      // Initialize the drag state
      const initialDragState = initializeDragState(row, rowIndex);
      setDragState(initialDragState);

      // Fire callback
      onRowDragStart?.({ row });

      // Throttling control variables
      let animationFrameId: number | null = null;
      let autoScrollAnimationFrameId: number | null = null;
      let lastUpdateTime = 0;
      const UPDATE_INTERVAL = 16; // ~60fps, matching the browser's refresh rate

      // Track the cursor position so the auto-scroll loop can re-check continuously
      let currentMouseY = 0;
      let isDragging = false;

      const updateDragPosition = (currentMouseY: number) => {
        const currentTime = Date.now();
        // Throttle updates by interval
        if (currentTime - lastUpdateTime >= UPDATE_INTERVAL) {
          const targetInfo = calculateTargetIndex(currentMouseY);
          const targetIndex = targetInfo.index;
          const previewTop = calculateDragPreviewPosition(currentMouseY, initialDragState.dragPreview.height);
          // Update state directly to avoid setTimeout latency
          setDragState((prev) => updateDragState(prev, targetIndex, previewTop, rowIndex));

          lastUpdateTime = currentTime;
        }
      };

      // Continuous auto-scroll check — independent of mousemove events
      const checkAndScroll = () => {
        if (!isDragging) {
          // Re-check on the next frame
          return (autoScrollAnimationFrameId = requestAnimationFrame(checkAndScroll));
        }

        if (editAreaRef.current && gridRef.current) {
          const editAreaElement = editAreaRef.current;
          const gridElement = editAreaElement.querySelector('.ReactVirtualized__Grid') as HTMLElement;

          if (gridElement) {
            const gridRect = gridElement.getBoundingClientRect();
            const scrollThreshold = 50; // Distance threshold that triggers scrolling
            const scrollSpeed = 10; // Scroll speed

            // Cursor position relative to the grid element
            const mouseY = currentMouseY - gridRect.top;
            // Scroll up if needed
            if (mouseY < scrollThreshold) {
              const newScrollTop = gridElement.scrollTop - scrollSpeed;
              onScroll({ ...onScrollParamsRef.current, scrollTop: Math.max(0, newScrollTop) });
              updateDragPosition(currentMouseY);
            }
            // Scroll down if needed
            else if (mouseY > gridRect.height - scrollThreshold) {
              const newScrollTop = gridElement.scrollTop + scrollSpeed;
              onScroll({ ...onScrollParamsRef.current, scrollTop: Math.min(newScrollTop, gridElement.scrollHeight - gridRect.height) });
              updateDragPosition(currentMouseY);
            }
          }
        }

        // Continue the loop on the next frame
        autoScrollAnimationFrameId = requestAnimationFrame(checkAndScroll);
      };

      // Kick off the continuous scroll check
      autoScrollAnimationFrameId = requestAnimationFrame(checkAndScroll);

      // mousemove handler
      const handleMouseMove = (moveEvent: MouseEvent) => {
        isDragging = true;
        // Track the latest cursor position
        currentMouseY = moveEvent.clientY;

        // Cancel any pending frame
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId);
        }

        // Use requestAnimationFrame to align with browser rendering
        animationFrameId = requestAnimationFrame(() => {
          updateDragPosition(currentMouseY);
          animationFrameId = null;
        });
      };

      // mouseup handler
      const handleMouseUp = () => {
        // Stop the drag and the auto-scroll check
        isDragging = false;

        // Cancel pending animation frames
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }

        if (autoScrollAnimationFrameId) {
          cancelAnimationFrame(autoScrollAnimationFrameId);
          autoScrollAnimationFrameId = null;
        }

        // Use functional updates so we always read the latest state
        setDragState((prevState) => {
          const { draggedIndex, targetIndex, originalData, draggedRow } = prevState;

          // Reset the drag state immediately so the visual feedback disappears at once
          const resetState = {
            ...initialDragState,
            isDragging: false,
            draggedIndex: -1,
            dragPreview: {
              ...initialDragState.dragPreview,
              visible: false,
            },
            insertionLine: {
              ...initialDragState.insertionLine,
              visible: false,
            },
          };

          // Then run the drag-end logic
          setTimeout(() => {
            handleDragEnd(draggedIndex, targetIndex, draggedRow, originalData);
          }, 0);

          return resetState;
        });

        // Remove event listeners
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [enableRowDrag, onRowDragStart, initializeDragState, calculateTargetIndex, calculateDragPreviewPosition, updateDragState, handleDragEnd, scrollTop],
  );

  const handleInitDragLine: EditData['onActionMoveStart'] = (data) => {
    if (dragLine) {
      const assistActionIds =
        getAssistDragLineActionIds &&
        getAssistDragLineActionIds({
          action: data.action,
          row: data.row,
          editorData,
        });
      const cursorLeft = parserTimeToPixel(cursorTime, { scaleWidth, scale, startLeft });
      const assistPositions = defaultGetAssistPosition({
        editorData,
        assistActionIds,
        action: data.action,
        row: data.row,
        scale,
        scaleWidth,
        startLeft,
        hideCursor,
        cursorLeft,
      });
      initDragLine({ assistPositions });
    }
  };

  const handleUpdateDragLine: EditData['onActionMoving'] = (data) => {
    if (dragLine) {
      const movePositions = defaultGetMovePosition({
        ...data,
        startLeft,
        scaleWidth,
        scale,
      });
      updateDragLine({ movePositions });
    }
  };

  /** Render each cell */
  const cellRenderer: GridCellRenderer = ({ rowIndex, key, style }) => {
    const row = editorData[rowIndex];

    return (
      <EditRow
        {...props}
        style={{
          ...style,
          backgroundPositionX: `0, ${startLeft}px`,
          backgroundSize: `${startLeft}px, ${scaleWidth}px`,
        }}
        areaRef={editAreaRef}
        key={key}
        rowHeight={row?.rowHeight || rowHeight}
        rowData={row}
        dragLineData={dragLineData}
        rowIndex={rowIndex}
        dragState={{
          isDragging: dragState.draggedIndex !== -1,
          draggedIndex: dragState.draggedIndex,
        }}
        onRowDragStart={(params) => {
          handleRowDragStart(params.row, rowIndex);
        }}
        onActionMoveStart={(data) => {
          handleInitDragLine(data);
          return onActionMoveStart && onActionMoveStart(data);
        }}
        onActionResizeStart={(data) => {
          handleInitDragLine(data);
          return onActionResizeStart && onActionResizeStart(data);
        }}
        onActionMoving={(data) => {
          handleUpdateDragLine(data);
          return onActionMoving && onActionMoving(data);
        }}
        onActionResizing={(data) => {
          handleUpdateDragLine(data);
          return onActionResizing && onActionResizing(data);
        }}
        onActionResizeEnd={(data) => {
          disposeDragLine();
          return onActionResizeEnd && onActionResizeEnd(data);
        }}
        onActionMoveEnd={(data) => {
          disposeDragLine();
          return onActionMoveEnd && onActionMoveEnd(data);
        }}
      />
    );
  };

  useLayoutEffect(() => {
    gridRef.current?.scrollToPosition({ scrollTop, scrollLeft });
    scrollToPositionRef.current = { scrollTop, scrollLeft };
  }, [scrollTop, scrollLeft]);

  useEffect(() => {
    gridRef.current?.recomputeGridSize();
  }, [editorData]);

  return (
    <div ref={editAreaRef} className={cn('timeline-editor-edit-area relative mt-2.5 flex-1 overflow-hidden', slots.editArea)}>
      <AutoSizer>
        {({ width, height }) => {
          // Total height of all rows
          const totalHeight = calculateTotalHeight(editorData, rowHeight);
          // Per-row heights
          const heights = getRowHeights(editorData, rowHeight);
          if (totalHeight < height) {
            heights.push(height - totalHeight);
            if (heightRef.current !== height && heightRef.current >= 0) {
              setTimeout(() =>
                gridRef.current?.recomputeGridSize({
                  rowIndex: heights.length - 1,
                }),
              );
            }
          }
          heightRef.current = height;

          return (
            <>
              <Grid
                columnCount={1}
                rowCount={heights.length}
                ref={gridRef}
                cellRenderer={cellRenderer}
                columnWidth={Math.max(scaleCount * scaleWidth + startLeft, width)}
                width={width}
                height={height}
                rowHeight={({ index }) => heights[index] || rowHeight}
                overscanRowCount={10}
                overscanColumnCount={0}
                onScroll={(param) => {
                  onScrollParamsRef.current = param;
                  onScroll(param);
                }}
              />
              {/* Insertion line indicator */}
              <InsertionLine top={calculateRowAccumulatedHeight(dragState.insertionLine.index)} visible={dragState.insertionLine.visible} />
              {/* Drag preview element */}
              <DragPreview top={dragState.dragPreview.top} height={dragState.dragPreview.height} visible={dragState.dragPreview.visible} />
            </>
          );
        }}
      </AutoSizer>
      {dragLine && <DragLines scrollLeft={scrollLeft} {...dragLineData} />}
    </div>
  );
});
