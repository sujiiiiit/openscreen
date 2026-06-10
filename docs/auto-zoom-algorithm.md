# Auto-Zoom Algorithm

> The detailed spec for how auto-zoom decides **when**, **where**, and **how
> much** to zoom. The editor *wiring* (one-shot trigger, Regenerate, persistence,
> history) lives in `docs/editor-canvas.md` → Auto-Zoom; this doc is the
> algorithm. Code: `lib/auto-zoom/`. Supersedes the design sketch in
> `docs/auto-zoom-plan.md`.

## What it is

Auto-zoom is a **generator of ordinary manual zoom clips** (`CanvasZoomClip`). It
runs on a finished recording, analyses the captured interaction, and emits plain
clips onto the existing manual Zoom track. It only chooses **WHEN** (`start`/`end`
in timeline seconds), **WHERE** (artboard-normalized `focus`), and **HOW MUCH**
(`scale`). The renderer, export, persistence, and Zoom panel are the manual
system, unchanged — a generated clip is indistinguishable from a hand-made one.

## Guiding principles

1. **High recall — everything meaningful zooms.** Every deliberate interaction
   (click, selection, typing, right-click, double-click) is a zoom candidate. The
   difference between events is **confidence**, which sets *how much* they zoom —
   not *whether* they do. Nothing is dropped for being "low importance".
2. **Confidence → scale.** A plain click gets the base scale; a click on a target,
   typing, a double-click, or a dense cluster (whose confidences accumulate) zooms
   further, up to `zoomMax`. Important moments literally get more closeup.
3. **The camera follows the work.** Same-region bursts merge into one held zoom;
   distinct regions **tile** back-to-back (the earlier hold extends to meet the
   next), so the view moves region-to-region instead of flashing wide between
   nearby events.
4. **Wide only on genuine idle.** Fast scroll/transit and real idle (no activity)
   are the *only* things that return the camera to identity (1×). Everything else
   stays engaged.
