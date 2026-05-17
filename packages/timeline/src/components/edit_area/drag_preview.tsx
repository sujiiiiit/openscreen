import React, { FC } from 'react';
import { useTimelineClassNames } from '../../interface/class_names';
import { cn } from '../../utils/cn';

interface DragPreviewProps {
  /** Top offset of the preview element */
  top: number;
  /** Height of the preview element */
  height: number;
  /** Whether the preview element is visible */
  visible: boolean;
}

/**
 * Drag preview component - renders the placeholder row that follows the cursor while dragging.
 */
export const DragPreview: FC<DragPreviewProps> = ({ top, height, visible }) => {
  const slots = useTimelineClassNames();
  if (!visible) return null;

  return (
    <div
      className={cn(
        'pointer-events-none absolute left-0 right-0 z-[1001] rounded border-2 border-dashed border-timeline-guide bg-timeline-guide/30 opacity-80',
        slots.dragPreview,
      )}
      style={{ top, height }}
    >
      <div className="px-4 py-2 text-xs font-bold text-timeline-guide">Dragging...</div>
    </div>
  );
};
