# Auto-Zoom — Implementation Plan

> Status: **plan / not yet implemented.** Authored 2026-05-29 from a 3-researcher
> design pass (detection / motion / architecture). This document is the
> single source of truth for the build; update it as the implementation lands,
> then fold the shipped behaviour into `docs/editor-canvas.md` (Auto-Zoom +
> Export Pipeline + Project Persistence) and `docs/normal-term.md` per the
> repo's doc rules.

## Goal

After a recording, analyse the captured cursor + keyboard data and generate a
handful of **cinematic, editable zoom keyframes** — Screen-Studio-style "push in
on the action, hold, ease back out." The bar is *calm and intentional*, never a
follow-cam. The detector is offline (post-recording), which is the whole
advantage: it can see the future and place the push-in so it lands exactly as a
click happens.

## Decisions locked by the user (2026-05-29)

1. **Whole-composite zoom** — background, grain, video, and cursor scale
   together as one camera (matches Screen Studio). Accepted trade-off: the
   fixed-density grain pattern magnifies (gets coarser) at high zoom; documented
   limitation, not fixed in v1.
2. **The tuned palette** — `1.6×` on clicks, `2.0×` on text entry, hard cap
   `2.5×`; asymmetric ease `600 ms` in / `750 ms` (lazier) out.
3. The keyframes are **suggestions the user can edit/disable/delete** — never a
   locked black box.

## Guiding principle

Make **fewer, longer, more-confident** zooms. A static wide shot is the default;
most of the timeline has no zoom. Every threshold biases toward *not* zooming.
Motion polish (anticipation, hysteresis, smoothstep) matters more than detection
accuracy — a mediocre detector with beautiful motion beats the reverse.

---

## Data inputs (verified on a real recording)

Written by the mac-addon to the recording folder, time-aligned so
`processTimeMs − processTimeStartMs == screen-video source time` (alignment
already solved; see `project_input_capture` memory):

- **`mousemoves-0.json`** — `{x, y, cursorId, activeModifiers, processTimeMs, type:"mouseMoved"}`,
  ~120 Hz. `x/y` are logical display points, top-left origin, clamped to display bounds.
- **`mouseclicks-0.json`** — `{button, type:"mouseDown"|"mouseUp", x, y, cursorId, processTimeMs}`.
- **`keystrokes-0.json`** — **opt-in**, may be absent/empty. `{character, processTimeMs, activeModifiers}`.
- **`cursorId`** is semantic: `arrow`, `pointingHand` (link/button), `iBeam`/text
  (typing), `resize*` (dragging a handle) — used to disambiguate intent.
- Display bounds + `scaleFactor` (backing scale) come from `recording.json`.

The existing cursor pipeline (`getCursorData` IPC → `CursorTrackData`) already
parses `mousemoves-0.json` + the input manifest entry. Auto-zoom adds a sibling
`getInputData` that also returns clicks + keystrokes (one round-trip).

---

## Architecture — three pure modules, mirroring the cursor pattern

The cursor feature is the exact template to copy: a pure deterministic
`lib/cursors/cursor-track.ts` (detect/sample) + a shared
`components/editor/canvas/cursor-scene.ts` (`placeCursor`, used by **both** the
editor overlay and the exporter). Auto-zoom is the same shape.

### 1. `lib/auto-zoom/zoom-track.ts` (pure detector + sampler)

No React / DOM / `Date.now()` / `Math.random()`. Stable sort, deterministic ids,
fixed reducer order, specified summation order — identical input ⇒ byte-identical
keyframes.

