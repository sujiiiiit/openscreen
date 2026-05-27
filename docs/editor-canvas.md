# Editor Canvas Knowledge Base

This document records the current video-canvas editor architecture, the terms we should use, features implemented so far, optimization decisions, problems encountered, and references used. Keep it current whenever the Konva editor, artboard, zoom, grid, video rendering, or related UI changes.

## Terminology

Use these names in code review, docs, comments, and new implementation plans. The shorter translation table lives in `docs/normal-term.md`.

| Common phrase used in discussion | Preferred industry term           | Meaning in this app                                                                                                                   |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Outer canvas                     | Workspace or pasteboard           | The bounded editor surface around the artboard. Implemented by the Konva `Stage` viewport and the workspace background.               |
| Inner canvas                     | Artboard or frame                 | The export-sized editable area, e.g. 1920 x 1080 for 16:9.                                                                            |
| Canvas section                   | Workspace section                 | Top editor section containing the fixed/collapsible sidebar and Konva workspace.                                                      |
| Timeline section                 | Timeline panel                    | Resizable bottom editor panel reserved for timeline/playback UI.                                                                      |
| Sidebar section                  | Editor sidebar                    | Fixed-width left editor panel with its own collapse animation; it is not resizable.                                                   |
| Canvas zoom                      | Viewport transform                | The `scale`, `x`, and `y` camera transform applied to the stage.                                                                      |
| Elements                         | Canvas nodes or layer items       | Videos now; future text, shapes, subtitles, images, etc.                                                                              |
| Hover bounds                     | Hover outline                     | A non-selecting visual outline shown around the canvas node under the pointer.                                                        |
| Rotation degree                  | Rotation readout                  | A transient degree label shown while rotating the selected node.                                                                      |
| Resize handles                   | Transformer                       | The Konva `Transformer` attached to the selected canvas node.                                                                         |
| Pixel grid                       | Artboard pixel grid               | A 1 artboard pixel grid visible at high zoom inside the artboard.                                                                     |
| Outer grid                       | Workspace grid or pasteboard grid | A future visual grid for the dark workspace outside the artboard. Not implemented yet.                                                |
| Background tab add video         | Media import action               | Local `video/*` file picker that adds a video node to the artboard.                                                                   |
| Timeline area zoom value         | Canvas zoom control               | Footer dropdown showing and controlling current workspace zoom.                                                                       |
| Timeline block                   | Timeline clip                     | A non-destructive time range that references one canvas video and stores timeline in/out plus source in/out.                          |
| Left labels in timeline          | Track label rail                  | A fixed row-name column beside timeline lanes; currently omitted. The unlabeled timeline keeps a 30 px start inset.                   |
| Grid snap in timeline            | Timeline grid snap                | Clip move/resize snapping to the ruler subdivision grid.                                                                              |
| Auxiliary line snap              | Timeline guide-line snap          | Clip edge snapping to other clip edges and the playhead, with temporary vertical guide lines.                                         |
| Timeline auto scroll             | Timeline edge auto-scroll         | Horizontal scrolling while dragging a clip near the visible timeline edge.                                                            |
| Ruler time style                 | Ruler tick label format           | Clock-style timeline labels, e.g. `0:15`, `1:00`, and `1:05:00`; compact major dot ticks remain visible while labels keep a wide gap. |
| Controls on top                  | Timeline transport controls       | Theme-colored skip, play/pause, and playback time controls in the footer's top toolbar, above the ruler and lanes.                    |
| Timeline zoom                    | Timeline zoom                     | Horizontal timeline scale controls that increase or decrease pixels per second.                                                       |
| Fit timeline                     | Fit longest clip to width         | Default timeline view mode that scales the widest clip block to the visible timeline width and scrolls to that clip.                  |
| Play cursor                      | Playhead                          | Current committed timeline time used to sample every canvas video.                                                                    |
| Secondary hover seek             | Hover preview                     | Paused-only ghost cursor that previews the frame under the pointer without writing the committed playhead. Hover seeks are coalesced by rAF, gated per-element, and cancelled by any committed write. |
| Frames going forth and back      | Stale seek redraw                 | An older completed media seek repainting the canvas after a newer committed playhead seek; guarded by committed-time redraw checks.   |
| Cut video edge                   | Source trim                       | Non-destructive `sourceIn` / `sourceOut` adjustment created by resizing a timeline clip.                                              |
| Frozen clip frame                | Inactive clip visibility          | Playback sync rule that hides a canvas media node outside its active clip range instead of holding an edge frame.                     |
| Border radius / rounded corners  | Corner radius (squircle)          | Per-node corner radius in artboard pixels, drawn as an iOS / macOS-style continuous-corner squircle.                                  |
| iOS / macOS smooth corners       | Corner smoothing                  | Per-node 0–1 smoothing factor; 0 = circular arc, 0.6 = macOS look, 1 = fully continuous-curvature.                                    |

## Current Scope

Implemented:

- Canva-like bounded editor workspace using Konva and react-konva.
- Two-section resizable layout: fixed/collapsible sidebar plus workspace in the top section, timeline panel in the bottom section.
- Artboard presets: Wide 16:9, Vertical 9:16, Portrait 4:5, Standard 4:3, Square 1:1.
- Local video import from the Background tab.
- Live video playback inside the artboard.
- Timeline panel with top transport controls, playhead scrubbing, unlabeled neutral media lanes, and editable clips.
- Non-destructive source trims for timeline clips.
- Export/render pipeline for MP4 / WebM output.
- Playhead-driven playback sync for screen, camera, and imported media.
- Selection, dragging, resizing, and rotation through Konva `Transformer`.
- Hover outline for unselected video nodes.
- Fixed bottom-center rotation readout while a selected node is rotating.
- Pointer-centered zoom, keyboard zoom, pinch zoom tuning, panning, and zoom dropdown.
- High-zoom artboard pixel grid.
- Snapping with Figma-style alignment guides during drag and resize, plus keyboard arrow nudging with grid snap.
- Workspace theme color token: `editor-workspace` = `#1e1e1e`.
- Per-node video appearance via the Video sidebar tab: squircle corner radius + smoothing, a squircle-following border (width, color, alignment, offset), and a squircle-following drop shadow (color with baked alpha, X / Y, blur, spread).
- Auto-routing of canvas / timeline selection to the Video tab via a `SidebarSelectionBridge`.
- Non-destructive remove-from-canvas: deleting a video (recorded or imported) detaches it from the canvas/timeline but keeps it in the project; the Video tab lists it with an **Add** action to put it back.

Not implemented yet:

- Audio controls.
- Cropping/masking.
- Workspace grid outside the artboard.
- Soft-bound zoom settling to remove hard edge jumps completely.

## Packages

- `konva@10.3.0`
- `react-konva@19.2.4`

`react-konva` is browser-only, so the stage is loaded with `next/dynamic(..., { ssr: false })` in `components/editor/main.tsx`.

## Files

| File                                                      | Responsibility                                                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/page.tsx`                                            | Top-level editor layout. Wraps the editor in `EditorCanvasProvider`, tooltip provider, one vertical resizable group, top workspace section, and timeline panel. |
| `components/editor/main.tsx`                              | Client-only dynamic import for `EditorWorkspace` and full-size workspace panel wrapper.                                                                         |
| `components/editor/background-panel.tsx`                  | Background tab upload UI for adding local video files.                                                                                                          |
| `components/editor/footer.tsx`                            | Footer shell containing the artboard preset dropdown, top timeline transport controls, audio status, canvas zoom dropdown, and timeline panel.                  |
| `components/editor/timeline-panel.tsx`                    | Timeline UI, playback controls, playhead scrubbing, clip rendering, and move/resize handlers.                                                                   |
| `components/editor/sidebar.tsx`                           | Left editor sidebar, tab rail, tab content panel, and fixed-width collapse/expand animation.                                                                    |
| `components/editor/canvas/provider.tsx`                   | Editor canvas state, video import metadata, artboard state, viewport size, view transform, and actions.                                                         |
| `components/editor/canvas/editor-workspace.tsx`           | Konva stage shell, layer composition, viewport sizing, zoom, pan, and keyboard shortcuts.                                                                       |
| `components/editor/canvas/artboard-pixel-grid.tsx`        | Custom non-listening pixel grid renderer for high zoom inside the artboard.                                                                                     |
| `components/editor/canvas/canvas-video-node.tsx`          | Live video node rendering, frame callbacks, object URL playback, cover crop attrs, squircle sceneFunc with passes for drop shadow (off-canvas-cast technique) and per-node border, hitFunc kept at the node body, and Konva node registration.   |
| `components/editor/video-panel.tsx`                       | Video tab UI: file-card list of every project video — on-canvas videos (action: **Select**) followed by detached videos (action: **Add**) — with the appearance controls (Corners — radius + smoothing; Border — width, color, alignment, offset; Shadow — color with baked alpha, X, Y, blur, spread) shown when a card is selected.              |
| `lib/rgba-color.ts`                                       | Minimal rgba parser / formatter shared by `CanvasVideoNode` and the Shadow color picker. Accepts `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`, `rgba(...)`, and `transparent`; emits a normalised `rgba(R, G, B, A)` string.                                                                |
| `components/editor/sidebar/selection-bridge.tsx`          | Subscribes to canvas selection and switches the sidebar to the Video tab + opens the sidebar whenever a video is selected.                                      |
| `lib/squircle.ts`                                         | Figma-style continuous-corner math. `computeSquircleCornerParams(radius, smoothing)` and `traceSquirclePath(ctx, w, h, params)` for allocation-free hot path.   |
| `components/editor/canvas/selected-video-transformer.tsx` | Selected node transformer wiring, handle sizing, rotation snaps, and transform constraints.                                                                     |
| `components/editor/canvas/selection-toolbar.tsx`          | Floating DOM selection action bar for lock, duplicate, and delete.                                                                                              |
| `components/editor/canvas/artboard-preset-dropdown.tsx`   | Artboard preset dropdown in the footer.                                                                                                                         |
| `components/editor/canvas/canvas-zoom-menu.tsx`           | Canvas zoom dropdown and zoom percentage readout.                                                                                                               |
| `components/editor/canvas/canvas-node-constants.ts`       | Shared canvas node names, hover outline constants, transformer anchors, snap angles, snap thresholds, guide colors, keyboard nudge steps, and control colors.   |
| `components/editor/canvas/snap-guide-overlay.tsx`         | Imperative Konva overlay drawing the pink Figma-style alignment and distance guides from a fixed line pool.                                                     |
| `components/editor/canvas/view-transform-utils.ts`        | Viewport interaction helpers for input target checks, modifier detection, and screen-pixel snapping.                                                            |
| `components/ui/dropdown-menu.tsx`                         | Shared dropdown menu primitives used by artboard and zoom controls.                                                                                             |
| `lib/editor-canvas.ts`                                    | Artboard presets, zoom/grid constants, fit transform, clamped view helpers, and pointer-centered zoom helper.                                                   |
| `lib/editor-canvas-snap.ts`                               | Pure snap math: rotated AABB, snap-cache builder, drag-snap and resize-snap solvers, equal-spacing distance guides, grid snap helpers.                          |
| `types/editor-canvas.ts`                                  | Canvas types: size, artboard, pixel grid settings, view transform, video item (incl. persistence `source`), transform patch.                                    |
| `components/editor/canvas/persistence.ts`                 | Pure serialize / deserialize helpers between `CanvasVideoItem` + `EditorArtboard` + `CanvasTimelineClip` and the `ProjectStateV1` schema written to `project.json`. |
| `components/editor/save-status-indicator.tsx`             | Cloud icon in the titlebar that reflects autosave state (`saving` / `saved` / `error`); pulses while writing, turns red on failure, tooltips clarify in plain English. |
| `electron/ipc/project-schema.ts`                          | Schema source of truth for `project.json` (versioned `ProjectStateV1`), `parseProjectState` validator, plus import-asset and save-state IPC payload types.        |
| `electron/ipc/projects.ts`                                | `projects:*` IPC handlers — reads `project.json`, resolves `assetUrlsByVideoId`, atomically writes editor state, copies imported videos into the project folder. |
| `app/globals.css`                                         | Theme tokens, including `--editor-workspace`.                                                                                                                   |
| `docs/normal-term.md`                                     | Developer-friendly translation table from discussion terms to industry terms.                                                                                   |

## Architecture

The stage is a bounded viewport, not an infinite canvas.

```text
Editor layout
  EditorCanvasProvider
    Root ResizablePanelGroup, vertical
      Workspace section ResizablePanel
        EditorSidebar
          Sidebar tab rail
          Sidebar tab content
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
      Timeline ResizablePanel
        ArtboardPresetDropdown
        EditorTimelineControls
        EditorTimelineAudioStatus
        CanvasZoomMenu
        EditorTimelinePanel
          @openscreen/timeline ruler/playhead
          Unlabeled neutral media lanes with timeline clips
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

