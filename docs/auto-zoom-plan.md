# Auto-Zoom — Implementation Plan (v2)

> Status: **plan / not yet implemented.** Rewritten 2026-06-08 after the user
> locked the approach. **This supersedes the 2026-05-29 plan**, which predated
> the PixiJS cutover and the manual Zoom-track and proposed a *separate*
> `autoZoom` keyframe representation + its own camera. That separate model is
> **dropped.** Auto-zoom is now a pure **generator of ordinary manual zoom
> clips** (`CanvasZoomClip`). When this ships, fold the behaviour into
> `docs/editor-canvas.md` (Auto-Zoom + Project Persistence) and add terminology
> to `docs/normal-term.md` per the repo doc rules.

## What it is (one sentence)

After a recording finishes and opens in the editor for the first time, analyse
the captured cursor moves + clicks and **emit a handful of ordinary
`CanvasZoomClip` objects into the existing manual Zoom track** — choosing only
*from-where-to-where* (`start`/`end`), *what point* (`focus`), and *how much*
(`scale`). Everything else — the whole-composite camera, easing, blur,
persistence, the editable Zoom panel, export — is the manual system, unchanged.

## Decisions locked by the user (2026-06-08)

1. **Manual architecture only.** Auto-zoom is a generator. It produces plain
   `CanvasZoomClip`s and changes **nothing** in the renderer/sampler. No
   separate representation, no follow-cam, no asymmetric ease. A generated clip
   is indistinguishable in kind from one dragged in by hand and is fully
   editable / movable / deletable afterward.