```ts
// Recording-relative events (t = processTimeMs − processTimeStartMs, ms).
export interface ZoomInputEvent {
  t: number
  x: number            // display points, top-left origin
  y: number
  kind: 'click' | 'drag' | 'key' | 'move'
  cursorId: string
  dragEndT?: number    // for kind:'drag', the mouseUp time
  dragEndX?: number
  dragEndY?: number
}

// Persisted INTENT keyframe — NOT the baked ramp. Lead-in/ease times are
// re-derived at sample time, so tuning LEAD_IN_MS/EASE_*_MS later improves
// already-saved projects.
export interface ZoomKeyframe {
  id: string                 // deterministic hash of (round(tStartMs), focus)
  tStartMs: number           // hold-window start in source time (lead-in folded in)
  tEndMs: number             // hold-window end in source time
  focus: { x: number; y: number }   // NORMALIZED 0..1 in display space
  scale: number              // quantized to the palette, ≤ ZOOM_MAX
  kind: 'click' | 'drag' | 'typing' | 'dwell'
  confidence: number         // 0..1
  enabled: boolean
}

export interface ZoomGeometry {
  displayWidth: number
  displayHeight: number
  durationMs: number
}

export function rawEventsFromSidecars(
  moves: Array<{ processTimeMs: number; x: number; y: number; cursorId?: string }>,
  clicks: Array<{ processTimeMs: number; x: number; y: number; type: string; cursorId?: string }>,
  keystrokes: Array<{ processTimeMs: number }> | null,
  processTimeStartMs: number,
): ZoomInputEvent[]

export function buildAutoZoomKeyframes(
  events: ZoomInputEvent[],
  geom: ZoomGeometry,
  params?: Partial<AutoZoomParams>,
): ZoomKeyframe[]

// Closed-form smoothstep ease-in → hold → ease-out around each enabled
// keyframe's window. Total over any keyframe set (overlap-safe). Returns the
// camera in DISPLAY POINTS (focus) + scale; identity {scale:1} between zooms.
export function sampleAutoZoomAtTime(
  keyframes: ZoomKeyframe[],
  sourceMs: number,
  params?: Partial<AutoZoomParams>,
): { scale: number; focusX: number; focusY: number }
```

### 2. `components/editor/canvas/zoom-scene.ts` (shared geometry, used by both render paths)

First, **extract** the display-point→artboard block currently inlined in
`placeCursor` (`cursor-scene.ts:123-144`) into a shared
`displayPointToArtboard()` and have `placeCursor` call it — so the cursor and the
camera map points through *the same* cover-crop + transform math and can never
drift.

```ts
export interface DisplayToArtboard {
  artboardX: number
  artboardY: number
  /** uniform px-per-display-point scale (cover crop preserves aspect) */
  scale: number
}
export function displayPointToArtboard(
  displayX: number, displayY: number,
  video: CursorVideoGeometry,     // already exported from cursor-scene.ts
  displayWidth: number, displayHeight: number,
): DisplayToArtboard

export interface AutoZoomCamera {
  scale: number      // 1 = no zoom (identity-snapped within EPSILON)
  offsetX: number    // artboard-space translation
  offsetY: number
}

// Sample the keyframes at source time, map the normalized focus → artboard
// space, build the scale + translation, and CLAMP so the visible window
// (artboard W/scale × H/scale) stays inside the artboard (no exposed edges).
// Pure: editor tick and export loop call it at the same source time.
export function placeAutoZoomCamera(
  keyframes: ZoomKeyframe[],
  video: CursorVideoGeometry,
  artboard: { width: number; height: number },
  geom: { displayWidth: number; displayHeight: number },
  sourceSeconds: number,
): AutoZoomCamera

// Tiny helper that writes the camera onto a Konva node (Layer or Group).
// scale + position; identity-snaps to {1,0,0}.
export function applyCamera(node: Konva.Node, cam: AutoZoomCamera): void
```

**Camera math.** Choose the focus point `c` in artboard space (focus normalized
→ display points → `displayPointToArtboard`). The viewer always sees the fixed
artboard `W×H`; a zoom of `S` shows a window `W/S × H/S` centred on `c`. So
`scale = S`, and the translation pins `c` to the artboard centre:
`offset = center − S·c`. **Pan-clamp:** clamp `c.x ∈ [W/(2S), W − W/(2S)]`
(and y) *before* computing the offset, so the window never exposes outside the
artboard. If the clamp interval is empty (focus too near an edge at that scale),
reduce `S` toward 1 until it fits; if even `S=1` can't contain, emit identity.
`placeAutoZoomCamera` owns this clamp identically for both paths.

### 3. Thin callers (editor + export) — see Wiring.

---

## Detection pipeline (inside `buildAutoZoomKeyframes`)

