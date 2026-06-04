# Editor Canvas Snapping

Comprehensive reference for the snapping pipeline used by the Konva-based video
editor. Covers every snap target, the math, the data flow, the overlay
renderer, performance choices, known limits, and the manual test plan. The
higher-level editor doc is `docs/editor-canvas.md`; this file goes deep into
the snap system specifically. Industry terms come from `docs/normal-term.md`.

---

## 1. Purpose and scope

The editor supports Figma-style snapping during three kinds of interactions:

1. **Drag** — the user grabs a video node and moves it.
2. **Resize** — the user grabs a Transformer handle (corner or side anchor).
3. **Keyboard nudge** — Arrow keys move the selected node by whole artboard
   pixels (`1`, or `10` with Shift).

Rotation snapping (45° increments) is handled separately by the Konva
`Transformer`'s built-in `rotationSnaps` and is not part of this pipeline.

Goals of the pipeline:

- Match Figma's "hard snap with a pink dashed guide" feel.
- Provide a 6-screen-pixel pull threshold that stays constant across zoom.
- Allow the user to bypass snapping with Cmd or Ctrl.
- Cover artboard, peer-node, rule-of-thirds, pixel-grid, equal-spacing and
  dimension-match targets in a single composable solver.
- Stay correct at AGENTS.md's stress case of 5000+ canvas nodes by avoiding
  per-frame allocation, hot-path React state writes, and O(N) scans.

---

## 2. Glossary

| Term | Meaning |
| --- | --- |
| **Artboard** | Editable output frame (e.g. 1920×1080). Coordinates `(0, 0)` to `(artboard.width, artboard.height)`. |
| **Viewport** | Visible workspace area in screen pixels. Holds the Konva `Stage`. |
| **View transform** | `{ scale, x, y }` applied to the stage. Converts artboard ↔ screen coordinates. |
| **Artboard coordinates** | Local coordinates inside the artboard group — independent of the view transform. This is the canonical space for snap math. |
| **AABB** | Axis-aligned bounding box `{ x, y, width, height }` of a node, including its rotation. |
| **Snap stop** | A candidate value on one axis that the dragged AABB can lock onto. |
| **Edge** | One of three values per axis of a dragged AABB: `start`, `center`, `end`. |
| **Snap delta** | The 1-D adjustment that moves an edge onto a stop. Negative if the stop is below the edge value. |
| **Guide line** | The thin pink dashed line that flashes when a snap fires. |
| **Distance guide** | The two pink segments + numeric label drawn when equal-spacing fires between two neighbours and the dragged node. |
| **Dimension guide** | The short pink markers + `W <n>` / `H <n>` label drawn when a resize snaps the dragged width or height to match another node. |
| **Snap override modifier** | Cmd (macOS) / Ctrl (other) held during the interaction. Disables snapping for that interaction. |

---

## 3. Coordinate spaces and threshold

All snap math runs in **artboard coordinates** — the same space stored in
`CanvasVideoItem.x`, `y`, `width`, `height`. The view transform only matters
for the threshold conversion.

```
thresholdArtboard = SNAP_THRESHOLD_SCREEN_PX / viewTransform.scale
```

`SNAP_THRESHOLD_SCREEN_PX = 6` is defined in
`components/editor/canvas/canvas-node-constants.ts`. At 100% zoom that's 6
artboard px; at 400% zoom it's 1.5 artboard px; at 25% it's 24 artboard px.
The same threshold is used for every snap kind (edge, dimension, equal
spacing, grid).

Rotated nodes use their rotated AABB (computed analytically from the rotation
matrix). The snap pipeline does not need the node's `getClientRect()` and
therefore never walks the Konva scene graph during a drag.

---

## 4. Snap targets (catalogue)

The solver considers six categories of stops, listed in their tie-break
priority order (lower number wins on equal proximity):

| Priority | Kind | Description |
| --- | --- | --- |
| 0 | `artboard-center` | The artboard's horizontal and vertical midlines. |
| 1 | `artboard-edge` | The artboard's left/right (x=0, x=W) and top/bottom (y=0, y=H) edges. |
| 2 | `node-center` | Each other node's horizontal and vertical midlines (from its rotated AABB). |
| 3 | `node-edge` | Each other node's left, right, top, bottom edges. |
| 4 | `rule-of-thirds` | The 1/3 and 2/3 lines on each axis. |
| 5 | `grid` | Integer artboard pixels. Active only when `viewTransform.scale ≥ PIXEL_GRID_SETTINGS.visibleFromScale` (400%), and unconditionally for keyboard nudges. Lowest-priority fallback. |

In addition the solver runs two non-stop checks:

- **Equal spacing** — fires only when no edge snap matched on that axis. Looks
  for two neighbours whose cross-axis ranges overlap the dragged AABB, one on
  each side, such that `|gapLeft − gapRight|` is within threshold. Snap delta
  equalises the gaps.
