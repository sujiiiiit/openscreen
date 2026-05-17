# Editor Canvas Knowledge Base

This document records the current video-canvas editor architecture, the terms we should use, features implemented so far, optimization decisions, problems encountered, and references used. Keep it current whenever the Konva editor, artboard, zoom, grid, video rendering, or related UI changes.

## Terminology

Use these names in code review, docs, comments, and new implementation plans. The shorter translation table lives in `docs/normal-term.md`.

| Common phrase used in discussion | Preferred industry term           | Meaning in this app                                                                                                     |
| -------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Outer canvas                     | Workspace or pasteboard           | The bounded editor surface around the artboard. Implemented by the Konva `Stage` viewport and the workspace background. |
| Inner canvas                     | Artboard or frame                 | The export-sized editable area, e.g. 1920 x 1080 for 16:9.                                                              |
| Canvas zoom                      | Viewport transform                | The `scale`, `x`, and `y` camera transform applied to the stage.                                                        |
| Elements                         | Canvas nodes or layer items       | Videos now; future text, shapes, subtitles, images, etc.                                                                |
| Hover bounds                     | Hover outline                     | A non-selecting visual outline shown around the canvas node under the pointer.                                          |
| Rotation degree                  | Rotation readout                  | A transient degree label shown while rotating the selected node.                                                        |
| Resize handles                   | Transformer                       | The Konva `Transformer` attached to the selected canvas node.                                                           |
| Pixel grid                       | Artboard pixel grid               | A 1 artboard pixel grid visible at high zoom inside the artboard.                                                       |
| Outer grid                       | Workspace grid or pasteboard grid | A future visual grid for the dark workspace outside the artboard. Not implemented yet.                                  |
| Background tab add video         | Media import action               | Local `video/*` file picker that adds a video node to the artboard.                                                     |
| Timeline area zoom value         | Canvas zoom control               | Footer dropdown showing and controlling current workspace zoom.                                                         |

## Current Scope

Implemented:

- Canva-like bounded editor workspace using Konva and react-konva.
- Resizable layout with sidebar, main workspace, and footer/timeline placeholder.
- Artboard presets: Wide 16:9, Vertical 9:16, Portrait 4:5, Standard 4:3, Square 1:1.
- Local video import from the Background tab.
- Live video playback inside the artboard.
- Selection, dragging, resizing, and rotation through Konva `Transformer`.
- Hover outline for unselected video nodes.
- Fixed bottom-center rotation readout while a selected node is rotating.
- Pointer-centered zoom, keyboard zoom, pinch zoom tuning, panning, and zoom dropdown.
- High-zoom artboard pixel grid.
- Snapping with Figma-style alignment guides during drag and resize, plus keyboard arrow nudging with grid snap.
- Workspace theme color token: `editor-workspace` = `#1e1e1e`.

Not implemented yet:

- Timeline editing.
- Player controls.
- Export/render pipeline.
- Audio controls.
- Cropping/masking.
- Workspace grid outside the artboard.
- Soft-bound zoom settling to remove hard edge jumps completely.

## Packages

- `konva@10.3.0`
- `react-konva@19.2.4`

`react-konva` is browser-only, so the stage is loaded with `next/dynamic(..., { ssr: false })` in `components/editor/main.tsx`.

## Files