| # | Stage | What |
|---|---|---|
| 1 | Parse | `rawEventsFromSidecars`: normalize to recording-relative ms, drop `t < 0`, stable-sort by `(t, click > key > move)`. Reuse `rawSamplesFromMoves`' shape. Tolerate missing/empty keystrokes. |
| 2 | Score intent | Weight each non-move event: click `1.0`, drag(travel > `DRAG_MIN_TRAVEL`) `1.2`, typing-burst/iBeam `1.0`, dwell `0.5`, raw moves **`0`**. cursorId multipliers: `pointingHand ×1.15`, `iBeam ×1.1`. Collapse `mouseDown→mouseUp` with travel > `DRAG_MIN_TRAVEL` into one drag event spanning the gesture. |
| 3 | Temporal segment | Single linear pass; new segment when the gap to the previous scored event > `SEGMENT_GAP_MS`. Accumulate weighted events per segment. Optional **one** spatial split per segment when it spans far-apart locations with a clear internal temporal seam. |
| 4 | Resolve focus + scale | Focus = the **settle point** (3-sample median speed low-pass; first sustained-low after a ballistic peak) or directly the click `x/y` (ground-truth settle) — *never the mid-flight arc*. Focus = intent-weighted centroid dominated by clicks/settle, clamped in-frame, stored **normalized**. Scale from the 80th-percentile spatial spread mapped via `FRAME_FILL`, quantized to the palette, capped at `ZOOM_MAX`. |
| 5 | Reduce (fixed order) | (a) drop segment weight < `MIN_SEGMENT_WEIGHT`; (b) **merge** segments closer than `MERGE_GAP_MS` with focus within `MERGE_DIST` into one continuous hold; (c) drop/extend windows shorter than `MIN_HOLD_MS`; (d) keep top-N by confidence under `MAX_ZOOMS_PER_MIN`; (e) re-sort by time. Snapshot-tested. |
| 6 | Emit | `ZoomKeyframe[]` with lead-in folded into `tStartMs` (shift earlier by `LEAD_IN_MS`), `tEndMs` extended for hysteresis and clamped to `durationMs − TAIL_GUARD_MS`. |

### When / Where / How much / Typing

- **When** — a segment must clear `MIN_SEGMENT_WEIGHT`, survive the reducer, and
  the clip must be ≥ `MIN_CLIP_MS`. Raw moves never trigger.
- **Where** — settle point or click position; typing anchors to the preceding
  `iBeam` click / pre-burst settle (the mouse is *still* during typing — never
  use the live mouse position).
- **How much** — tight cluster → palette top; broad activity → gentler; capped
  at `2.5×` (source-sharpness ceiling at the recording backing scale).
- **Typing** — burst = ≥2 keys within `TYPE_GAP_MS`, or any key while
  `cursorId == 'iBeam'`. Use `ZOOM_TYPING` and a longer hold (cover the keystroke
  span + a short tail). No keystrokes sidecar → fall back to `iBeam` on
  clicks/moves; tabbed-into-field with no anchor → accept a missed zoom in v1.

---

## Motion (inside `sampleAutoZoomAtTime`)

- **Easing** — closed-form **smoothstep** (cubic, C1-continuous, zero overshoot)
  over explicit ease-in → hold → ease-out windows. **No physics spring in v1.**
  Overshoot/bounce easing banned (the cheap-motion tell on a full-frame camera).
- **Anticipation** — lead-in folded into `tStartMs` at generate time, so the
  push-in lands as the click happens, and a trim clips it naturally like any
  other window.
- **Hysteresis** — asymmetric eager-in / lazy-out (`EASE_OUT_MS > EASE_IN_MS`);
  `tEndMs` extended before the ease-out so the camera holds through short pauses.
  Adjacent segments within `MERGE_GAP_MS`/`MERGE_DIST` are merged at detection
  time, so the camera never zooms out only to immediately zoom back in.
- **No deadzone pan in v1** — every zoom is a **static hold** on a fixed focus.
  The only motion is segment-to-segment transitions (direct eased retarget).
  Deadzone lazy-follow is deferred.
- **Rate limit** — `MAX_ZOOMS_PER_MIN` + `MIN_HOLD_MS` + the merge step, all at
  plan time (deterministic).

---

## Persistence — persist the intent keyframes, do NOT derive-on-load

The user can edit/disable keyframes, so they must survive a refresh ⇒ persist.
Persist **only** the detector's intent (window + normalized focus + scale + kind
+ enabled), not the baked ramps, so motion-constant tuning improves old projects.
Export reads the persisted keyframes and **never re-detects**, so future detector
tuning can't desync preview from MP4.