- **Dimension match** (resize only) — checks if the dragged box's width or
  height is within threshold of any other node's width or height, or the
  artboard's width or height. When it fires it snaps the box dimensions and
  re-anchors at the corner/edge opposite the active anchor.

---

## 5. Architecture: data flow per frame

```
DRAG:
  onDragStart  →  buildDragSnapCache(excluding the dragged node)
  onDragMove   →  getRotatedAABB(live node) → findDragSnaps → mutate node.x/y
                                            → overlayRef.setGuides(...)
  onDragEnd    →  overlayRef.clear(), snapCacheRef.current = null
                  → updateVideoTransform(id, { x, y })

RESIZE (Transformer):
  onTransformStart  →  build resize snap cache (in selected-video-transformer.tsx)
  boundBoxFunc      →  findResizeSnap(oldBox, newBox, activeAnchor, ...)
                       → overlayRef.setGuides(guides, [], dimensions)
                       → return snapped box to Konva
  onTransformEnd    →  overlayRef.clear(), bake scale → width/height, persist

KEYBOARD NUDGE (Arrow keys):
  keydown  →  compute (dx, dy)
            →  buildDragSnapCache  →  findDragSnaps at candidate AABB
            →  apply snap only on nudged axis, only if it doesn't reverse the press
            →  overlayRef.setGuides(...) with a 700 ms auto-clear timer
            →  updateVideoTransform with rounded integer position
```

Nothing on the hot path triggers a React state update for the overlay. The
overlay is mutated through a single imperative ref
(`SnapGuideOverlayHandle.setGuides` / `clear`) and `layer.batchDraw()`.

The only React state writes during drag are the existing toolbar position
updates, which are already coalesced through `requestAnimationFrame`.

---

## 6. Files

| File | Responsibility |
| --- | --- |
| `lib/editor-canvas-snap.ts` | Pure snap math. No Konva or React imports. Owns `SnapCache`, all solvers, `applyEdgeSnap` / `applyCornerSnap` / `applyDimensionSnap`, and shared geometry helpers (`getRotatedAABB`, `viewportArtboardAABB`). |
| `components/editor/canvas/snap-guide-overlay.tsx` | The imperative overlay. Holds a fixed pool of `Konva.Line` and `Konva.Text` shapes, exposes `setGuides` / `clear` via `useImperativeHandle`. |
| `components/editor/canvas/canvas-node-constants.ts` | `SNAP_THRESHOLD_SCREEN_PX`, `SNAP_GUIDE_STROKE`, `SNAP_GUIDE_DASH`, `KEYBOARD_NUDGE_STEP`, `KEYBOARD_NUDGE_LARGE_STEP`. |
| `components/editor/canvas/editor-workspace.tsx` | Drag handlers, keyboard handler, snap-cache builder, overlay placement, modifier tracking, window-blur reset. |
| `components/editor/canvas/selected-video-transformer.tsx` | Resize-time snap inside `boundBoxFunc`, transform-start cache build, transform-end overlay clear. |
| `lib/editor-canvas.ts` | Provides `PIXEL_GRID_SETTINGS` and view-clamping helpers reused by the snap callers. |
| `types/editor-canvas.ts` | Shared `CanvasVideoItem`, `EditorArtboard`, `ViewTransform`, `CanvasSize` types. |

---

## 7. Snap cache

```ts
type SnapCache = {
  artboard: EditorArtboard
  verticalStops: SnapStop[]
  horizontalStops: SnapStop[]
  verticalValues: Float32Array      // sorted mirror of verticalStops[i].value
  horizontalValues: Float32Array
  widthStops: DimensionStop[]
  heightStops: DimensionStop[]
  otherNodes: Array<{ id: string; aabb: AABB }>
  gridStep: number | null
}
```

Built by `buildSnapCache({ artboard, otherVideos, includeRuleOfThirds,
gridStep, viewportAABB })`:

1. Seeds vertical and horizontal stop arrays with the artboard edges, the
   artboard centre, and (if requested) rule-of-thirds lines.
2. For each other video, computes its rotated AABB, and if a `viewportAABB`
   was supplied, skips the node when its AABB does not overlap the inflated
   viewport on **either** axis. This is the spatial pruning that makes
   5000-node scenes cheap.
3. Pushes that node's left, right and centre into `verticalStops`, and its
   top, bottom and centre into `horizontalStops`, with `spanStart` /
   `spanEnd` referring to the cross-axis range of the source AABB. The span
   limits the rendered guide line to the union of source + dragged AABB.
4. Pushes the node's AABB width and height into `widthStops` and
   `heightStops`. The artboard's own width and height are appended at the
   end so the user can also size-match the artboard.
5. Sorts both stop arrays by value (priority is the secondary sort key).
6. Mirrors the sorted values into `Float32Array`s so the solver can use
   `lowerBound` binary search.