| File                                                      | Responsibility                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/page.tsx`                                            | Top-level editor layout. Wraps the editor in `EditorCanvasProvider`, tooltip provider, vertical resizable panels, sidebar, main workspace, and footer.        |
| `components/editor/main.tsx`                              | Client-only dynamic import for `EditorWorkspace`.                                                                                                             |
| `components/editor/background-panel.tsx`                  | Background tab upload UI for adding local video files.                                                                                                        |
| `components/editor/footer.tsx`                            | Footer/timeline placeholder, artboard preset dropdown, and canvas zoom dropdown.                                                                              |
| `components/editor/canvas/provider.tsx`                   | Editor canvas state, video import metadata, artboard state, viewport size, view transform, and actions.                                                       |
| `components/editor/canvas/editor-workspace.tsx`           | Konva stage shell, layer composition, viewport sizing, zoom, pan, and keyboard shortcuts.                                                                     |
| `components/editor/canvas/artboard-pixel-grid.tsx`        | Custom non-listening pixel grid renderer for high zoom inside the artboard.                                                                                   |
| `components/editor/canvas/canvas-video-node.tsx`          | Live video node rendering, frame callbacks, object URL playback, cover crop attrs, and Konva node registration.                                               |
| `components/editor/canvas/selected-video-transformer.tsx` | Selected node transformer wiring, handle sizing, rotation snaps, and transform constraints.                                                                   |
| `components/editor/canvas/selection-toolbar.tsx`          | Floating DOM selection action bar for lock, duplicate, and delete.                                                                                            |
| `components/editor/canvas/artboard-preset-dropdown.tsx`   | Artboard preset dropdown in the footer.                                                                                                                       |
| `components/editor/canvas/canvas-zoom-menu.tsx`           | Canvas zoom dropdown and zoom percentage readout.                                                                                                             |
| `components/editor/canvas/canvas-node-constants.ts`       | Shared canvas node names, hover outline constants, transformer anchors, snap angles, snap thresholds, guide colors, keyboard nudge steps, and control colors. |
| `components/editor/canvas/snap-guide-overlay.tsx`         | Imperative Konva overlay drawing the pink Figma-style alignment and distance guides from a fixed line pool.                                                   |
| `components/editor/canvas/view-transform-utils.ts`        | Viewport interaction helpers for input target checks, modifier detection, and screen-pixel snapping.                                                          |
| `components/ui/dropdown-menu.tsx`                         | Shared dropdown menu primitives used by artboard and zoom controls.                                                                                           |
| `lib/editor-canvas.ts`                                    | Artboard presets, zoom/grid constants, fit transform, clamped view helpers, and pointer-centered zoom helper.                                                 |
| `lib/editor-canvas-snap.ts`                               | Pure snap math: rotated AABB, snap-cache builder, drag-snap and resize-snap solvers, equal-spacing distance guides, grid snap helpers.                        |
| `types/editor-canvas.ts`                                  | Canvas types: size, artboard, pixel grid settings, view transform, video item, transform patch.                                                               |
| `app/globals.css`                                         | Theme tokens, including `--editor-workspace`.                                                                                                                 |
| `docs/normal-term.md`                                     | Developer-friendly translation table from discussion terms to industry terms.                                                                                 |

## Architecture

The stage is a bounded viewport, not an infinite canvas.

```text
Editor layout
  EditorCanvasProvider
    Sidebar
      BackgroundPanel
    Main
      EditorWorkspace
        Konva Stage
          Background/grid Layer, listening=false
            Artboard fill
            ArtboardPixelGrid
          Content Layer
            Transparent hit rect
            Clipped artboard content group
              CanvasVideoNode[]
            Artboard border
          Snap Guide Layer, listening=false
            SnapGuideOverlay (pooled Konva.Line shapes)
          Selection Overlay Layer
            Hover outline
            SelectedVideoTransformer
        DOM selection toolbar
        DOM rotation readout
    Footer
      ArtboardPresetDropdown
      CanvasZoomMenu
      Timeline placeholder
