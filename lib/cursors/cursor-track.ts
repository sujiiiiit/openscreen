// Pure processing of captured cursor data (the recording's `mousemoves-0.json`)
// into a smooth, deterministic, time-indexed trajectory the editor can sample
// by the screen video's source time.
//
// Two deliberate choices:
//   1. We precompute smoothing over a fixed timestep, so the smoothed position
//      is a pure function of time t — identical whether the user plays, scrubs
//      backward, or the exporter renders frame-by-frame. Because this is an
//      offline recorded track, the smoothing can be zero-phase (forward +
//      backward) instead of adding an explicit delay.
//   2. Time is the recording-relative elapsed ms (sample.processTimeMs minus the
//      session start), which equals the screen video element's currentTime×1000.
//      Sampling by the video's currentTime makes trims/offsets free.

export interface RawCursorSample {
  /** Recording-relative ms (processTimeMs − session.processTimeStartMs). */
  t: number
  /** Display-relative logical points, top-left origin. */
  x: number
  y: number
  cursorId: string
}

export interface SmoothedCursorTrack {
  /** Fixed-timestep smoothed positions, ascending in `t` (ms). */
  t: Float64Array
  x: Float64Array
  y: Float64Array
  /** cursorId in effect at each step (stepwise; no interpolation). */
  cursorIds: string[]
  /** Mouse button transitions, recording-relative ms, sorted ascending. */
  clicks: CursorClickEvent[]
  /** Recorded display size in points — the cursor coordinate space. */
  displayWidth: number
  displayHeight: number
  /** Total covered duration in ms. */
  durationMs: number
}

export interface CursorSmoothingParams {
  /** Exponential filter time constant. Larger = softer path. */
  timeConstantMs: number
  /** Repeated forward/backward passes. Larger = stronger smoothing. */
  passes: number
}

export interface CursorClickEvent {
  /** Recording-relative ms (processTimeMs − session.processTimeStartMs). */
  t: number
  type: "down" | "up"
}

// 120 Hz integration matches the raw capture cadence; fine enough to look
// continuous, cheap enough to pre-compute even for long recordings.
const SIM_DT_MS = 1000 / 120

/** Build raw samples from a parsed `mousemoves-0.json` array + the session start. */
export function rawSamplesFromMoves(
  moves: Array<{
    processTimeMs: number
    x: number
    y: number
    cursorId?: string
  }>,
  processTimeStartMs: number
): RawCursorSample[] {
  const samples = moves
    .map((m) => ({
      t: m.processTimeMs - processTimeStartMs,
      x: m.x,
      y: m.y,
      cursorId: m.cursorId ?? "arrow",
    }))
    .filter((s) => Number.isFinite(s.t) && s.t >= 0)
    .sort((a, b) => a.t - b.t)
  return samples
}

/**
 * Minimum dwell (ms) a cursor shape must persist to be shown when cursor-type
 * stabilization is on. Captured shapes that change and revert faster than this
 * (e.g. an I-beam blip while brushing past a text field, or a pointing-hand
 * flicker crossing a link) are held to the surrounding shape so the rendered
 * cursor doesn't flicker. Matches the "~150 ms" feel chosen for the toggle.
 */
export const CURSOR_TYPE_STABILIZE_MS = 150

/**
 * Minimum-dwell debounce of the cursor SHAPE timeline: any run of a `cursorId`
 * shorter than `thresholdMs` is relabeled to the previously committed shape, so
 * brief flickers (`arrow → iBeam → arrow`) collapse to the steady shape. Only the
 * `cursorId` field changes — positions and clicks are untouched — and it is a
 * pure function of the samples, so preview and export stay identical. The final
 * run persists to the recording end (treated as long → kept), and a short leading
 * run is kept as the initial shape (there is no prior shape to fall back to).
 */
export function stabilizeCursorIds(
  samples: RawCursorSample[],
  thresholdMs: number
): RawCursorSample[] {
  if (samples.length < 2 || thresholdMs <= 0) return samples
  const out = samples.map((s) => ({ ...s }))
  let committedId = samples[0].cursorId
  let runStart = 0
  for (let i = 1; i <= samples.length; i++) {
    const isBoundary =
      i === samples.length || samples[i].cursorId !== samples[runStart].cursorId
    if (!isBoundary) continue
    // The run [runStart, i) lasts until the next shape change; the final run
    // persists to the recording end, so treat its duration as infinite (kept).
    const dur =
      i < samples.length ? samples[i].t - samples[runStart].t : Infinity
    if (runStart > 0 && dur < thresholdMs) {
      for (let k = runStart; k < i; k++) out[k].cursorId = committedId
    } else {
      committedId = samples[runStart].cursorId
    }
    runStart = i
  }
  return out
}

/** Build normalized click events from `mouseclicks-0.json`. */
export function clickEventsFromClicks(
  clicks: Array<{ processTimeMs: number; type?: string }>,
  processTimeStartMs: number
): CursorClickEvent[] {
  return clicks
    .map((click): CursorClickEvent | null => {
      const t = click.processTimeMs - processTimeStartMs
      if (!Number.isFinite(t) || t < 0) return null
      const type = click.type?.toLowerCase()
      if (type === "mousedown" || type === "down") return { t, type: "down" }
      if (type === "mouseup" || type === "up") return { t, type: "up" }
      return null
    })
    .filter((click): click is CursorClickEvent => click !== null)
    .sort((a, b) => a.t - b.t)
}