`gridStep` is stored verbatim. The solver consults it as a per-axis fallback.

### Where the cache is built

- Workspace `buildDragSnapCache(excludeId)`
  ([editor-workspace.tsx](components/editor/canvas/editor-workspace.tsx)):
  reads `videosRef`, `artboardRef`, `viewportSizeRef`, `viewTransformRef`,
  computes an inflated viewport AABB (`±25%` on each side), and sets
  `gridStep = PIXEL_GRID_SETTINGS.unit` when `view.scale >=
  PIXEL_GRID_SETTINGS.visibleFromScale`, else `null`.
- Transformer `handleTransformStart`
  ([selected-video-transformer.tsx](components/editor/canvas/selected-video-transformer.tsx)):
  same logic, uses the prop refs the workspace passes in.

Both store the result into a local ref (`snapCacheRef` /
`resizeSnapCacheRef`) which is read by every subsequent frame and torn down
on `dragEnd` / `transformEnd`.

---

## 8. Drag-time snap pipeline

Entry: `handleDragMove` on the stage delegates to all nodes named
`video-node` (Konva node-name delegation, see
[canvas-node-constants.ts](components/editor/canvas/canvas-node-constants.ts)).

Steps per drag frame:

1. If `isSnapDisabledRef.current` (Cmd or Ctrl held) or no cache, clear the
   overlay and update the toolbar; return.
2. Compute the rotated AABB of the dragged node at its current Konva attrs
   via `getRotatedAABB`.
3. Convert the screen threshold to artboard space:
   `SNAP_THRESHOLD_SCREEN_PX / viewTransform.scale`.
4. Call `findDragSnaps(aabb, cache, threshold)` →
   `{ deltaX, deltaY, guides, distances }`.
5. If either delta is non-zero, mutate the node position imperatively:
   `videoNode.position({ x: x + deltaX, y: y + deltaY })`. Note: this is
   intentionally a delta on top of Konva's drag-tracked position, not an
   absolute set; we never fight Konva's drag state.
6. Push the guides and distance guides to `guideOverlayRef.current.setGuides`.
7. Update the floating selection toolbar via the existing rAF-coalesced path.

On `dragEnd` the overlay is cleared, `snapCacheRef.current` is nulled, and
`updateVideoTransform(id, { x, y })` persists the snapped position to the
provider.

### `findDragSnaps` algorithm

```ts
const edges = computeDraggedEdges(aabb)   // 3 per axis

let x = findAxisSnap(edges.vertical, cache.verticalStops, cache.verticalValues, threshold)
let y = findAxisSnap(edges.horizontal, cache.horizontalStops, cache.horizontalValues, threshold)

if (!x && cache.gridStep) x = findGridAxisSnap(edges.vertical, cache.gridStep, threshold)
if (!y && cache.gridStep) y = findGridAxisSnap(edges.horizontal, cache.gridStep, threshold)

if (!x) distance-spacing on x
if (!y) distance-spacing on y
```

`findAxisSnap` does:

```
for each dragged edge:
  i = lowerBound(values, edge.value − threshold)
  while values[i] <= edge.value + threshold:
    diff = values[i] − edge.value
    pick the candidate with the smallest |diff|
    (on ties, pick the candidate with the lowest STOP_PRIORITY)
```

`STOP_PRIORITY` is defined inline in `lib/editor-canvas-snap.ts`. The grid
fallback runs only when no other stop matched on that axis, so smart guides
always beat grid snap.

### Equal-spacing (distance guides)

`computeEqualSpacing(aabb, axis, otherNodes, threshold)`:

1. Filter `otherNodes` by cross-axis overlap with the dragged AABB.
2. Bin them into "left" (their end edge is before the dragged start) and
   "right" (their start edge is after the dragged end).
3. Pick the nearest neighbour on each side.
4. Compute `gapLeft = draggedStart − leftEnd`, `gapRight = rightStart −
   draggedEnd`. If `|gapRight − gapLeft| ≤ threshold`, the snap fires.
5. Snap delta = `(gapRight − gapLeft) / 2` so the gaps become equal.
6. Returned guide carries two segments: one from `leftEnd` to `draggedStart +
   delta`, one from `draggedEnd + delta` to `rightStart`. Cross-axis level is
   the midline of the union of all three rectangles' cross ranges.

The overlay renders these as two perpendicular dashed segments plus a numeric
label `gap` between them.

---

## 9. Resize-time snap pipeline

Lives in
[selected-video-transformer.tsx](components/editor/canvas/selected-video-transformer.tsx)
inside the Konva `Transformer`'s `boundBoxFunc`.

Konva calls `boundBoxFunc(oldBox, newBox)` for every transform iteration
with both boxes in the parent transform space, which for our editor is the
artboard coordinate space.

The transformer:

1. Skips snap if the node is locked, the proposed size would be below
   `MIN_VIDEO_NODE_SIZE`, or no cache is available.
