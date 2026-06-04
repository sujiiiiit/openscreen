import { TimelineRow } from '@openscreen/timeline-engine';

/**
 * Calculate the cumulative height of rows up to the given index.
 * @param editorData Editor data
 * @param rowIndex Target row index
 * @param defaultRowHeight Default row height
 * @returns Cumulative height
 */
export const calculateRowAccumulatedHeight = (
  editorData: TimelineRow[],
  rowIndex: number,
  defaultRowHeight: number
): number => {
  let accumulatedHeight = 0;
  for (let i = 0; i < rowIndex; i++) {
    accumulatedHeight += editorData[i]?.rowHeight || defaultRowHeight;
  }
  return accumulatedHeight;
};

/**
 * Calculate the total height of all rows.
 * @param editorData Editor data
 * @param defaultRowHeight Default row height
 * @returns Total height
 */
export const calculateTotalHeight = (
  editorData: TimelineRow[],
  defaultRowHeight: number
): number => {
  return editorData.reduce((total, row) => total + (row?.rowHeight || defaultRowHeight), 0);
};

/**
 * Get the array of actual row heights.
 * @param editorData Editor data
 * @param defaultRowHeight Default row height
 * @returns Array of heights
 */
export const getRowHeights = (
  editorData: TimelineRow[],
  defaultRowHeight: number
): number[] => {
  return editorData.map(row => row?.rowHeight || defaultRowHeight);
};

/**
 * Calculate the top offset of the insertion line.
 * @param editorData Editor data
 * @param targetIndex Target index
 * @param defaultRowHeight Default row height
 * @returns Top offset of the insertion line
 */
export const calculateInsertionLineTop = (
  editorData: TimelineRow[],
  targetIndex: number,
  defaultRowHeight: number
): number => {
  return calculateRowAccumulatedHeight(editorData, targetIndex, defaultRowHeight);
};

/**
 * Check whether a drag target index is valid.
 * @param targetIndex Target index
 * @param draggedIndex Index of the dragged row
 * @param totalRows Total row count
 * @returns Whether the target is valid
 */
export const isValidDragTarget = (
  targetIndex: number,
  draggedIndex: number,
  totalRows: number
): boolean => {
  // Allow dropping past the last row (targetIndex = totalRows)
  return targetIndex >= 0 && targetIndex <= totalRows && targetIndex !== draggedIndex;
};
