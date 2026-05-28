// Pure processing of captured cursor data (the recording's `mousemoves-0.json`)
// into a smooth, deterministic, time-indexed trajectory the editor can sample
// by the screen video's source time.
//
// Two deliberate choices:
//   1. We pre-integrate a critically-damped spring over a fixed timestep, so the
//      smoothed position is a pure function of time t — identical whether the
//      user plays, scrubs backward, or the exporter renders frame-by-frame.
//      (A real-time "chase the pointer" spring would depend on animation
//      history and desync on scrub/export.)
//   2. Time is the recording-relative elapsed ms (sample.processTimeMs minus the
//      session start), which equals the screen video element's currentTime×1000.
//      Sampling by the video's currentTime makes trims/offsets free.

export interface RawCursorSample {
  /** Recording-relative ms (processTimeMs − session.processTimeStartMs). */
  t: number;
  /** Display-relative logical points, top-left origin. */
  x: number;
  y: number;
  cursorId: string;
}

export interface SmoothedCursorTrack {
  /** Fixed-timestep smoothed positions, ascending in `t` (ms). */
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
  /** cursorId in effect at each step (stepwise; no interpolation). */
  cursorIds: string[];
  /** Recorded display size in points — the cursor coordinate space. */
  displayWidth: number;
  displayHeight: number;
  /** Total covered duration in ms. */
  durationMs: number;
}

// Screen Studio's mouseMovementSpring defaults (project.json): a calm,
// slightly-overdamped follow that hides capture jitter without visible lag.
export interface SpringParams {
  stiffness: number;
  damping: number;
  mass: number;
}

export const DEFAULT_CURSOR_SPRING: SpringParams = {
  stiffness: 470,
  damping: 70,
  mass: 3,
};

// 120 Hz integration matches the raw capture cadence; fine enough to look
// continuous, cheap enough to pre-compute even for long recordings.
const SIM_DT_MS = 1000 / 120;

/** Build raw samples from a parsed `mousemoves-0.json` array + the session start. */
export function rawSamplesFromMoves(
  moves: Array<{ processTimeMs: number; x: number; y: number; cursorId?: string }>,
  processTimeStartMs: number,
): RawCursorSample[] {
  const samples = moves
    .map((m) => ({
      t: m.processTimeMs - processTimeStartMs,
      x: m.x,
      y: m.y,
      cursorId: m.cursorId ?? "arrow",
    }))
    .filter((s) => Number.isFinite(s.t) && s.t >= 0)
    .sort((a, b) => a.t - b.t);
  return samples;
}

