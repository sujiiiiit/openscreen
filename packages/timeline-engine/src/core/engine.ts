import { Emitter } from './emitter';
import { Events, EventTypes } from './events';
import { TimelineAction, TimelineRow } from '../interface/action';
import { TimelineEffect } from '../interface/effect';

const PLAYING = 'playing';
const PAUSED = 'paused';
type PlayState = 'playing' | 'paused';

export interface ITimelineEngine extends Emitter<EventTypes> {
  readonly isPlaying: boolean;
  readonly isPaused: boolean;
  effects: Record<string, TimelineEffect>;
  data: TimelineRow[];
  /** Set the playback rate */
  setPlayRate(rate: number): boolean;
  /** Get the playback rate */
  getPlayRate(): number;
  /** Re-render the current frame */
  reRender(): void;
  /** Set the current playback time */
  setTime(time: number, isTick?: boolean): boolean;
  /** Get the current playback time */
  getTime(): number;
  /** Start playback */
  play(param: {
    /** Defaults to playing from start to end; takes precedence over autoEnd */
    toTime?: number;
    /** Whether to stop automatically once playback completes */
    autoEnd?: boolean;
  }): boolean;
  /** Pause playback */
  pause(): void;
}

/**
 * Timeline player.
 * Can run standalone, independently of the editor.
 * @export
 * @class TimelineEngine
 * @extends {Emitter<EventTypes>}
 */
export class TimelineEngine extends Emitter<EventTypes> implements ITimelineEngine {
  constructor() {
    super(new Events());
  }

  /** requestAnimationFrame timerId */
  private _timerId: number | undefined;

  /** Playback rate */
  private _playRate = 1;
  /** Current time */
  private _currentTime: number = 0;
  /** Playback state */
  private _playState: PlayState = 'paused';
  /** Timestamp of the previous frame */
  private _prev: number = 0;

  /** Map of action effects */
  private _effectMap: Record<string, TimelineEffect> = {};
  /** Map of actions to execute */
  private _actionMap: Record<string, TimelineAction> = {};
  /** Action IDs sorted by ascending start time */
  private _actionSortIds: string[] = [];

  /** Index of the next action to process */
  private _next: number = 0;
  /** IDs of actions whose time range currently contains the playhead */
  private _activeActionIds: string[] = [];

  /** Whether playback is in progress */
  get isPlaying() {
    return this._playState === 'playing';
  }
  /** Whether playback is paused */
  get isPaused() {
    return this._playState === 'paused';
  }

  set effects(effects: Record<string, TimelineEffect>) {
    this._effectMap = effects;
  }
  set data(data: TimelineRow[]) {
    if (this.isPlaying) this.pause();
    this._dealData(data);
    this._dealClear();
    this._dealEnter(this._currentTime);
  }

  /**
   * Set the playback rate.
   * @memberof TimelineEngine
   */
  setPlayRate(rate: number): boolean {
    if (rate <= 0) {
      console.error('Error: rate cannot be less than 0!');
      return false;
    }
    const result = this.trigger('beforeSetPlayRate', { rate, engine: this });
    if (!result) return false;
    this._playRate = rate;
    this.trigger('afterSetPlayRate', { rate, engine: this });

    return true;
  }
  /**
   * Get the playback rate.
   * @memberof TimelineEngine
   */
  getPlayRate() {
    return this._playRate;
  }

  /**
   * Re-render the current frame.
   * @return {*}
   * @memberof TimelineEngine
   */
  reRender() {
    if (this.isPlaying) return;
    this._tickAction(this._currentTime);
  }

  /**
   * Set the current playback time.
   * @param {number} time
   * @param {boolean} [isTick] Whether this update originates from a tick
   * @memberof TimelineEngine
   */
  setTime(time: number, isTick?: boolean): boolean {
    const result = isTick || this.trigger('beforeSetTime', { time, engine: this });
    if (!result) return false;

    this._currentTime = time;

    this._next = 0;
    this._dealLeave(time);
    this._dealEnter(time);

    if (isTick) this.trigger('setTimeByTick', { time, engine: this });
    else this.trigger('afterSetTime', { time, engine: this });
    return true;
  }
  /**
   * Get the current playback time.
   * @return {*}  {number}
   * @memberof TimelineEngine
   */
  getTime(): number {
    return this._currentTime;
  }

  /**
   * Start playback from the current time.
   * @param param
   * @return {boolean} {boolean}
   */
  play(param: {
    /** Defaults to playing from start to end; takes precedence over autoEnd */
    toTime?: number;
    /** Whether to stop automatically once playback completes */
    autoEnd?: boolean;
  }): boolean {
    const { toTime, autoEnd } = param;

    const currentTime = this.getTime();
    /** Bail out if already playing, or if the requested end time is not after the current time */
    if (this.isPlaying || (toTime && toTime <= currentTime)) return false;

    // Update playback state
    this._playState = PLAYING;

    // Fire `start` on currently active actions
    this._startOrStop('start');

    // Emit event
    this.trigger('play', { engine: this });

    this._timerId = requestAnimationFrame((time: number) => {
      this._prev = time;
      this._tick({ now: time, autoEnd, to: toTime });
    });
    return true;
  }

