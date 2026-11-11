# Auto-Zoom Algorithm

> How auto-zoom decides **when** a zoom happens and **where** the camera looks.
> The editor *wiring* (one-shot trigger, Regenerate, persistence, history) lives
> in `docs/editor-canvas.md` → Auto-Zoom. Code: `src/lib/auto-zoom/generate-from-
> clicks.ts` (generation) + `src/components/editor/canvas/zoom-scene.ts` +
> `pixi/zoom-spring.ts` (render-time follow + transition).

Auto-zoom is a **generator of ordinary zoom clips** (`CanvasZoomClip`). It runs on
a finished recording, reads the captured clicks (+ typing bursts), and emits plain
clips onto the existing Zoom track. The renderer, export, persistence, and Zoom
panel are the shared zoom system — auto-zoom decides **WHEN** a zoom happens
(start/end), **HOW MUCH** (scale) and the planned shot centre (focus).

Generation started as a port of **Cap's** click clustering (`~/sujit/cap`) and
was replaced (2026-11) by a **spatiotemporal shot planner**: Cap merges on time
alone, which chained a recording of scattered clicks into one long 2× zoom that
panned across the whole screen. The render-time follow is still Cap's model.

## Two cooperating pieces

1. **Generation (when / how much):** plan shots from recorded actions
   (`src/lib/auto-zoom/generate-from-clicks.ts`).
2. **Auto focus (where, at render time):** every generated clip is
   `mode: "auto"`, so the camera spring-follows the recorded cursor while held
   (`zoom-scene.ts` + `pixi/zoom-spring.ts`). See `docs/editor-canvas.md` →
   Composition Zoom Camera for the render math.

A clip can also be `mode: "manual"` (a fixed stored `focus`), set from the Zoom
panel's Auto/Manual toggle. Hand-added clips default to manual; generated clips
are auto; legacy clips with no persisted `mode` default to auto. A generated
clip's `focus` is its planned shot centre, so toggling it to Manual gives a
framed, still shot.

## Generation — shot planner

`generateZoomClipsFromClicks(clicks, durationSeconds, typingBursts)`:

1. **Actions.** Each down-click is a point action. A down followed by its up
   (same button, before the next down, ≤ 10 s) that travelled > `0.03` is one
   **drag** spanning down→up (box = both ends, tail runs from the up). Each typing
   burst is an action spanning first→last key, boxed by its caret reads
   (`AutoZoomTypingBurst.bounds`, built in `auto-zoom-scene.ts`). Actions in the
   last `1000 ms` are ignored (usually the Stop click).
2. **Shots.** Walking actions in time order, an action joins the current shot when
   it starts within `3000 ms` of the shot's last action **and** the union box
   still fits the **safe area** (`70%`) of the view at the gentlest auto scale
   (`1.5×`, i.e. extent ≤ `0.467` of the artboard). Otherwise it opens a new shot.
   An action whose own box cannot fit at `1.5×` (a screen-wide drag) is a **wide**
   action: it gets no zoom and nothing joins it.
3. **Window.** `start = firstAction − 500 ms` (with the default 1 s spring ramp the
   amount is ~97% landed, so the action plays in a settled frame);
   `end = lastActionEnd + 2000 ms` (clicks/drags) or `+ 1800 ms` (typing) — about
   1 s of settled hold after the action before the 1 s zoom-out. Clamped to
   `[1 ms, duration − 800 ms]`.
4. **Joins (no pumps).** A wide beat shorter than `1000 ms` reads as
   out-and-straight-back-in. For each pair of neighbouring shots with less than
   that between them:
   - same area (union fits at `1.5×`) → **merge** into one shot;
   - different areas → **trim** the earlier shot's tail (down to
     `lastAction + 1500 ms`) to open a ≥ 1 s beat; if that is not possible,
     **abut** them (cut after A's last action, no later than B's first) so the
     renderer welds A → B without passing through 1×;
   - if abutting would leave A shorter than `1200 ms` (rapid clicks hopping
     across the screen), **drop** A — its actions stay wide — and resolve B
     against the shot before A.
   A dropped or wide action is protected: the shots around it may neither merge
   nor weld across it, and the next shot may not start before its last action
   (pushing its start back to open the beat, or dropping it if < `1200 ms` is
   left).
5. **Framing + emit.** `scale = clamp(floor₀.₂₅(0.7 / boxExtent), 1.5, 2.0)` (a point
   → `2.0`), `focus` = box centre, `mode: "auto"`, default transition, then
   `normalizeZoomClips`.

Ids are deterministic (`auto-zoom-<startMs>-<endMs>`), so re-generating is
idempotent — the same inputs yield the same clips.

### Guaranteed invariants (randomized test, 500 seeds; 20k verified once)

- One clean lane: sorted, non-overlapping, in bounds, every clip ≥ 0.5 s,
  unchanged by a second `normalizeZoomClips`.
- Scale ∈ `[1.5, 2.0]`.
- Between consecutive clips: abutting (weld) **or** ≥ 1 s wide — never a pump.
- Every kept action point (click, drag end, typing extent) that a clip covers lies
  inside that clip's zoomed view around its planned `focus`.

### Constants

| Name | Value |
| --- | --- |
| Pre-padding (lead-in) | `500 ms` |
| Click / drag post-padding | `2000 ms` |
| Typing post-padding | `1800 ms` |
| Join gap (action → shot) | `3000 ms` |
| Min wide beat (anti-pump) | `1000 ms` |
| Min trimmed tail | `1500 ms` |
| Min welded shot | `1200 ms` |
| Drag min travel / max duration | `0.03` / `10 s` |
| Safe view fraction | `0.7` |
| Auto scale palette | `1.5 – 2.0`, step `0.25` |
| Trailing-action ignore | `1000 ms` |
| End clamp padding | `800 ms` |
| Typing burst | ≥ 3 keys, gaps ≤ `1500 ms` |

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
- **Caret follow while typing** (`zoomFollowTypingCaret`): the sampler feeding
  the spring is `sampleFollowArtboardFocus` — inside a typing session it returns
  the text caret instead of the (hidden) pointer, reading up to `300 ms` ahead
  so the camera starts moving before the first key. See `docs/editor-canvas.md`
  → Typing Behavior.

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

- No importance scoring, drag/double-click heuristics, or scene cohesion (typing
  enters only as bursts + caret follow above).
- No frame-analysis content bounds (`engagedRects`) and **no zoom-out-to-fit
  reveal**. Cap's auto mode is pure cursor-follow; a menu/popover is not framed.
  `engagedRects` remains a tolerated legacy field in the schema but is no longer
  populated or read.

## Capture data

Generation and the follow both consume the recorded cursor track
(`CursorTrackData`: display-relative `moves` + `clicks` in logical points),
mapped into artboard-normalized focus + timeline seconds by
`src/components/editor/canvas/auto-zoom-scene.ts` (the shared `displayPointToArtboard`
chain, so a zoom lands on exactly the pixel the cursor sat on). Whole-display
recordings only — window/region recordings would need target-rect normalization.

## Determinism & testing

Both generation and the follow are pure functions of their inputs:
`src/lib/auto-zoom/__tests__/generate-from-clicks.test.ts` covers the shot planner
(unit cases + the randomized invariants above);
`src/components/editor/canvas/__tests__/zoom-spring.test.ts` covers the spring
primitives; `src/components/editor/canvas/__tests__/zoom-scene.test.ts` covers the
follow path, spring transition, weld, and motion blur.