```

Layer split:

- Background/grid layer is non-interactive and is not redrawn for every video frame.
- Content layer contains videos and the artboard hit/border nodes. Video frame updates call `batchDraw()` on this layer only.
- Selection overlay layer contains one hover outline and the Transformer so live video redraws do not repaint selection controls every decoded frame.
- DOM selection toolbar floats above the selected node and is positioned from the selected node's screen-space bounds, with a model-based fallback so selection always shows the toolbar even before the media node ref is ready.
- DOM rotation readout appears only while the active Transformer anchor is `rotater`. It is fixed at the bottom center of the workspace with a fully rounded badge and hides the selection toolbar for the duration of rotation.

## State Model

`EditorCanvasProvider` owns the canvas state and exposes narrowed context hooks so unrelated UI does not subscribe to every canvas state change.

Important types:

- `CanvasVideoItem`: `id`, `fileName`, `objectUrl`, `intrinsicWidth`, `intrinsicHeight`, `x`, `y`, `width`, `height`, `rotation`, `locked`.
- `EditorArtboard`: `presetId`, `width`, `height`.
- `ViewTransform`: `scale`, `x`, `y`.
- `PixelGridSettings`: `enabled`, `unit`, `majorUnit`, `visibleFromScale`, `opacity`, `color`, `majorOpacity`, `majorColor`, `role`.

Important actions:

- `addVideoFile(file)`
- `selectItem(id | null)`
- `updateVideoTransform(id, patch)`
- `setVideoLocked(id, locked)`
- `duplicateVideo(id)`
- `deleteVideo(id)`
- `setArtboardPreset(id)`
- `setViewportSize(size)`
- `setViewTransform(transform)`
- `fitArtboardToViewport()`

Context hooks:

- `useEditorCanvasMedia()`: videos, selection, selected video, import error.
- `useEditorCanvasArtboard()`: current artboard.
- `useEditorCanvasView()`: viewport size and viewport transform.
- `useEditorCanvasActions()`: stable canvas actions.
- `useEditorCanvas()`: compatibility hook that merges every context and should be avoided in hot or narrow components.

`ResizeObserver` updates the viewport size from the main editor area, so the Konva stage follows sidebar/footer resizing.

## Artboard

Presets live in `lib/editor-canvas.ts`.

Current presets:

- Wide: 1920 x 1080, 16:9.
- Vertical: 1080 x 1920, 9:16.
- Portrait: 1080 x 1350, 4:5.
- Standard: 1440 x 1080, 4:3.
- Square: 1080 x 1080, 1:1.

Changing the preset resets the view to fit and changes future video placement.

## Video Import And Rendering

The Background tab uses a local file picker with `accept="video/*"`.

On import:

- `readVideoMetadata()` creates a temporary `HTMLVideoElement`.
- It reads `videoWidth` and `videoHeight` from `loadedmetadata`.
- The video is placed as a cover fit over the current artboard.
- The created `objectUrl` is stored and revoked on provider unmount, import failure, or delete when no remaining duplicated video references the same URL.

For rendering:

- Each `CanvasVideoNode` creates one hidden `HTMLVideoElement`.
- Video element settings: `muted = true`, `loop = true`, `playsInline = true`, `preload = "auto"`.
- The actual `HTMLVideoElement` is passed directly to `Konva.Image` through the `image` prop.
- Video nodes use Konva `Image` crop props to emulate CSS `object-fit: cover`. Resizing the frame changes the visible box while the source video keeps its original pixel aspect ratio and is center-cropped instead of stretched.
- No video transcoding, canvas caching, intermediate bitmap resizing, or export resampling is done.
- `requestVideoFrameCallback()` is preferred for frame redraws.
- `Konva.Animation` is used as a fallback when video frame callbacks are unavailable.
- `CanvasVideoNode` is memoized and receives stable item-id callbacks, so viewport zoom/pan state does not re-render every mounted video node.

Quality notes:

- Keeping the source as a live `HTMLVideoElement` avoids compromising the original video before drawing.
- We do not set `Konva.pixelRatio = 1`; Konva keeps its normal device-pixel-ratio behavior.
- We do not cache video nodes, because caching would freeze or resample moving video.
- We keep image smoothing behavior natural for regular video. Turning smoothing off is more appropriate for pixel art, not normal video.
- Zoom can reveal source detail, but no renderer can invent detail beyond the video file's actual pixels.

## Interaction Model

Selection:

- Click a video to select it.
- Click the empty artboard hit rect to deselect.
- Selected video attaches one Konva `Transformer`.
- Selected video also shows a floating DOM toolbar with lock, duplicate, and delete actions.
- Locking keeps the video selectable and keeps the toolbar visible, but disables dragging, resize handles, side handles, and rotation controls. While locked, the toolbar collapses to the unlock action only and remeasures itself so it remains centered.
- Selection and drag persistence are handled at the `Stage` level by delegating events from nodes named `video-node`, rather than attaching full interaction handlers to every canvas node.
- Shortcuts when a node is selected: `Cmd/Ctrl + Shift + L` toggles lock, `Cmd/Ctrl + D` duplicates, `Delete` or `Backspace` deletes, and `Arrow` keys nudge the node by 1 artboard pixel (`Shift + Arrow` nudges by 10). Shortcuts are ignored while typing in editable controls.

Hovering:

- Moving the pointer over an unselected video node shows a hover outline around its bounds.
- The hover outline is one non-listening `Rect` in the selection overlay layer, not one outline per node.
- Pointer movement is handled at the `Stage` level by reading the current Konva event target and checking for the shared node name. This keeps the 5000+ node case bounded to one delegated branch, one ref lookup, and one overlay redraw only when the hovered node changes.
- Hover outline is hidden while panning, when leaving the stage, and when the hovered node becomes selected.

Dragging:

- Selected videos are draggable unless pan mode is active or the video is locked.
- Drag end stores `x` and `y` back into provider state.

Transforming:

- Corner anchors and side anchors are enabled.
- Corner anchors preserve aspect ratio with `keepRatio`; side handles allow direct horizontal or vertical resizing like Canva-style editor controls.
- Side-handle resizing behaves like resizing a DOM media frame with `object-fit: cover`: the frame can get wider, taller, narrower, or shorter, but the video itself does not distort. The selected node updates its Konva crop attrs during the active transform so the preview stays correct while dragging, then bakes the final width and height into state on `transformend`.
- Rotation is enabled with snaps at 0, 45, 90, 135, 180, 225, 270, and 315 degrees.
- While rotating, the selection toolbar is hidden and a compact bottom-center rotation readout appears in the workspace. The readout shows rounded signed degrees in a fully rounded `text-sm` badge.
- Flip is disabled.
- Minimum transformed size is 32 px.
- On transform end, scale is baked into `width` and `height`, then node scale resets to 1.
- Transformer handles, border, and rotation offset use fixed canvas-pixel sizes. Konva `Transformer` is rendered on the canvas, not as DOM, but it manages itself in absolute screen-like coordinates; applying an extra `1 / viewScale` makes handles oversized when zoomed out and too small when zoomed in.
- Transformer styling uses circular corner handles, pill-shaped side handles, a purple selection border, and a floating rotate handle below the node with inline Hugeicons refresh SVG path data drawn into the Konva anchor at a 2 px stroke.
- Locked videos keep the Transformer border but render no resize/rotate anchors.
- Transform follow and transform-end persistence live on the single active `Transformer`, not on every media node.

Panning:

- Space + drag pans.
- Middle mouse drag pans.
- Normal wheel pans the bounded workspace.
- High-frequency zoom and pan update the Konva `Stage` imperatively for immediate visual feedback, then coalesce React state commits with `requestAnimationFrame`.

Zooming:

- `Cmd/Ctrl + wheel` zooms around the pointer.
- Browser trackpad pinch is detected through the `ctrlKey` wheel path and uses a faster delta constant.
- `Cmd/Ctrl + +` zooms in.
- `Cmd/Ctrl + -` zooms out.
- `Cmd/Ctrl + 0` zooms to 100%.
- `Shift + 1` fits the artboard.
- Footer zoom dropdown supports zoom in, zoom out, zoom to fit, 50%, 100%, and 200%.

Current constants:

- Min zoom: 10%.
- Max zoom: 25,000%.
- Keyboard/menu zoom step: 1.18.
- Command-wheel delta: 60.
- Pinch delta: 16.

## Grids

Implemented grid:

- Artboard pixel grid only.
- Visible at 400% and above.
- Minor cells represent 1 artboard pixel.
- Major lines appear every 10 artboard pixels.
- Grid is visual-only and non-listening.
- Grid draws only the visible line range, not every possible line in the artboard.
- Grid is under content, so a full-artboard video covers it.

Not implemented:

- Workspace/pasteboard grid outside the artboard.
- Layout guide grid.
- Overlay grid above content.

Terminology reminder: if the user says "outer canvas grid", call it a "workspace grid" or "pasteboard grid". Do not confuse it with the artboard pixel grid.

## Snapping

Figma-style snapping is active during drag, resize, rotation, and keyboard arrow nudges. Snap math lives in `lib/editor-canvas-snap.ts`; pink dashed guide lines and equal-spacing segments render through `SnapGuideOverlay` on a dedicated non-listening Konva layer placed between the content and selection-overlay layers.

Snap targets:

- Artboard left, right, top, bottom edges.
- Artboard horizontal and vertical centers.
- Artboard rule-of-thirds lines (1/3 and 2/3 on each axis).
- Other canvas nodes: left, right, top, bottom edges and centers.
- Equal-spacing distance guides between two neighbors and the dragged node along the axis where the neighbors' cross-axis ranges overlap the dragged AABB. Each distance guide renders a small numeric label showing the rounded gap in artboard pixels.
- Dimension match during resize: when the dragged node's width or height comes within threshold of another node's width or height (or the artboard width or height), the resize snaps to make them equal. Corner anchors with `keepRatio` snap whichever dimension has the smaller delta and derive the cross axis from the original aspect ratio. Side anchors snap only the axis they own. The match renders short pink markers along both rectangles plus a `W <value>` or `H <value>` label.
- Integer artboard pixels (grid) during drag and resize when the artboard pixel grid is visible (zoom ≥ `PIXEL_GRID_SETTINGS.visibleFromScale`, i.e. 400%), and always when moving via keyboard arrow keys. The grid acts as a lowest-priority fallback per axis: it only fires when no artboard, smart-guide, or rule-of-thirds match was found.

Activation and override:

- Threshold is 6 screen pixels, constant across zoom (`SNAP_THRESHOLD_SCREEN_PX`). The artboard-space threshold passed to the solver is `SNAP_THRESHOLD_SCREEN_PX / viewTransform.scale`.
- Hold Cmd (macOS) or Ctrl (Windows/Linux) to disable snapping for that interaction. The modifier is tracked at `keydown`/`keyup` and read as a ref from the hot path so it does not trigger re-renders. A window `blur` listener resets the modifier ref so a Cmd+Tab away does not leave snapping permanently disabled.
- Rotation snaps to multiples of 45 degrees via `rotationSnaps` on the Transformer; this is independent of the alignment-guide snap pipeline and does not render guide lines.
- Keyboard arrow nudges go through the same snap pipeline as drag: `1` artboard pixel per press, `10` with Shift, then snapped against artboard edges, centers, rule-of-thirds, other nodes, equal-spacing, and (at ≥400% zoom) the artboard pixel grid. The dragged-node AABB is computed at the nudged candidate position before the solver runs, so the smart-guide pull is applied on top of the per-press step. The final position is rounded to whole artboard pixels. Locked nodes do not nudge. Cmd/Ctrl + Arrow falls through to the browser default (no nudge); to nudge without snapping, hold Cmd before pressing the arrow only if you want snapping disabled — currently Cmd suppresses the nudge entirely, so this is a known limitation.
- Keyboard snap is per-axis and never cancels the press: if the node is already aligned with a guide, pressing the arrow still moves the node by the step in that direction. A snap is only applied if the resulting position actually moved in the direction the user pressed; otherwise the raw step wins and no guide flashes for that axis. This prevents the "stuck on a guide" feel where consecutive presses would be undone by the snap pulling back.

Visual feedback:

- Guide stroke `#FF00FF` with a `4 px, 4 px` dash, rendered in artboard space with `strokeWidth = 1 / viewTransform.scale` so the line stays one screen pixel at any zoom.
- The overlay is imperative: a fixed pool of four guide lines, four distance segments, and two distance labels. `setGuides` updates `points`, `text`, and `visible`; no React reconciliation runs per drag frame.
- Distance labels render the rounded gap value at the midpoint of the first segment of each distance guide. Font size is `11 / viewTransform.scale` so the label stays at a constant screen size.