2. Reads the active anchor via `transformer.getActiveAnchor()` (excludes
   `"rotater"`).
3. Computes the screen-pixel threshold the same way as drag.
4. Calls `findResizeSnap(oldBox, newBox, anchor, cache, threshold,
   keepRatio=true)` and uses its returned box.
5. Calls `guideOverlayRef.current.setGuides(snapped.guides, [],
   snapped.dimensions)`. Resize does not produce equal-spacing distance
   guides.

### `findResizeSnap` algorithm

The active anchor determines which edges may move:

| Anchor | Active vertical edge | Active horizontal edge |
| --- | --- | --- |
| `top-left` | `start` | `start` |
| `top-center` | — | `start` |
| `top-right` | `end` | `start` |
| `middle-left` | `start` | — |
| `middle-right` | `end` | — |
| `bottom-left` | `start` | `end` |
| `bottom-center` | — | `end` |
| `bottom-right` | `end` | `end` |

Only edges in the active set are eligible to snap on each axis. The solver
then computes four candidate snaps:

- `edge-x`: nearest x-axis stop the active vertical edge could lock onto.
- `edge-y`: nearest y-axis stop the active horizontal edge could lock onto.
- `dim-w`: closest `widthStop` to `newBox.width` (if a vertical edge is
  active).
- `dim-h`: closest `heightStop` to `newBox.height` (if a horizontal edge is
  active).

Grid fallback runs after edge snaps when `gridStep` is set.

#### Corner anchor + `keepRatio` (Canva / Figma style)

Sort the four candidates by absolute delta and pick the smallest. Apply
exactly one snap and let the cross axis follow:

- `edge-x` / `edge-y` → `applyCornerSnap(oldBox, newBox, anchor, axis, edge,
  delta)`. Snaps the active axis, then sets the cross axis to
  `width / height = oldBox.width / oldBox.height`. Anchors at the corner
  opposite the active handle.
- `dim-w` / `dim-h` → `applyDimensionSnap(oldBox, newBox, anchor, axis,
  targetValue, preserveRatio=true)`. Sets the snapped axis directly to the
  target value, derives the cross axis from the old ratio, and re-anchors at
  the opposite corner using the `anchorPivot` helper.

The winner-takes-all rule keeps the box on aspect ratio. Edge snaps still
render a guide line; dimension snaps render dimension markers + a label.

#### Side anchors (or corners without `keepRatio`)

Each active axis is resolved independently:

```
if active.vertical:
  if |edgeX.delta| <= |widthMatch.delta|:
     apply edge snap on x
  else:
     apply dimension snap on width
if active.horizontal:
  similar for y / height
```

`applyEdgeSnap` and `applyDimensionSnap` both leave the opposite edge (or
opposite corner / midpoint) fixed via the `anchorPivot` helper.

#### Skipped cases

- `newBox.rotation !== 0`: the function returns immediately with no snap.
  Rotated drag still works (the rotated AABB is well-defined), but rotated
  resize would require oriented edge snapping which is out of scope.
- No active anchor (the transformer is idle or the rotater is being dragged).
- `thresholdArtboard <= 0`.

### Output type

```ts
type ResizeSnapResult = {
  box: ResizeBox            // possibly-modified newBox
  guides: GuideLine[]       // edge / grid guides
  dimensions: DimensionGuide[]
}
```

---

## 10. Dimension match (size snap)

When you resize the second node toward the size of the first node, the
dimension solver makes the widths or heights snap to be equal.

### Stops

Built into the cache:

- One `DimensionStop` per other-node AABB width → `widthStops`.
- One per height → `heightStops`.
- The artboard's width and height are appended (with `nodeId: "__artboard__"`
  and an artboard-sized AABB) so the user can also size-match the artboard
  exactly.

### Solver

```ts
findDimensionSnap(currentValue, stops, threshold) → { delta, stop } | null
```

Linear scan over `widthStops` or `heightStops`. These arrays are short
(O(visible nodes) ≤ a handful of items per axis after pruning), so a linear
scan is fine here; binary-search optimisation is reserved for the dense
edge-stop arrays.

### Anchoring

`applyDimensionSnap` re-positions the box so the corner / midpoint opposite
the active anchor stays fixed at its current screen position. Pivot table:

| Active anchor | Pivot (kept fixed) |
| --- | --- |
| `top-left` | `(newBox.x + width, newBox.y + height)` |
| `top-center` | `(newBox.x + width/2, newBox.y + height)` |
| `top-right` | `(newBox.x, newBox.y + height)` |
| `middle-left` | `(newBox.x + width, newBox.y + height/2)` |
| `middle-right` | `(newBox.x, newBox.y + height/2)` |
| `bottom-left` | `(newBox.x + width, newBox.y)` |
| `bottom-center` | `(newBox.x + width/2, newBox.y)` |
| `bottom-right` | `(newBox.x, newBox.y)` |