  /**
   * Pause playback.
   * @memberof TimelineEngine
   */
  pause() {
    if (this.isPlaying) {
      this._playState = PAUSED;
      // Fire `stop` on currently active actions
      this._startOrStop('stop');

      this.trigger('paused', { engine: this });
    }
    this._timerId && cancelAnimationFrame(this._timerId);
  }

  /** Playback finished */
  private _end() {
    this.pause();
    this.trigger('ended', { engine: this });
  }

  private _startOrStop(type?: 'start' | 'stop') {
    for (let i = 0; i < this._activeActionIds.length; i++) {
      const actionId = this._activeActionIds[i];
      const action = this._actionMap[actionId];
      const effect = this._effectMap[action?.effectId];

      if (type === 'start') {
        effect?.source?.start && effect.source.start({ action, effect, engine: this, isPlaying: this.isPlaying, time: this.getTime() });
      } else if (type === 'stop') {
        effect?.source?.stop && effect.source.stop({ action, effect, engine: this, isPlaying: this.isPlaying, time: this.getTime() });
      }
    }
  }

  /** Per-frame tick */
  private _tick(data: { now: number; autoEnd?: boolean; to?: number }) {
    if (this.isPaused) return;
    const { now, autoEnd, to } = data;

    // Compute the current time
    let currentTime = this.getTime() + (Math.min(1000, now - this._prev) / 1000) * this._playRate;
    this._prev = now;

    // Apply the current time
    if (to && to <= currentTime) currentTime = to;
    this.setTime(currentTime, true);

    // Run actions
    this._tickAction(currentTime);
    // When auto-stopping, check whether all actions have finished
    if (!to && autoEnd && this._next >= this._actionSortIds.length && this._activeActionIds.length === 0) {
      this._end();
      return;
    }

    // Check whether playback has reached the target time
    if (to && to <= currentTime) {
      this._end();
    }

    if (this.isPaused) return;
    this._timerId = requestAnimationFrame((time) => {
      this._tick({ now: time, autoEnd, to });
    });
  }

  /** Execute active actions for the given tick */
  private _tickAction(time: number) {
    this._dealEnter(time);
    this._dealLeave(time);

    // render
    const length = this._activeActionIds.length;
    for (let i = 0; i < length; i++) {
      const actionId = this._activeActionIds[i];
      const action = this._actionMap[actionId];
      const effect = this._effectMap[action.effectId];
      if (effect && effect.source?.update) {
        effect.source.update({ time, action, isPlaying: this.isPlaying, effect, engine: this });
      }
    }
  }

  /** Reset active-action state */
  private _dealClear() {
    while (this._activeActionIds.length) {
      const actionId = this._activeActionIds.shift();
      const action = this._actionMap[actionId as string];

      const effect = this._effectMap[action?.effectId];
      if (effect?.source?.leave) {
        effect.source.leave({ action, effect, engine: this, isPlaying: this.isPlaying, time: this.getTime() });
      }
    }
    this._next = 0;
  }

  /** Handle actions entering the active range at the given time */
  private _dealEnter(time: number) {
    // add to active
    while (this._actionSortIds[this._next]) {
      const actionId = this._actionSortIds[this._next];
      const action = this._actionMap[actionId];

      if (!action.disable) {
        // Stop once we reach an action that hasn't started yet

        if (action.start > time) break;
        // The action is eligible to start
        if (action.end > time && !this._activeActionIds.includes(actionId)) {
          const effect = this._effectMap[action.effectId];
          if (effect && effect.source?.enter) {
            effect.source.enter({ action, effect, isPlaying: this.isPlaying, time, engine: this });
          }

          this._activeActionIds.push(actionId);
        }
      }
      this._next++;
    }
  }

  /** Handle actions leaving the active range at the given time */
  private _dealLeave(time: number) {
    let i = 0;
    while (this._activeActionIds[i]) {
      const actionId = this._activeActionIds[i];
      const action = this._actionMap[actionId];

      // Outside the action's playback window
      if (action.start > time || action.end < time) {
        const effect = this._effectMap[action.effectId];

        if (effect && effect.source?.leave) {
          effect.source.leave({ action, effect, isPlaying: this.isPlaying, time, engine: this });
        }

        this._activeActionIds.splice(i, 1);
        continue;
      }
      i++;
    }
  }

  /** Normalize incoming row data into the engine's internal maps */
  private _dealData(data: TimelineRow[]) {
    const actions: TimelineAction[] = [];
    data.map((row) => {
      actions.push(...row.actions);
    });
    const sortActions = actions.sort((a, b) => a.start - b.start);
    const actionMap: Record<string, TimelineAction> = {};
    const actionSortIds: string[] = [];

    sortActions.forEach((action) => {
      actionSortIds.push(action.id);
      actionMap[action.id] = { ...action };
    });
    this._actionMap = actionMap;
    this._actionSortIds = actionSortIds;
  }
}