5. **Always keep the subject in frame, and follow it predictively.** A hold's
   focus + scale keep the subject visible — a point uses the (confidence-scaled)
   base scale; a large selection/cluster scales *down* to fit. *Within* a hold the
   camera is no longer static: it follows the cursor **predictively** (see
   [Predictive in-hold follow](#predictive-in-hold-follow-reveal-modes)) — holding
   rock-steady while the engaged content stays in frame, and committing one
   anticipatory move (pan, or zoom-out-to-fit-then-return) only when it leaves.
6. **Deterministic & pure.** No `Date.now()` / `Math.random()` / DOM. The same
   input always yields byte-identical clips (ids included), so re-running never
   churns the autosave fingerprint and every stage is exhaustively unit-testable.

## The staged pipeline

```
InteractionTrack          normalize.ts     all input streams, mapped + sorted
  → Fixation[] / idle      kinematics.ts    cursor dwell vs transit; idle spans
  → Engagement[]           importance.ts    "what is worth a closeup" (scored)
  → ZoomWindow[]           detectors/*      WHEN + which region
  → ZoomWindow[]           cinematography.ts merge / overlap / rate-limit (pacing)
  → { focus, scale }       framing.ts       keep the subject in frame
  → CanvasZoomClip[]       pipeline.ts      emit, deterministic, normalized
```

Each stage is a pure function in its own module. New signals plug into
`normalize` + `importance` without touching the detectors.

### 0. Normalize (`normalize.ts`)

The renderer adapter (`components/editor/canvas/auto-zoom-scene.ts`) maps each
captured stream into editor space (artboard-normalized `0..1` focus + timeline
seconds, reusing the cursor overlay's `displayPointToArtboard`). `normalizeTrack`
then sorts every stream by time and drops non-finite samples, yielding a clean
`InteractionTrack { moves, events, durationSeconds }`. Centralizing the merge here
means a future signal only has to be appended to the track.

### 1. Kinematics (`kinematics.ts`)

The high-frequency move stream (~120 Hz) is split into **fixations** — spans where
the pointer dwelled inside a small region (`fixationMaxRadius`) for at least
`fixationMinMs`. Transit (saccade) intervals are implicit: the gaps between
fixations. Long quiet gaps (`idleGapMs`) become **idle spans**. Fixations are the
eye-tracking-style attention proxy; idle spans drive the "stay wide" rule.

### 2. Importance (`importance.ts`)

Clicks are paired `down`→`up` into gestures, classified, and scored. **Only
deliberate engagement produces a candidate** — a bare fixation never does (it only
*boosts* a click that lands right after it). This directly encodes "dwell alone
never triggers a zoom."

| Signal → **Engagement** (zoom-worthy) | Detection | Score bonus |
|---|---|---|
| Click on a link/button | `pointingHand` cursor / AX role | +0.15 |
| Typing into a field | `iBeam` cursor (P2+: keystrokes) | +0.10, `typing` |
| Right-click → context menu | `button: right` | +0.20 |
| Double-click / open | two downs within `doubleClickMs`, same spot | +0.25 |
| Selection / drag | down→up travel > `dragMinTravel` | +0.20, frames the **whole span** |
| Dwell that **leads to** a click | a fixation ended near the click within `dwellClickWindowMs` | +0.30 |

| **Suppressed** (never an engagement) | Why |
|---|---|
| Fast scroll (P3) | skimming / skipping content |
| Fast cursor transit | just moving to a target |
| Idle | nothing happening |
| Bare dwell (no following click) | "thinking with the mouse parked" |

Base score is `1` (a plain click); bonuses accumulate, and a window's confidence
is the **sum** of its engagements' scores — so an active region (many actions)
zooms harder than a single click. Nothing is dropped on a score threshold. The
subject `region` is a zero-size rect for a point click, or the bounding span for a
selection. A **typing** engagement is also *extended* forward (up to
`maxTypingHoldMs` or the next engagement) so mouse-silent typing reads as one
sustained zoom — a P1 stand-in until the keystroke stream lands in P2.

### 3. Detector (`detectors/`)

The detector implements `detect(input) → ZoomWindow[]` — the only "engagements →
windows" step; it shares every other stage. There is one detector,
**`hybrid-stabilized`**; the registry stays pluggable so another could be added
without touching the pipeline.

**`hybrid-stabilized`** covers every engagement (high recall preserved) while
holding the camera steady and framing calmly:

- **Dwell-extended holds** — each engagement is extended to cover the surrounding
  cursor dwell (the fixation before/after the click), so the hold lasts as long as
  the user actually stayed in that region. A bare fixation never creates a window;
  dwell only shapes a window already anchored by a deliberate engagement.
- **Hysteretic clustering** — extended engagements group into clusters with a
  *sticky* boundary (`hysteresisFocusJump`, much larger than a naive per-click
  split) so a small wander never starts a new region (the cure for needless panning
  + framing drift). One cluster → one steady held window.
- **Stable framing anchor** — each cluster is framed on the score-weighted
  centroid of its dense core (members within `clusterRadius` of the peak
  engagement), *not* the drifting union center; the union is grown symmetrically
  about the anchor (`geometry.growRectAroundCenter`) so every subject stays in
  frame while the center stays put.
- **Idle release** — the hold is released at the next idle span (stay wide only on
  genuine idle). It pushes in/out on the gentler `hybridEaseMs` / `hybridLeadInMs`
  ramps, and scale cohesion across a scene is applied at emit (§6).

### 4. Cinematography / pacing (`cinematography.ts`)

The high-recall pass. Only same-region merging and real idle reduce the zoom
count — there is no sparsity quota:

- **merge** — fold *same-region* (`mergeDist`), near-in-time (`mergeGapMs`) windows
  into one held zoom (anti-pump); the framed region is their **union** and
  confidences add up.
- **tile** — extend a window's end to the next window's start across any non-idle
  gap below `bridgeMaxGapMs`, so the camera moves region-to-region instead of
  flashing wide.
- **overlap** — where windows still collide, clip the earlier end; if that would
  drop it below `minZoomClipSeconds`, **merge** it into the neighbour instead of
  dropping it (nothing is lost).
- **cap** — a high per-minute safety backstop (`maxZoomsPerMin`); over it, the
  lowest-confidence window is merged into its nearest neighbour (never dropped).

Return-to-wide happens only at a real idle gap (no window there → identity).

### 5. Framing (`framing.ts`)

`solveFraming(region, baseScale, params) → { focus, scale }` — the "always keep
the subject in frame" solver:

```
maxDim   = max(region.width, region.height) · (1 + framePadding)
fitScale = maxDim > 0 ? 1 / maxDim : zoomMax     // a point fits at any scale
scale    = clamp( min(baseScale, fitScale, zoomMax), 1, zoomMax )   // quantized 0.05
focus    = clampZoomFocus( center(region) )
```

- A **point** subject → `scale = baseScale` (the renderer keeps an edge focus
  visible, so the point is always in frame).
- A **large** subject → `fitScale < baseScale`, so it scales *down* until the whole
  region fits inside the visible window (size `1/scale` of the artboard).

`baseScale` comes from the window's **confidence** (`baseScaleForConfidence`):
`base + max(0, confidence − 1) · confidenceGain`, where `base` is `zoomTyping` for
typing windows else `zoomScale`, clamped to `[1, zoomMax]`. So a plain click sits
at the base and busy/important regions climb toward `zoomMax`.

### 6. Emit (`pipeline.ts`)

Each window → `CanvasZoomClip` via `withZoomClipDefaults` with a **deterministic
id** (`auto-zoom-<round(startMs)>-<round(focusX·1000)>-<round(focusY·1000)>`) and
the baked transition, then `normalizeZoomClips` as the final single-lane safety
net.

**One scale per scene.** Focus is always per-window. When `sceneCohesion` is on
(the default), the emit groups the paced windows into **scenes** — a maximal run of
*touching* windows (the tiling in §4 abuts a run's members; only a real idle gap
breaks the run, since any gap > `idleGapMs` is itself an idle span and
`bridgeMaxGapMs ≥ idleGapMs`) — and collapses each scene to a single steady scale:
the run's **MIN** desired scale. MIN is the only choice that keeps every subject
framed (it can only zoom *less* than a window asked for, never crop), so
magnification never bounces while the camera tiles across a scene; confidence still
sets the scale *between* scenes. Scale does not enter the deterministic id, so this
never churns the autosave fingerprint.

## Predictive in-hold follow (reveal modes)

The stages above pick **when / where / how much** and emit one `(focus, scale)`
per clip. The cursor-follow *within* a hold is a separate, **render-time**
concern that the editor preview and the exporter compute identically from the
same recorded cursor (`components/editor/canvas/zoom-scene.ts` →
`computeZoomFollowPaths`). It is **predictive, not reactive**: generation is
offline, so the whole cursor track is known up front.

- **Dwells, not crossings.** The hold is sampled (`predictionHz`) and segmented
  into **dwells** (settle points; the same idea as kinematics fixations) and
  transits. The camera holds rock-steady while the *next dwell's engaged region*
  sits inside a generous inner safe box (`safeFraction`), and commits a move only
  when it pokes past that box by `commitMargin` (hysteresis → no thrashing).
- **Anticipatory timing.** A committed move targets the **destination dwell**, not
  the cursor's transient position, and is timed to run in lockstep with the
  cursor's travel (begin as it departs, arrive as it settles). The ramp is
  velocity-matched between `minMoveSec`/`maxMoveSec`; a fast flick is one clean
  move instead of a chasing series of reframes.
- **Reveal mode is AUTO.** The smallest disorienting move wins: **PAN** (focus
  only) when a slide brings the engaged region into frame at the held zoom;
  **ZOOM-OUT-to-fit then RETURN** when it can't. The fit scale reuses the framing
  solver's math (`1 / (regMax·(1 + fitMargin))`).
- **Engaged region = dwell ∪ content rect.** A bare dwell is tiny → always PANs.
  The region is widened by the **content rect** of an interaction active around
  the dwell — which is what forces a zoom-out reveal of a menu/popover larger than
  the frame (the Screen-Studio submenu beat).
- **Motion blur.** A reframe carries a velocity-scaled directional pan blur with a
  **high ceiling** (subtle for gentle moves, a strong smear only on the fastest
  flicks); an in-hold zoom-out also gets radial blur from its scale velocity. Both
  are pure functions of the follow path (preview == export).

Knobs live in `ZOOM_FOLLOW_DEFAULTS` (render-time, parity-shared), not
`AUTO_ZOOM_DEFAULTS`. The follow path is recomputed deterministically, never
persisted.

### Content bounds via frame-analysis (`lib/auto-zoom/content-bounds/`)

We don't yet capture Accessibility element bounds, so "what the cursor is engaging"
is recovered by **analysing the recorded frames**. At generation, for each click
(bounded, offline) we grab a frame just before and just after and diff them
(`frame-diff.ts`: a lightweight luma difference + grid-cell vote + box-density
guard — deliberately not OpenCV/ML for a bounding-box-of-an-appeared-rectangle
task); the changed-region bbox is the engaged content's extent. The decode is a
bounded hidden-`<video>` seek pass (`components/editor/canvas/auto-zoom-frames.ts`),
best-effort: any failure degrades to pure cursor geometry. The frame-normalized
rect is mapped to artboard space (same cover-crop chain as the cursor overlay),
attached to the click event's `rect`, and emitted on the clip as **`engagedRects`**
(persisted — it must reach the separate export window). This sits behind the
swappable `ContentBoundsProvider` seam, so an Accessibility-backed provider can
replace frame-diff later without touching the pipeline.

## Parameters (`params.ts` → `AUTO_ZOOM_DEFAULTS`)

High-recall defaults (tune freely): `zoomScale 1.6` (plain-click base),
`zoomTyping 2.0`, `confidenceGain 0.3` (scale per confidence over 1), `zoomMax 2.6`,
`easeMs 450`, `leadInMs 250`, `minHoldMs 900`, stabilization knobs
(`clusterRadius 0.12` = dense-core radius for the framing anchor,
`hysteresisFocusJump 0.30` = sticky region boundary, `clusterMergeGapMs 2200`,
`sceneCohesion true` = one scale per scene, `hybridEaseMs 650` = the push ramp,
`hybridLeadInMs 300`), `mergeGapMs 1800`,
`mergeDist 0.10` (same-region only),
`bridgeMaxGapMs 2000` (tiling), `minZoomClipSeconds 0.5`, `maxZoomsPerMin 40`
(safety backstop, not a quota), `dragMinTravel 0.04`, `doubleClickMs 350`,
`maxTypingHoldMs 5000`, `tailGuardMs 800` (ignore the Stop click),
`minRecordingMs 3000` (shorter → zero zooms), plus kinematics knobs
(`fixationMaxRadius 0.04`, `fixationMinMs 250`, `idleGapMs 1500`,
`dwellClickWindowMs 1200`, `framePadding 0.18`).

## Data roadmap (capture phases)

P1 (current) uses only **moves + clicks + cursorId + button**, already exposed via
`CursorTrackData`. Richer signals are wired into `normalize`/`importance` in later
phases (no detector changes):

- **P2** — surface `activeModifiers` + the existing `keystrokes-0.json` (cheap; on
  disk already). Real typing bursts, shortcuts, modifier-qualified clicks.
- **P3** — native **scroll/wheel** + **window/app focus** capture. Scroll →
  skim-suppression; app-switch → zoom boundaries.
- **P4** — native **Accessibility** capture: caret bounds (`AXSelectedTextRange` →
  `AXBoundsForRange`), focused-element bounds (`AXFrame`), focused-window bounds,
  element role (`AXRole`). Precise framing of the actual control/caret. AX bounds
  are converted to display-relative top-left logical points *in native* so the
  adapter reuses `displayPointToArtboard` verbatim.

## Determinism & testing

- Pure: no clock/randomness/DOM. Stable sorts, fixed reducer order, ids derived
  from rounded start + focus.
- Tests: `lib/auto-zoom/__tests__/pipeline.test.ts` (per-stage units + the
  track-based pipeline, including the `hybrid-stabilized` block: guards, dwell
  extension, hysteresis, stable anchor, one-scale-per-scene, recall, determinism).
  `compare.ts` reports objective metrics (clip count, zoomed fraction, mean scale,
  click coverage) over a committed `InteractionTrack` fixture.
- Verify: `npx vitest run lib/auto-zoom`, `pnpm typecheck`. In-editor: press the
  Zoom panel's **Regenerate auto-zoom**, compare.