After the new width/height is decided, x/y are recomputed so the pivot stays
where it was — no jump.

### Visual

For a width match, two short horizontal markers are drawn just above the
dragged rect and the matched rect (offset by `DISTANCE_LABEL_OFFSET_PX /
scale` so they stay 6 screen px above the top edge), each spanning the
rect's width. A `W <value>` label appears centred on top of the dragged
rect.

For a height match, the mirror behaviour on the left side with `H <value>`.

If a width snap and a height snap both fire (only possible in the corner +
keepRatio path because of the winner-takes-all rule, so this can only happen
when an edge snap and a dimension snap split the axes — currently not
supported in a single iteration), the overlay's pool size accommodates 4
markers + 2 labels.

---

## 11. Keyboard nudge snap

Arrow keys fire only when:

- A node is selected and unlocked.
- The user is not in an editable target (the existing `isEditableTarget`
  helper guards this).
- No zoom modifier (Cmd/Ctrl) is held — Cmd+Arrow is reserved for other
  shortcuts and falls through to the browser.

Per press:

1. Compute `dx`/`dy` from the key (`±1`, or `±10` with Shift). Only one of
   the two is non-zero.
2. Build a fresh drag-snap cache via `buildDragSnapCache(selectedVideo.id)`.
   This pulls in the current artboard, the up-to-date sibling list, the
   pruned viewport, and the appropriate `gridStep` for the current zoom.
3. Compute the rotated AABB at the **candidate** position
   `(selectedVideo.x + dx, selectedVideo.y + dy)`.
4. Call `findDragSnaps(aabb, cache, threshold)`.
5. Per-axis suppression rules:
   - The snap delta is **only** applied on the axis the user nudged. A
     vertical arrow never moves the node sideways onto an unrelated x-guide.
   - If applying the snap would result in zero movement or movement in the
     opposite direction from the press, the snap is dropped on that axis and
     the raw candidate is used instead. This is the "no cancel" rule that
     prevents the node from getting stuck on a guide.
6. Filter `result.guides` and `result.distances` so only guides on still-active
   axes flash on the overlay.
7. If any guides survived, `setGuides(filteredGuides, filteredDistances)` and
   start a 700 ms auto-clear timer. Consecutive presses reset the timer.
   Starting a drag cancels the pending timer.
8. Round the final `(finalX, finalY)` to whole artboard pixels via
   `snapToIntegerArtboardPixels` and persist with `updateVideoTransform`.

### Worked example

Setup: another node has its left edge at `x = 540`. View scale `1.0` →
threshold = 6 artboard px. Selected node currently at `x = 538`.

| Press | Candidate `x` | Snap delta | `finalX − 538` | Behaviour |
| --- | --- | --- | --- | --- |
| Right | 539 | +1 (snap to 540) | +2 (538 → 540) | Snap fires, guide flashes at `x=540`. |
| Right | 541 | −1 (snap to 540) | 0 → cancelled by no-cancel rule | Raw `x = 541`, no guide. |
| Right | 542 | −2 (snap to 540) | −1, opposite sign → cancelled | Raw `x = 542`. |
| Right | 543 | out of threshold | n/a | Raw `x = 543`. |

The user can therefore move past a guide by pressing the same arrow again.

---

## 12. Visual overlay

[snap-guide-overlay.tsx](components/editor/canvas/snap-guide-overlay.tsx)
exports `SnapGuideOverlay` and a handle type
`SnapGuideOverlayHandle`.

### Pool sizes

| Pool | Count | Purpose |
| --- | --- | --- |
| `guideRefs` | 4 `Konva.Line` | Primary edge / grid guides. |
| `distanceRefs` | 4 `Konva.Line` | Equal-spacing segments (2 per distance guide × 2 max). |
| `labelRefs` | 2 `Konva.Text` | Distance guide gap labels. |
| `dimensionLineRefs` | 4 `Konva.Line` | Dimension match markers (2 per match × 2 max). |
| `dimensionLabelRefs` | 2 `Konva.Text` | `W <n>` / `H <n>` labels. |

All shapes are created once on mount and mutated via `node.points(...)`,
`node.x(...)`, `node.text(...)`, `node.visible(...)`. They are
`listening: false`, `perfectDrawEnabled: false`, and
`shadowForStrokeEnabled: false`.

### Strokes and labels

- Stroke colour: `#FF00FF` (`SNAP_GUIDE_STROKE`).
- Stroke width: `1 / viewTransform.scale` (artboard space). Together with
  the default `strokeScaleEnabled = true`, the rendered stroke stays one
  screen pixel at any zoom.
- Dash: `[4 / scale, 4 / scale]`.
- Label font size: `11 / scale`. Each label centres itself with `offsetX =
  width / 2`, `offsetY = height / 2`.
- Label offset for dimension markers: `6 / scale` screen pixels above (width
  match) or left of (height match) the rectangles.

### Imperative API

