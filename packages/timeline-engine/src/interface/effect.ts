import type { TimelineEngine } from "../core/engine";
import type { TimelineAction } from "./action";

export interface TimelineEffect {
  /** Effect ID */
  id: string,
  /** Effect name */
  name?: string,
  /** Effect runtime callbacks */
  source?: TimeLineEffectSource,
}

export interface EffectSourceParam {
  /** Current time */
  time: number,
  /** Whether playback is in progress */
  isPlaying: boolean,
  /** The action being processed */
  action: TimelineAction,
  /** The effect being processed */
  effect: TimelineEffect,
  /** The timeline engine instance */
  engine: TimelineEngine,
}

/**
 * Effect lifecycle callbacks.
 * @export
 * @interface TimeLineEffectSource
 */
export interface TimeLineEffectSource {
  /** Called when playback starts inside the action's time range */
  start?: (param: EffectSourceParam) => void;
  /** Called when the playhead enters the action's time range */
  enter?: (param: EffectSourceParam) => void;
  /** Called on each tick while the action is active */
  update?: (param: EffectSourceParam) => void;
  /** Called when the playhead leaves the action's time range */
  leave?: (param: EffectSourceParam) => void;
  /** Called when playback stops inside the action's time range */
  stop?: (param: EffectSourceParam) => void;
}
