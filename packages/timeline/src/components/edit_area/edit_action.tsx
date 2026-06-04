import React, { FC, useLayoutEffect, useRef, useState } from 'react';
import { TimelineAction, TimelineRow } from '@openscreen/timeline-engine';
import { useTimelineClassNames } from '../../interface/class_names';
import { CommonProp } from '../../interface/common_prop';
import { DEFAULT_ADSORPTION_DISTANCE, DEFAULT_MOVE_GRID, PREFIX } from '../../interface/const';
import { cn } from '../../utils/cn';
import { getScaleCountByPixel, parserTimeToPixel, parserTimeToTransform, parserTransformToTime } from '../../utils/deal_data';
import { RowDnd } from '../row_rnd/row_rnd';
import { RndDragCallback, RndDragEndCallback, RndDragStartCallback, RndResizeCallback, RndResizeEndCallback, RndResizeStartCallback, RowRndApi } from '../row_rnd/row_rnd_interface';
import { DragLineData } from './drag_lines';

export type EditActionProps = CommonProp & {
  row: TimelineRow;
  action: TimelineAction;
  dragLineData: DragLineData;
  setEditorData: (params: TimelineRow[]) => void;
  handleTime: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => number;
  areaRef: React.RefObject<HTMLDivElement | null>;
  /** Adjust scrollLeft by a delta */
  deltaScrollLeft?: (delta: number) => void;
};

