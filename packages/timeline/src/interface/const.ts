export const PREFIX = `timeline-editor`;

/** Initial cursor time */
export const START_CURSOR_TIME = 0;
/** Default scale */
export const DEFAULT_SCALE = 1;
/** Default number of subdivisions per scale */
export const DEFAULT_SCALE_SPLIT_COUNT = 10;

/** Default scale width in pixels */
export const DEFAULT_SCALE_WIDTH = 160;
/** Default left offset where the scale starts */
export const DEFAULT_START_LEFT = 20;
/** Default minimum move step in pixels */
export const DEFAULT_MOVE_GRID = 1;
/** Default snap distance in pixels */
export const DEFAULT_ADSORPTION_DISTANCE = 8;
/** Default action row height */
export const DEFAULT_ROW_HEIGHT = 32;

/** Minimum scale count */
export const MIN_SCALE_COUNT = 20;
/** Maximum scale count */
export const MAX_SCALE_COUNT = Infinity;
/** Number of scales added per increment */
export const ADD_SCALE_COUNT = 5;

/** Error messages */
export const ERROR = {
  START_TIME_LESS_THEN_ZERO: 'Action start time cannot be less than 0!',
  END_TIME_LESS_THEN_START_TIME: 'Action end time cannot be less then start time!',
}