Algorithm shape:

- A snap cache is built once on drag start and once on transform start. It contains sorted vertical and horizontal stops for the artboard, rule-of-thirds, and every other node's edges and centers, plus axis-aligned bounding boxes for each other node. Sorted stop values are mirrored into a `Float32Array` so lookups can use binary search.
- The cache also drops nodes whose AABB does not overlap an inflated viewport (current viewport expanded 25% on each side), so 5000+ off-screen nodes contribute nothing to per-frame work.
- Per drag frame, the dragged node's rotated AABB is computed analytically from its live Konva attrs (no `getClientRect`). For each of its three edges per axis (start, center, end) the solver does a `lowerBound` into the sorted stops and scans only the small window of values within the threshold. The closest match per axis wins, with ties broken by stop priority (artboard center > artboard edge > node center > node edge > rule-of-thirds > grid).
- If no edge snap is found on an axis, the solver checks for equal-spacing between two cross-axis-overlapping neighbors; if `|gapLeft - gapRight|` is within the threshold, the dragged node snaps to equalize the gaps and two distance segments render at the midline of the union.
- Per resize frame the same pipeline runs, but only edges on the active anchor are allowed to snap. Corner anchors with `keepRatio` pick the dominant axis snap and derive the cross-axis length from the original aspect ratio, anchored at the opposite corner.
- Resize snap is skipped when the node has a non-zero rotation; rotated resize math would require oriented edge snapping that is not in scope for v1. (Rotated drag snap works, since the snap pipeline operates on the rotated AABB.)
- Keyboard arrow nudges flash the matched guide lines and distance segments on the same overlay used by drag, then auto-clear after 700 ms (the timer resets on each consecutive press, and any new drag start cancels a pending clear).