```ts
type SnapGuideOverlayHandle = {
  setGuides(
    guides: GuideLine[],
    distances: DistanceGuide[],
    dimensions?: DimensionGuide[]
  ): void
  clear(): void
}
```

`setGuides` always processes every pool slot — slots without a corresponding
payload are hidden. `clear` walks every pool ref once, hiding any node
currently visible, and only calls `batchDraw()` if at least one node was
mutated.

The overlay is placed on its own `<Layer listening={false}>` between the
content layer (videos) and the existing overlay layer (transformer + toolbar
host). Guides therefore sit above the videos and below the selection
controls, exactly like Figma's behaviour.

---

## 13. Modifier override and window blur

`isSnapDisabledRef: RefObject<boolean>` is updated by the workspace's
key handlers:

- `keydown` on `Meta` or `Control` → `true`, and the overlay is cleared.
- `keyup` on `Meta` or `Control` (when neither modifier remains held) →
  `false`.
- `window` `blur` → both `isSnapDisabledRef` and `isSpacePressedRef` are
  reset to `false`. This handles the case where the user Cmd+Tab'd away
  while holding the modifier, so the `keyup` never fires inside the page.

All hot-path snap functions early-return when this ref is true:

- `handleDragMove`: snaps are skipped and the overlay is cleared.
- `boundBoxFunc` in the transformer: snaps are skipped, snapped output box
  is the raw `newBox`, overlay cleared.
- Keyboard nudge: snaps are skipped, no guide flashes, the raw integer step
  is applied.

---

## 14. Performance design

Every choice in this list is deliberate and verified against the AGENTS.md
target of 5000+ canvas nodes:

1. **Cache once, query many.** The O(N) work — iterating every other node,
   computing rotated AABBs, sorting — happens only at drag-start and
   transform-start, not per frame.
2. **Spatial pruning.** Nodes whose AABB doesn't overlap the inflated
   viewport (±25%) are dropped before they enter the cache. With 5000 nodes
   off-screen they contribute nothing to per-frame work.
3. **Binary-search lookup.** Edge-stop arrays are sorted by value and
   mirrored into `Float32Array`s. Each dragged edge does one `lowerBound`
   call and scans only the threshold window. Worst case per axis is O(log N
   + k) where k is the number of stops within `threshold`.
4. **Dimension stops use linear scan**, which is fine because the array
   length is O(visible nodes) after pruning, typically ≤ 50.
5. **No per-frame allocation.** `findDragSnaps` allocates one small object
   per axis and pushes at most three entries to local arrays; no maps, no
   sets, no spread, no `getClientRect`. `setGuides` mutates a fixed Konva
   shape pool; no shapes are created or destroyed on the hot path.
6. **No React state writes on snap frames.** The overlay state lives in
   refs. The only React state the drag still touches is the
   already-coalesced toolbar position update.
7. **`listening: false` guide layer.** Hit testing is skipped on the guide
   layer entirely, so it adds no per-event overhead.
8. **Modifier check is a ref read, not a re-render.** Pressing Cmd doesn't
   re-render the workspace; it flips a boolean read inline by
   `handleDragMove` / `boundBoxFunc` / the arrow handler.
9. **AABB math, not Konva traversal.** All rect computations use
   `getRotatedAABB`, which is four cosine/sine multiplications, never the
   tree-walking `getClientRect`.

---

## 15. Edge cases

| Case | Behaviour |
| --- | --- |
| Locked node | `CanvasVideoNode` sets `draggable={!locked}`, so drag never fires. Resize is blocked because the transformer's `enabledAnchors` is empty when locked. Keyboard nudge short-circuits on `selectedVideo.locked`. |
| Rotated node (drag) | Snap pipeline operates on the rotated AABB. Position snaps work; rotation is preserved. |
| Rotated node (resize) | `findResizeSnap` early-returns with no snap. The Transformer's existing 45° rotation snaps still work via `rotationSnaps`. |
| Multi-edge collision (e.g. dragged left = artboard left and dragged centre = node centre) | The solver tests all three edges per axis and picks the smallest |delta|. Tie-broken by `STOP_PRIORITY`. |
| Snap delta exactly at threshold | Inclusive; `distance > threshold` filters out, anything ≤ threshold is a candidate. |
| Snap cache built with zero other nodes | Edge stops still include artboard edges/centre and (optional) rule-of-thirds; the pipeline degrades gracefully and only snaps to artboard targets. |
| Zoom = 0 or undefined | Threshold conversion is guarded by `Math.max(0.0001, scale)`. |
| Empty viewport (resized to 0) | `buildDragSnapCache` skips the viewport-AABB step and passes `null` for `viewportAABB`, disabling pruning. |
| User starts a drag while a nudge guide timer is still pending | `handleDragStart` cancels the timer and clears the overlay before the drag's first `dragmove` fires. |
| User holds Cmd / Ctrl across a window blur | `window.blur` listener resets `isSnapDisabledRef`; on return, the modifier ref is `false` until the user presses Cmd/Ctrl again. |
| Equal-spacing with rotated neighbours | Uses each neighbour's rotated AABB, so equal-spacing still fires between rotated rectangles. |
| Dimension match with rotated nodes | Width and height of the rotated AABB are used, so a rotated neighbour with AABB width 540 will snap a non-rotated dragged box to width 540. (Resize is still skipped if the **dragged** node is rotated.) |