Add an **optional** field — no version bump (mirrors `cursorSizeMultiplier` /
`onCanvas` precedent; `parseProjectState` tolerates absent optionals, old
`project.json` keeps loading):

```ts
// project-schema.ts — ProjectArtboard
autoZoom?: { keyframes: ProjectZoomKeyframe[] }
```

Wire in lock-step (per CLAUDE.md persistence rules):

- **`electron/ipc/project-schema.ts`** — `ProjectZoomKeyframe` type + `parseArtboard`
  reads `autoZoom` via a tolerant `parseZoomKeyframe` (clamp scale to `[1, ZOOM_MAX]`,
  focus to `[0,1]`, drop malformed entries; absent → `undefined`). No reject on missing.
- **`types/api.d.ts`** — mirror `ProjectZoomKeyframe` + the `autoZoom` field.
- **`components/editor/canvas/persistence.ts`** — `serializeArtboard` emits
  `autoZoom` (omit when empty, to keep legacy `project.json` byte-identical and
  the post-hydration autosave a no-op); add the deserialize half. **Include
  `autoZoom` in `fingerprintProjectState`** so edits trigger a save — this is why
  the keyframe `id` MUST be deterministic (a re-stamped id would churn the
  fingerprint into a save loop).
- **`components/editor/canvas/provider.tsx`** — hold the keyframes in editor
  state; apply in **both** hydration paths (fast-path restore + slow-path
  synthesis), **reset** in the project-switch block, and add to the
  **autosave-effect dependency** list. (Detection itself runs only on the
  explicit button, below — hydration just restores what was saved.)
- **Save-status** — the "Auto-zoom" generate writes through the normal autosave
  debounce; no parallel save mechanism.

---

## Wiring the camera into the two render paths

The **math is shared** (`placeAutoZoomCamera` → `{scale, offsetX, offsetY}`);
only the *application site* differs, because the two stages are structured
differently (same situation as `placeCursor` today).

### Editor (`editor-workspace.tsx`)

Whole-composite ⇒ transform **background + content together**, but **not** the
snap-guide / overlay chrome layers.

- The background lives in the first `<Layer listening={false}>` (`ArtboardBackground`
  + `ArtboardGrain` + `ArtboardPixelGrid`, line ~1366). Add a `backgroundLayerRef`.
- The content lives in `contentLayerRef`, inside an **artboard-clip `Group`**
  (`clipX/Y/Width/Height`, line ~1393) holding the videos + `CanvasCursorOverlay`.
- **Keep the artboard viewport fixed while its contents scale:** introduce one
  **inner camera `Group`** *inside* the existing clip group (wrapping the videos +
  cursor) and apply the camera to it — so the clip rect and the artboard border
  stay put while the content scales. Apply the same camera to the background
  group/layer. Do **not** apply it to the clip group itself (its clip would scale)
  nor to the layer wholesale (the artboard-fill hit-rect + border rect would move).
- Drive it imperatively from the existing timeline tick (the same hot path
  `CanvasCursorOverlay` uses via `subscribeTimelineTicks` / `subscribeHoverTime`):
  sample the keyframes, `applyCamera(...)` to the background group + inner camera
  group, `batchDraw()`. **No per-frame React state.**
- The camera composes **under** the user's stage-level `ViewTransform` (pan/zoom
  for inspection) — so the user can still inspect while the camera animates inside
  the artboard the viewer will see. Pixel grid note: it currently sits in the
  background group and will zoom with it; if that's unwanted it should move to an
  overlay (chrome) layer — flag, not v1-critical.

### Export (`build-stage.ts` + `run-export.ts`)

The export stage is exactly artboard-sized (`stage.scale = outputW/artboardW`),
has **no** clip group, and the background/content are separate `Konva.Layer`s —
so apply the camera **at layer level** to `handles.backgroundLayer` and
`handles.contentLayer` (both children of the stage, composing under the stage
scale). Build a `ZoomCameraHandle` in `buildExportStage` analogous to the cursor
handle (carry the keyframes + geometry).

