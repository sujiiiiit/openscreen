import { TimelineEngine } from "./engine";

export class Events {
  handlers = {};

  constructor(handlers = {}) {
    this.handlers = {
      beforeSetTime: [],
      afterSetTime: [],
      setTimeByTick: [],
      beforeSetPlayRate: [],
      afterSetPlayRate: [],
      setActiveActionIds: [],
      play: [],
      paused: [],
      ended: [],
      ...handlers,
    };
  }
}

export interface EventTypes {
  /**
   * Fired before the time is set manually.
   * @type {{ time: number, engine: TimelineEngine }}
   * @memberof EventTypes
   */
  beforeSetTime: { time: number; engine: TimelineEngine };
  /**
   * Fired after the time is set manually.
   * @type {{ time: number, engine: TimelineEngine }}
   * @memberof EventTypes
   */
  afterSetTime: { time: number; engine: TimelineEngine };
  /**
   * Fired after the time is set by a tick.
   * @type {{ time: number, engine: TimelineEngine }}
   * @memberof EventTypes
   */
  setTimeByTick: { time: number; engine: TimelineEngine };
  /**
   * Fired before the playback rate is set.
   * Returning false prevents the rate change.
   * @type {{ speed: number, engine: TimelineEngine }}
   * @memberof EventTypes
   */
  beforeSetPlayRate: { rate: number; engine: TimelineEngine };
  /**
   * Fired after the playback rate is set.
   * @type {{ speed: number, engine: TimelineEngine }}
   * @memberof EventTypes
   */
  afterSetPlayRate: { rate: number; engine: TimelineEngine };
  /**
   * Fired when playback starts.
   * @type {{engine: TimelineEngine}}
   * @memberof EventTypes
   */
  play: { engine: TimelineEngine };
  /**
   * Fired when playback is paused.
   * @type {{ engine: TimelineEngine }}
   * @memberof EventTypes
   */
  paused: { engine: TimelineEngine };
  /**
   * Fired when playback ends.
   * @type {{ engine: TimelineEngine }}
   * @memberof EventTypes
   */
  ended: { engine: TimelineEngine };
}