- `CanvasVideoItem`: `id`, `fileName`, `objectUrl`, `fileSize`, `source` (persistence pointer — `{ kind: "recording", assetRole }` for screen/camera recordings or `{ kind: "imported", relativePath, fileSize }` for files copied into the project folder), `intrinsicWidth`, `intrinsicHeight`, `durationMs`, `x`, `y`, `width`, `height`, `rotation`, `locked`, `role`, plus per-node appearance fields `cornerRadius`, `cornerSmoothing`, `borderWidth`, `borderColor`, `borderOffset`, `borderAlignment` (`"inside" | "center" | "outside"`), `shadowColor` (rgba string with baked alpha), `shadowBlur`, `shadowOffsetX`, `shadowOffsetY`, `shadowSpread`. `objectUrl` is the runtime URL the renderer hands to a `<video>` element; it is rebuilt on every hydration from `source` and is not persisted.
- `CanvasTimelineClip`: `id`, `videoId`, `start`, `end`, `sourceIn`, `sourceOut`.
- `EditorArtboard`: `presetId`, `width`, `height`.
- `ViewTransform`: `scale`, `x`, `y`.
- `PixelGridSettings`: `enabled`, `unit`, `majorUnit`, `visibleFromScale`, `opacity`, `color`, `majorOpacity`, `majorColor`, `role`.

Important actions:

- `addVideoFile(file)`
- `selectItem(id | null)`
- `updateVideoTransform(id, patch)`
- `updateVideoAppearance(id, patch)` — partial update covering `cornerRadius`, `cornerSmoothing`, `borderWidth`, `borderColor`, `borderOffset`, `borderAlignment`, `shadowColor`, `shadowBlur`, `shadowOffsetX`, `shadowOffsetY`, `shadowSpread`. Bypasses the `locked` gate (locking only blocks geometry); the no-op bail-out compares all eleven fields so a slider parked at its current value never triggers a redraw.
- `setVideoLocked(id, locked)`
- `duplicateVideo(id)`
- `deleteVideo(id)` — **non-destructive**: detaches the video from the canvas/timeline (moves it to `detachedVideos`, drops its clip) instead of removing it from the project. Despite the name, no project data or asset file is deleted.
- `addVideoToCanvas(id)` — inverse of `deleteVideo`: re-attaches a detached video to the canvas with a fresh full-length timeline clip and selects it.
- `setArtboardPreset(id)`
- `setViewportSize(size)`
- `setViewTransform(transform)`
- `fitArtboardToViewport()`
- `registerTimelineVideoElement(id, element | null)`
- `registerTimelineCanvasNode(id, node | null)`
- `setTimelineTime(time)`
- `playTimeline()`, `pauseTimeline()`, `toggleTimelinePlayback()`
- `zoomTimelineIn()`, `zoomTimelineOut()`, `fitTimelineToWidth()`
- `moveTimelineClip(id, start, end)`
- `resizeTimelineClip(id, start, end, direction)`
- `subscribeTimelineTicks(callback)`

Context hooks:

- `useEditorCanvasMedia()`: `videos` (on canvas), `detachedVideos` (in project, removed from canvas), selection, selected video, import error.
- `useEditorCanvasArtboard()`: current artboard.
- `useEditorCanvasView()`: viewport size and viewport transform.
- `useEditorCanvasTimeline()`: clips, selected clip, playhead time, duration, timeline zoom, fit mode, playback state, primary audio video id.
- `useEditorCanvasActions()`: stable canvas actions.
- `useEditorCanvasTimelineActions()`: stable timeline playback, clip-editing, and media-registration actions.
- `useEditorCanvasSaveStatus()`: autosave indicator state.
- `useEditorHistory()`: `canUndo`, `canRedo`, `undo()`, `redo()`. Reactive enablement flags for future toolbar/menu surfaces; stable callbacks for the keyboard handler.
- `useEditorCanvas()`: compatibility hook that merges every context and should be avoided in hot or narrow components.

`ResizeObserver` updates the viewport size from the workspace area, so the Konva stage follows timeline resizing and sidebar collapse/expand.

## Undo / Redo

