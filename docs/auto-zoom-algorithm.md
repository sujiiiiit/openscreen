# Auto-Zoom Algorithm

> How auto-zoom decides **when** a zoom happens and **where** the camera looks.
> The editor *wiring* (one-shot trigger, Regenerate, persistence, history) lives
> in `docs/editor-canvas.md` → Auto-Zoom. Code: `lib/auto-zoom/generate-from-
> clicks.ts` (generation) + `components/editor/canvas/zoom-scene.ts` +
> `pixi/zoom-spring.ts` (render-time follow + transition).

Auto-zoom is a **generator of ordinary zoom clips** (`CanvasZoomClip`). It runs on
a finished recording, reads the captured clicks, and emits plain clips onto the
existing Zoom track. The renderer, export, persistence, and Zoom panel are the
shared zoom system — auto-zoom only decides **WHEN** a zoom happens (start/end).

This is a port of **Cap's** zoom model (`~/sujit/cap`). It replaced an earlier
staged, importance-driven detector (`lib/auto-zoom/{pipeline,importance,
kinematics,framing,cinematography,detectors,content-bounds}`), which was removed.

## Two cooperating pieces

1. **Generation (when):** cluster recorded clicks into zoom windows
   (`lib/auto-zoom/generate-from-clicks.ts`).
2. **Auto focus (where, at render time):** every generated clip is
   `mode: "auto"`, so its focus point is **not** stored — the camera
   spring-follows the recorded cursor while held (`zoom-scene.ts` +
   `pixi/zoom-spring.ts`). See `docs/editor-canvas.md` → Composition Zoom Camera
   for the render math.

A clip can also be `mode: "manual"` (a fixed stored `focus`), set from the Zoom
panel's Auto/Manual toggle. Hand-added clips default to manual; generated clips
are auto; legacy clips with no persisted `mode` default to auto.

## Generation — click clustering

`generateZoomClipsFromClicks(clicks, durationSeconds)` (a port of Cap's
`generate_zoom_segments_from_clicks_impl`):

1. Keep **down-clicks** only, in timeline-seconds order.
2. **Ignore trailing clicks** in the last `1000 ms` of the recording (no room to
   settle).
3. Pad each click into a window `[t − 300 ms, t + 2500 ms]`, clamped to the
   recording bounds.
4. **Merge by interval-gap:** a window joins the current cluster when it starts
   within `2500 ms` of the cluster's (growing) END — so a run of clicks up to
   ~5 s apart chains into ONE long zoom (far fewer, longer clips than a per-click
   gap). The first click's position seeds the clip's ease-in anchor (`focus`).
5. Emit each surviving window (≥ `MIN_ZOOM_CLIP_SECONDS`) as a clip at
   `scale = 2.0`, `mode: "auto"`, default transition, then `normalizeZoomClips`
   into one non-overlapping lane.

Ids are deterministic (`auto-zoom-<startMs>-<endMs>`), so re-generating is
idempotent — the same clicks yield the same clips.

### Constants (ported verbatim from Cap)

| Name | Value |
| --- | --- |
| Click pre-padding | `300 ms` |
| Click post-padding | `2500 ms` |
| Merge gap (interval-gap) | `2500 ms` |
| Trailing-click ignore | `1000 ms` |
| End clamp padding | `800 ms` |
| Start min | `1 ms` |
| Auto zoom amount | `2.0` |

## Auto focus — spring cursor-follow (render time)

For an `auto` clip, `computeZoomFollowPaths` precomputes a follow path off the hot
path (port of Cap's `zoom_focus_interpolation.rs`):

- Sample the cursor's artboard focus every `8 ms` across the hold.
- Convert each live sample into a short **predictive intent target** by blending
  toward the cursor's near-future position (`280 ms`, blend `0.58`, capped by
  the lag leash). Since the full cursor track is known, this smooths hard
  right-then-down turns into one diagonal camera intent instead of a visible
  corner chase.
- Drive a **mass-spring-damper** (`stiffness 200, damping 40, mass 2.25`) toward
  each intent target — the spring gives the cinematic lag + settle.
- **Lag leash:** cap how far the smoothed focus trails the live cursor at
  `clamp(viewportHalf · 0.65, 0.12, 0.28)` of the frame, snapping back and
  bleeding velocity so a fast flick never drags the cursor out of the window.
- **Edge-snap** (`0.25`): pin the view to a frame edge when the cursor nears it;
  storing the snapped focus in `[0,1]` also keeps the visible window inside the
  artboard (no off-frame reveal).
- A **null sample** (cursor off-screen) holds the previous target (no phantom
  motion across a gap).

The smoothed focus is baked into `8 ms` keyframes; the per-frame sampler lerps
between them, so it is pure and deterministic (preview == export). A `manual`
clip gets no path and renders as a plain fixed-focus zoom.

The follow consumes the recorded cursor metadata independently of the custom
cursor overlay. Turning off custom cursor rendering hides the sprite in preview
and export, but `auto` Zoom clips still follow the captured hotspot as long as
the cursor sidecar is available and the hotspot maps onto the screen video.

The zoom **amount** ramps on the spring too (`springEase` / `springEaseOut`), fit
into the clip's `transition.durationMs` window (default `1000 ms` = Cap's
`ZOOM_DURATION`) — see `docs/editor-canvas.md`.

## What this model does NOT do

- No importance scoring, typing/drag/double-click heuristics, or scene cohesion.
- No frame-analysis content bounds (`engagedRects`) and **no zoom-out-to-fit
  reveal**. Cap's auto mode is pure cursor-follow; a menu/popover is not framed.
  `engagedRects` remains a tolerated legacy field in the schema but is no longer
  populated or read.

## Capture data

Generation and the follow both consume the recorded cursor track
(`CursorTrackData`: display-relative `moves` + `clicks` in logical points),
mapped into artboard-normalized focus + timeline seconds by
`components/editor/canvas/auto-zoom-scene.ts` (the shared `displayPointToArtboard`
chain, so a zoom lands on exactly the pixel the cursor sat on). Whole-display
recordings only — window/region recordings would need target-rect normalization.

## Determinism & testing

Both generation and the follow are pure functions of their inputs:
`lib/auto-zoom/__tests__/generate-from-clicks.test.ts` covers clustering;
`components/editor/canvas/__tests__/zoom-spring.test.ts` covers the spring
primitives; `components/editor/canvas/__tests__/zoom-scene.test.ts` covers the
follow path, spring transition, weld, and motion blur.