In the `run-export.ts` frame loop, per frame:
1. Compute `cam = placeAutoZoomCamera(keyframes, screenVideo, artboard, geom, screenEntry.sourceTimeSec)` using the active screen clip's source time (honours trims/splits via the frame plan).
2. `applyCamera(handles.contentLayer, cam)` **and** `applyCamera(handles.backgroundLayer, cam)`.
3. **Background redraw fix:** today the background is drawn **once** (`run-export.ts:290`)
   and only `contentLayer.draw()` runs per frame. With whole-composite zoom the
   background transforms too, so it must be **re-drawn on frames where the camera
   transform changed** (track the previous `cam`; if equal — e.g. an identity
   stretch between zooms — keep the draw-once optimization). On `scale==1`
   (identity-snap) the background can stay as last drawn.

### Generate trigger

An explicit **"Auto-zoom" button** runs the detector once
(`getInputData` → `buildAutoZoomKeyframes`) and writes `enabled:true` keyframes so
the effect shows immediately. **"Regenerate"** re-runs with a confirm and
overwrites. (Auto-on-first-open is a one-line follow-up once tuning is trusted.)

---

## Tunable constants (taste lives here, not in code complexity)

```
ZOOM_SCALE / ZOOM_TYPING / ZOOM_MAX = 1.6 / 2.0 / 2.5   (quantize scale to 0.05)
EASE_IN_MS / EASE_OUT_MS            = 600 / 750          (asymmetric — calm pull-back)
LEAD_IN_MS                          = 400               (push-in lands AS the action)
MIN_HOLD_MS                         = 1200
SEGMENT_GAP_MS                      = 1200
MERGE_GAP_MS / MERGE_DIST           = 2500 / 0.25·min(W,H)   (biggest anti-pump lever)
MIN_CLIP_MS                         = 3000              (below this → zero zooms)
MAX_ZOOMS_PER_MIN                   = 4
SETTLE_SPEED / BALLISTIC_SPEED      = 0.15 / 1.5 pts/ms (measured: p50=0.40, p90=2.40)
DRAG_MIN_TRAVEL / DWELL_MIN_MS / TYPE_GAP_MS = 40 pts / 600 / 1000
MIN_SEGMENT_WEIGHT / CONF_MIN       = 1.0 / 0.3
FRAME_FILL / TAIL_GUARD_MS          = 0.70 / 800        (spread→scale; ignore trailing Stop click)
```

---

## Edge cases

**Handled in v1**

| Case | Handling |
|---|---|
| `mousemoves-0.json` missing/empty | `buildAutoZoomKeyframes` → `[]`; identity transform; never throws/blocks open. |
| `keystrokes-0.json` absent (opt-in off) | Treat as null; typing detection no-ops, falls back to `iBeam`; clicks/drags/dwell unaffected. |
| No clicks at all (pure reading) | Dwell-only; if none clears `MIN_SEGMENT_WEIGHT`, **zero** keyframes (a static wide shot is correct). Never invent a zoom from moves. |
| Trailing park on Stop button | Clamp every `tEndMs` to `durationMs − TAIL_GUARD_MS`. |
| Rapid-fire / double-click | One segment (gap ≪ `SEGMENT_GAP`), tiny spread → one tight zoom. No chatter. |
| Click → far drag (resize/window move) | `resize*` cursorId forces drag treatment; the drag span feeds spread → one wider, gentler framing. |
| Focus too near a display edge | Clamp focus into the interior box; if it collapses, reduce scale toward 1; else identity (never expose outside the video). |
| Recording < `MIN_CLIP_MS` | Suppress generation entirely (zero keyframes). |
| `scale == 1.0` between zooms | `placeAutoZoomCamera` identity-snaps to `{1,0,0}`; non-zoomed footage byte-identical to today. Regression-tested. |
| Disabled keyframe + refresh | `enabled:false` persists; sampler filters disabled keyframes before building the curve → holds scale 1, eases into the next enabled zoom. |
| Manually overlapping keyframes | Sampler is total: at any `t` the active window is the one whose `[tStart,tEnd]` contains it with the **latest** `tStart` (last-start-wins); smoothstep blends the seam. |
| Trim inside a lead-in/hold | Camera sampled by source time through the frame plan; a trimmed-out window never samples active. Trim inside a lead-in → slightly abrupt push from the clip's first active time (seed scale 1). Document; snap-trim-to-keyframe is a later nicety. |
| Sidecars deleted but keyframes persisted | Self-contained keyframes play/export from `project.json`; only "Regenerate" is disabled. (Payoff of persist-not-derive.) |
| User pans/zooms `ViewTransform` mid-camera-move | Composes: `stage(view) · layer(camera)`; export has no view transform, so editor-at-view-identity == the export frame. Parity-tested. |
| Cursor magnifies under zoom | `cameraScale · cursorSizeMultiplier` is geometrically correct (pinned + proportional). Accepted; do **not** counter-scale (would break the shared-layer parity). |
| 5000+ node scene | O(1) per tick: two layer/group transforms + one keyframe lookup. No `getClientRect` loops, no new layers, no per-frame React. Do **not** `cache()` the content layer (changes every frame). |