/** Linearly interpolate the raw pointer position at time `t` (ms). */
function rawPositionAt(
  samples: RawCursorSample[],
  t: number
): { x: number; y: number } {
  if (samples.length === 0) return { x: 0, y: 0 }
  if (t <= samples[0].t) return { x: samples[0].x, y: samples[0].y }
  const last = samples[samples.length - 1]
  if (t >= last.t) return { x: last.x, y: last.y }
  // This runs only during the pre-pass; the runtime sampler below owns the
  // hot-path binary search used during playback/export.
  let lo = 0
  let hi = samples.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = samples[lo]
  const b = samples[hi]
  const span = b.t - a.t || 1
  const f = (t - a.t) / span
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

/** cursorId in effect at time `t`: the most recent sample at or before `t`. */
function cursorIdAt(samples: RawCursorSample[], t: number): string {
  let lo = 0
  let hi = samples.length - 1
  if (t <= samples[0].t) return samples[0].cursorId
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid
  }
  return samples[lo].cursorId
}

function zeroPhaseSmooth(
  values: Float64Array,
  params: CursorSmoothingParams
): Float64Array {
  const n = values.length
  if (n <= 2) return Float64Array.from(values)

  const passes = Math.max(1, Math.round(params.passes))
  const alpha =
    params.timeConstantMs <= 0
      ? 1
      : SIM_DT_MS / (params.timeConstantMs + SIM_DT_MS)

  let current = Float64Array.from(values)
  for (let pass = 0; pass < passes; pass++) {
    const forward = new Float64Array(n)
    forward[0] = current[0]
    for (let i = 1; i < n; i++) {
      forward[i] = forward[i - 1] + alpha * (current[i] - forward[i - 1])
    }

    const backward = new Float64Array(n)
    backward[n - 1] = forward[n - 1]
    for (let i = n - 2; i >= 0; i--) {
      backward[i] = backward[i + 1] + alpha * (forward[i] - backward[i + 1])
    }

    // Keep bookends exact. The renderer already holds the first/last sample
    // across stationary gaps, and drifting those endpoints looks like timing
    // error rather than smoothing.
    backward[0] = values[0]
    backward[n - 1] = values[n - 1]
    current = backward
  }

  return current
}

/**
 * Precompute a zero-phase smoothed, time-indexed track. This removes jitter
 * without adding an explicit temporal delay: unlike a live chase-spring, this
 * pass can use future samples because the recording is already complete.
 */
export function buildSmoothedTrack(
  samples: RawCursorSample[],
  displayWidth: number,
  displayHeight: number,
  params: CursorSmoothingParams,
  clicks: CursorClickEvent[] = []
): SmoothedCursorTrack {
  // Start the smoothed timeline at the FIRST captured sample, not at t=0. A
  // leading gap (mouse still until the first move) carries no samples; the
  // smoothed track is seeded at the first sample so `sampleCursorAtTime` holds
  // that position back to t=0 instead of easing in from the origin.
  const startMs = samples.length ? samples[0].t : 0
  const endMs = samples.length ? samples[samples.length - 1].t : 0
  const durationMs = endMs
  const steps = Math.max(1, Math.ceil((endMs - startMs) / SIM_DT_MS) + 1)
  const tArr = new Float64Array(steps)
  const rawX = new Float64Array(steps)
  const rawY = new Float64Array(steps)
  const cursorIds: string[] = new Array(steps)

  for (let i = 0; i < steps; i++) {
    const t = startMs + i * SIM_DT_MS
    const target = rawPositionAt(samples, t)
    tArr[i] = t
    rawX[i] = target.x
    rawY[i] = target.y
    cursorIds[i] = samples.length ? cursorIdAt(samples, t) : "arrow"
  }

  const xArr = zeroPhaseSmooth(rawX, params)
  const yArr = zeroPhaseSmooth(rawY, params)

  return {
    t: tArr,
    x: xArr,
    y: yArr,
    cursorIds,
    clicks,
    displayWidth,
    displayHeight,
    durationMs,
  }
}

/**
 * Build a track straight from the raw samples with NO smoothing — the
 * cursor passes exactly through every captured point (linear interpolation
 * between adjacent samples only). Use this to inspect raw capture accuracy /
 * density without any easing or lag.
 */
export function buildRawTrack(
  samples: RawCursorSample[],
  displayWidth: number,
  displayHeight: number,
  clicks: CursorClickEvent[] = []
): SmoothedCursorTrack {
  const n = samples.length
  const tArr = new Float64Array(n)
  const xArr = new Float64Array(n)
  const yArr = new Float64Array(n)
  const cursorIds: string[] = new Array(n)
  for (let i = 0; i < n; i++) {
    tArr[i] = samples[i].t
    xArr[i] = samples[i].x
    yArr[i] = samples[i].y
    cursorIds[i] = samples[i].cursorId
  }
  return {
    t: tArr,
    x: xArr,
    y: yArr,
    cursorIds,
    clicks,
    displayWidth,
    displayHeight,
    durationMs: n ? samples[n - 1].t : 0,
  }
}

export interface CursorSample {
  /** Display-relative logical points. */
  x: number
  y: number
  cursorId: string
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
  tMs: number
): CursorSample | null {
  const n = track.t.length
  if (n === 0) return null
  const clampedT =
    tMs < track.t[0] ? track.t[0] : tMs > track.t[n - 1] ? track.t[n - 1] : tMs

  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (track.t[mid] <= clampedT) lo = mid
    else hi = mid
  }
  const span = track.t[hi] - track.t[lo] || 1
  const f = (clampedT - track.t[lo]) / span
  return {
    x: track.x[lo] + (track.x[hi] - track.x[lo]) * f,
    y: track.y[lo] + (track.y[hi] - track.y[lo]) * f,
    cursorId: track.cursorIds[lo],
  }
}