Performance shape:

- Snap cache is allocated once per drag or transform; per-frame work is O(stops + nodes) without allocations.
- The guide layer is `listening: false`; its shapes are pooled and only `points` / `visible` are mutated.
- Drag handlers stay imperative and never trigger a React state write for guide changes. The existing toolbar position update remains the only React state write on the hot path, and it is already coalesced through `requestAnimationFrame`.

## Workspace Theme

The outer workspace background color is a theme token:

- CSS variable: `--editor-workspace`
- Tailwind color: `bg-editor-workspace`
- Value: `#1e1e1e`

Use this token for future editor workspace surfaces instead of hardcoding the color.

## Problems, Decisions, And Solutions

### React-Konva And Next.js SSR

Problem:

- `react-konva` is browser-only and should not be imported into server-rendered modules.

Decision:

- `EditorWorkspace` is loaded through `next/dynamic` with `ssr: false` from `components/editor/main.tsx`.

Reference:

- Konva/react-konva guidance says browser-only usage requires a client guard or dynamic import.

### Video Quality

Problem:

- The editor must not blur or downsample imported video by transcoding, caching, or using intermediate canvases.

Decision:

- Store and draw the original `HTMLVideoElement` as the `Konva.Image` source.
- Avoid `cache()` on video nodes.
- Avoid per-frame React state updates.