Snapshot-based, in-memory undo/redo for the document state. Lives entirely in `EditorCanvasProvider`; pure decision logic in `components/editor/canvas/history.ts`. Cleared on project switch and app quit (no crash-recovery persistence — that's reserved for Phase 6 in `docs/project-plan.md`).

Scope:

- Restores `{ artboard, videos, timelineClips }` — the same slice the autosave fingerprint covers. The serialized `videos` array carries both on-canvas and detached videos (split by `onCanvas`), so a detach or re-add is restored as an atomic undo step: restore re-splits the array back into the `videos` / `detachedVideos` lists.
- Does NOT restore selection (`selectedItemId`), playhead time (`timelineTime`), timeline zoom/scroll, workspace view transform, hover preview, or any other session-only state. Selection is invalidated only when the previously-selected video no longer exists in the restored **on-canvas** set; otherwise it is left alone. The playhead is clamped if the restored duration is shorter than its current position.
- When the restored artboard dimensions differ from the current ones (e.g., undoing a preset change), the viewport is auto-refit to the new size via `getFitViewTransform`. This matches `setArtboardPreset`'s "always fit on size change" rule so the canvas never strands at a stale zoom after an undo.

Capture point:

- Aligned to the existing 500 ms autosave debounce. The push site lives inside `flushAutosave`'s drain loop (in `provider.tsx`, immediately after the fingerprint compare). Every drain iteration calls `pushHistoryFromAutosave(snapshot, fingerprint, capturedTag)` regardless of disk-write outcome, so history advances even on transient IPC errors and on no-op fingerprint matches.
- **Zero per-surface wiring** on sliders, Konva drag/transform, or timeline clip move/resize. The natural debounce already collapses a fast-fire burst into one entry.
- **Tag capture is synchronous with the snapshot.** The drain reads and clears `historyCommitTagRef.current` at the same instant it serialises the snapshot, then passes the captured tag through to the push. A user action that races the IPC await cannot mis-attribute its tag to the in-flight snapshot — its tag is picked up by the next drain pass instead.

Coalescing:

- Each action sets `historyCommitTagRef.current = "<tag>"` before mutating state (one line per action). Tags used today: `transform`, `appearance`, `nudge` (same tag as `transform` today), `lock`, `add`, `delete`, `duplicate`, `preset`, `background`, `padding`, `grain`, `clip-move`, `clip-resize`. A missing tag is treated as `unknown` and always pushes a new entry.
- `applyHistoryCommit` (in `history.ts`) replaces the top entry when the new commit shares the previous tag AND lands inside `HISTORY_COALESCE_WINDOW_MS = 2000`. Otherwise it appends a new entry. The replace branch truncates the redo tail past the cursor — editing on top of an undid cursor must invalidate the stale future. Identical fingerprints just refresh the timestamp and preserve the existing tag when the incoming tag is `unknown` (so a benign post-flush no-op cannot demote a meaningful tag).
- `ALWAYS_NEW_ENTRY_TAGS = { "add", "delete", "duplicate", "preset" }` — these always push a new entry, never coalesce. Coupled with the destructive-flush rule below they guarantee that "Cmd+Z" undoes exactly one delete/add/duplicate/preset change.

Destructive flush:

- `addVideoFile`, `addRemoteVideo`, `duplicateVideo`, `deleteVideo`, `addVideoToCanvas`, and `setArtboardPreset` call `flushAutosaveNow()` **before** they mutate state. The helper pushes the pre-destructive snapshot to history **synchronously** (so the boundary survives even when another save is already in flight — `flushAutosave` would queue itself and the in-memory boundary would otherwise be lost), then kicks the async drain to write that snapshot to disk. The destructive change that follows lands as its own entry on the next autosave fire.

Storage:

- `MAX_HISTORY_ENTRIES = 100`, FIFO eviction at the front.
- In-memory `historyRef` in the provider. The state never touches disk.
- The project-switch reset block (`useEffect` ~`provider.tsx:2581`) clears `historyRef`, `historyCommitTagRef`, `restoringFromHistoryRef`, `sessionImportedUrlsRef`, and both reactive flags.
- Both hydration paths seed a baseline entry tagged `"unknown"` so the user's first edit becomes index 1 and `Cmd+Z` returns to the loaded state. The slow path also seeds `lastWrittenSerializedRef` so the destructive flush inside `addRemoteVideo` does not write the still-empty state to disk before the auto-add lands.

Object URL on restore:

- Recording-source videos take their URL from `project.assetUrlsByVideoId[videoId]` (resolved by main at project open).
- Imported-source videos take their URL from (in order): an existing in-state copy, `project.assetUrlsByVideoId`, or a `sessionImportedUrlsRef: Map<id, string>` cache populated when the file was first imported via `addVideoFile` / `addRemoteVideo`. The cache only ever holds `file://` URL strings — no blob memory is pinned by undo. A missing file falls back to an empty `objectUrl`, identical to hydration's broken-asset semantics.

Keyboard:

- `Cmd/Ctrl + Z` = undo. `Cmd/Ctrl + Shift + Z` = redo. Wired in `editor-workspace.tsx`'s `handleKeyDown`, above the selection-required branch so the shortcut works without a selection. Bails when `isEditableTarget(event.target)` is true. Blocked during active rotation (`isRotatingSelectedNodeRef`), Transformer drags (`isTransformingSelectedNodeRef`), and pan (`isPanningRef`) so a keypress mid-gesture cannot yank state out from under the hot path.

Titlebar buttons:

- `components/editor/history-controls.tsx` renders ghost-style icon buttons (HugeIcons `Undo03Icon` / `Redo03Icon`) next to the Folder and `SaveStatusIndicator` in `components/ui/titlebar.tsx`. Each is wrapped in a Tooltip; clicking calls `undo()` / `redo()`. The buttons are `disabled` when `canUndo` / `canRedo` is false, so they grey out at the ends of the stack and after a project switch.

Performance:

- Push site: one pure JS array op per autosave. Serialization is O(videos + clips). Negligible vs the IPC write.
- Restore: one bulk replace of three state slots → one content-layer redraw. `CanvasVideoNode` memoization keeps unchanged nodes from re-rendering, preserving the 5000-node stress invariant.
- Memory peak today (10 videos × 100 entries × ~1 KB) ≈ 1 MB. At the 5000-node stress invariant from `CLAUDE.md` the same 100-entry cap would hold ≈ 250 MB of snapshots — well above the budget for that target. When the editor moves toward that scale, swap the entry cap for a byte-budgeted cap (or move to diff snapshots) before turning on persisted history.

Known limitations:

- Two **different** non-destructive actions landing inside the same 500 ms autosave window coalesce into one entry (the last tag wins). One `Cmd+Z` rolls back both. The destructive-flush rule prevents this from mixing destructive and non-destructive edits; pairs like "nudge + appearance change" within 500 ms are accepted as a single undo unit. Acceptable per the zero-wiring constraint.
- Undoing a deleted video whose underlying file is no longer on disk restores a node with an empty `objectUrl`. Same semantics as hydration after the file disappears.
- Crash-recovery persistence (replay `<project>/history/` on app open) is intentionally deferred to Phase 6 of `docs/project-plan.md`.

## Layout Resizing

The editor shell uses the shared shadcn `Resizable` wrapper around `react-resizable-panels` only for the vertical split between the top workspace section and the bottom timeline panel.

Panel groups:

- `editor-root-layout`: vertical split between the workspace panel and timeline panel.

Panel sizing:

- Workspace panel default height: `69%`; minimum height: `260px`.
- Timeline panel default height: `31%`; minimum height: `140px`; maximum height: `60%`.
- The sidebar is not a resizable panel. It keeps its existing tab rail plus animated content width: `360px` when open and `0px` when collapsed.

Collapse behavior:

- `EditorSidebar` owns tab selection and open state through `useSidebarTabs`.
- The sidebar collapse/expand button toggles the sidebar content width only. It does not call the resizable panel imperative API and does not expose a sidebar drag handle.

Performance notes:

- Resizing changes layout bounds only. It does not add Konva layers, per-node DOM overlays, or per-node listeners.
- The existing workspace `ResizeObserver` is the bridge from DOM layout to Konva viewport size.
- Large scenes remain bounded by the existing stage-level event delegation and constant layer count; a timeline resize or sidebar collapse may trigger a viewport-size state update and stage redraw, but it does not loop over canvas nodes.

## Artboard

Presets live in `lib/editor-canvas.ts`.

Current presets:

- Wide: 1920 x 1080, 16:9.
- Vertical: 1080 x 1920, 9:16.
- Portrait: 1080 x 1350, 4:5.
- Standard: 1440 x 1080, 4:3.
- Square: 1080 x 1080, 1:1.

Changing the preset resets the view to fit and changes future video placement.

### Artboard Padding

The Background panel exposes a `Padding` slider above `Background blur`. Padding is stored on `EditorArtboard.padding` as absolute artboard pixels in the range `0–500`. We use pixels rather than a percentage so every notch on the slider maps to the same number of artboard pixels regardless of preset, giving users one-to-one control when they trim or frame the recording.

Behavior:

- Padding insets the screen-role recording on all four sides while preserving its intrinsic aspect ratio.
- At `padding === 0`, screen-role video uses the existing cover-fit (`getCoverVideoPlacement`) so default auto-layout is unchanged.
- At `padding > 0`, screen-role video switches to contain-fit inside the inner rect (`artboard.width - 2 * inset` × `artboard.height - 2 * inset`), revealing the background on the surrounding margin.
- Padding only affects videos with `role === "screen"`. Camera and media nodes are left alone — padding describes the framing of the recording, not other layers.
- Locked screen videos are skipped; users explicitly chose to pin those.
- Slider is disabled when no screen-role video is present.
- Preset changes and project hydration preserve `padding` (same lifecycle as `background` and `grain`). When the preset changes, screen-role videos relayout via `relayoutVideoForArtboard`, which now consults the next artboard's `padding` instead of just its size.

Helpers:

- `getPaddingInsetPx(artboard)` clamps the stored pixel value against `floor(min(width, height) / 2) - 1` so the inner rect can never collapse to zero, regardless of slider position or canvas preset.
- `getScreenVideoPlacement(metadata, artboard)` is the single source of truth for screen-role placement and routes between cover-fit and padded contain-fit.

## Video Import And Rendering

The Background tab uses a local file picker with `accept="video/*"`.

On import:

- `readVideoMetadata()` creates a temporary `HTMLVideoElement`.
- It reads `videoWidth` and `videoHeight` from `loadedmetadata`.
- The video is placed as a cover fit over the current artboard.
- The created `objectUrl` is stored and revoked on provider unmount, import failure, or project switch. Removing a video from the canvas (`deleteVideo`) is now a detach and deliberately does **not** revoke the URL — the video remains in the project and may be re-added. In practice on-canvas/detached videos hold `file://` URLs (recordings resolve from `project.assets`; imports resolve from the copied asset), so there is no blob memory to reclaim until the project unloads.

For rendering:

- Each `CanvasVideoNode` creates one hidden `HTMLVideoElement`.
- Video element settings: `loop = false`, `playsInline = true`, `preload = "auto"`.
- The actual `HTMLVideoElement` is passed directly to `Konva.Image` through the `image` prop.
- Video nodes use Konva `Image` crop props to emulate CSS `object-fit: cover`. Resizing the frame changes the visible box while the source video keeps its original pixel aspect ratio and is center-cropped instead of stretched.
- No video transcoding, canvas caching, intermediate bitmap resizing, or export resampling is done.
- One redraw lifecycle effect picks the right primitive at mount: `requestVideoFrameCallback` chains a redraw per decoded frame when supported, otherwise a single `Konva.Animation` ticks the content layer while the element is playing. Both paths share the same play/pause/seek handlers and stop cleanly on unmount.
- `CanvasVideoNode` is memoized and receives stable item-id callbacks, so viewport zoom/pan state does not re-render every mounted video node.
- `CanvasVideoNode` does not autoplay. It registers its `HTMLVideoElement` with the timeline controller once metadata/data is ready, and the controller seeks/plays/pauses it from the shared playhead.
- Screen audio is enabled only for the first screen video — the `shouldPlayAudio` prop sets `element.muted` in one place. Camera and media nodes stay muted so preview audio does not duplicate.

Project recording metadata:

- Electron project loading prefers each asset's manifest `durationMs` when present.
- Some screen recordings expose width, height, and codec in the manifest but omit screen `durationMs`. In that case the project loader falls back to the longest known output duration from the same recording, and the renderer can still probe the file with a temporary `HTMLVideoElement` before creating the timeline clip.
- Timeline clips should not be created from remote project assets until a positive duration is available when one can be read; otherwise they fall back to the minimum clip duration as a last resort.

Quality notes:

- Keeping the source as a live `HTMLVideoElement` avoids compromising the original video before drawing.
- `Konva.pixelRatio = Math.min(window.devicePixelRatio || 1, 3)`. The cap was raised from 2 to 3 so 5K/6K displays (Pro Display XDR / Studio Display at native scaling) get a backing store that actually matches the panel — at the previous cap of 2, those displays rendered the canvas at 2/3 of their pixel density, which read as a ~33% sharpness loss before any zoom. We keep an upper cap of 3 because no realistic source resolution benefits from a larger backing store, and removing the cap entirely risks memory blow-ups on extreme multi-monitor setups.
- The video `sceneFunc` (`drawSquircleVideo` in `canvas-video-node.tsx`) explicitly sets `imageSmoothingEnabled = true` and `imageSmoothingQuality = "high"` on the underlying 2D context before `drawImage`. The default canvas2d smoothing quality is `"low"` (fast bilinear), which is visibly blurry whenever the video is upscaled past its source resolution. `"high"` uses the browser's best interpolation (typically bicubic or Lanczos) — much sharper at moderate zoom for the same CPU cost. Konva's public `Context` proxy doesn't expose `imageSmoothingQuality` as a forwarded property, so we reach into `_context` directly.
- We do not cache video nodes, because caching would freeze or resample moving video.
- Zoom can reveal source detail, but no renderer can invent detail beyond the video file's actual pixels. At extreme zoom (5×+ above the source resolution) the limit is the recording, not the canvas — record at native Retina (e.g. 3024×1964) for the most zoom headroom.

## Video Appearance

Every video node carries per-node appearance state on `CanvasVideoItem`. There is no separate `cropShape` field anymore — circular camera previews are expressed as a max-radius, max-smoothing squircle so all three roles share one render path.

State, per video:

- `cornerRadius` — artboard pixels. `0` means a sharp rectangle.
- `cornerSmoothing` — `0..1`. `0` = circular arc (CSS `border-radius`). `0.6` = macOS look. `1` = fully continuous-curvature squircle.
- `borderWidth` — artboard pixels. `0` skips the border render path entirely.
- `borderColor` — CSS color string used as the stroke style.
- `borderOffset` — signed artboard pixels added to the stroke centerline (positive pushes outward, negative pulls inward).
- `borderAlignment` — `"inside" | "center" | "outside"`. Adds ±`borderWidth / 2` (or `0` for center) to `borderOffset` to produce the final centerline, matching Figma's stroke-alignment semantics. `outside` at offset 0 sits flush outside the node.
- `shadowColor` — CSS rgba string. Alpha is baked in (`rgba(R, G, B, A)`); there is no separate `shadowOpacity` field. The shadow pass short-circuits when alpha = 0.
- `shadowBlur` — gaussian blur radius. `0` is a sharp duplicate cast.
- `shadowOffsetX`, `shadowOffsetY` — signed displacement of the shadow relative to the silhouette.
- `shadowSpread` — Figma-style spread: positive grows the caster silhouette outward before blur is applied (corner radius scales by the same delta), negative shrinks it. The shadow pass also short-circuits when blur, both offsets, and spread are all 0 (the cast would land exactly under the silhouette and be hidden by the image).

Defaults per role at creation:

- `screen`, `media`: `cornerRadius = 0`, `cornerSmoothing = 0.6`.
- `camera`: `cornerRadius = floor(min(intrinsicW, intrinsicH) / 2)`, `cornerSmoothing = 1`. Renders as a perfect circle by default.
- All roles: `borderWidth = 0`, `borderColor = "#000000"`, `borderOffset = 0`, `borderAlignment = "inside"`. The border is invisible until the user nudges the width slider.
- All roles: `shadowColor = "rgba(0, 0, 0, 0.25)"`, `shadowBlur = 0`, `shadowOffsetX = 0`, `shadowOffsetY = 0`, `shadowSpread = 0`. The default rgba is opaque enough to look right on the first slider drag, but the all-zero spatial defaults keep the shadow invisible until the user nudges it.

Squircle math (`lib/squircle.ts`):

- `computeSquircleCornerParams(radius, smoothing)` returns the Figma-derived per-corner constants `{ p, a, b, c, d, angleAlpha, arcSweep, radius }`. Independent of width and height, so the same params survive resize without recomputation.
- `traceSquirclePath(ctx, width, height, params)` walks the four corners, each composed of one cubic Bézier ramp, one circular arc of `arcSweep` radians via `ctx.arc()`, and a second cubic Bézier back onto the next edge. No allocations, no temporary objects.
- `clampSquircleRadius(width, height, radius)` clamps to `min(width, height) / 2` so the path can never self-intersect.
- `tracePathOrRect(ctx, width, height, params | null)` collapses to a single `ctx.rect()` call when `params === null` (radius = 0), keeping the radius-0 case effectively free.

`CanvasVideoNode` sceneFunc, in render order so layering matches Figma (shadow underneath, video in the middle, border on top):

1. If `shadowParams !== null`: two-pass shadow with a `destination-out` mask, all at the silhouette's real position inside the artboard clip group.
   - **Pass 1** — translate to `(originX, originY)`, set `shadowColor` / `shadowBlur` / `shadowOffsetX` / `shadowOffsetY`, trace the spread-enlarged squircle, fill with `#000`. Canvas2D paints both the silhouette and its blurred drop shadow.
   - **Pass 2** — translate again, set `globalCompositeOperation = "destination-out"`, retrace the same path, fill. The silhouette pixels we just laid down get erased so only the shadow remains.
   - We tried the classic off-canvas-cast trick first (path at `-1e6`, compensated `shadowOffset*`). Browsers cull draw operations whose path bbox doesn't intersect the current clip — and our videos live inside an artboard `clipX/Y/Width/Height` group on the workspace's content layer — so the whole op (including its shadow) got dropped except for tiny precision-spill slivers right at the clip edge. The in-place draw + mask approach has no cull risk. The artboard background lives on a separate Konva layer, so `destination-out` only touches the videos layer canvas. Overlapping videos on the same layer can see their pixels chipped out in the spread region — rare in practice and accepted for v1.
2. If `squircleParams !== null`: trace the silhouette and call `context.clip()`. When `cornerRadius === 0` the trace collapses to a single `ctx.rect()` call and clipping is skipped entirely.
3. `drawImage` the live `HTMLVideoElement` with the existing object-fit-cover crop attrs.
4. If `borderParams !== null`: translate to the border-box origin, trace a separate squircle at `width + 2·signedDistance` × `height + 2·signedDistance` with `cornerRadius + signedDistance`, and stroke it. The translate handles outside-aligned and positive-offset borders, which draw past the node bounds; the artboard-level clip group keeps strokes contained.

`borderParams` is memoized on `(borderWidth, borderColor, borderOffset, borderAlignment, cornerRadius, cornerSmoothing, width, height)` and returns `null` for `width = 0` or when the inset collapses the border box past its own bounds. The trace reuses `clampSquircleRadius` + `computeSquircleCornerParams` so the same allocation-free hot path applies.

The `hitFunc` uses the same squircle path **at the node's own size** so clicks in the rounded-off corners pass through to whatever sits underneath. The border is purely visual; clicks past the node bounds (outside-aligned border, positive offset) fall through to whatever sits underneath, keeping the selectable region stable as the user tunes width / offset.

Tab routing:

- `SidebarSelectionBridge` mounts inside both `EditorCanvasProvider` and `SidebarTabsProvider`. It is render-less and reacts only to `selectedItemId` changes.
- On selection transition `null → id` or `idA → idB`, it routes to the Video tab and opens the sidebar.
- Artboard selections (`selectedItemId === ARTBOARD_SELECTION_ID`) are skipped on purpose. The workspace's artboard-rect click handler already calls `selectSidebarTab("background")` synchronously after `selectItem(ARTBOARD_SELECTION_ID)`; without the skip, the bridge effect would fire on the same render and override the Background tab back to Video — visible whenever the previous selection was a video on the timeline (so the transition counts as `idA → idB`).
- The `useSidebarTabs` reducer toggles `isOpen` when `selectTab` is called with the already-active tab; the bridge calls `open()` instead when `activeTab === "video"` to avoid an accidental collapse.
- Deselection (`id → null`) is deliberately ignored — the user keeps whatever panel they were last working in.

Panel layout:

- The Video panel has two mutually-exclusive views driven entirely by `selectedItemId`. It uses `Tabs` from `@/components/ui/tabs` as a controlled motion container only — there is no visible tab bar; the active value is fully derived from selection, with no `onValueChange` so nothing inside the Tabs subtree can toggle the view on its own:
  - **List view** (no selection): heading + one-line description + a single-column stack of `Squircle` file cards — every on-canvas video first, then every detached video. Each card shows the `FileEmpty02` icon on the left and the file name + file size stacked on the right (formatted via a local `formatFileSize` helper — no monospace digit treatment), with a hover-revealed action affordance on the right. On-canvas cards show **Select** and call `selectItem(id)` (the single source of truth: canvas Transformer, timeline clip highlight, and the panel itself all derive from it); detached cards show **Add** and call `addVideoToCanvas(id)`, which re-attaches the video and selects it. The card chrome is identical for both — only the affordance label and click action change.
  - **Settings view** (video selected): replaces the heading with a `Button variant="link"` "← Videos" affordance at the same `text-sm font-semibold` slot, with its own one-line description below. Clicking it calls `selectItem(null)`, returning the user to list view and clearing the canvas / timeline selection in the same hop. Beneath the heading sit three appearance groups:
    - **Corners** — radius + smoothing.
    - **Border** — width slider, color swatch with native `<input type="color">`, alignment radiogroup of `inside | center | outside`, and offset slider in `[-64, +64]` artboard px. All Border controls except Width are disabled while `borderWidth === 0`, mirroring Figma's "no stroke when width is 0" behaviour.
    - **Shadow** — inline color row (`ColorAlphaSwatch`: a checker-backed native `<input type="color">` swatch with a directly-editable hex text input beside it — no popover), Opacity slider (0–100% — edits the alpha channel of `shadowColor`, default 25%), and X / Y / Blur / Spread sliders. Opacity lives on its own row beside the spatial sliders, but `shadowColor` remains the single source of truth and stores alpha as part of the rgba string.
- When no videos exist yet, list view shows an inline `Squircle` hint pointing at the Background tab.
- The settings-view subtree is keyed on the video id so internal refs reset cleanly across selections.
- `CanvasVideoItem.fileSize` is populated from `File.size` (really the imported `ArrayBuffer.byteLength`) on local uploads and from `ProjectAsset.fileSize` for recordings. It falls back to `0` ("Unknown size") only when the byte count is genuinely unknown (remote stream, or a recording whose asset file is missing).
  - **Source of truth differs by kind.** Imported videos persist their size in `project.json` (`source.fileSize`). Recordings do **not** — a recording's size is owned by its on-disk `.mov`, which the main process freshly stats into `ProjectAsset.fileSize` on every project open. Both hydration paths therefore resolve a recording's size from `project.assets` (by `assetRole`) rather than from the saved record, via `resolveFileSizeForRestore` in `provider.tsx`. This is why recordings show their real size after a refresh instead of "Unknown size" — earlier the fast path hard-coded `0` for recording sources.

Performance posture:

- Squircle params are memoized in `CanvasVideoNode` on `(cornerRadius, cornerSmoothing, width, height)`. Border params are a separate memo on `(borderWidth, borderColor, borderOffset, borderAlignment, cornerRadius, cornerSmoothing, width, height)` and short-circuit to `null` when `borderWidth = 0`, skipping the stroke pass entirely. Shadow params memo on `(shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY, shadowSpread, cornerRadius, cornerSmoothing, width, height)` and short-circuit when the parsed alpha is 0 or every spatial field (`blur`, `offsetX`, `offsetY`, `spread`) is 0. Steady-state playback and pan/zoom never recompute trig for any path.
- The hot-path trace is allocation-free and issues a constant ~17 canvas calls per node per draw (4 lineTo + 8 bezierCurveTo + 4 arc + 1 moveTo). The non-rounded fast-path is one `ctx.rect()` call.
- Rounded clipping is only enabled when `cornerRadius > 0`; otherwise the sceneFunc skips `context.clip()` entirely, saving a canvas state push per node per frame.
- The `updateVideoAppearance` action bails out when every patched field equals the current value, so a slider dragged at its committed position never triggers a downstream React re-render or Konva redraw.
- The Transformer border and hover outline remain rectangular (bounding box). Both stay imperative and pooled; squircle clipping does not change that contract.

Known limitations / v2 work:

- Per-corner radii (TL/TR/BR/BL). The data model is single-radius today; the storage shape can grow to `number | [tl, tr, br, bl]` without a breaking change at the type-level boundary.
- During a Transformer side-handle drag the corners visually stretch because the path is drawn at base `width`/`height` and Konva's scale is applied on top. After `transformend` the radius snaps back to absolute artboard pixels. Acceptable for v1 per the agreed unit ("absolute artboard px").
- A rounded hover outline / rounded transformer border would require a custom shape replacing Konva's built-in transformer border; left out for v1 to keep the bounding-box hit area predictable.

## Timeline And Playback

The bottom editor panel now contains the `EditorTimelinePanel`, built on the workspace `@openscreen/timeline` package.

Timeline model:

- Every canvas video receives one `CanvasTimelineClip`.
- `start` and `end` are timeline seconds.
- `sourceIn` and `sourceOut` are non-destructive source seconds.
- Minimum clip duration is `1 / 30` seconds.
- The project timeline duration is the larger of the longest source asset and the furthest edited clip end. An **empty** timeline (no clips) reports a duration of `0`, so the transport reads `00:00.00`; the `1 / 30` minimum-clip floor only applies once at least one clip exists, to guarantee a non-zero scrub range.
- Timeline transport controls live in the footer's top toolbar, above the ruler and lanes. They use the shared `Button` component, theme foreground/muted colors, `text-xs` proportional timer text in `0:01` / `1:05:00` format, and skip-back/play/skip-forward icon controls. Play/pause uses the same `PlayIcon` / `PauseIcon` pair as the recorder controls. Two inner chevron buttons (`ArrowLeft01Icon` / `ArrowRight01Icon`, titled "Previous/Next frame") flank play/pause for single-frame stepping; the outer skip controls remain ±5 s.
- The ruler may extend past the longest clip for breathing room, but the playhead is capped at `timelineDuration`: `EditorTimelinePanel` passes `maxCursorTime={timelineDuration}` to the `Timeline` component, which clamps cursor drag and time-area clicks so the user cannot scrub into the empty trailing area.
- Timeline zoom controls live in the footer's top toolbar as three standalone shared `Button` instances (`variant="outline"`, `size="sm"`; the zoom-out/zoom-in icon buttons use `size="icon-sm"` for matching height). They match the `Button variant="outline" size="sm"` used by the artboard-preset and canvas-zoom dropdowns, keeping the whole footer toolbar on one button style instead of a custom segmented wrapper. Fit is the default timeline view. Zoom in/out changes horizontal density and exits Fit; Fit computes a scale from the visible timeline width so the widest timeline clip block fits the viewport, then scrolls to that clip's start if it begins later in the timeline.
- The footer owns the timeline surface background; the nested top toolbar and timeline panel use transparent backgrounds.
- The timeline uses unlabeled neutral lanes with a 30 px start inset. There is no fixed track label rail or role-colored track background; clip role is communicated through the clip icon, color, and file name.
- The lane area disables the full-height per-second grid background and avoids row divider borders; compact major ruler dots remain available for time orientation.
- The ruler uses clock-style tick labels such as `0:10`, `1:00`, and `1:05:00`. Minor subdivision dots are hidden; compact major dot marks remain visible for orientation, while label rendering uses a wide measured-density stride to skip crowded numbers. Zooming in lowers that stride and reveals more detailed labels; fit mode may show coarser labels for long hour-scale videos.

Editing behavior:

- Moving a clip changes `start` / `end` while preserving its current source trim.
- Resizing the left edge changes `sourceIn`.
- Resizing the right edge changes `sourceOut`.
- Clip move and resize interactions use timeline grid snap, timeline guide-line snap, and timeline edge auto-scroll.
- Screen, camera, and media clips are independent. Moving or trimming one clip does not alter the others.
- Clicking a timeline clip selects the matching canvas video node; selecting a canvas node highlights its clip.

Playback sync behavior:

- The committed playhead is the source of truth for media time and the transport readout.
- Timeline hover preview seeking has been removed. Pointer movement over the timeline no longer samples canvas media, changes the transport readout, or writes `HTMLVideoElement.currentTime`.
- Scrubbing the ruler, clicking the time area, pressing skip controls, or dragging the playhead seeks every registered video element to the sampled source frame. Committed (paused) seeks are **coalesced to one in-flight seek per element**, mirroring the hover pipeline: while a seek is still decoding, further scrub moves do not issue a fresh `currentTime` write — they only advance `timelineTimeRef`, and the in-flight seek's completion handler reissues toward the latest playhead. This keeps every expensive long-GOP decode aimed at the newest target instead of thrashing the decoder with one write per pointermove (which previously left the preview lagging the cursor in visible steps). The in-flight target per element is tracked in `committedSeekStateRef`, with the same 250 ms safety-timeout repaint the hover path uses.
- When a committed seek lands, `onTimelineVideoSeeked` paints it via the canvas-video-node redraw callback and, if the playhead has since moved, reissues a single follow-up seek toward the live target. Unlike the hover branch it does **not** drop a near-miss landing: every landed committed frame is a real position along the scrub path, so painting it keeps the preview moving in step with the drag while the reissue converges on the live playhead. The older match-gated path (`shouldDrawTimelineVideoFrame`) still runs as the fallback for entry-less `seeked` events — playback redraws and genuinely stray seeks — so stale playback frames are still suppressed.
- `CanvasVideoNode` drives its `seeked` redraw through `requestVideoFrameCallback` when available, so the Konva content layer is composited in lockstep with the seeked frame actually being presented rather than a tick early (which could otherwise flash the pre-seek frame during a fast scrub). It falls back to an immediate `batchDraw()` only where rVFC is unavailable.
- **Frame stepping.** `stepTimelineFrame(±1)` advances the playhead by exactly one source frame (pausing playback first if running). It snaps the current time to the frame grid of the clip under the playhead before stepping, so repeated steps stay on frame boundaries even after a free scrub. Bound to `,` / `.` in `editor-workspace`'s global keydown (skipped while typing in an input, and not triggered with zoom/Shift modifiers) and to the two inner transport chevrons. Frame duration is `1 / fps`, where fps is the per-clip measured source rate or `DEFAULT_TIMELINE_FPS` (60, the recorder default) until a clip has played.
- **Source fps is session-only and measured lazily.** `CanvasVideoNode` samples `requestVideoFrameCallback` metadata (`mediaTime` / `presentedFrames`) during playback, derives a median rate, snaps it to a common rate within 5 %, and reports it once via `registerTimelineVideoFps`. The provider holds it in `videoFpsRef` (a `Map<videoId, number>`). It is **not** persisted to `project.json`, not part of undo history, and is cleared on project switch and element unregister — it only refines frame-step granularity for non-60 fps (typically imported) clips. Before a clip's first playback, stepping uses the 60 fps default.
- During playback the active clip whose range covers the playhead acts as the master clock: the controller reads its native `currentTime` and projects the timeline time from `clip.start + (element.currentTime - clip.sourceIn)`. The primary audio video is preferred; otherwise any visible clip works. This keeps the cursor lockstep with the frames being painted and prevents the rAF/decoder tug-of-war that used to manifest as frames jumping back and forth. The rAF estimate is only used when no master is available, or as a safety bound when the master jumps wildly (e.g., after tab-visibility gaps).
- The master video is never seeked during natural playback; the controller only ensures it is playing. Secondary visible videos play at their native rate and are only re-aligned when drift grows past `TIMELINE_PLAYBACK_DRIFT_SECONDS` (250 ms). Clips that just became active are precisely seeked into place on the same frame they become visible.
- When the playhead is before a clip starts or after it ends, the canvas hides that clip's Konva node and disables its hit testing.
- When the playhead lands on the very end of the timeline, the longest clip(s) stay visible and sample `sourceOut - 1 ms` so the canvas holds their last frame instead of going blank. Clips that end earlier in the timeline still hide at their own boundary; the hold only applies to clips whose `end` is within `TIMELINE_END_HOLD_EPSILON_SECONDS` of `timelineDuration`.
- A hidden inactive clip remains in editor state and in the timeline; scrub back into the clip range to show and edit the canvas node again.
- Mute is owned by `CanvasVideoNode` via the `shouldPlayAudio` prop derived from `primaryAudioVideoId`. The timeline controller no longer writes `element.muted` so there is one source of truth for the audible track.
- Video frame redraws still target the content layer only, so timeline playback does not repaint the background/grid or selection overlay layers.

Hover preview behavior:

- Hover-preview seek is **paused-only**. While the timeline is playing, `onTimeAreaHover` calls into `updateHoverPreviewTime` are dropped silently; the ghost cursor is not mounted; playback continues uninterrupted.
- The `@openscreen/timeline` package fires `onTimeAreaHover(time | null)` from `TimeArea`'s overlay div. The package suppresses these events while the main playhead is being dragged via an internal `draggingCursorRef` shared with the `Cursor` component, so cursor drag never produces a competing hover stream.
- The provider keeps the live hover position in `hoverPreviewTimeRef` (no React state per mouse move) and exposes `subscribeHoverTime` for the ghost cursor to follow. The only mounted-vs-unmounted decision is the `isHoverPreviewActive` boolean.
- Hover seeks are coalesced via `requestAnimationFrame` and dispatched at most one in-flight per video element. Each in-flight write records its target source time in `hoverSeekStateRef`; the canvas-video-node hands every `seeked` event back to the provider, which compares `element.currentTime` to that target. Mismatched completions are dropped; matched completions trigger `layer.batchDraw()` and, if the live hover ref has moved past the target, immediately reissue without waiting for another rAF.
- Every committed write (`syncTimelineMedia`) calls `cancelInFlightHoverSeeks()` first, so `setTimelineTime`, `pauseTimeline`, `playTimeline`'s end-of-tick pause, clip move/resize, and duration clamp all kill the hover pipeline before they issue committed seeks. Hover never writes committed state — the coupling is strictly one-way.
- A 250 ms per-entry safety timeout guards against rare browser coalescing where a new `currentTime` write lands on the same decoded frame and no `seeked` ever fires.
- A `document.visibilitychange = hidden` listener tears down all hover state so a tab-away mid-hover can't deliver stale `seeked` frames after the user returns.
- Hover leave (pointer exits the time area, the user clicks, the user presses play, or the user starts a cursor drag) calls `syncTimelineMedia(timelineTime, …)` which snaps every visible video back to the committed frame within a single seek.

Performance notes:

- Timeline playback uses refs, media elements, and imperative subscribers for hot-path sync.
- React state for the public playhead value is committed on a short interval (`TIMELINE_STATE_COMMIT_INTERVAL_MS`, 80 ms) during both playback **and** scrubbing, not on every decoded video frame or pointermove. The playhead itself stays smooth because the tick subscribers move the cursor imperatively on every update; only the React mirror (the transport readout and disabled-state) is throttled. Discrete transitions (play, pause, duration clamp) commit immediately via `commitTimelineTimeState`; scrub moves use the trailing-edge `scheduleTimelineTimeState`.
- Timeline visibility is derived from the active clip set. The controller only toggles Konva `visible` / `listening` on ids whose active state changed, and media sync applies playback work to the active set plus newly inactive ids.
- The active clip-set scan is cached by the nearest timeline clip boundary, so playback does not loop across every clip on every animation frame. A full scan happens after clip/video changes, node registration, or crossing the next clip start/end boundary.
- Hover preview and committed scrubbing share the same visibility cache and seek primitives (`safeSeekElement`, `getSeekableTimelineSourceTime`, `resolveTimelineFrame`, `syncTimelineVisibility`) and both coalesce to a single in-flight seek per element. They differ only in bookkeeping (`hoverSeekStateRef` vs `committedSeekStateRef`) and the completion decision: hover drops a near-miss landing, committed paints it and reissues toward the live playhead.
- The implementation keeps the existing constant Konva layer count and does not add DOM overlays per canvas node.

## Interaction Model

Selection:

- Click a video to select it.
- Click the empty artboard hit rect to deselect.
- Selected video attaches one Konva `Transformer`.
- Selected video also shows a floating DOM toolbar with lock, duplicate, and delete actions. The delete action is **remove-from-canvas** (detach), not a project delete — see Project Persistence → "Detached videos".
- Locking keeps the video selectable and keeps the toolbar visible, but disables dragging, resize handles, side handles, and rotation controls. While locked, the toolbar collapses to the unlock action only and remeasures itself so it remains centered.
- Selection and drag persistence are handled at the `Stage` level by delegating events from nodes named `video-node`, rather than attaching full interaction handlers to every canvas node.
- Shortcuts when a node is selected: `Cmd/Ctrl + Shift + L` toggles lock, `Cmd/Ctrl + D` duplicates, `Delete` or `Backspace` removes the node from the canvas (detaches it — the video stays in the project and can be re-added from the Video tab), and `Arrow` keys nudge the node by 1 artboard pixel (`Shift + Arrow` nudges by 10). Shortcuts are ignored while typing in editable controls.

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
- `Shift + 2` zooms to 200%.
- `Shift + F` fits the artboard.
- Footer zoom dropdown supports zoom in (⌘+), zoom out (⌘−), zoom to 100% (⌘0), zoom to 200% (⇧2), and zoom to fit (⇧F). All entries are plain menu items with `onClick`; the dropdown no longer uses radio/check items.

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

## Project Persistence

Editor state is autosaved into the project folder so reloading a project reproduces the exact same arrangement. Recording files are owned by the mac-addon and remain untouched.

On-disk layout per project (under `~/Documents/openscreen/<ISO-timestamp>/`):

```text
<project>/
  recording.json     # owned by @openscreen/mac-addon, untouched by the editor
  project.json       # editor state (this section)
  screen.mov         # the screen recording
  camera.mov         # optional camera recording
  assets/
    videos/
      <video-id>/
        <file>.mp4   # videos imported via the Background tab, copied here on import
```

Schema (`electron/ipc/project-schema.ts`):

- `version: 1` — first line of every read; mismatches fall back to "no saved state" and the renderer re-synthesises defaults.
- `artboard: { presetId, width, height, background, padding, grain }`.
  - `background` is either `null`, `{ type: "color", value }`, or `{ type: "wallpaper", value, blurRadius? }`. For wallpapers, `value` is a stable `WallpaperId` from `lib/wallpapers.ts` — wallpaper assets ship with the app and are not copied per-project.
- `videos: ProjectVideo[]` — one entry per project video (both on-canvas and detached), including its `source`:
  - `{ kind: "recording", assetRole: "screen" | "camera" }` — file path **and byte size** resolve through `project.assets` (which itself resolves from `recording.json`); deliberately no `fileSize` on the recording source, so the size never goes stale relative to the on-disk `.mov`.
  - `{ kind: "imported", relativePath, fileSize }` — `relativePath` is always inside `<project>/assets/videos/<id>/`.
  - `onCanvas?: boolean` — **optional, back-compat-safe** (added without a version bump per the "adding optional fields is safe" rule). Missing or `true` means the video is on the canvas; `false` marks a **detached** video (removed from the canvas but kept in the project). `serializeProjectState` writes on-canvas videos first with the field omitted (so legacy `project.json` stays byte-identical and the post-hydration fingerprint is a no-op), then appends detached videos tagged `onCanvas: false`.
- `timelineClips: ProjectTimelineClip[]` — `start`, `end`, `sourceIn`, `sourceOut` per clip. Only on-canvas videos have a clip; detached videos carry none.
- `updatedAtUnixMs` — refreshed by main on every successful write.

Not persisted: selection, playhead time, timeline zoom/scroll, viewport transform, hover preview state, measured per-clip source fps (`videoFpsRef`, re-measured each session for frame-stepping), the in-memory undo/redo history (`historyRef`), the session-only imported URL cache (`sessionImportedUrlsRef`), runtime `objectUrl` strings, all `*Ref` runtime state. The view always re-fits the artboard on load.

Derived-on-load (not persisted, but reconstructed every hydration): a recording's `CanvasVideoItem.fileSize` is read back from `ProjectAsset.fileSize`, not from `project.json`. Both hydration paths (fast-path restore and slow-path synthesis) and both undo/redo restores route through `resolveFileSizeForRestore`. Imported videos keep their persisted `source.fileSize` instead.

Export source URLs are also runtime-only. `ProjectSummary.assetUrlsByVideoId` is computed by main when a project loads, but the slow path after a fresh recording starts with no saved `project.json`, so that map can be empty while the renderer already has valid screen/camera `objectUrl` file URLs. The Export button therefore builds its payload with `buildExportAssetUrlsByVideoId(videos, project.assetUrlsByVideoId)`, preferring each live `CanvasVideoItem.objectUrl` and falling back to the project-summary URL. Nothing about that URL map is written back into `project.json`.

Hydration (in `components/editor/canvas/provider.tsx`):

- Fast path — `project.state` present: write the saved `artboard`, `videos`, and `timelineClips` directly into state. Saved `videos` are split by `onCanvas`: `onCanvas !== false` videos go to the live `videos` list, `onCanvas === false` videos go to the `detachedVideos` list (Video-tab-only, no canvas node). Clips are filtered to those whose `videoId` is an on-canvas video (defensive against a stale clip pointing at a detached video). Each video's `objectUrl` — including detached ones — is taken from `ProjectSummary.assetUrlsByVideoId[video.id]` (main resolves URLs for the entire `state.videos` array, so a detached video's file URL is ready the moment it is re-added). Missing files leave that entry undefined — the renderer keeps the node so the user can see what is broken instead of silently dropping it.
- Slow path — `project.state` is `null` (first open after a recording, or schema mismatch): the existing flow runs (probe screen/camera metadata via `readVideoMetadata`, pick an Auto vs Wide preset, add videos with `source: { kind: "recording", assetRole }`). The next user edit creates `project.json`.