2. **Runs automatically, exactly once** — on the first editor open of a freshly
   completed recording (the provider's slow-path hydration). It never re-runs:
   the generated clips are autosaved into `project.json`, so every later open
   restores them via the fast path. **No button, no Regenerate, no confirm, no
   auto-vs-manual marker** (the Zoom track is empty at first open — nothing to
   overwrite).
3. **One tuned "calm & sparse" default** (no sensitivity UI in v1). Fewer,
   longer, confident holds; most of the timeline stays wide. A global intensity
   knob is a later add.
4. **Built from data we already have** — clicks (+ `pointingHand` link targets),
   drags, dwell/settle, and the `iBeam` text-cursor as a typing hint. **No
   recorder, IPC, or schema changes.** Scroll-wheel and real keystroke capture
   are deferred (see Deferred).

## Data inputs (verified against a real 34 s recording, 2026-06-08)

All already reachable in the renderer via `window.api.projects.getCursorData(folder)`
→ `CursorTrackData` (`electron/ipc/projects.ts:346`, mirrored `types/api.d.ts:423`):

```ts
CursorTrackData = {
  moves:   Array<{ processTimeMs; x; y; cursorId?; type? }>   // ~120 Hz, display points, top-left
  clicks:  Array<{ processTimeMs; x; y; cursorId?; type?; button? }>  // down & up, display points
  processTimeStartMs: number   // == screen-video source-time 0 (native re-anchors to first frame)
  displayWidth: number         // display POINTS (not pixels)
  displayHeight: number
}
```

- `x/y` are **display-relative logical points, top-left origin** (not pixels,
  not normalized). `t_source_ms = processTimeMs − processTimeStartMs`.
- `clicks` carries its own `x/y` per event — no need to re-sample moves. `type`
  normalizes to `down`/`up`; **filter to `down`** to count discrete clicks.
- `cursorId` is semantic: `arrow`, `pointingHand` (link/button → strong "real
  target" signal), `iBeam` (text field → typing context), `resize*`, etc.
- Keystrokes sidecar (`keystrokes-0.json`) is **opt-in and NOT surfaced** to the
  renderer today (and was off in the sample) — typing is inferred from `iBeam`.
- Native already records `captureInput`/`captureCursorShapes` (confirmed in the
  sample manifest), so no capture change is needed for v1.

## Modules & wiring (the entire build surface)

### 1. `lib/auto-zoom/zoom-detect.ts` — pure detector (NEW)

No React / DOM / `Date.now()` / `Math.random()`. Deterministic: stable sort,
fixed reducer order, ids derived from `round(tStartMs)`+focus (so re-running is
idempotent and never churns the autosave fingerprint).

```ts
export interface AutoZoomInput {
  clicks: Array<{ tSourceMs: number; x: number; y: number; cursorId?: string; button?: string | number }>
  moves:  Array<{ tSourceMs: number; x: number; y: number; cursorId?: string }>
  // Pre-resolved geometry so the detector stays pure (no scene access):
  toFocus: (x: number, y: number) => { x: number; y: number; onScreen: boolean } // display pt → artboard-normalized
  toTimelineSeconds: (tSourceMs: number) => number | null  // source ms → timeline s, or null if trimmed out
  timelineDurationSeconds: number
  params?: Partial<AutoZoomParams>
}

// Returns ready-to-commit clips, already non-overlapping & defaulted.
export function buildAutoZoomClips(input: AutoZoomInput): CanvasZoomClip[]
```

The detector calls **`withZoomClipDefaults`** (`lib/zoom-clips.ts`) per clip and
runs the final list through **`normalizeZoomClips(list, durationSeconds)`** so
the non-overlap lane invariant the whole manual system assumes is guaranteed.

### 2. Share the display→artboard focus math (export an existing helper)

`mapCursorSampleToArtboard` (`components/editor/canvas/cursor-scene.ts:308`) is
currently internal. **Extract/export a pure `displayPointToArtboard(x, y,
video: CursorVideoGeometry, displayWidth, displayHeight)`** returning
`{ x, y, onScreen }` in artboard px, and have both `placeCursor` and the
detector's `toFocus` call it — so an auto-zoom focus lands on **exactly** the
pixel the cursor overlay shows. CLAUDE.md forbids duplicating this cover-crop
math; we share it. `toFocus` then divides by `artboard.{width,height}` and
`clampZoomFocus`-clamps to `[0,1]`.

### 3. Provider one-shot trigger (`components/editor/canvas/provider.tsx`)

The screen video + its timeline clip are added **asynchronously** in the slow
path (`void addRemoteVideo(...)`, ~`provider.tsx:4020`), so detection cannot run
inline. Instead, piggyback on the **first-recording-committed** moment:

- **Arm** in the slow path: when a `screen` asset exists, set
  `autoZoomPendingRef.current = true` (alongside `hydrationSeedPendingRef`).
- **Run once** in an effect keyed on `[videos, timelineClips]` (sibling of the
  history-seed effect at `provider.tsx:2306`): when `autoZoomPendingRef` is set
  and the screen video + its screen timeline clip are present, clear the flag
  and kick off async detection:
  1. `getCursorData(projectFolder)` → `CursorTrackData` (or `null` → emit no
     clips, never throw/block open).
  2. Build `CursorVideoGeometry` from the committed screen `CanvasVideoItem`
     (`x,y,width,height,rotation,intrinsicWidth,intrinsicHeight`) + `artboardRef`,
     and the screen timeline clip (`start,end,sourceIn,sourceOut`).
  3. `toFocus` = `displayPointToArtboard(...) ÷ artboard`; `toTimelineSeconds` =
     **inverse of `CursorController.getSourceSeconds`**:
     `timelineS = clip.start + (sourceS − clip.sourceIn)`, returning `null` when
     `sourceS ∉ [sourceIn, sourceOut)` (trimmed-out → drop the click).
  4. `buildAutoZoomClips(...)` → `CanvasZoomClip[]`.
  5. Commit internally via `commitZoomClipsRef(next)` + `setZoomClips(next)` (the
     same pair every mutator uses). The `zoomClips` change triggers the existing
     autosave debounce → `project.json` now carries the clips → never re-runs.
- **Reset:** `autoZoomPendingRef.current = false` is already covered by the
  project-switch reset block (extend it alongside the other refs at
  `provider.tsx:3692`).

No change to `EditorCanvasTimelineActions` — the trigger is internal, so no
public bulk mutator is exposed.

#### Undo / baseline behaviour — pick one (recommend **fold-into-baseline**)

The history baseline is seeded the instant the recording commits
(`provider.tsx:2306`). Two options for where the auto-zoom clips sit relative to
it:

- **(B) Fold into baseline (recommended).** Defer the baseline seed until
  detection resolves (gate the seed effect on an `autoZoomResolvedRef`), so the
  recording's cursor-0 baseline *includes* the auto-zoom clips. Then auto-zoom
  is "just how the recording opens" — `Cmd+Z` does not strip it, and there's no
  spurious undo step or "saving…" flash on open. Slightly more coordination.
- **(A) Post-hydration edit (simpler).** Let detection land as a normal commit
  on top of the baseline, tagged (e.g. `zoom-auto`). `Cmd+Z` right after open
  removes all auto-zooms in one step. Simplest; defensible if "undo the auto
  zooms" is considered a feature.

**Implemented: (A)** — the simpler, lower-risk option (it leaves the delicate
history-seed flow untouched). On first open `Cmd+Z` removes all generated zooms
in one atomic step (`zoom-auto-generate` ∈ `ALWAYS_NEW_ENTRY_TAGS`). Switching to
(B) later is a contained change (gate the seed effect on an auto-zoom-resolved
flag). The 2026-05-29 "fold into baseline" preference is recorded above as the
follow-up.

## Coordinate & time mapping (the correctness core — get this exactly right)

`CanvasZoomClip.focus` is normalized **against the ARTBOARD**, proven by
`zoom-scene.ts:239` (`offsetX = focus.x * artboard.width * (1 − scale)`) — NOT
the video frame, NOT the display. So a click's display point converts via the
five-space chain already in `mapCursorSampleToArtboard`:

```
display point (top-left, pts)
  → /displayWidth,/displayHeight        (normalized display fraction)
  → ×intrinsicW,×intrinsicH             (source pixels)
  → object-fit:cover crop               (getVideoCoverCrop)
  → node-local → rotate+translate       (artboard pixels)
  → /artboard.width,/artboard.height    (FOCUS, clampZoomFocus to [0,1])
```

Drop clicks whose mapping is `onScreen === false` (cropped-away region).

Time: clicks are **source ms**; zoom clips are **timeline seconds**. Convert per
the screen timeline clip: `timelineS = clip.start + (sourceS − clip.sourceIn)`,
dropping clicks outside `[sourceIn, sourceOut)`. At first open there is one
untrimmed screen clip (`start=0, sourceIn=0`), so this is identity — but write
the general form so later trims/splits stay correct.

## Detection algorithm (when / where / how much)

Calm & sparse. Every threshold biases toward **not** zooming; motion polish
(merge, lead-in, min-hold) matters more than detector cleverness.

1. **Events.** Keep `clicks` with `type==='down'`; map each to
   `(tTimeline, focus, cursorId)`; drop trimmed-out / off-screen. Pair
   `down→up` with travel `> DRAG_MIN_TRAVEL` into one **drag** spanning the
   gesture. Moves feed dwell/settle only.
2. **Segment.** New segment when the gap to the previous click `> SEGMENT_GAP`
   **or** the focus jumps `> SEGMENT_FOCUS_JUMP` (normalized). Accumulate clicks
   per segment.
3. **Focus.** The segment's **settle/action point**: the last click's position
   (ground-truth), or the click-weighted centroid (`pointingHand ×1.15`,
   `iBeam ×1.1`), clamped in-frame. Never a mid-flight move.
4. **Window.** `start = firstClickT − LEAD_IN` (push-in lands as the click
   happens); `end = lastClickT + HOLD_TAIL`; enforce `MIN_HOLD`; clamp
   `end ≤ timelineDuration − TAIL_GUARD` (ignore a trailing Stop-button click).
5. **Scale.** Tight cluster → palette top; broad spread → gentler. `iBeam`
   typing context → `ZOOM_TYPING`. Quantize 0.05, cap `ZOOM_MAX`.
6. **Reduce (fixed order).** (a) merge segments within `MERGE_GAP` whose focus
   is within `MERGE_DIST` into one continuous hold *(biggest anti-pump lever)*;
   (b) drop segments below `MIN_SEGMENT_CLICKS`/weight; (c) enforce
   `MIN_ZOOM_CLIP_SECONDS` (0.5, the manual floor) and `MIN_HOLD`; (d) keep top-N
   by confidence under `MAX_ZOOMS_PER_MIN`; (e) re-sort by time.
7. **Emit.** `withZoomClipDefaults({ id, start, end, focus, scale, enabled:true,
   transition:{ durationMs: EASE_MS, curve:'smootherstep' } })`, then
   `normalizeZoomClips`. (The renderer reads only `transition.durationMs` +
   `transition.curve`; `easePreset`/`speed`/`easeIn`/`easeOut` are ignored — set
   `durationMs`+`curve` explicitly.)

### Tunable constants (taste lives here) — starting values

```
ZOOM_SCALE / ZOOM_TYPING / ZOOM_MAX = 1.8 / 2.0 / 2.5   (manual default is 2.0, max 4)
EASE_MS                             = 600   (symmetric in/out — the manual sampler is symmetric)
LEAD_IN_MS                          = 350
MIN_HOLD_MS                         = 1200
SEGMENT_GAP_MS / SEGMENT_FOCUS_JUMP = 1200 / 0.22
MERGE_GAP_MS / MERGE_DIST           = 2500 / 0.18   (normalized)
MIN_ZOOM_CLIP_SECONDS               = 0.5   (hard floor from lib/zoom-clips)
MAX_ZOOMS_PER_MIN                   = 4
DRAG_MIN_TRAVEL                     = 0.04  (normalized)
TAIL_GUARD_MS                       = 800
MIN_RECORDING_MS                    = 3000  (below this → zero zooms)
```

## What is explicitly NOT changed

Render/sampler (`zoom-scene.ts`), blur (`zoom-blur.ts`), the editor scene, the
**export pipeline** (`run-export.ts`/`build-stage.ts` already sample
`state.zoomClips` with the shared `sampleZoomCameraAtTime`), the **schema**
(`project-schema.ts` `zoomClips` already persists), the **IPC** (`getCursorData`
already returns clicks), the **native addon**, and the **Zoom UI** (panel +
timeline render auto clips for free). Auto clips inherit all of it.

## Edge cases (v1)

| Case | Handling |
|---|---|
| `getCursorData` null / no moves | emit `[]`; never throw or block first open. |
| No clicks (pure reading) | dwell-only; if nothing clears the threshold → **zero** zooms (a wide shot is correct). |
| Recording `< MIN_RECORDING_MS` | suppress (zero zooms). |
| Off-screen / cropped clicks | dropped via `onScreen`. |
| Trailing Stop-button click | clamped by `TAIL_GUARD`. |
| Rapid-fire / double-click | one segment, tight spread → one tight zoom. |
| Far drag (resize/window move) | drag span feeds a wider, gentler framing. |
| Overlap / sub-floor spans | `normalizeZoomClips` trims to one lane (earlier wins); detector pre-spaces to avoid loss. |
| User edits/deletes an auto clip | it's an ordinary clip — edits persist; deletes are permanent (no re-trigger in v1). |
| Video later resized/moved on artboard | focus (artboard-normalized, baked at gen time) drifts — same as manual clips; documented, not fixed. |

## Deferred (documented, not v1)

Scroll-wheel capture (native + IPC); real keystroke-driven typing zooms (new
IPC + capture-on); a manual "Regenerate"/intensity control; pan-within-a-zoom /
follow-cam (needs a sampler change, out of "manual architecture only"); content
saliency / ML; multi-display & window/region focus (whole-display only, matching
the cursor overlay — window/region would need target-rect normalization, not
`displayBoundsPoints`).

## Verification

- `lib/auto-zoom/__tests__/zoom-detect.test.ts` — fixed synthetic
  clicks/moves → exact `CanvasZoomClip[]` (determinism + stable ids); reducer
  snapshots near the rate/merge caps; empty/`null` input → `[]`.
- Focus parity: a click at a known display point → the **same** artboard point
  the cursor overlay places (shared `displayPointToArtboard`).
- Non-overlap: generated output is unchanged by a second `normalizeZoomClips`.
- One-shot: second open uses the fast path and does **not** re-detect.
- Targeted vitest on touched `canvas/__tests__`, then `pnpm typecheck`.
- Manual: record ~30 s with clicks + a typing burst, open the editor, scrub for
  calm holds, export, diff MP4 motion vs preview at several timestamps.
- Docs: `docs/editor-canvas.md` (Auto-Zoom section + Project Persistence note
  that `zoomClips` now also originate from auto-zoom; focus-drift + whole-display
  limitations) and `docs/normal-term.md` (auto-zoom terminology).

## Build order

1. `lib/auto-zoom/zoom-detect.ts` + unit tests (pure; validate on the real
   recording first).
2. Extract/export `displayPointToArtboard` from `cursor-scene.ts`; reuse in
   `placeCursor`; add focus-parity test.
3. Provider wiring: arm in slow path, one-shot detect effect after the screen
   recording commits, internal `commitZoomClipsRef`+`setZoomClips` under the
   `zoom-auto-generate` undo tag (option A), reset-block entry.
4. Docs (`editor-canvas.md`, `normal-term.md`) + manual verification.
