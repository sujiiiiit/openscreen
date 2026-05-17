import { EditData, RequiredEditData } from "./timeline";

/** Common component props */
export interface CommonProp extends RequiredEditData {
  /** Scale tick count */
  scaleCount: number;
  /** Set the scale tick count */
  setScaleCount: (scaleCount: number) => void;
  /** Cursor time */
  cursorTime: number;
  /** Current timeline width */
  timelineWidth: number;
}