Autosave:

- A single effect watches `artboard`, `videos`, `detachedVideos`, and `timelineClips`. Any change schedules a `setTimeout` after `PROJECT_STATE_AUTOSAVE_DEBOUNCE_MS` (500 ms) that calls `window.api.projects.saveState(project.path, snapshot)`. Every `serializeProjectState` call site (autosave drain, synchronous flush, both hydration seeds) passes `detachedVideosRef.current` as the 4th argument; the export snapshot omits it (export must never include detached videos).
- `window` `blur` and `beforeunload` listeners flush the pending timer synchronously so quick edits before quit make it to disk.
- A "single writer + pending" pair (`autosaveInFlightRef` / `autosavePendingRef`) collapses concurrent writes — at most one IPC save is in flight, and any change made during it triggers one follow-up write when it returns.
- Both the debounced effect and the flush listeners gate on `hydratedProjectIdRef.current === project.id`, so saves never fire before hydration completes or with the wrong project's path.

Imported video files:

- `addVideoFile(file)` probes the file with a transient blob URL (for intrinsic size + duration), then ships `file.arrayBuffer()` over IPC to `projects:importAsset`. The main handler writes it to `<project>/assets/videos/<id>/<sanitized-name>` and returns the `file://` URL plus the relative path. The `CanvasVideoItem` ends up with `source: { kind: "imported", relativePath, fileSize }` and uses the returned URL as its `objectUrl`.
- Filenames are sanitised in main (`sanitizeFileName`) and the resolved path is rejected unless it is inside the project folder, so a hostile asset can never escape `<project>/assets/`.