---

## 16. Known limitations

- **Rotated resize**: any non-zero rotation on the resized node short-circuits
  the resize snap. Rotated drag and rotated dimension stops still work.
- **Cmd / Ctrl + Arrow keyboard nudge**: the existing shortcut layout
  reserves Cmd/Ctrl + Arrow for browser behaviour, so the nudge handler does
  not fire when the modifier is held. Today there is no way to do a
  "step-only, no snap" keyboard nudge.
- **Keyboard nudge cancels guides aggressively**: by design, if applying a
  snap would zero or reverse the press, the guide for that axis is dropped.
  This means landing exactly on a guide via the keyboard does not always
  flash the line.
- **Equal-spacing only considers two neighbours**: one on each side along the
  active axis. Three-way equal spacing (e.g. four shapes A-B-C-D with three
  equal gaps) is not detected.
- **Dimension match has no `getActiveAnchor()` fallback**: if Konva returns
  `null` for `getActiveAnchor()` (rare), `findResizeSnap` returns the
  unchanged box and clears the overlay.
- **Hover smart guides**: Figma flashes guides on hover even without a drag.
  Not supported here; guides only render during drag, resize, or keyboard
  nudge.

---

## 17. Manual verification plan

Recommended after any change that touches the snap pipeline. Open
`http://localhost:3535` with the editor and import two or three videos.

1. **Artboard edges** — drag a video toward each edge of the artboard; a
   pink line flashes at the matched edge and the node snaps.
2. **Artboard centre** — drag toward the centre; both axes snap, two
   perpendicular lines cross at the centre.
3. **Rule of thirds** — drag near the 1/3 and 2/3 lines on each axis; a
   pink line at the relevant third flashes.
4. **Smart guide edges** — drag a video so its left, right, top, or bottom
   aligns with another video's matching edge; the guide line spans the union
   of both AABBs along the cross axis.
5. **Smart guide centres** — drag to align centres; horizontal / vertical
   centre lines flash.
6. **Distance guides** — place three videos roughly evenly along an axis,
   drag the middle one; the two equal-spacing segments and the gap label
   flash when within threshold.
7. **Grid snap during drag at high zoom** — zoom past 400% so the artboard
   pixel grid is visible; drag a video; position snaps to integer artboard
   pixels even when no smart guide is in range.
8. **Resize snap (side anchors)** — drag a middle-left, middle-right,
   top-centre, or bottom-centre anchor toward an artboard edge or another
   node's edge; only the active edge snaps, the opposite edge stays fixed.
9. **Resize snap (corner anchors with keepRatio)** — drag a corner toward
   alignment; the dominant axis snaps and the cross axis follows aspect
   ratio.
10. **Dimension match (width)** — make node B larger than node A, grab node
    B's bottom-right corner, drag inward until widths match; the `W <n>`
    label and two short pink markers above each rect flash.
11. **Dimension match (height)** — same on the vertical axis; expect `H
    <n>` on the left.
12. **Dimension match to artboard** — resize a node to match the artboard's
    width or height; the markers + label appear.
13. **Keyboard nudge with snap** — select a node near a guide; press the
    arrow that moves it toward the guide; snap fires + guide flashes for
    ~700 ms. Press again to move past; raw step applies, no guide.
14. **Keyboard nudge does not get stuck** — sit a node exactly on a guide;
    press the arrow repeatedly; the node should move by `1` each press,
    no guide flash on the cancelled-snap axis.
15. **Cmd/Ctrl override during drag** — hold Cmd while dragging; no snap,
    no guides.
16. **Cmd/Ctrl override during resize** — hold Cmd while resizing; no
    snap, no guides.
17. **Window blur + modifier release** — hold Cmd, switch to another app,
    release Cmd outside the page, return; the next drag snaps normally.
18. **Rotation snap (legacy)** — rotate via the rotate anchor; rotation
    locks to 45° increments via the existing `rotationSnaps`. No pink
    guides flash for rotation.
19. **Rotated drag** — rotate a node, then drag it; smart guides still
    fire against the rotated AABB.
20. **5000-node perf sanity** — script-create 5000 placeholder rects (or
    do it manually with smaller counts), drag one across the artboard;
    DevTools performance trace should show no per-frame allocation spikes
    and the dragged frame budget should remain under 16 ms.

After code changes, also run:

```bash
pnpm exec eslint \
  components/editor/canvas/editor-workspace.tsx \
  components/editor/canvas/selected-video-transformer.tsx \
  components/editor/canvas/canvas-node-constants.ts \
  components/editor/canvas/snap-guide-overlay.tsx \
  lib/editor-canvas-snap.ts
pnpm typecheck
```

`pnpm lint` repo-wide has pre-existing unrelated failures; use targeted lint
on the touched files only.

---

## 18. API reference

### Types

```ts
// lib/editor-canvas-snap.ts

type AABB = { x: number; y: number; width: number; height: number }

type SnapStopKind =
  | "artboard-edge"
  | "artboard-center"
  | "rule-of-thirds"
  | "grid"
  | "node-edge"
  | "node-center"

type SnapStop = {
  value: number
  kind: SnapStopKind
  nodeId?: string
  spanStart?: number
  spanEnd?: number
}

type DimensionStop = {
  value: number
  nodeId: string
  aabb: AABB
}

type SnapCache = {
  artboard: EditorArtboard
  verticalStops: SnapStop[]
  horizontalStops: SnapStop[]
  verticalValues: Float32Array
  horizontalValues: Float32Array
  widthStops: DimensionStop[]
  heightStops: DimensionStop[]
  otherNodes: Array<{ id: string; aabb: AABB }>
  gridStep: number | null
}

type GuideLine = {
  axis: "x" | "y"
  value: number
  kind: SnapStopKind
  from: number
  to: number
}

type DistanceGuide = {
  axis: "x" | "y"
  gap: number
  segments: Array<{ from: number; to: number; cross: number }>
}

type DimensionGuide = {
  axis: "width" | "height"
  value: number
  draggedRect: AABB
  matchedRect: AABB
}

type ResizeBox = {
  x: number; y: number; width: number; height: number; rotation: number
}

type ResizeAnchor =
  | "top-left" | "top-center" | "top-right"
  | "middle-left" | "middle-right"
  | "bottom-left" | "bottom-center" | "bottom-right"
  | null

type SnapResult = {
  deltaX: number
  deltaY: number
  guides: GuideLine[]
  distances: DistanceGuide[]
}

type ResizeSnapResult = {
  box: ResizeBox
  guides: GuideLine[]
  dimensions: DimensionGuide[]
}
```

### Functions

| Function | Purpose |
| --- | --- |
| `getRotatedAABB(item)` | Returns axis-aligned bounding box of a `{ x, y, width, height, rotation }` item. Used by drag and cache builder. |
| `buildSnapCache({ artboard, otherVideos, includeRuleOfThirds, gridStep?, viewportAABB? })` | Builds a `SnapCache`. Runs once per drag-start / transform-start. |
| `computeDraggedEdges(aabb)` | Returns the 3 vertical + 3 horizontal edges for a dragged AABB. |
| `findDragSnaps(aabb, cache, threshold)` | Returns `{ deltaX, deltaY, guides, distances }` for a drag frame. |
| `findResizeSnap(oldBox, newBox, anchor, cache, threshold, keepRatio)` | Returns `{ box, guides, dimensions }` for a resize frame. |
| `snapToIntegerArtboardPixels(value)` | `Math.round(value)`. Used at keyboard nudge commit. |
| `gridSnapActive(scale, pixelGridVisibleFromScale)` | Boolean helper exported for callers that want to mirror the workspace's grid-activation rule. |
| `viewportArtboardAABB(viewportSize, viewTransform)` | Returns the viewport's AABB in artboard coords. Used to compute the pruning window. |

### Constants

| Constant | Value | Source |
| --- | --- | --- |
| `SNAP_SCREEN_PX` | `6` | `lib/editor-canvas-snap.ts` (the math-side mirror) |
| `SNAP_THRESHOLD_SCREEN_PX` | `6` | `canvas-node-constants.ts` (used by callers) |
| `SNAP_GUIDE_STROKE` | `"#FF00FF"` | `canvas-node-constants.ts` |
| `SNAP_GUIDE_DASH` | `[4, 4]` | `canvas-node-constants.ts` |
| `KEYBOARD_NUDGE_STEP` | `1` | `canvas-node-constants.ts` |
| `KEYBOARD_NUDGE_LARGE_STEP` | `10` | `canvas-node-constants.ts` |
| Grid step | `PIXEL_GRID_SETTINGS.unit` | `lib/editor-canvas.ts` |
| Grid activation zoom | `PIXEL_GRID_SETTINGS.visibleFromScale` (`4`) | `lib/editor-canvas.ts` |

---

## 19. Change log

- **2026-05-17** — Initial dedicated snapping reference, capturing the
  pipeline as it stands after the keyboard-snap, dimension-match, binary
  search, spatial pruning, distance-label, and no-cancel-nudge passes. See
  the `docs/editor-canvas.md` Snapping section for a shorter user-level
  summary and `docs/normal-term.md` for the discussion ↔ industry term
  translation table.