**Deferred + documented**

- Grain magnifies under zoom (whole-composite consequence; re-applying grain
  post-camera is deferred).
- Multi-display / region recording (single coord space matching the cursor track).
- Physics-spring camera; deadzone lazy-follow; zoom-out-travel-zoom-in for far
  jumps; ML/learned saliency; clustering (k-means/DBSCAN); content-fit continuous
  zoom; auto-generate-on-open; schema version bump; cursor counter-scaling;
  snap-trim-to-keyframe.

---

## Verification

- `lib/auto-zoom/__tests__/zoom-track.test.ts` — snapshot a fixed synthetic
  sidecar input → exact `ZoomKeyframe[]` (determinism + stable ids).
- Reducer-pipeline snapshots near the rate/confidence caps (reproducible plans).
- Identity-frame regression: `placeAutoZoomCamera` at a no-zoom time → exactly
  `{scale:1, offsetX:0, offsetY:0}`; export of a no-keyframe project is
  byte-identical to current output.
- Editor-vs-export parity: same keyframes + same source time → identical
  artboard-space camera from both call sites (with editor `ViewTransform = identity`).
- Pan-clamp: focus near a corner at high scale never exposes outside artboard
  bounds; clamp identical in both paths.
- Empty/absent sidecar tests (missing moves → `[]`; absent keystrokes → iBeam
  fallback; no throw).
- Targeted vitest on touched `canvas/__tests__` + `export/__tests__`, then
  `pnpm typecheck`.
- Manual: record ~30 s with clicks + a typing burst, click Auto-zoom, scrub for
  calm holds, export, diff MP4 motion vs scrubbed preview at several timestamps.
- Docs: update `docs/editor-canvas.md` (new Auto-Zoom section + Export Pipeline +
  Project Persistence: list `autoZoom` as persisted; grain/cursor magnification +
  single-display as limitations) and `docs/normal-term.md` (camera / zoom
  keyframe terminology).

---

## Still-open product decisions (recommended defaults in **bold**)

1. **Trigger UX** — **explicit "Auto-zoom" button** (no surprise) vs
   auto-generate on first open.
2. **Low-confidence suggestions** (below `CONF_MIN`) — ship **enabled** /
   shipped-but-disabled (dimmed) / hidden. *(Recommend: shipped-but-disabled.)*
3. **Regenerate policy after edits** — **generate once, treat as user data,
   manual Regenerate overwrites with a confirm** (no silent re-generation).
4. **`ZOOM_MAX` adaptivity** — adapt to the recording's backing scale (lower cap
   for low-DPI sources to avoid visible softening) vs **fixed `2.5×`** for v1.
5. **Tuning budget** — defaults are tuned against one ~33 s sample; confirm
   appetite to re-tune the named constants after testing 4K, trackpad-vs-mouse,
   and fast-vs-slow recordings before locking them.

## Suggested build order

1. `lib/auto-zoom/zoom-track.ts` + unit tests (pure, no UI) — validate on the
   real recording first.
2. `zoom-scene.ts`: extract `displayPointToArtboard`, add `placeAutoZoomCamera` +
   `applyCamera` + parity/clamp tests.
3. Schema + persistence + provider wiring (field round-trips, autosave).
4. Editor wiring (inner camera group + background, tick-driven) + "Auto-zoom" button.
5. Export wiring (layer-level camera + background-redraw fix) + parity test.
6. Docs (`editor-canvas.md`, `normal-term.md`) + manual verification.