References:

- Konva video-on-canvas example.
- MDN `HTMLVideoElement.requestVideoFrameCallback()`.
- MDN `CanvasRenderingContext2D.imageSmoothingEnabled`.

### Video Playback Performance

Problem:

- Redrawing the whole stage every video frame would waste work, especially with grids and future overlays.

Decision:

- Split the stage into background/grid, content, and selection overlay layers.
- Video frame callbacks only call `contentLayer.batchDraw()`.
- The grid layer is `listening={false}`.
- The Transformer lives in the overlay layer, so decoded video frames do not repaint controls while a video is selected.
- The selection toolbar is regular DOM over the stage, not part of any Konva layer, so video frame redraws never repaint toolbar buttons.
- Toolbar position is written imperatively through a ref. Drag and transform updates use the selected node's current `x`, `y`, `width`, `height`, `scale`, and `rotation` directly, avoiding hot-path `getClientRect()` and DOM size reads so the toolbar can follow the node immediately.
- Video nodes stay mostly passive: stage-level delegated drag/select handlers and Transformer-level transform handlers avoid thousands of per-node interaction callbacks in large scenes.
- Transformer anchors avoid canvas shadows in the hot path; strokes and fills provide the Canva-style control shape with much lower redraw cost.
- Hover bounds use one reusable non-listening overlay rect. The hover path does not create React state updates, per-node mouse handlers, per-node DOM overlays, or `getClientRect()` scans across the scene.
- The rotation readout is one fixed-position DOM node inside the workspace. Rotation frames update `textContent` and `visibility` only; they do not create React state updates, compute handle geometry, or add per-node overlays.
- Keep video nodes memoized, avoid new per-item callback props from the workspace render loop, and do not update React state on decoded video frames.

References:

- Konva performance guidance: keep computation low, be careful with layer count, use non-listening layers for passive graphics.

### Pixel Grid Performance

Problem:

- Drawing a full 1920 x 1080 1 px grid every frame would be expensive and unnecessary.

Decision:

- Draw the grid as a custom non-listening `Shape`.
- Only draw the visible line range based on the current viewport transform.
- Hide the grid below 400% zoom.
- Keep the grid in the background layer, not the video redraw layer.

References:

- Figma pixel grid behavior: pixel grid is visible at 400% or higher.
- Konva custom shape and performance guidance.

### React Render Churn

Problem:

- Zooming and panning update the viewport transform frequently. If every editor panel subscribes to the full canvas context or every video node receives fresh callback props on each render, React does unnecessary work during the hottest interaction path.

Decision:

- Split provider reads into media, artboard, view, and actions contexts.
- Use narrow hooks in the Background panel, artboard preset dropdown, zoom menu, and workspace.
- Memoize `CanvasVideoNode` and pass only the stable `onNodeChange(id, node)` callback; selection, dragging, and transforms are delegated at the `Stage` or active `Transformer` level.
- Apply pointer-driven viewport transforms directly to the Konva `Stage` in the hot path.
- Coalesce React viewport state commits through `requestAnimationFrame` for the zoom readout and derived grid/shadow props.
- Bail out of no-op selection, viewport-size, and video-transform state updates.

Result:

- Zoom/pan no longer waits for React to re-render before the canvas visibly moves, and it does not also re-render media import UI, artboard preset UI, or unchanged video node components.

### Pointer-Centered Zoom

Problem:

- Natural zoom should preserve the artboard point under the cursor.

Decision:

- Use pointer-centered zoom math in `getZoomedViewTransform()`.
- Convert the pointer to a world/artboard point using the old transform, then compute the new stage position from the new scale.

Reference:

- Konva zoom-relative-to-pointer demo.

### Hard Bounds And Zoom Jumping

Problem:

- When pointer-centered zoom reaches a pan bound, `clampWorkspaceView()` can change `x`/`y` after the pointer-zoom math. This makes the artboard shift under the cursor and looks like a visual jump.

Current status:

- The cause is understood.
- We relaxed pan bounds and snapped stage translation to screen pixels, which reduces some jitter.
- A complete soft-bound solution is not yet implemented.

Recommended next solution:

- Clamp zoom immediately but allow raw pointer-centered `x`/`y` during active wheel or pinch zoom.
- After wheel/pinch goes idle for about 120 to 180 ms, gently settle the view back inside bounds.
- Keep hard clamping for explicit fit and resize operations.

### Outer Workspace Grid

Problem:

- The user expected grid lines in the dark outer workspace.

Current status:

- Not implemented. The current pixel grid is clipped to the artboard.

Recommended next solution:

- Add a separate non-listening `WorkspaceGrid` below the artboard.
- Draw it in viewport/workspace coordinates with adaptive spacing.
- Keep it distinct from the artboard pixel grid.

### Canvas Module Refactor

Problem:

- The first implementation concentrated provider state, workspace behavior, rendering nodes, transformer logic, grid drawing, and footer controls into a few broad files.

Decision:

- Split the editor canvas into focused modules under `components/editor/canvas/`.
- Rename artboard/canvas helpers into `lib/editor-canvas.ts` so the file owns editor canvas constants and math, not only artboard presets.
- Keep UI controls near the canvas feature they control: `ArtboardPresetDropdown` and `CanvasZoomMenu`.

Result:

- Workspace behavior, video rendering, transformer behavior, grid drawing, and state management can now be read and changed independently without changing runtime behavior.

## References

- Konva zoom relative to pointer: https://konvajs.org/docs/sandbox/Zooming_Relative_To_Pointer.html
- Konva video on canvas: https://new.konvajs.org/docs/sandbox/Video_On_Canvas.html
- Konva Transformer API: https://konvajs.org/api/Konva.Transformer.html
- Konva performance tips: https://konvajs.org/docs/performance/All_Performance_Tips.html
- Konva Stage API, pointer position: https://konvajs.org/api/Konva.Stage.html
- Figma zoom and pixel grid behavior: https://help.figma.com/hc/en-us/articles/360041065034-Adjust-your-zoom-and-view-options
- Figma layout grids: https://help.figma.com/hc/en-us/articles/360040450513-Create-layout-grids-with-grids-columns-and-rows
- MDN `HTMLVideoElement.requestVideoFrameCallback()`: https://developer.mozilla.org/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
- MDN `CanvasRenderingContext2D.imageSmoothingEnabled`: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/imageSmoothingEnabled

## Verification Used So Far

Common checks after canvas changes:

```bash
pnpm exec eslint <changed files>
pnpm typecheck
pnpm build:next
```

Browser smoke tests have been run with local Chrome against `http://localhost:3535` to confirm:

- Konva canvases render.
- Two layers render after the background/content split.
- High zoom reaches 25,000%.
- Pixel grid appears at high zoom.
- Footer zoom dropdown opens and lists expected actions.

Known unrelated project issue:

- Full `pnpm lint` has failed on pre-existing unrelated files outside this canvas work. Use targeted lint for changed files unless the broader lint cleanup is part of the task.