/** Linearly interpolate the raw pointer position at time `t` (ms). */
function rawPositionAt(samples: RawCursorSample[], t: number): { x: number; y: number } {
  if (samples.length === 0) return { x: 0, y: 0 };
  if (t <= samples[0].t) return { x: samples[0].x, y: samples[0].y };
  const last = samples[samples.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y };
  // Linear scan is fine here — this runs once per sim step during the
  // pre-pass, and we advance a cursor index monotonically in the caller.
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.t - a.t || 1;
  const f = (t - a.t) / span;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** cursorId in effect at time `t`: the most recent sample at or before `t`. */
function cursorIdAt(samples: RawCursorSample[], t: number): string {
  let lo = 0;
  let hi = samples.length - 1;
  if (t <= samples[0].t) return samples[0].cursorId;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return samples[lo].cursorId;
}

/**
 * Pre-integrate a critically-damped spring over the samples into a smoothed,
 * time-indexed track. The result is deterministic and cheap to sample.
 */
export function buildSmoothedTrack(
  samples: RawCursorSample[],
  displayWidth: number,
  displayHeight: number,
  spring: SpringParams = DEFAULT_CURSOR_SPRING,
): SmoothedCursorTrack {
  // Start the smoothed timeline at the FIRST captured sample, not at t=0. A
  // leading gap (mouse still until the first move) carries no samples; the
  // spring is seeded at the first sample so `sampleCursorAtTime` holds that
  // position back to t=0 instead of springing in from the origin.
  const startMs = samples.length ? samples[0].t : 0;
  const endMs = samples.length ? samples[samples.length - 1].t : 0;
  const durationMs = endMs;
  const steps = Math.max(1, Math.ceil((endMs - startMs) / SIM_DT_MS) + 1);
  const tArr = new Float64Array(steps);
  const xArr = new Float64Array(steps);
  const yArr = new Float64Array(steps);
  const cursorIds: string[] = new Array(steps);

  const dt = SIM_DT_MS / 1000; // seconds for the physics
  const { stiffness, damping, mass } = spring;

  // Seed at the first real sample so there's no spring-in from origin.
  let px = samples.length ? samples[0].x : 0;
  let py = samples.length ? samples[0].y : 0;
  let vx = 0;
  let vy = 0;

  for (let i = 0; i < steps; i++) {
    const t = startMs + i * SIM_DT_MS;
    const target = rawPositionAt(samples, t);
    // Semi-implicit Euler — stable for stiff springs.
    const ax = (-stiffness * (px - target.x) - damping * vx) / mass;
    const ay = (-stiffness * (py - target.y) - damping * vy) / mass;
    vx += ax * dt;
    vy += ay * dt;
    px += vx * dt;
    py += vy * dt;
    tArr[i] = t;
    xArr[i] = px;
    yArr[i] = py;
    cursorIds[i] = samples.length ? cursorIdAt(samples, t) : "arrow";
  }

  return {
    t: tArr,
    x: xArr,
    y: yArr,
    cursorIds,
    displayWidth,
    displayHeight,
    durationMs,
  };
}

/**
 * Build a track straight from the raw samples with NO spring smoothing — the
 * cursor passes exactly through every captured point (linear interpolation
 * between adjacent samples only). Use this to inspect raw capture accuracy /
 * density without any easing or lag.
 */
export function buildRawTrack(
  samples: RawCursorSample[],
  displayWidth: number,
  displayHeight: number,
): SmoothedCursorTrack {
  const n = samples.length;
  const tArr = new Float64Array(n);
  const xArr = new Float64Array(n);
  const yArr = new Float64Array(n);
  const cursorIds: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    tArr[i] = samples[i].t;
    xArr[i] = samples[i].x;
    yArr[i] = samples[i].y;
    cursorIds[i] = samples[i].cursorId;
  }
  return {
    t: tArr,
    x: xArr,
    y: yArr,
    cursorIds,
    displayWidth,
    displayHeight,
    durationMs: n ? samples[n - 1].t : 0,
  };
}

export interface CursorSample {
  /** Display-relative logical points. */
  x: number;
  y: number;
  cursorId: string;
}

/**
 * Sample the smoothed track at recording-relative time `tMs` (= screen video
 * currentTime × 1000). The pointer is physically on screen for the entire
 * recording, but event-based capture writes nothing while it is stationary — so
 * a leading gap (mouse still at start) or trailing gap (mouse parked on the Stop
 * button) leaves no samples at the ends. We therefore HOLD the first / last
 * known position across those gaps rather than hiding the cursor: the position
 * is correct precisely because the mouse wasn't moving there. Returns null only
 * for an empty track; the overlay's own crop test handles off-screen hiding.
 */
export function sampleCursorAtTime(
  track: SmoothedCursorTrack,
  tMs: number,
): CursorSample | null {
  const n = track.t.length;
  if (n === 0) return null;
  const clampedT =
    tMs < track.t[0] ? track.t[0] : tMs > track.t[n - 1] ? track.t[n - 1] : tMs;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track.t[mid] <= clampedT) lo = mid;
    else hi = mid;
  }
  const span = track.t[hi] - track.t[lo] || 1;
  const f = (clampedT - track.t[lo]) / span;
  return {
    x: track.x[lo] + (track.x[hi] - track.x[lo]) * f,
    y: track.y[lo] + (track.y[hi] - track.y[lo]) * f,
    cursorId: track.cursorIds[lo],
  };
}