Detached videos (remove-from-canvas / add-back lifecycle):

- "Delete" from the canvas — the selection toolbar trash button, the `Delete` / `Backspace` shortcut — is **non-destructive**. `deleteVideo(id)` moves the whole `CanvasVideoItem` from `videos` to `detachedVideos`, drops its timeline clip, clears selection if it was selected, and **does not revoke its object URL** (the file still belongs to the project). The same path applies to both recordings and imported videos.
- The renderer keeps two in-memory lists: `videos` (on canvas, the only list every existing consumer — canvas nodes, timeline, playback, export, padding, primary-audio — reads) and `detachedVideos` (Video-tab-only). Detached videos are deliberately **not** a flag on `videos` so the 5000-node hot paths never iterate or filter a detached entry.
- The Video tab lists `videos` then `detachedVideos`; on-canvas cards show **Select** (calls `selectItem`), detached cards show **Add** (calls `addVideoToCanvas`). The card chrome is identical — only the affordance label and click action differ.
- `addVideoToCanvas(id)` is the inverse: it moves the item back to `videos`, mints a **fresh full-length** `createTimelineClip` (the pre-removal trim/position on the timeline is intentionally *not* restored), and selects the restored video. The item keeps its stored canvas position, size, and appearance (corners/border/shadow) because those live on the `CanvasVideoItem` itself. The item is **appended** to `videos`, so a re-added video returns to the top of the canvas z-order (front-most) rather than its original stacking index — "re-add = bring to front", matching how a freshly imported video lands.
- Both `deleteVideo` and `addVideoToCanvas` are destructive-flush + history-tagged actions (`"delete"` / `"add"`, both in `ALWAYS_NEW_ENTRY_TAGS`), so each is exactly one undo step. Undo/redo restore re-splits the snapshot's `videos` by `onCanvas`, so detach and re-add round-trip through history cleanly.
- There is **no permanent-delete UI** today: a detached video persists in `project.json` (with `onCanvas: false`) indefinitely. Removing it from the project entirely (and deleting the underlying imported asset) is a future affordance.