export const EditAction: FC<EditActionProps> = ({
  editorData,
  row,
  action,
  effects,
  rowHeight,
  scale,
  scaleWidth,
  scaleSplitCount,
  startLeft,
  gridSnap,
  disableDrag,

  scaleCount,
  maxScaleCount,
  setScaleCount,
  onActionMoveStart,
  onActionMoving,
  onActionMoveEnd,
  onActionResizeStart,
  onActionResizeEnd,
  onActionResizing,

  dragLineData,
  setEditorData,
  onClickAction,
  onClickActionOnly,
  onDoubleClickAction,
  onContextMenuAction,
  getActionRender,
  handleTime,
  areaRef,
  deltaScrollLeft,
}) => {
  const rowRnd = useRef<RowRndApi>(null);
  const isDragWhenClick = useRef(false);
  const slots = useTimelineClassNames();
  const { id, maxEnd, minStart, end, start, selected, flexible = true, movable = true, effectId } = action;

  // Compute the min/max pixel range
  const leftLimit = parserTimeToPixel(minStart || 0, {
    startLeft,
    scale,
    scaleWidth,
  });
  const rightLimit = Math.min(
    maxScaleCount * scaleWidth + startLeft, // Cap movement using maxScaleCount
    parserTimeToPixel(maxEnd || Number.MAX_VALUE, {
      startLeft,
      scale,
      scaleWidth,
    }),
  );

  // Initialize the action's transform from its time range
  const [transform, setTransform] = useState(() => {
    return parserTimeToTransform({ start, end }, { startLeft, scale, scaleWidth });
  });

  useLayoutEffect(() => {
    setTransform(parserTimeToTransform({ start, end }, { startLeft, scale, scaleWidth }));
  }, [end, start, startLeft, scaleWidth, scale]);

  // Configure the grid-snap step
  const gridSize = scaleWidth / scaleSplitCount;

  // Marker class names (no styling — consumers can target these via classNames / action.className)
  const markerClasses = [
    `${PREFIX}-action`,
    movable && `${PREFIX}-action-movable`,
    selected && `${PREFIX}-action-selected`,
    flexible && `${PREFIX}-action-flexible`,
    effects[effectId] && `${PREFIX}-action-effect-${effectId}`,
  ];

  /** Compute the required scale count */
  const handleScaleCount = (left: number, width: number) => {
    const curScaleCount = getScaleCountByPixel(left + width, {
      startLeft,
      scaleCount,
      scaleWidth,
    });
    if (curScaleCount !== scaleCount) setScaleCount(curScaleCount);
  };

  //#region [rgba(100,120,156,0.08)] callbacks
  const handleDragStart: RndDragStartCallback = () => {
    onActionMoveStart && onActionMoveStart({ action, row });
  };
  const handleDrag: RndDragCallback = ({ left, width }) => {
    isDragWhenClick.current = true;

    if (onActionMoving) {
      const { start, end } = parserTransformToTime({ left, width }, { scaleWidth, scale, startLeft });
      const result = onActionMoving({ action, row, start, end });
      if (result === false) return false;
    }
    setTransform({ left, width });
    handleScaleCount(left, width);
  };

  const handleDragEnd: RndDragEndCallback = ({ left, width }) => {
    // Compute time
    const { start, end } = parserTransformToTime({ left, width }, { scaleWidth, scale, startLeft });

    // Persist data
    const rowItem = editorData.find((item: TimelineRow) => item.id === row.id);
    if (!rowItem) return;
    const action = rowItem.actions.find((item: TimelineAction) => item.id === id);
    if (!action) return;
    action.start = start;
    action.end = end;
    setEditorData(editorData);

    // Fire callback
    if (onActionMoveEnd) onActionMoveEnd({ action, row, start, end });
  };

  const handleResizeStart: RndResizeStartCallback = (dir) => {
    onActionResizeStart && onActionResizeStart({ action, row, dir });
  };

  const handleResizing: RndResizeCallback = (dir, { left, width }) => {
    isDragWhenClick.current = true;
    if (onActionResizing) {
      const { start, end } = parserTransformToTime({ left, width }, { scaleWidth, scale, startLeft });
      const result = onActionResizing({ action, row, start, end, dir });
      if (result === false) return false;
    }
    setTransform({ left, width });
    handleScaleCount(left, width);
  };

  const handleResizeEnd: RndResizeEndCallback = (dir, { left, width }) => {
    // Compute time
    const { start, end } = parserTransformToTime({ left, width }, { scaleWidth, scale, startLeft });

    // Persist data
    const rowItem = editorData.find((item: TimelineRow) => item.id === row.id);
    if (!rowItem) return;
    const action = rowItem.actions.find((item: TimelineAction) => item.id === id);
    if (!action) return;
    action.start = start;
    action.end = end;
    setEditorData(editorData);

    // Fire callback
    if (onActionResizeEnd) onActionResizeEnd({ action, row, start, end, dir });
  };
  //#endregion

  const nowAction = {
    ...action,
    ...parserTransformToTime({ left: transform.left, width: transform.width }, { startLeft, scaleWidth, scale }),
  };

  const nowRow: TimelineRow = {
    ...row,
    actions: [...row.actions],
  };
  if (row.actions.includes(action)) {
    nowRow.actions[row.actions.indexOf(action)] = nowAction;
  }

  return (
    <RowDnd
      ref={rowRnd}
      parentRef={areaRef}
      start={startLeft}
      left={transform.left}
      width={transform.width}
      grid={(gridSnap && gridSize) || DEFAULT_MOVE_GRID}
      adsorptionDistance={gridSnap ? Math.max((gridSize || DEFAULT_MOVE_GRID) / 2, DEFAULT_ADSORPTION_DISTANCE) : DEFAULT_ADSORPTION_DISTANCE}
      adsorptionPositions={dragLineData.assistPositions}
      bounds={{
        left: leftLimit,
        right: rightLimit,
      }}
      edges={{
        left: !disableDrag && flexible && `.${PREFIX}-action-left-stretch`,
        right: !disableDrag && flexible && `.${PREFIX}-action-right-stretch`,
      }}
      enableDragging={!disableDrag && movable}
      enableResizing={!disableDrag && flexible}
      onDragStart={handleDragStart}
      onDrag={handleDrag}
      onDragEnd={handleDragEnd}
      onResizeStart={handleResizeStart}
      onResize={handleResizing}
      onResizeEnd={handleResizeEnd}
      deltaScrollLeft={deltaScrollLeft}
    >
      <div
        onMouseDown={() => {
          isDragWhenClick.current = false;
        }}
        onClick={(e) => {
          let time: number | undefined;
          if (onClickAction) {
            time = handleTime(e);
            onClickAction(e, { row, action, time: time });
          }
          if (!isDragWhenClick.current && onClickActionOnly) {
            if (!time) time = handleTime(e);
            onClickActionOnly(e, { row, action, time: time });
          }
        }}
        onDoubleClick={(e) => {
          if (onDoubleClickAction) {
            const time = handleTime(e);
            onDoubleClickAction(e, { row, action, time: time });
          }
        }}
        onContextMenu={(e) => {
          if (onContextMenuAction) {
            const time = handleTime(e);
            onContextMenuAction(e, { row, action, time: time });
          }
        }}
        className={cn(
          markerClasses,
          'absolute left-0 top-0 bg-timeline-row',
          slots.action,
          action.className,
        )}
        style={{ height: rowHeight }}
      >
        {getActionRender && getActionRender(nowAction, nowRow)}
        {flexible && (
          <div className={`${PREFIX}-action-left-stretch absolute left-0 top-0 h-full w-2.5 overflow-hidden rounded`} />
        )}
        {flexible && (
          <div className={`${PREFIX}-action-right-stretch absolute right-0 top-0 h-full w-2.5 overflow-hidden rounded`} />
        )}
      </div>
    </RowDnd>
  );
};
