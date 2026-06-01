import React, { FC, useRef, useCallback } from 'react';
import { TimelineAction, TimelineRow } from '@openscreen/timeline-engine';
import { useTimelineClassNames } from '../../interface/class_names';
import { CommonProp } from '../../interface/common_prop';
import { cn } from '../../utils/cn';
import { parserPixelToTime } from '../../utils/deal_data';
import { DragLineData } from './drag_lines';
import { EditAction } from './edit_action';

export type EditRowProps = CommonProp & {
  areaRef: React.RefObject<HTMLDivElement | null>;
  rowData?: TimelineRow;
  style?: React.CSSProperties;
  dragLineData: DragLineData;
  setEditorData: (params: TimelineRow[]) => void;
  /** Horizontal scroll offset from the left */
  scrollLeft: number;
  /** Adjust scrollLeft by a delta */
  deltaScrollLeft: (scrollLeft: number) => void;
  /** Drag-related props */
  rowIndex?: number;
  /** Current drag state */
  dragState?: {
    isDragging: boolean;
    draggedIndex: number;
  };
};

export const EditRow: FC<EditRowProps> = (props) => {
  const { rowData, style = {}, onClickRow, onRowHover, onDoubleClickRow, onContextMenuRow, areaRef, scrollLeft, startLeft, scale, scaleWidth, enableRowDrag, onRowDragStart, rowIndex = -1, dragState } = props;
  const slots = useTimelineClassNames();
  const isDraggedRow = dragState?.isDragging && dragState.draggedIndex === rowIndex;

  const dragHandleRef = useRef<HTMLDivElement>(null);

  const handleTime = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    if (!areaRef.current) return 0;
    const rect = areaRef.current.getBoundingClientRect();
    const position = e.clientX - rect.x;
    const left = position + scrollLeft;
    const time = parserPixelToTime(left, { startLeft, scale, scaleWidth });
    return time;
  };

  // Drag handle mousedown handler
  const handleDragHandleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!enableRowDrag || !rowData || rowIndex === -1) return;

      e.preventDefault();
      e.stopPropagation();

      // Fire the drag start callback — handled by the EditArea component
      onRowDragStart?.({ row: rowData });
    },
    [enableRowDrag, rowData, rowIndex, onRowDragStart],
  );

  return (
    <div
      className={cn(
        'timeline-editor-edit-row-bg relative box-border flex flex-row transition-[opacity,transform] duration-200 ease',
        isDraggedRow && 'cursor-grabbing opacity-50',
        slots.editRow,
        rowData?.classNames,
      )}
      style={style}
      onClick={(e) => {
        if (rowData && onClickRow) {
          const time = handleTime(e);
          onClickRow(e, { row: rowData, time: time });
        }
      }}
      onMouseMove={(e) => {
        if (rowData && onRowHover) {
          onRowHover({ row: rowData, time: handleTime(e) });
        }
      }}
      onMouseLeave={() => {
        if (rowData && onRowHover) {
          onRowHover({ row: rowData, time: null });
        }
      }}
      onDoubleClick={(e) => {
        if (rowData && onDoubleClickRow) {
          const time = handleTime(e);
          onDoubleClickRow(e, { row: rowData, time: time });
        }
      }}
      onContextMenu={(e) => {
        if (rowData && onContextMenuRow) {
          const time = handleTime(e);
          onContextMenuRow(e, { row: rowData, time: time });
        }
      }}
    >
      {/* Drag handle */}
      {enableRowDrag && rowData && (
        <div
          ref={dragHandleRef}
          className={cn(
            'absolute left-1 top-1/2 z-10 flex h-4 w-4 -translate-y-1/2 cursor-grab select-none items-center justify-center text-xs text-zinc-500 opacity-60 transition-opacity duration-200 hover:text-zinc-400 hover:opacity-100 active:cursor-grabbing',
            slots.editRowDragHandle,
          )}
          onMouseDown={handleDragHandleMouseDown}
          title="Drag to reorder row"
        >
          ⋮⋮
        </div>
      )}

      {(rowData?.actions || []).map((action: TimelineAction) => (
        <EditAction key={action.id} {...props} handleTime={handleTime} row={rowData!} action={action} />
      ))}
    </div>
  );
};