Atomic writes:

- `writeJsonAtomic` writes to a `.project.json.<pid>-<ts>-<rand>.tmp` sibling first, then `rename`s on top. POSIX `rename` on the same filesystem is atomic, so a crash mid-write leaves either the previous or the new file — never a torn JSON. Any failure — `writeFile` *or* `rename` — unlinks the tmp so a read-only or full disk doesn't accumulate `.tmp` orphans.

Safety invariants for the autosave pipeline:

- **Cross-project bail.** `flushAutosave` captures `projectPath` once and re-checks `projectRef.current.path` at the top of every drain-loop iteration. If the user switches projects mid-save, the drain stops and the indicator silently rolls over to the new project's autosave; we never write the new project's data to the old project's `project.json`.
- **Status reset on project switch.** The hydration effect's reset block clears `autosaveTimerRef`, `autosaveRetryTimerRef`, `autosavePendingRef`, `lastWrittenSerializedRef`, the in-memory save error, and resets `saveStatus` to `saved` — so the cloud indicator can never strand on `saving` or `error` after a switch.
- **Skip redundant first save.** A fingerprint (JSON minus `updatedAtUnixMs`) of the last successful write lives in `lastWrittenSerializedRef`. Fast-path hydration seeds it from the loaded state, so the autosave effect's immediate post-hydration run sees no diff and skips the IPC. The indicator still briefly flashes `saving` (optimistic), then settles back on `saved`.
- **`addVideoFile` cross-project guard.** Captures the project id at function start, re-checks `projectRef.current.id` after the metadata probe *and* after `importAsset` returns. A switch during either async stage aborts cleanly. If the switch happens after the copy completed, the asset file is logged as an orphan in the old project's `assets/videos/<id>/` and the new project is left untouched.
- **`beforeunload` prompt during unsaved work.** If a debounce timer is pending, a save is in flight, or another follow-up is queued, we call `event.preventDefault()` + set `event.returnValue = ""` so the platform shows its "Leave site?" prompt. Closing anyway still loses at most the 500 ms-debounced edit (the IPC round-trip won't complete), but the prompt nudges the user to wait for the indicator to settle.
- **Auto-retry on transient errors.** When a save fails, `flushAutosave` schedules a single retry after `PROJECT_STATE_AUTOSAVE_RETRY_MS` (5 s). A new user edit supersedes the retry (the autosave-trigger effect clears `autosaveRetryTimerRef`). A project switch also cancels it.
- **Filename hardening.** `sanitizeFileName` / `sanitizeAssetId` reject pure-dot inputs (`.`, `..`, `...`) so a hostile caller can't aim a write at a parent directory even though `isPathInside` is the second line of defence.

Performance notes:

- Saving is debounced to 500 ms and writes the full document; payload size is dominated by `videos[]` which is small even at thousands of nodes (~100 bytes per video). For a true 5000-node stress case, the JSON would land at ~500 KB — still cheap, but if it grows further we should switch to a binary or delta format rather than ship denser per-node fields.
- The serialiser allocates two fresh arrays per save (`videos.map`, `timelineClips.map`). The autosave debounce keeps this off the interaction hot path; it never runs inside drag, transform, or playback ticks.

Save status indicator (`components/editor/save-status-indicator.tsx`):

- A cloud icon lives in the titlebar (right of the Open project button). Subscribes only to the dedicated `useEditorCanvasSaveStatus()` slice so frequent video/timeline updates don't re-render it.
- States: `idle` (hidden — no project loaded yet), `saving` (`CloudLoadingIcon`, gently animated), `saved` (`CloudSavingDone01Icon`), `error` (same `CloudSavingDone01Icon` tinted with `text-destructive`, error reason shown under the tooltip label).
- The provider sets `saving` whenever the debounce timer is scheduled or a save is in flight, and resolves to `saved` or `error` inside `flushAutosave`'s `finally`. The fast-path hydration also seeds `saved` so the indicator doesn't lie about pending writes immediately after open.

Opening a project without recording:

- The recorder-bar settings menu has an **Open project…** item. It opens a native folder picker rooted at `~/Documents/openscreen/`, validates the folder via `loadProjectFromFolder` (must have a `recording.json`), and if valid promotes the path to the **sticky active project**. The recorder bar then closes and the main editor window opens — same transition as after a recording. Invalid folders surface an error dialog; cancel is silent.
- Sticky active project (`activeProjectPath` in `electron/ipc/projects.ts`):
  - In-memory in the main process and persisted to `<userData>/active-project.json` so it survives both window reloads (Cmd+R) and full app restarts.
  - `projects:getLatest` checks it first, before the recorder hint and the "newest folder by mtime" fallback. Without this, refreshing the editor after switching from Project A to Project B would silently snap back to A because A's folder was modified more recently.
  - **Every "open a project" path funnels through `setActiveProjectFromFolder`** so the choice is always persisted: the recorder-bar settings menu's "Open project…" entry, the titlebar's folder picker (`projects:pickAndOpen`), the programmatic `projects:open(path)` IPC, and `main.ts`'s `onStatusChanged` recording-stop branch. The function validates the folder via `loadProjectFromFolder` (`recording.json` must exist), returns the loaded `ProjectSummary` on success so callers don't double-load, and writes the path to disk for restart persistence.
  - `projects:getLatest` is the *only* read-only path — it never promotes a fallback result to active, so the active slot only changes in response to explicit user opens or successful recordings.
  - Self-heals if the folder is missing on a subsequent boot: the slot is cleared and `getLatest` falls through to the legacy "newest by mtime" path.

Known limitations:

- A missing asset on reload renders an empty `objectUrl` — the video element will fail. We surface no UI for this yet; treat reporting a "broken video" placeholder + recovery affordances as a follow-up.
- ArrayBuffer-over-IPC import works fine for typical screen recordings (tens to hundreds of MB) but allocates the entire file in renderer memory before the copy. For multi-GB imports a streaming path API would be required.
- `beforeunload` flushes are best-effort — the platform does not guarantee an async IPC round-trip completes before the window is destroyed. The 500 ms debounce keeps the worst-case loss tight.

## Export Pipeline

Exporting reads the same `ProjectStateV1` snapshot the autosave writes, replays the timeline frame-by-frame onto a vanilla-Konva offscreen stage, and feeds each composed frame to a WebCodecs-backed encoder via [Mediabunny](https://mediabunny.dev/). Audio is streamed window-by-window through a separate mixer (`streamTimelineAudio`) so peak RAM stays bounded regardless of source-file size or timeline duration.

Trigger:

- Editor titlebar Export button (`components/editor/title-bar-export-button.tsx`). Disabled when the project has no timeline clips. On click it serialises the current state with `serializeProjectState(artboard, videos, timelineClips)`, resolves export source URLs with `buildExportAssetUrlsByVideoId(videos, project.assetUrlsByVideoId)`, and calls `window.api.export.openWindow({ settings, state, assetUrlsByVideoId, outputBaseName })`. The live URL merge is required for immediate post-recording export: before a reload, `ProjectSummary.assetUrlsByVideoId` can still be empty because main computed it before the slow-path canvas videos were synthesized and autosaved. The main process stashes the payload and opens the Export window.

Window:

- Separate `BrowserWindow` configured in `electron/windowConfigs.ts` (`exportWin`, **560×280**, vibrancy `under-window`, hidden titlebar — same chrome family as Recording Quality and Permissions). The `createExportWindow` site in `main.ts` falls back to 480×560 if the config is somehow missing; the configured value is what actually ships.
- Route: `/export/` (`app/export/page.tsx`). States: `loading`, `ready` (settings form), `running` (progress + cancel), `done` (success + Reveal in Finder + Export again), `error` / `cancelled` (retry / close). The editor window is hidden when encoding starts (`export:markPreparing` → main calls `hideMainWindow`). The editor is shown again on `cancel`, `error`, or when the export window closes — **not** on `done`, because the user is supposed to see the success surface (Reveal in Finder / Export again) before dismissing.

IPC (`electron/ipc/export.ts`):

- `export:openWindow` — receives `ExportStartPayload`, stashes it, opens the window. If an export window is already open, brings it forward without replacing the payload or resetting state (close + reopen is the way to get a fresh snapshot).
- `export:getStartPayload` — read-once payload pull from the export window.
- `export:getSettings` / `export:setSettings` — persisted to `<userData>/export-settings.json` via the same coercion path used by `defaultExportSettings()` (`lib/editor-project/export-settings.ts`).
- `export:markPreparing` — flips phase + hides the editor.
- `export:reportProgress`, `export:reportDone(ArrayBuffer)`, `export:reportError` — state machine + final file write to `~/Documents/openscreen/exports/<base>-<ISO>.<ext>`. All three refuse to mutate state once the phase is terminal (`done`/`error`/`cancelled`) — see the state-machine notes below.
- `export:cancel` — refuses for terminal phases (a late cancel after `done` would otherwise resurrect the state machine, with catastrophic consequences for the just-written output). For active phases, flips to `cancelled` and restores the editor. The export window's own `AbortController` short-circuits the in-flight `runExport` promise.
- `export:revealOutput` — `shell.showItemInFolder`, gated to paths inside the exports directory.
- `export:closeWindow` — pure window operation; **does not touch state.phase** so a terminal phase survives the close and the `disposeExportPendingPayload` cleanup correctly leaves the output alone. The window's `closed` handler in `main.ts` calls `disposeExportPendingPayload` and restores the editor.

**State-machine invariants** — `done`, `error`, and `cancelled` are terminal. Every IPC handler checks `TERMINAL_PHASES.has(state.phase)` before mutating, so a late or duplicate IPC can never resurrect a finished job. The `disposeExportPendingPayload` cleanup only deletes `state.outputPath` when phase is **not** terminal — a successful `done` job is "the user's file now" and must never be touched. (This combination fixes the bug where clicking Done used to call `cancel` first, flip the phase, and trigger a phantom delete of the just-saved video.)

Settings (`electron/ipc/export-schema.ts` + mirror in `types/api.d.ts` + renderer-side helpers in `lib/editor-project/export-settings.ts`):

- `format: 'mp4-avc' | 'mp4-hevc' | 'webm-vp9'`. Probed on mount with Mediabunny's `canEncodeVideo`; unsupported codecs are dimmed in the dropdown.
- `resolution: 'artboard' | '720p' | '1080p' | '1440p' | '4k'`. Aspect-preserving fit via `exportResolutionPixels` — long edge snaps to the target preset, short edge follows the artboard's aspect ratio, **and** the result is capped to the preset's nominal 16:9 pixel budget so near-square artboards at 4K don't blow past H.264 Level 5.2's 9.4 Mpx ceiling. Both dimensions are rounded to even pixels so AVC/HEVC accept them.
- `fps: 30 | 60`. (FPS is informational for the probe — `canEncodeVideo` doesn't take it.)
- Audio is **always** muxed when any source clip has an audio track. There is no `includeAudio` toggle.

`exportResolutionPixels` lives **only** in `lib/editor-project/export-settings.ts`. The electron-side `export-schema.ts` deliberately does not duplicate it — see the comment in that file. The basic helpers (`defaultExportSettings`, `coerceExportSettings`, `exportContainerExtension`) are duplicated across the two modules because the renderer's tsconfig excludes `electron/`; those three MUST stay byte-equivalent, and the unit tests in `lib/editor-project/__tests__/export-settings.test.ts` lock the behaviour in.

**No quality knob.** We deliberately don't expose a quality dropdown because users already pick a resolution. Instead `computeScreenContentBitrate` in `run-export.ts` derives a single text-content-tuned bitrate from `(codec, width, height, fps)` — anchored at 14 Mbps for 1080p H.264, ~2× what Mediabunny's `QUALITY_HIGH` would have produced. Mediabunny's `QUALITY_*` constants assume natural-video content where ~6 Mbps for 1080p H.264 looks fine; for terminal output / code / design tools that same bitrate is the dominant source of visible text blur. The encoder is also given `contentHint: 'text'` and a 1 s `keyFrameInterval` (more frequent I-frames preserve static text). Audio is pinned to 128 kbps AAC / Opus.

**Safety guards in `run-export.ts`**:

- `MAX_TIMELINE_SECONDS = 4 h` — refuse to start an export above this. A multi-hour blocking encode that crashes near the end is unrecoverable; users with longer content should trim first.
- `MAX_OUTPUT_PIXELS = 3840 × 2160` — refuse output dimensions above the 4K nominal pixel budget. The pixel-budget cap in `exportResolutionPixels` already keeps presets in line; this catches custom artboards at `resolution: 'artboard'`.
- Active timeline clips must resolve to source media before the export stage is built. Missing source URLs now fail the job instead of producing a correct-duration white background encode.
- Source decoder startup is fail-fast for every active source. If Mediabunny/WebCodecs cannot open a source (for example an unsupported recording codec), the export surfaces an error instead of silently skipping that clip. The frame loop additionally tracks, per source, whether it ever produced a decoded canvas; after the loop it fails the job (naming the offending file) if any source that had active frames decoded **zero** frames end-to-end, which catches "decoder opened but never produced pixels" failures before a blank file can be written. This is deliberately a per-source *total*, not a per-frame window: a clip whose audio track outlasts its video track yields `null` for its trailing frames, and that must still export the frames it has rather than abort.
- Every `await` inside the frame loop, the audio mixer, and the audio-presence probe checks the `AbortSignal` so cancel response is at most one frame's latency.

Rendering pipeline (`components/editor/export/`):

- `build-stage.ts`: builds a vanilla `Konva.Stage` from a `ProjectStateV1` snapshot. One `Konva.Layer` for the background (color or wallpaper bitmap + grain overlay) and one for the video content. Each video is a `Konva.Image` whose `sceneFunc` calls the shared `drawCanvasVideoFrame` from `components/editor/canvas/video-scene-draw.ts` — so the export frame is pixel-identical to the editor preview. A scale factor (output width / artboard width) is applied at the Stage level so all node coordinates remain in artboard space. Nodes start `visible(false)`; the loop activates them per frame.
- `source-frames.ts`: source-side WebCodecs decode pipeline. `planExportFrames` walks the timeline once and produces (a) a per-output-frame list of active clips and (b) the monotonic sequence of source timestamps each unique source video will be asked about. `SourceFrameProvider.create({...})` opens a Mediabunny `Input` over `UrlSource` (HTTP Range streaming — does **not** blob the whole file into memory) and wraps a `CanvasSink.canvasesAtTimestamps(...)` async generator. Mediabunny decodes each source packet **at most once** when timestamps are monotonic and pre-fetches `poolSize`–1 canvases ahead of the consumer. The create path is wrapped in try/catch so a failure between `new Input` and the iterator handoff disposes the Input rather than leaking it.
- `decode-audio.ts` (`streamTimelineAudio`): **window-based streaming mixer**. The previous implementation `fetch(file://…) → arrayBuffer() → OfflineAudioContext.decodeAudioData()` per source loaded the entire source video file into RAM and then allocated a single timeline-sized output `AudioBuffer` — for a 2 GB recording and a 1 h timeline that's ~2 GB transient + ~1.4 GB decoded, easily crashing the export window. The current pipeline:
  1. Opens one Mediabunny `Input` per unique source URL (HTTP Range streaming).
  2. Builds one `AudioBufferSink.buffers(sourceIn, sourceOut)` async iterator per timeline clip — lazy decode, packet-by-packet.
  3. Walks the output timeline in fixed 0.5 s windows. For each window: allocate a window-sized `AudioBuffer` (~192 KB at 48 kHz stereo), mix-add every overlapping clip's decoded chunks into it (so overlapping clips compose instead of clobbering), `await audioSource.add(windowBuffer)` to honour encoder backpressure, then drop the window buffer to GC.
  Peak RAM stays bounded under ~10 MB regardless of timeline length or source size. Output sample rate is the max observed across all sources; mismatched sources are linearly resampled inline.
- `run-export.ts`: orchestrates the loop. Emits an `onStage(stage)` callback at every phase boundary (`preparing`, `decoding-audio`, `encoding`, `muxing-audio`, `finalizing`) so the export window can swap its headline + status text in step with the pipeline. **Probe-before-add**: because Mediabunny doesn't let you remove a track after `output.start()`, the runner first calls `probeHasAnyAudio` to open each source briefly and check `getPrimaryAudioTrack()`. If any source has audio, an `AudioBufferSource` is added; otherwise the file is video-only. The source-decoder spin-up still runs active sources in parallel, but any missing metadata or decoder failure aborts the job; successful-but-blank exports are worse than a visible error because they look complete until playback. For each output frame:
  1. `node.visible(false)` on every video node (so a clip that ended last frame doesn't ghost a stale image).
  2. In parallel, `await provider.next()` for each active source → assign the returned canvas to its Konva node via `node.image(canvas)` + `node.visible(true)`.
  3. `handles.contentLayer.draw()` — only the content layer; background stays untouched.
  4. Blit every layer canvas onto the stable composite `<canvas>` (via the layer's underlying `_canvas`).
  5. `await videoSource.add(t, 1/fps)` — Mediabunny's backpressure; never fire-and-forget.
  6. Periodic `onProgress` callback (~10 Hz) with `{ framesDone, framesTotal, etaSeconds }`, reported through IPC. The page renders a realtime `Frame N of M · WxH · ETA` line plus a cycling micro-phrase (`Composing`, `Painting frames`, `Wiring shadows`, …) so the user sees the export actively breathing during the long encoding phase.
- After the frame loop, if an audio track was added, `streamTimelineAudio` is run end-to-end and the windows are pushed through `AudioBufferSource.add` one at a time. If audio mixing throws or produces no samples (edge case: every source's audio decode failed), a single tiny silent buffer is pushed so the track isn't empty (Mediabunny requires at least one packet per declared track before finalize).

Why this is fast — what we removed:

- **No per-frame `<video>.currentTime` seek.** Each seek invalidated the decoder and re-decoded from the prior keyframe (50–200 ms per call). With a sequential `VideoDecoder` pipeline via `CanvasSink`, every source packet is decoded **once**, in order, while we hand canvases to the encoder. For text-heavy 1080p exports this alone is the difference between ~5 fps and ~30+ fps export throughput.
- **No per-frame background redraw.** v1 called `stage.draw()` every iteration which redrew both layers; the background never changes, so we draw it once at startup and only `contentLayer.draw()` per frame.
- **No `HTMLVideoElement` lifecycle overhead.** No `loadedmetadata` waits, no rVFC safety nets, no off-DOM stalls. The source files are streamed in via HTTP Range requests through `UrlSource`.
- **No fetch+arrayBuffer+decodeAudioData for audio.** Mediabunny `AudioBufferSink` streams source packets the same way the video sink does, so audio decode shares the same HTTP-Range / pool-of-canvases lifecycle and never holds the full source file in JS heap.
- The Mediabunny output uses `BufferTarget`; on success the renderer hands the `ArrayBuffer` to `export:reportDone`, which writes the bytes to disk in main.

Performance / scaling notes:

- Constant layer count (1 background + 1 content), regardless of video count — scales to 5000+ nodes.
- `listening(false)`, `perfectDrawEnabled = false` on every node. No transformer, no interaction listeners.
- The composite canvas is allocated once and redrawn in place each frame; no `getImageData` round-trips. Mediabunny's `CanvasSource` wraps it directly into a `VideoFrame`.
- Source decode and encode are both WebCodecs-backed and execute on browser-internal threads. The driver in `run-export.ts` is a single pure async function with an `AbortSignal`.
- The audio mixer holds at most one window-sized `AudioBuffer` plus the per-source decoder pre-fetch (typically a handful of packets per active clip) — peak RAM constant under ~10 MB.

Per-window CSP / `webSecurity`:

- The export window opts in to `webSecurity: false` (in `createExportWindow`) so cross-origin `<video>` loads from `file://` don't taint the canvas, which would break `new VideoFrame(canvas, …)`.
- The CSP `connect-src 'self' app: file:` is scoped to the export window only via a per-`webContentsId` check in `onHeadersReceived`. Every other window keeps the tighter base CSP (`connect-src 'self' app:`).

Cancellation:

- `AbortController.abort()` inside the export page rejects the next `await` in `runExport`. The outer `finally` block disposes the Konva stage; the inner `finally` disposes every `SourceFrameProvider` (which cancels in-flight HTTP Range requests, closes the WebCodecs `VideoDecoder`, and returns pooled canvases to GC). The audio mixer's `finally` disposes its own Inputs + iterator handles. Mediabunny output is left to GC — no partial file is written because `reportDone` is the only write site.
- The renderer-side `cancelEncode` is guarded: it sends the `cancel` IPC only when an `AbortController` is active. This prevents the "click Done on the success screen → file gets deleted" bug by ensuring the cancel handler never runs after a terminal phase.

Known limitations:

- HEVC encode availability varies by OS/GPU. The codec probe hides it when missing.
- The driver runs on the export window's main thread. Long-duration 4K60 exports may stutter the export window's UI (progress bar) under encoder backpressure; the editor stays fully responsive because it's a separate window. The source decode and encode are both already WebCodecs-backed and run on browser-internal threads, so moving the driver itself to a Worker is mostly a UI-stutter mitigation, not a perf win.
- Non-monotonic source timestamps (rare: two clips referencing the same source at out-of-order source times) still work but lose `CanvasSink.canvasesAtTimestamps`'s per-packet decode optimisation — the decoder re-seeks per timestamp jump.
- Audio sample-rate conversion uses linear interpolation inline per output frame. This is fine for the common 44.1 → 48 kHz conversion at screen-recording quality; a polyphase resampler would be sharper for extreme rate ratios but the cost/benefit doesn't justify it today.
- Wallpaper backgrounds load via `fetch(/assets/...)`. On a packaged build this resolves to `app://./assets/...`, which is on the allowlisted protocol — works, but the bitmap is loaded fresh per export.
- The export settings live in `<userData>/export-settings.json`, **not** inside `project.json`. This is intentional — last-used export preferences are a user-level setting, not project state. Keep them out of `ProjectStateV1`.
- Hard ceilings: timelines above 4 hours and outputs above the 4K nominal pixel budget are refused at the start of `runExport`. Beyond these the failure modes shift from "slow" to "OOM mid-encode", which is unrecoverable; failing early gives the user actionable feedback.

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
- Timeline playback keeps media control in provider refs. Registered `HTMLVideoElement`s are sampled from the playhead without per-frame React state writes for each canvas node.
- Timeline active-clip visibility uses a cached boundary window, so steady playback between clip starts/ends reuses the current visible id set instead of rescanning every timeline clip on each `requestAnimationFrame`.
- Timeline hover preview is back, paused-only, and gated. Every `seeked` event flows through the provider's single `onTimelineVideoSeeked(id, element, redrawLayer)` decision: if the element has a live hover entry whose target matches `currentTime`, redraw and (if the hover ref moved) reissue; otherwise fall back to the committed-time gate. Hover never writes committed state and every committed write cancels the hover pipeline first.
- Paused video `seeked` events are not blindly redrawn. The video node asks the timeline controller whether the decoded frame still matches the committed playhead target before calling `contentLayer.batchDraw()`, so out-of-order seek completions do not create a forward/back frame flash.
- During playback the master active clip drives the cursor from its native `currentTime`; the controller never re-seeks the master and only nudges secondary videos when drift exceeds `TIMELINE_PLAYBACK_DRIFT_SECONDS`. This replaces the older per-frame drift-correction that could trigger small back-and-forth seeks when rAF jitter pushed the rAF-accumulated time above the 80 ms threshold.
- Explicit user actions (scrub, click, skip, clip move/resize, play start, clip activation) still go through a single forced sync that snaps every visible video to the target source frame within `TIMELINE_FORCE_SEEK_EPSILON_SECONDS`.
- Inactive clip visibility is implemented by toggling the existing Konva media node's `visible` and `listening` attrs from the timeline controller; it does not add thumbnail canvases, extra Konva nodes, or DOM overlays.
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

### Squircle Corners (iOS / macOS)

Problem:

- The editor needs corner-radius support for video nodes, but a plain CSS-style `border-radius` shows the elbow at large radii. The user explicitly wanted iOS / macOS-style continuous corners so the seam between the straight edge and the corner is invisible.
- Camera previews already rendered as a perfect circle via a separate elliptical `sceneFunc` and a `cropShape` field. Maintaining two render paths blocked a unified appearance model and any future per-corner radii.

Decision:

- Drop `cropShape` entirely. Express a perfect circle as a max-radius (`min(w,h) / 2`), max-smoothing (`1.0`) squircle — the visual result is identical and the render path collapses to a single sceneFunc for all roles.
- Use the Figma-derived continuous-corner algorithm with two knobs: `cornerRadius` (artboard px) and `cornerSmoothing` (0–1). Smoothing defaults: camera = `1.0`, screen / media = `0.6` (the macOS look).
- Trace the path on the Konva.Context directly (no `Path2D`) and feed it into `ctx.clip()` so the image draw inside the sceneFunc takes the squircle silhouette.
- Memoize the per-corner constants on `(radius, smoothing, width, height)`. The constants are independent of width / height in principle, but the clamped effective radius depends on the box's shorter side.

Result:

- One sceneFunc handles `screen`, `camera`, and `media`. No `cropShape`, no separate elliptical drawing.
- Radius-0 fast path is a single `ctx.rect()` call; clipping is skipped entirely when no rounding is in effect.
- Visually matches macOS app-window / app-icon corners at `cornerSmoothing = 0.6`, and matches the prior elliptical camera at `cornerRadius = min(w,h)/2`, `cornerSmoothing = 1`.

References:

- Figma, "Desperately Seeking Squircles".
- Apple HIG continuous corners (iOS / macOS app icons).

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
- Konva listening false performance tip: https://konvajs.org/docs/performance/Listening_False.html
- Konva Stage API, pointer position: https://konvajs.org/api/Konva.Stage.html
- shadcn `Resizable` component: https://ui.shadcn.com/docs/components/base/resizable
- `react-resizable-panels` API: https://github.com/bvaughn/react-resizable-panels
- Figma zoom and pixel grid behavior: https://help.figma.com/hc/en-us/articles/360041065034-Adjust-your-zoom-and-view-options
- Figma layout grids: https://help.figma.com/hc/en-us/articles/360040450513-Create-layout-grids-with-grids-columns-and-rows
- MDN `HTMLVideoElement.requestVideoFrameCallback()`: https://developer.mozilla.org/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
- MDN `CanvasRenderingContext2D.imageSmoothingEnabled`: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/imageSmoothingEnabled
- Figma blog, "Desperately Seeking Squircles": https://www.figma.com/blog/desperately-seeking-squircles/
- Apple Human Interface Guidelines, continuous corners (app icons): https://developer.apple.com/design/human-interface-guidelines/app-icons

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
- Timeline panel renders in the footer, shows the empty-state timeline, disables play with no media, and logs no browser console errors.

Known unrelated project issue:

- Full `pnpm lint` has failed on pre-existing unrelated files outside this canvas work. Use targeted lint for changed files unless the broader lint cleanup is part of the task.
