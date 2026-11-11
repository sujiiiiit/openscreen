# Editor Canvas Knowledge Base

This document records the current video-canvas editor architecture, the terms we should use, features implemented so far, optimization decisions, problems encountered, and references used. Keep it current whenever the Konva editor, artboard, zoom, grid, video rendering, or related UI changes.

## Terminology

Use these names in code review, docs, comments, and new implementation plans. The shorter translation table lives in `docs/normal-term.md`.

| Common phrase used in discussion | Preferred industry term           | Meaning in this app                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outer canvas                     | Workspace or pasteboard           | The bounded editor surface around the artboard. Implemented by the PixiJS viewport and the workspace background.                                                                                                                                                                                                                                                                                 |
| Inner canvas                     | Artboard or frame                 | The export-sized editable area, e.g. 1920 x 1080 for 16:9.                                                                                                                                                                                                                                                                                                                                       |
| Canvas section                   | Workspace section                 | Top editor section containing the fixed/collapsible sidebar and PixiJS workspace.                                                                                                                                                                                                                                                                                                                |
| Timeline section                 | Timeline panel                    | Resizable bottom editor panel reserved for timeline/playback UI.                                                                                                                                                                                                                                                                                                                                 |
| Sidebar section                  | Editor sidebar                    | Fixed-width left editor panel with its own collapse animation; it is not resizable.                                                                                                                                                                                                                                                                                                              |
| Canvas zoom                      | Viewport transform                | The `scale`, `x`, and `y` camera transform applied to the PixiJS world container.                                                                                                                                                                                                                                                                                                                |
| Elastic artboard / rubber canvas | Canvas bitmap stretch             | Preview-only non-uniform scaling when the browser stretches old PixiJS pixels during workspace resize. The renderer buffer and CSS canvas box must be resized together, then the resized scene must be painted immediately.                                                                                                                                                                      |
| Elements                         | Canvas nodes or layer items       | Videos now; future text, shapes, subtitles, images, etc.                                                                                                                                                                                                                                                                                                                                         |
| Hover bounds                     | Hover outline                     | A non-selecting visual outline shown around the canvas node under the pointer.                                                                                                                                                                                                                                                                                                                   |
| Auto layout / video position     | Derived video placement           | `computeVideoPlacement` in `src/lib/video-placement.ts`: `x/y/width/height` recomputed from artboard size + padding for every canvas video (all roles). Persisted for v1 compatibility, never gesture-edited; rotation is always written as 0.                                                                                                                                                       |
| Pixel grid                       | Artboard pixel grid               | A 1 artboard pixel grid visible at high zoom inside the artboard.                                                                                                                                                                                                                                                                                                                                |
| Outer grid                       | Workspace grid or pasteboard grid | A future visual grid for the dark workspace outside the artboard. Not implemented yet.                                                                                                                                                                                                                                                                                                           |
| Background tab add video         | Media import action               | Local `video/*` file picker that adds a video node to the artboard.                                                                                                                                                                                                                                                                                                                              |
| Timeline area zoom value         | Canvas zoom control               | Footer dropdown showing and controlling current workspace zoom.                                                                                                                                                                                                                                                                                                                                  |
| Timeline block                   | Timeline clip                     | A non-destructive time range that references one canvas video and stores timeline in/out plus source in/out.                                                                                                                                                                                                                                                                                     |
| Left labels in timeline          | Track label rail                  | A fixed row-name column beside timeline lanes; currently omitted. The unlabeled timeline keeps a 30 px start inset.                                                                                                                                                                                                                                                                              |
| Grid snap in timeline            | Timeline grid snap                | Clip move/resize snapping to the ruler subdivision grid. Currently **disabled** (see [Timeline And Playback](#timeline-and-playback)); only guide-line snap is active.                                                                                                                                                                                                                           |
| Auxiliary line snap              | Timeline guide-line snap          | Clip edge snapping to other clip edges and the playhead, with temporary vertical guide lines.                                                                                                                                                                                                                                                                                                    |
| Timeline auto scroll             | Timeline edge auto-scroll         | Horizontal scrolling while dragging a clip near the visible timeline edge.                                                                                                                                                                                                                                                                                                                       |
| Ruler time style                 | Ruler tick label format           | Clock-style timeline labels, e.g. `0:15`, `1:00`, and `1:05:00`; compact major dot ticks remain visible while labels keep a wide gap.                                                                                                                                                                                                                                                            |
| Controls on top                  | Timeline transport controls       | Theme-colored skip, play/pause, and playback time controls in the footer's top toolbar, above the ruler and lanes.                                                                                                                                                                                                                                                                               |
| Timeline zoom                    | Timeline zoom                     | Horizontal timeline scale controls that increase or decrease pixels per second.                                                                                                                                                                                                                                                                                                                  |
| Fit timeline                     | Fit longest clip to width         | Default timeline view mode that scales the widest clip block to the visible timeline width and scrolls to that clip.                                                                                                                                                                                                                                                                             |
| Play cursor                      | Playhead                          | Current committed timeline time used to sample every canvas video.                                                                                                                                                                                                                                                                                                                               |
| Secondary hover seek             | Hover preview                     | Paused-only ghost cursor that previews the active clip frame, cursor overlay, and manual Zoom camera under the pointer without writing the committed playhead. Fires from anywhere over the timeline — the ruler **or** the tracks. Hover coalesces live `HTMLVideoElement` seeks per element, paints landed frames through the canvas redraw callback, and is cancelled by any committed write. |
| Frames going forth and back      | Stale seek redraw                 | An older completed media seek repainting the canvas after a newer committed playhead seek; guarded by committed-time redraw checks.                                                                                                                                                                                                                                                              |
| Cut video edge                   | Source trim                       | Non-destructive `sourceIn` / `sourceOut` adjustment created by resizing a timeline clip.                                                                                                                                                                                                                                                                                                         |
| Frozen clip frame                | Inactive clip visibility          | Playback sync rule that hides a canvas media node outside its active clip range instead of holding an edge frame.                                                                                                                                                                                                                                                                                |
| Border radius / rounded corners  | Corner radius (squircle)          | Per-node corner radius in artboard pixels, drawn as an iOS / macOS-style continuous-corner squircle.                                                                                                                                                                                                                                                                                             |
| iOS / macOS smooth corners       | Corner smoothing                  | Per-node 0–1 smoothing factor; 0 = circular arc, 0.6 = macOS look, 1 = fully continuous-curvature.                                                                                                                                                                                                                                                                                               |
| Custom / fake / SVG cursor       | Cursor overlay                    | Themed SVG cursor (`CanvasCursorOverlay`) drawn over the screen video from the recording's captured cursor track, replacing the OS cursor.                                                                                                                                                                                                                                                       |
| Cursor style / cursor theme      | Cursor set (`cursorSetId`)        | Persisted bundled cursor asset set (`macos`, `macos-tahoe`, `touch`, `halloween`, or `custom-1..20`) used by preview/export to resolve captured cursor shapes.                                                                                                                                                                                                                                   |
| Cursor click point               | Cursor hotspot                    | The point in a cursor SVG that sits on the recorded pointer position (0..1 fraction of the SVG box); drives the Konva offset.                                                                                                                                                                                                                                                                    |
| Cursor lean / pointer tilt       | Cursor motion rotation (side lean) | Persisted cursor motion setting (`cursorMotionRotation`, 0..1) that derives a subtle Screen-Studio-style horizontal side lean from recent cursor velocity. The direction-follow "rotation" mode was removed 2026-06-06; the legacy `cursorMotionRotationMode` field is parsed and ignored.                                                                                                                                                                                                     |
| Fullscreen play / present mode   | Fullscreen preview                | A distraction-free mode that fullscreens the workspace, fill-fits the artboard, hides all editor chrome, and auto-plays the composition start-to-end like a video player.                                                                                                                                                                                                                        |
| Fill the screen / no-padding fit | Fill-fit (preview contain-fit)    | Zero-padding contain-fit transform (`getPreviewFillTransform`) used only in fullscreen preview; letterbox bars frame the artboard, no crop.                                                                                                                                                                                                                                                      |

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
- Playhead-driven playback sync for screen, camera, imported media, and cursor overlay, including visibility/blur pauses that commit the active video frame before resuming.
- Click-to-select with a plain selection outline. Placement is **settings-derived** (`src/lib/video-placement.ts`) — there are no drag/resize/rotate gestures, transform handles, marquee, multi-select, lock, or duplicate (all removed; see [Interaction Model](#interaction-model)).
- Hover outline for unselected video nodes.
- Pointer-centered zoom, keyboard zoom, pinch zoom tuning, panning, and zoom dropdown.
- High-zoom artboard pixel grid.
- Workspace theme color token: `editor-workspace` = `#1e1e1e`.
- Per-node video appearance via the Video sidebar tab: squircle corner radius + smoothing and a squircle-following border (width, color, alignment, offset). (A squircle-following drop shadow existed previously and was removed entirely on 2026-06-06 — UI, renderer, export, and persisted fields.)
- Auto-routing of canvas / timeline selection to the Video tab via a `SidebarSelectionBridge`.
- Non-destructive remove-from-canvas: deleting a video (recorded or imported) detaches it from the canvas/timeline but keeps it in the project; the Video tab lists it with an **Add** action to put it back.
- Cursor overlay: a themed SVG cursor drawn over the screen recording, driven by captured cursor metadata, zero-phase-smoothed and hotspot-accurate (Screen Studio-style). See [Cursor Overlay](#cursor-overlay).
- Manual Zoom clips: a dedicated Zoom track drives a real composition zoom camera with focus point, visible-window preview, radial zoom blur during motion, and export parity. See [Timeline And Playback](#timeline-and-playback).
- Fullscreen preview: a "Preview" titlebar button plays the composition start-to-end in true fullscreen with native-style auto-hiding controls. See [Fullscreen Preview Mode](#fullscreen-preview-mode).

Not implemented yet:

- Audio controls.
- Cropping/masking.
- Workspace grid outside the artboard.
- Soft-bound zoom settling to remove hard edge jumps completely.

## Packages

- `konva@10.3.0`
- `react-konva@19.2.4`

`react-konva` is browser-only, so the stage is loaded with `next/dynamic(..., { ssr: false })` in `src/components/editor/main.tsx`.

## Files

| File                                                      | Responsibility                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/page.tsx`                                            | Top-level editor layout. Wraps the editor in `EditorCanvasProvider`, tooltip provider, one vertical resizable group, top workspace section, and timeline panel.                                                                                                                                                                       |
| `src/components/editor/main.tsx`                              | Client-only dynamic import for `EditorWorkspace` and full-size workspace panel wrapper.                                                                                                                                                                                                                                               |
| `src/components/editor/background-panel.tsx`                  | Background sidebar tab: header master switch (`artboard.backgroundEnabled` — when off, preview/export paint no background fill/wallpaper **and** padding stops insetting (videos re-lay out full-bleed), all controls disable, stored values are kept), Wallpaper / Color backdrop pickers, plus Padding and Background blur sliders. Each slider renders a one-line muted helper description (`AdjustmentRow`'s required `description` prop; the copy swaps to explain *why* when the control is disabled — no screen recording / no wallpaper). |
| `src/components/editor/footer.tsx`                            | Footer shell containing the artboard preset dropdown, top timeline transport controls, audio status, canvas zoom dropdown, and timeline panel.                                                                                                                                                                                        |
| `src/components/editor/timeline-panel.tsx`                    | Timeline UI, playback controls, playhead scrubbing, clip rendering, and move/resize handlers.                                                                                                                                                                                                                                         |
| `src/components/editor/sidebar.tsx`                           | Left editor sidebar, tab rail, tab content panel, and fixed-width collapse/expand animation. Tab order: Background, Cursor, Video, Subtitle, Audio, Zoom — Zoom is deliberately last (selection-driven via the timeline, not a browsing destination).                                                                                 |
| `src/components/editor/zoom-panel.tsx`                        | Sidebar Zoom tab for the selected Zoom clip: enabled switch, clip-start focus preview, draggable focus point, visible zoom window, scale, Strength, and transition Duration controls. The Focus preview and every slider render a one-line muted helper description under their labels (same pattern as the other sidebar panels). When the clip's enabled switch is off, the focus preview (pointer-blocked, still showing the snapshot), its caption, and all sliders dim and disable — only the header switch stays interactive; the clip's settings are kept for re-enable. |
| `src/components/editor/canvas/provider.tsx`                   | Editor canvas state, video import metadata, artboard state, viewport size, view transform, and actions.                                                                                                                                                                                                                               |
| `src/components/editor/canvas/editor-workspace.tsx`           | Konva stage shell, layer composition, viewport sizing, zoom, pan, keyboard shortcuts, and the fullscreen-preview lifecycle (fullscreen request/exit, fill-fit transform, chrome/interaction gating).                                                                                                                                  |
| `src/components/editor/canvas/zoom-scene.ts`                  | Pure manual-zoom math shared by preview and export: defaults hydration, fixed-anchor camera sampling, duration-based transition timing by composition time, visible-window geometry, and Konva camera placement.                                                                                                                      |
| `src/components/editor/canvas/scene-snapshot.ts`              | Module-level bridge for one-shot artboard rasterization: `PixiCanvas` registers `CanvasScene.captureCompositeSnapshot` on mount; `captureSceneSnapshot(targetWidth)` returns the composed artboard (no chrome, unzoomed) as a canvas, or null when no canvas is mounted. Used by the Zoom tab's focus preview.                       |
| `src/components/editor/canvas/preview-controls.tsx`           | `PreviewControls` — DOM overlay for fullscreen preview: click/Space-to-toggle surface, auto-hiding transport (play/pause, tick-driven scrub bar, clock), always-on Exit button, centered Replay at end.                                                                                                                               |
| `src/components/editor/title-bar-preview-button.tsx`          | Titlebar "Preview" button (before Export) that calls `enterPreview()`; disabled until the timeline has a positive duration.                                                                                                                                                                                                           |
| `src/components/editor/canvas/artboard-pixel-grid.tsx`        | Custom non-listening pixel grid renderer for high zoom inside the artboard.                                                                                                                                                                                                                                                           |
| `src/components/editor/canvas/canvas-video-node.tsx`          | Live video node rendering, frame callbacks, object URL playback, cover crop attrs, squircle sceneFunc with passes for drop shadow (off-canvas-cast technique) and per-node border, hitFunc kept at the node body, and Konva node registration.                                                                                        |
| `src/components/editor/canvas/canvas-cursor-overlay.tsx`      | `CanvasCursorOverlay` — one Konva `Image` in the artboard clip group that samples the captured cursor track by playback source time and draws the themed SVG at its hotspot. Imperative on the hot path. See [Cursor Overlay](#cursor-overlay).                                                                                       |
| `src/lib/cursors/cursor-track.ts`                             | Pure cursor-data processing: raw samples → deterministic zero-phase smoothed track (`buildSmoothedTrack`) → `sampleCursorAtTime`.                                                                                                                                                                                                     |
| `src/lib/cursors/cursor-set.ts`                               | Maps a captured `cursorId` (NSCursor name) → themed SVG asset + hotspot, with base-set fallback.                                                                                                                                                                                                                                      |
| `src/lib/cursors/cursor-manifest.ts`                          | Generated cursor index (hotspot + size per asset). Built by `scripts/generate-cursor-manifest.mjs`.                                                                                                                                                                                                                                   |
| `electron/ipc/projects.ts` (`projects:getCursorData`)     | Read-only IPC that loads a recording's cursor track (`mousemoves-0.json`, `mouseclicks-0.json`, + `input` manifest entry) into `CursorTrackData`.                                                                                                                                                                                     |
| `src/components/editor/video-panel.tsx`                       | Video tab UI: file-card list of every project video — on-canvas videos (action: **Select**) followed by detached videos (action: **Add**) — with the appearance controls (corner radius + smoothing; border width, color, offset — no "Corners"/"Border" group headings, the rows stand alone; the width slider is labeled **"Border"**, not "Width") shown when a card is selected. Border **alignment** and **offset** (in that order) live in an **"Advanced settings"** accordion at the bottom, collapsed by default — built on the unstyled animate-ui Base accordion primitive (`src/components/animate-ui/primitives/base/accordion.tsx`, Motion height/opacity/mask panel animation) with minimal inline styling, no card chrome. Alignment uses the shared `SelectionPills` selector (`src/components/editor/selection-pills.tsx`, extracted from the Cursor panel's smoothing control) at `size="md"` (`h-8 px-3 text-sm`, a step up from the Cursor panel's `xs`; the component's sizes are `xs` / `md` / `default`). The sliders, Alignment, and the **Advanced settings trigger itself** render a one-line muted helper description under their labels (same pattern as the Background/Cursor panels; the Offset copy swaps to explain *why* when no border width is set; the trigger's description uses block `span`s, not `h4`/`p`, because a `button` only allows phrasing content). The Color row intentionally has no description; its control is a pill-shaped `Button` (`variant="outline" size="sm"`, `rounded-full`; circular swatch + `#HEX` readout) whose click opens a visually-hidden native color input positioned behind the pill, so the OS color popup anchors to the control. The row is labeled **"Border color"**. Color changes are **debounced** (`BORDER_COLOR_COMMIT_DEBOUNCE_MS`, 150 ms trailing): the pill previews instantly from local `draftColor` state while the OS picker drags, and the provider commit (scene re-render + history + autosave) fires only after the drag pauses; a pending color is flushed on unmount so switching videos mid-drag can't drop it. |
| `src/components/editor/sidebar/selection-bridge.tsx`          | Subscribes to canvas selection and switches the sidebar to the Video tab + opens the sidebar whenever a video is selected.                                                                                                                                                                                                            |
| `src/components/editor/sidebar/tab-preference.ts`             | `localStorage` read/write for the persisted sidebar tab state (`openscreen:sidebarTab` — active tab id + open/collapsed flag) plus the opt-out flag (`openscreen:sidebarTabPersist`) and its change event. App-level, deliberately outside `project.json`; validates the stored tab id against `TAB_IDS` and drops unknown ids.       |
| `src/app/recording-settings/page.tsx` (Editor section)        | Settings window **"Remember sidebar tab"** switch toggling sidebar tab persistence (default ON; default-size `Switch` in a `SettingRow`). OFF stops writes and clears the stored entry; ON writes the current tab through immediately. The Settings window is a separate `BrowserWindow`, so `SidebarTabsProvider` syncs via the cross-window `storage` event for `openscreen:sidebarTabPersist` (plus the same-window `SIDEBAR_TAB_PERSIST_CHANGE_EVENT`). Also hosts the **"Autoplay on open"** switch (default ON, app-level flag `openscreen:autoplayOnOpen`, helpers in `src/components/editor/canvas/autoplay-preference.ts`) — the provider reads that flag at fire time, so no change event is needed. Both switches lived in the editor titlebar before 2026-06-07 (`title-bar-autoplay-switch.tsx` / `title-bar-tab-persist-switch.tsx`, removed). |
| `src/lib/squircle.ts`                                         | Figma-style continuous-corner math. `computeSquircleCornerParams(radius, smoothing)` and `traceSquirclePath(ctx, w, h, params)` for allocation-free hot path.                                                                                                                                                                         |
| `src/components/editor/canvas/artboard-preset-dropdown.tsx`   | Artboard preset dropdown in the footer. The **Auto** row's subtext always shows the concrete size Auto would resolve to (`resolveAutoArtboard(resolveAutoSourceDims(sourceVideoDims, videos))` — the screen recording's pixel size, else an on-canvas video's intrinsic size, else the Wide fallback) instead of the former static "Match source" placeholder; `sourceVideoDims` is exposed reactively through the `useEditorCanvasArtboard()` slice. The Auto row is its own component (`AutoArtboardRadioItem`) rendered inside `DropdownMenuContent`, so its `videos` subscription only exists while the menu is open — canvas video edits never re-render the closed footer control. The trigger still shows the actual `artboard.width × height` while Auto is active. |
| `src/components/editor/canvas/canvas-zoom-menu.tsx`           | Canvas zoom dropdown and zoom percentage readout.                                                                                                                                                                                                                                                                                     |
| `src/components/editor/canvas/view-transform-utils.ts`        | Viewport interaction helpers for input target checks, modifier detection, and screen-pixel snapping.                                                                                                                                                                                                                                  |
| `src/lib/video-placement.ts`                                  | Pure derived-placement module: `computeVideoPlacement` (cover-fit at padding 0, padded contain-fit otherwise), `getPaddingInsetPx` clamp, and `applyAutoLayout` (recompute every video, force rotation 0, identity-preserving for autosave convergence).                                                                              |
| `src/components/ui/dropdown-menu.tsx`                         | Shared dropdown menu primitives used by artboard and zoom controls.                                                                                                                                                                                                                                                                   |
| `src/lib/editor-canvas.ts`                                    | Artboard presets, zoom/grid constants, fit transform (`getFitViewTransform`), zero-padding fill-fit transform (`getPreviewFillTransform`), clamped view helpers, and pointer-centered zoom helper.                                                                                                                                    |
| `src/lib/zoom-clips.ts`                                       | Pure Zoom-track helpers: clip ids, default settings, clamping, overlap detection, placement, normalization, and patch sanitization.                                                                                                                                                                                                   |
| `src/lib/motion-blur/radial-zoom-blur.ts`                     | Custom WebGL2 radial zoom blur postprocess for editor preview and export; ports Pixi `ZoomBlurFilter`'s one-sided center-pull sample pattern with baked strength, 2% inner-radius, and infinite-radius tuning, and returns `null` when WebGL2 is unavailable so the camera effect can still render sharp.                             |
| `src/lib/editor-canvas-snap.ts`                               | Pure snap math: rotated AABB, snap-cache builder, drag-snap and resize-snap solvers, equal-spacing distance guides, grid snap helpers.                                                                                                                                                                                                |
| `src/types/editor-canvas.ts`                                  | Canvas types: size, artboard, pixel grid settings, view transform, video item (incl. persistence `source`), Zoom clip, transform patch.                                                                                                                                                                                               |
| `src/components/editor/canvas/persistence.ts`                 | Pure serialize / deserialize helpers between `CanvasVideoItem` + `EditorArtboard` + `CanvasTimelineClip` + `CanvasZoomClip` and the `ProjectStateV1` schema written to `project.json`.                                                                                                                                                |
| `src/components/editor/save-status-indicator.tsx`             | Cloud icon in the titlebar that reflects autosave state (`saving` / `saved` / `error`); pulses while writing, turns red on failure, tooltips clarify in plain English.                                                                                                                                                                |
| `electron/ipc/project-schema.ts`                          | Schema source of truth for `project.json` (versioned `ProjectStateV1`), `parseProjectState` validator, plus the save-state IPC payload types.                                                                                                                                                                                         |
| `electron/ipc/projects.ts`                                | `projects:*` IPC handlers — reads `project.json`, resolves `assetUrlsByVideoId`, atomically writes editor state (per-folder save mutex), loads cursor sidecars with validation + diagnostics, manages the sticky active project (with sessionId identity recovery).                                                                   |
| `electron/ipc/fs-utils.ts`                                | Shared `writeJsonAtomic` (tmp sibling + atomic `rename`) used by `project.json`, `active-project.json`, and `window-bounds.json` writes.                                                                                                                                                                                              |
| `electron/window-bounds.ts`                               | Persists user-positioned window bounds (`<userData>/window-bounds.json`) for the editor, camera preview, recorder bar, and export windows; validates saved bounds against connected displays on restore.                                                                                                                              |
| `src/app/globals.css`                                         | Theme tokens, including `--editor-workspace`.                                                                                                                                                                                                                                                                                         |
| `docs/normal-term.md`                                     | Developer-friendly translation table from discussion terms to industry terms.                                                                                                                                                                                                                                                         |

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
              Clipped artboard background group
                Artboard fill
              ArtboardPixelGrid
            Content Layer
              Transparent hit rect
              Clipped artboard content group
                Manual zoom camera group
                  CanvasVideoNode[]
                  CanvasCursorOverlay
              Unzoomed artboard border
            Selection Overlay Layer
              Hover outline
              Selection outline
          DOM radial zoom blur overlay canvas
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
- Manual Zoom clips transform only the artboard composition groups (background fill and content/cursor). The persisted `focus` is a fixed zoom anchor: `sampleZoomCameraAtTime` applies `offset = focus * artboardSize * (1 - scale)`, so the focus point stays in the same rendered artboard position for the whole transition and every other pixel scales radially around it. The persisted `transition.durationMs` value sets how long each zoom-in / zoom-out ramp takes, independent of clip span, so long clips can hold the zoom instead of making the ramp crawl. Artboard border, pixel grid, hover outline, selection outline, and other editor chrome stay unzoomed.
- Radial zoom blur is a reused custom postprocess overlay: the preview crops the **artboard region** out of the already-drawn background/content layer canvases **at device-pixel resolution** (`Konva.pixelRatio`, up to 3×) into one source canvas, runs the shared WebGL shader when zoom motion is non-zero, draws the blurred artboard back in place, and temporarily hides the source layer canvases so the sharp and blurred versions are not double-painted. The blur origin is the same fixed zoom anchor as the camera transform, not a separately clamped camera center, so edge and near-edge zooms do not pan first and blur later. The shader now follows Pixi `ZoomBlurFilter`: 32 one-sided samples from each pixel toward the focus point, randomized per-pixel sample phase to hide fixed-kernel banding, parabolic weights (`4p(1-p)`), an inner-radius feather, and an infinite outer radius. Blurring **only the artboard** (not the whole viewport) keeps the streak inside the artboard exactly like the exporter — an earlier full-viewport composite let a strong streak smear past the artboard edge into the workspace margin — and device-pixel sizing keeps the preview as sharp as the export (compositing at CSS-pixel size used to halve the resolution). The DOM overlay canvas also pins its CSS width/height to the viewport while its backing store remains high-DPI, so the backing-store size cannot make the overlay appear larger than the workspace. Any imperative viewport transform (`scheduleViewTransform`, used by pan/wheel zoom) re-renders the overlay synchronously after moving the Konva stage; otherwise a paused playhead inside a Zoom clip can leave the blurred video texture at the previous screen position while the artboard/backdrop moves. Because `batchDraw()` is frame-scheduled, an active blur overlay forces `drawScene()` on the two source layers immediately before cropping; this keeps the sampled texture current without redrawing hit graphs. It deliberately avoids Konva `cache()` / filter work on scene nodes.
- Selection overlay layer contains one hover outline and one selection outline (screen space, stage-level) so live video redraws never repaint selection chrome per decoded frame.

## State Model

`EditorCanvasProvider` owns the canvas state and exposes narrowed context hooks so unrelated UI does not subscribe to every canvas state change.

Important types:

- `CanvasVideoItem`: `id`, `fileName`, `objectUrl`, `fileSize`, `source` (persistence pointer — `{ kind: "recording", assetRole }` for screen/camera recordings or `{ kind: "imported", relativePath, fileSize }` for files copied into the project folder), `intrinsicWidth`, `intrinsicHeight`, `durationMs`, `x`, `y`, `width`, `height`, `rotation`, `locked`, `role`, plus per-node appearance fields. **Placement is derived-then-persisted:** `x/y/width/height` are always recomputed from the artboard settings via `src/lib/video-placement.ts` (never gesture-edited), `rotation` is always written as `0`, and `locked` is read/written for v1 schema compatibility but ignored by the editor (the lock feature was removed with the transformer). Also `cornerRadius`, `cornerSmoothing`, `borderWidth`, `borderColor`, `borderOffset`, `borderAlignment` (`"inside" | "center" | "outside"`). (The `shadow*` fields were removed entirely on 2026-06-06.) `objectUrl` is the runtime URL the renderer hands to a `<video>` element; it is rebuilt on every hydration from `source` and is not persisted.
- `CanvasTimelineClip`: `id`, `videoId`, `start`, `end`, `sourceIn`, `sourceOut`.
- `CanvasZoomClip`: `id`, `start`, `end`, `enabled`, `focus`, `mode` (`"auto" | "manual"`), `scale`, `radialBlur`, `transition`, plus legacy-readable `radialBlurSettings` / `easePreset` / `engagedRects`. `mode` is auto (cursor-follow) vs manual (fixed `focus`); in `manual` mode `focus` is the user anchor (may sit on any artboard edge/corner) and preview/export keep that point fixed on screen, in `auto` mode `focus` is only the ease-in anchor and the camera spring-follows the cursor. `transition.durationMs` is the persisted ramp duration in milliseconds. Runtime clips always carry full defaults via `withZoomClipDefaults`; zoom-blur strength, 2% inner radius, and outer radius stay baked in `ZOOM_RADIAL_BLUR_SHADER` / renderer defaults, legacy `transition.speed` / `easeIn` / `easeOut` / `curve` / `easePreset` still hydrate but the amount ramp is the **spring** (the `curve` field is vestigial), and `engagedRects` is a tolerated legacy field no longer populated or read. `project.json` may omit default-valued settings (including `mode` when `auto`).
- `EditorArtboard`: `presetId`, `width`, `height`.
- `ViewTransform`: `scale`, `x`, `y`.
- `PixelGridSettings`: `enabled`, `unit`, `majorUnit`, `visibleFromScale`, `opacity`, `color`, `majorOpacity`, `majorColor`, `role`.

Important actions:

- `selectItem(id | null)`
- `updateVideoAppearance(id, patch)` — partial update covering `cornerRadius`, `cornerSmoothing`, `borderWidth`, `borderColor`, `borderOffset`, `borderAlignment`. The no-op bail-out compares all six fields so a slider parked at its current value never triggers a redraw.
- `deleteVideo(id)` — **non-destructive**: detaches the video from the canvas/timeline (moves it to `detachedVideos`, drops its clip) instead of removing it from the project. Despite the name, no project data or asset file is deleted.
- `addVideoToCanvas(id)` — inverse of `deleteVideo`: re-attaches a detached video to the canvas with a fresh full-length timeline clip and selects it. Placement is recomputed against the **current** artboard settings on re-attach (derived placement), so the video lands per today's padding/preset, not wherever it sat before removal.
- ~~`updateVideoTransform` / `setVideoLocked` / `duplicateVideo`~~ — removed with the transformer. Placement is settings-derived; lock and duplicate no longer exist.
- `setArtboardPreset(id)`
- `setViewportSize(size)` — during fullscreen preview this updates the size state but skips its auto-fit/clamp transform mutation, so the user's saved view survives and the imperative fill-fit isn't fought.
- `setViewTransform(transform)`
- `fitArtboardToViewport()`
- `enterPreview()`, `exitPreview()` — toggle the session-only `isPreviewMode` flag. Pure state toggles: every side effect (fullscreen request/exit, start playback from 0, fill-fit, restore the saved view) lives in `editor-workspace.tsx` effects that key on `isPreviewMode`, keeping the provider DOM-free.
- `registerTimelineVideoElement(id, element | null)`
- `registerTimelineCanvasNode(id, node | null)`
- `setTimelineTime(time)`
- `playTimeline()`, `pauseTimeline()`, `toggleTimelinePlayback()`
- `zoomTimelineIn()`, `zoomTimelineOut()`, `fitTimelineToWidth()`
- `moveTimelineClip(id, start, end)`
- `resizeTimelineClip(id, start, end, direction)`
- `addZoomClip(start, end)`, `moveZoomClip(id, start)`, `resizeZoomClip(id, start, end, direction)`, `updateZoomClip(id, patch)`, `removeZoomClip(id)`, `selectZoomClip(id | null)`
- `subscribeTimelineTicks(callback)`

Context hooks:

- `useEditorCanvasMedia()`: `videos` (on canvas), `detachedVideos` (in project, removed from canvas), selection, selected video, import error.
- `useEditorCanvasArtboard()`: current artboard.
- `useEditorCanvasView()`: viewport size, viewport transform, and `isPreviewMode`.
- `useEditorCanvasTimeline()`: clips, selected clip, Zoom clips, selected Zoom clip id, playhead time, duration, timeline zoom, fit mode, playback state, primary audio video id.
- `useEditorCanvasActions()`: stable canvas actions.
- `useEditorCanvasTimelineActions()`: stable timeline playback, clip-editing, and media-registration actions.
- `useEditorCanvasSaveStatus()`: autosave indicator state.
- `useEditorHistory()`: `canUndo`, `canRedo`, `undo()`, `redo()`. Reactive enablement flags for future toolbar/menu surfaces; stable callbacks for the keyboard handler.
- `useEditorCanvas()`: compatibility hook that merges every context and should be avoided in hot or narrow components.

`ResizeObserver` updates the viewport size from the workspace area, so the Konva stage follows timeline resizing and sidebar collapse/expand.

## Undo / Redo

Snapshot-based, in-memory undo/redo for the document state. Lives entirely in `EditorCanvasProvider`; pure decision logic in `src/components/editor/canvas/history.ts`. Cleared on project switch and app quit (no crash-recovery persistence — that's reserved for Phase 6 in `docs/project-plan.md`).

Scope:

- Restores `{ artboard, videos, timelineClips, zoomClips }` — the same slice the autosave fingerprint covers. The serialized `videos` array carries both on-canvas and detached videos (split by `onCanvas`), so a detach or re-add is restored as an atomic undo step: restore re-splits the array back into the `videos` / `detachedVideos` lists. Undo/redo also drops the session-only `selectedZoomClipId` if the restored set no longer contains it.
- Does NOT restore selection (`selectedItemId`), playhead time (`timelineTime`), timeline zoom/scroll, workspace view transform, hover preview, or any other session-only state. Selection is invalidated only when the previously-selected video no longer exists in the restored **on-canvas** set; otherwise it is left alone. The playhead is clamped if the restored duration is shorter than its current position.
- When the restored artboard dimensions differ from the current ones (e.g., undoing a preset change), the viewport is auto-refit to the new size via `getFitViewTransform`. This matches `setArtboardPreset`'s "always fit on size change" rule so the canvas never strands at a stale zoom after an undo.

Capture point:

- Aligned to the existing 500 ms autosave debounce. The push site lives inside `flushAutosave`'s drain loop (in `provider.tsx`, immediately after the fingerprint compare). Every drain iteration calls `pushHistoryFromAutosave(snapshot, fingerprint, capturedTag)` regardless of disk-write outcome, so history advances even on transient IPC errors and on no-op fingerprint matches.
- **Zero per-surface wiring** on sliders or timeline clip move/resize. The natural debounce already collapses a fast-fire burst into one entry.
- **Tag capture is synchronous with the snapshot.** The drain reads and clears `historyCommitTagRef.current` at the same instant it serialises the snapshot, then passes the captured tag through to the push. A user action that races the IPC await cannot mis-attribute its tag to the in-flight snapshot — its tag is picked up by the next drain pass instead.

Coalescing:

- Each action sets `historyCommitTagRef.current = "<tag>"` before mutating state (one line per action). Tags used today: `appearance`, `add`, `delete`, `preset`, `background`, `background-enabled`, `padding`, `cursor-custom-rendering`, `cursor-set`, `cursor-size`, `cursor-smoothing`, `cursor-click-press-scale`, `cursor-always-use-pointer`, `cursor-type-stabilization`, `cursor-motion-rotation`, `cursor-motion-blur`, `cursor-motion-blur-backend`, `clip-move`, `clip-resize`, `zoom-add`, `zoom-move`, `zoom-resize`, `zoom-settings`, `zoom-remove`. (`transform`, `nudge`, `lock`, and `duplicate` were removed with the transformer; placement changes are tagged by their settings action — `padding` / `preset`.) A missing tag is treated as `unknown` and always pushes a new entry.
- `applyHistoryCommit` (in `history.ts`) replaces the top entry when the new commit shares the previous tag AND lands inside `HISTORY_COALESCE_WINDOW_MS = 2000`. Otherwise it appends a new entry. The replace branch truncates the redo tail past the cursor — editing on top of an undid cursor must invalidate the stale future. Identical fingerprints just refresh the timestamp and preserve the existing tag when the incoming tag is `unknown` (so a benign post-flush no-op cannot demote a meaningful tag).
- `ALWAYS_NEW_ENTRY_TAGS = { "add", "delete", "preset" }` — these always push a new entry, never coalesce. Coupled with the destructive-flush rule below they guarantee that "Cmd+Z" undoes exactly one delete/add/preset change.

Destructive flush:

- `addRemoteVideo`, `deleteVideo`, `addVideoToCanvas`, and `setArtboardPreset` call `flushAutosaveNow()` **before** they mutate state. The helper pushes the pre-destructive snapshot to history **synchronously** (so the boundary survives even when another save is already in flight — `flushAutosave` would queue itself and the in-memory boundary would otherwise be lost), then kicks the async drain to write that snapshot to disk. The destructive change that follows lands as its own entry on the next autosave fire.

Storage:

- `MAX_HISTORY_ENTRIES = 100`, FIFO eviction at the front.
- In-memory `historyRef` in the provider. The state never touches disk.
- The project-switch reset block (`useEffect` ~`provider.tsx:2581`) clears `historyRef`, `historyCommitTagRef`, `restoringFromHistoryRef`, `hydrationSeedPendingRef`, `sessionVideoUrlsRef`, and both reactive flags.
- Both hydration paths seed a cursor-0 baseline tagged `"unknown"` whose state is the **recording-ready** document (artboard preset + auto-added recording + its clip), so the user's first edit becomes index 1, `Cmd+Z` returns to that ready state, and the blank canvas is **never** an undo step.
  - **Fast path** (`project.json` exists): the recording is already in the saved state, so the baseline is seeded synchronously from the hydrated snapshot.
  - **Slow path** (fresh recording, no `project.json`): the recording is added asynchronously by `addRemoteVideo`, so the baseline cannot be seeded synchronously. Instead hydration arms `hydrationSeedPendingRef`; `pushHistoryFromAutosave` drops every push while it is set (swallowing the empty pre-add snapshots), and a dedicated seed effect (keyed on `videos`/`timelineClips`) turns the first committed non-empty state into the cursor-0 baseline and clears the flag. Seeding eagerly on commit — rather than waiting for the recording's debounced autosave — guarantees the baseline is in place before the user can interact, so even an immediate reposition of the recording is undoable. The recording-add's own autosave then matches the baseline fingerprint and refreshes the timestamp instead of appending. The slow path also seeds `lastWrittenSerializedRef` so the destructive flush inside `addRemoteVideo` does not write the still-empty state to disk before the auto-add lands.

Object URL on restore:

- `resolveObjectUrlForRestore` resolves a restored video's `objectUrl` for **both** recording and imported sources, in order: an existing in-state copy (`videoByIdRef` / `detachedVideos`), `project.assetUrlsByVideoId[videoId]`, then a `sessionVideoUrlsRef: Map<id, string>` cache. The cache is populated for every added video (`addRemoteVideo`) and only ever holds `file://` URL strings — no blob memory is pinned by undo. A missing file falls back to an empty `objectUrl`, identical to hydration's broken-asset semantics.
- The session cache is **load-bearing for fresh recordings**, not just imports. `project.assetUrlsByVideoId` is built by main from the saved `state.videos` (`resolveAssetUrlsForState` in `electron/ipc/projects.ts`) and is **empty until a `project.json` exists** — so a recording opened via the slow path has no entry there. If a restore lands on a state where the recording is briefly off the canvas (any redo onto a snapshot whose video is not currently in `videos`/`detachedVideos`) the live `videoByIdRef` lookup also misses, and without the session cache the recording would rebuild with an empty `objectUrl` and render blank (the canvas appears to "lose" the recording, while the cursor overlay — which reads geometry, not the video element — lingers). Caching recording URLs in `sessionVideoUrlsRef` closes that gap. (The slow-path undo baseline is now the recording-ready state, not a blank canvas — see the Storage notes above — so plain undo no longer triggers this, but the cache still guards delete/re-add and other off-canvas restore paths.)

Keyboard:

- `Cmd/Ctrl + Z` = undo. `Cmd/Ctrl + Shift + Z` = redo. Wired in `editor-workspace.tsx`'s `handleKeyDown`, above the Delete branch so the shortcut works without a selection. Bails when `isEditableTarget(event.target)` is true.

Titlebar buttons:

- `src/components/editor/history-controls.tsx` renders ghost-style icon buttons (HugeIcons `Undo03Icon` / `Redo03Icon`) next to the Folder and `SaveStatusIndicator` in `src/components/ui/titlebar.tsx`. Each is wrapped in a Tooltip; clicking calls `undo()` / `redo()`. The buttons are `disabled` when `canUndo` / `canRedo` is false, so they grey out at the ends of the stack and after a project switch.

Performance:

- Push site: one pure JS array op per autosave. Serialization is O(videos + clips). Negligible vs the IPC write.
- Restore: one bulk replace of three state slots → one content-layer redraw. `CanvasVideoNode` memoization keeps unchanged nodes from re-rendering, preserving the 5000-node stress invariant.
- Memory peak today (10 videos × 100 entries × ~1 KB) ≈ 1 MB. At the 5000-node stress invariant from `CLAUDE.md` the same 100-entry cap would hold ≈ 250 MB of snapshots — well above the budget for that target. When the editor moves toward that scale, swap the entry cap for a byte-budgeted cap (or move to diff snapshots) before turning on persisted history.

Known limitations:

- Two **different** non-destructive actions landing inside the same 500 ms autosave window coalesce into one entry (the last tag wins). One `Cmd+Z` rolls back both. The destructive-flush rule prevents this from mixing destructive and non-destructive edits; pairs like "padding + appearance change" within 500 ms are accepted as a single undo unit. Acceptable per the zero-wiring constraint.
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

Persistence:

- The active sidebar tab and the open/collapsed flag survive a refresh / app restart. `SidebarTabsProvider` restores them from `localStorage` (`openscreen:sidebarTab`, helpers in `src/components/editor/sidebar/tab-preference.ts`) in a one-shot post-hydration effect — the first client render must match the prerendered defaults, same pattern as the renderer backend preference — and writes every later change through. The reducer's `restore` action sets both fields verbatim (unlike `selectTab`, which toggles `isOpen` on the already-active tab) and bails when nothing changes.
- This is **app-level UI chrome, not project state** — it deliberately lives outside `project.json` (like the renderer backend preference) and applies across projects. A stored tab id that no longer exists is dropped and the defaults (`background`, open) apply.
- `SidebarSelectionBridge` routing still wins over the restored tab once the user selects something on the canvas/timeline; the resulting tab change is written through like any user tab switch.
- Persistence is **opt-out** via the Settings window's **"Remember sidebar tab"** switch (Editor section of `src/app/recording-settings/page.tsx`, default ON, flag stored at `openscreen:sidebarTabPersist`; moved out of the titlebar on 2026-06-07). Turning it OFF stops writes **and clears the stored entry** — "don't persist" reliably means the defaults next launch, not a stale snapshot. Turning it back ON writes the current tab through immediately, so a restart right after toggling restores what the user is looking at. Because the Settings window is a separate `BrowserWindow`, `SidebarTabsProvider` listens for the cross-window `storage` event on `openscreen:sidebarTabPersist` in addition to the same-window `SIDEBAR_TAB_PERSIST_CHANGE_EVENT`; no reload is needed either way. While OFF, tab state is plain session-only.

Performance notes:

- Resizing changes layout bounds only. It does not add Konva layers, per-node DOM overlays, or per-node listeners.
- The existing workspace `ResizeObserver` is the bridge from DOM layout to Konva viewport size.
- Large scenes remain bounded by the existing stage-level event delegation and constant layer count; a timeline resize or sidebar collapse may trigger a viewport-size state update and stage redraw, but it does not loop over canvas nodes.

## Artboard

Presets live in `src/lib/editor-canvas.ts`.

Current presets:

- Wide: 1920 x 1080, 16:9.
- Vertical: 1080 x 1920, 9:16.
- Portrait: 1080 x 1350, 4:5.
- Standard: 1440 x 1080, 4:3.
- Square: 1080 x 1080, 1:1.

Changing the preset resets the view to fit and relayouts **every** canvas video via `applyAutoLayout` (`src/lib/video-placement.ts`) — placement is fully derived from the artboard settings.

### Artboard Padding

The Background panel exposes a `Padding` slider above `Background blur`. Padding is stored on `EditorArtboard.padding` as absolute artboard pixels in the range `0–500`. We use pixels rather than a percentage so every notch on the slider maps to the same number of artboard pixels regardless of preset, giving users one-to-one control when they trim or frame the recording.

Behavior (placement is **derived for every video role** — screen, camera, and imported media all follow the same rule):

- Padding insets every canvas video on all four sides while preserving its intrinsic aspect ratio.
- At `padding === 0`, every video uses cover-fit (fills the artboard edge-to-edge, center-cropped).
- At `padding > 0`, every video switches to contain-fit inside the inner rect (`artboard.width - 2 * inset` × `artboard.height - 2 * inset`), revealing the background on the surrounding margin.
- The legacy per-video `locked` flag no longer skips relayout — the lock feature was removed with the transformer; the field persists for v1 schema compatibility but is ignored.
- Slider is disabled when no screen-role video is present.
- Preset changes and project hydration preserve `padding` (same lifecycle as `background`). Preset changes, padding changes, hydration, and video re-attach all recompute placement through the same helpers.

Helpers (in `src/lib/video-placement.ts` — pure, vitest-covered, importable by the export if ever needed):

- `getPaddingInsetPx(artboard)` clamps the stored pixel value against `floor(min(width, height) / 2) - 1` so the inner rect can never collapse to zero, regardless of slider position or canvas preset. It returns `0` when `artboard.backgroundEnabled === false` (Background tab master switch off ⇒ padding effect neutralized, full-bleed layout) — every placement call site inherits this because they all pass the full artboard.
- `computeVideoPlacement(intrinsic, artboard)` is the single source of truth for video placement and routes between cover-fit and padded contain-fit.
- `applyAutoLayout(videos, artboard)` maps every video through `computeVideoPlacement` and forces `rotation: 0`; it preserves per-item and array identity when nothing changed, so hydration recompute and slider no-ops never look like new edits to the autosave fingerprint.

**Background grain removed (2026-06-17).** The film-grain overlay (the Background panel `Grain` slider, the persisted `artboard.grain` field, the `setArtboardGrain` action + `grain` history tag, the noise `TilingSprite` in the preview scene and the export stage, and `getNoiseTexture` in `background.ts`) was removed completely. The grain `TilingSprite` used the `overlay` advanced blend mode, so this also dropped the `pixi.js/advanced-blend-modes` side-effect import from `scene.ts` and `build-stage.ts` (grain was its only consumer). The v1 schema validator no longer requires or returns `grain`; legacy `project.json` files that still carry it keep loading (unknown keys are ignored) and simply drop the field on the next save — no version bump needed because no remaining field changed shape. A `LEGACY_ARTBOARD` fixture in `persistence.test.ts` keeps a stray `grain` key on purpose to assert that tolerance.

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

**Drop shadow removed (2026-06-06).** The per-node squircle-following drop shadow (`shadowColor` / `shadowBlur` / `shadowOffsetX` / `shadowOffsetY` / `shadowSpread`) was removed completely: the Shadow panel group (and its `ColorAlphaSwatch` rgba picker plus the whole `src/lib/rgba-color.ts` helper), `computeShadowParams` / `ShadowRenderParams` in `video-scene-draw.ts`, the Pixi `shadowGfx` + `BlurFilter` layer in both the preview scene and the export stage, and the five persisted `ProjectVideo` fields. The v1 schema validator no longer requires those keys; legacy `project.json` files that still carry them keep loading (unknown keys are ignored) and simply drop the fields on the next save — no version bump needed because no remaining field changed shape.

Defaults per role at creation:

- `screen`, `media`: `cornerRadius = 0`, `cornerSmoothing = 1` (changed from `0.6` on 2026-06-07; the Video panel's Smoothing slider defaults and Resets to 100 % — `SMOOTHING_DEFAULT_PERCENT`. Existing projects keep their saved value: `cornerSmoothing` is a required v1 field, so only newly created videos pick up the new default).
- `camera`: `cornerRadius = floor(min(intrinsicW, intrinsicH) / 2)`, `cornerSmoothing = 1`. Renders as a perfect circle by default.
- All roles: `borderWidth = 0`, `borderColor = "#000000"`, `borderOffset = 0`, `borderAlignment = "inside"`. The border is invisible until the user nudges the width slider.

Squircle math (`src/lib/squircle.ts`):

- `computeSquircleCornerParams(radius, smoothing, budget)` returns the Figma-derived per-corner constants `{ p, a, b, c, d, angleAlpha, arcSweep, radius }`. `budget` is the per-corner rounding-and-smoothing budget — `min(width, height) / 2` of the box being traced — and caps the smoothing extension `p = (1 + smoothing) · radius` so the outline can never self-intersect. When `p` would overrun the budget, the requested smoothing's curvature profile (arc sweep + perpendicular handles `c`/`d`) is kept and the in-edge bézier handles `a`/`b` are redistributed into the remaining room — the `preserveSmoothing` behavior of the figma-squircle reference implementation, so the smoothing slider keeps having a visible effect at large radii.
- `traceSquirclePath(ctx, width, height, params)` walks the four corners, each composed of one cubic Bézier ramp, the middle circular arc of `arcSweep` radians **emitted as ≤45° cubic Béziers** (`traceArcAsBeziers`, standard `k = 4/3·tan(Δ/4)` construction, ~0.002 % radial error), and a second cubic Bézier back onto the next edge. No allocations, no temporary objects. Every curve passes `CURVE_FIDELITY = 0.98` as PixiJS's per-call adaptive-tessellation hint (subdivision tolerance is `(1 − smoothness)²` local px; the 0.5 default leaves ~0.25 px facets that turn visible under the ≤4× zoom camera). PixiJS's own `ctx.arc()` is deliberately avoided: it tessellates with a fixed step count (`6·r^⅓·sweep/π`) that ignores any fidelity setting and facets under zoom.
- `clampSquircleRadius(width, height, radius)` clamps the radius itself to `min(width, height) / 2`; the budget clamp above handles the smoothing extension on top of it.
- `tracePathOrRect(ctx, width, height, params | null)` collapses to a single `ctx.rect()` call when `params === null` (radius = 0), keeping the radius-0 case effectively free.
- Covered by `src/lib/squircle.test.ts`: figma-squircle reference parity across a radius/smoothing grid, the `p ≤ budget` invariant, no-backwards-edges regression (circle preset), all points/control points within the box for stressed combos, arc-as-bézier on-circle accuracy, and the per-box budgets wired through `computeSquircleParams` / `computeBorderParams`.

Node render order (video underneath, border on top):

1. If `squircleParams !== null`: trace the silhouette and clip to it. When `cornerRadius === 0` the trace collapses to a single `ctx.rect()` call and clipping is skipped entirely.
2. Draw the live video frame with the existing object-fit-cover crop attrs.
3. If `borderParams !== null`: translate to the border-box origin, trace a separate squircle at `width + 2·signedDistance` × `height + 2·signedDistance` with `cornerRadius + signedDistance`, and stroke it. The translate handles outside-aligned and positive-offset borders, which draw past the node bounds; the artboard-level clip keeps strokes contained.

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
  - **List view** (no selection): heading + one-line description + a single-column stack of `Squircle` file cards — every on-canvas video first, then every detached video. Each card shows the `FileEmpty02` icon on the left and the file name + file size stacked on the right (formatted via a local `formatFileSize` helper — no monospace digit treatment), with a hover-revealed action affordance on the right. On-canvas cards show **Select** and call `selectItem(id)` (the single source of truth: canvas selection outline, timeline clip highlight, and the panel itself all derive from it); detached cards show **Add** and call `addVideoToCanvas(id)`, which re-attaches the video and selects it. The card chrome is identical for both — only the affordance label and click action change.
  - **Settings view** (video selected): replaces the heading with a `Button variant="link"` "← Videos" affordance at the same `text-sm font-semibold` slot, with its own one-line description below. Clicking it calls `selectItem(null)`, returning the user to list view and clearing the canvas / timeline selection in the same hop. Beneath the heading sit three appearance groups:
    - **Corners** — radius + smoothing. The Radius slider max is `min(250, floor(min(w,h)/2))` (`RADIUS_SLIDER_MAX` caps the UI range; small nodes still cap at their per-corner squircle budget). The stored value is re-clamped by the renderer against the live size, so values above the cap from presets (e.g. the camera circle) still render correctly.
    - **Border** — width slider, color swatch with native `<input type="color">`, alignment radiogroup of `inside | center | outside`, and offset slider in `[-64, +64]` artboard px. All Border controls except Width are disabled while `borderWidth === 0`, mirroring Figma's "no stroke when width is 0" behaviour.
- When no videos exist yet, list view shows an inline `Squircle` hint pointing at the Background tab.
- The settings-view subtree is keyed on the video id so internal refs reset cleanly across selections.
- `CanvasVideoItem.fileSize` is populated from `ProjectAsset.fileSize` for recordings and from the persisted `source.fileSize` for legacy imported videos. It falls back to `0` ("Unknown size") only when the byte count is genuinely unknown (remote stream, or a recording whose asset file is missing).
  - **Source of truth differs by kind.** Imported videos persist their size in `project.json` (`source.fileSize`). Recordings do **not** — a recording's size is owned by its on-disk `.mov`, which the main process freshly stats into `ProjectAsset.fileSize` on every project open. Both hydration paths therefore resolve a recording's size from `project.assets` (by `assetRole`) rather than from the saved record, via `resolveFileSizeForRestore` in `provider.tsx`. This is why recordings show their real size after a refresh instead of "Unknown size" — earlier the fast path hard-coded `0` for recording sources.

Performance posture:

- Squircle and border params are recomputed only on appearance/size changes. Border params short-circuit to `null` when `borderWidth = 0`, skipping the stroke pass entirely. Steady-state playback and pan/zoom never recompute trig for any path.
- The hot-path trace is allocation-free and issues a constant ~21 canvas calls per node per draw (1 moveTo + 4 lineTo + 8 ramp bezierCurveTo + ≤8 arc bezierCurveTo). The non-rounded fast-path is one `ctx.rect()` call. The `CURVE_FIDELITY` hint makes PixiJS tessellate more vertices per curve, but geometry rebuilds only on appearance/size changes — never per frame — so the render loop is unaffected. (At a hypothetical 5000-node scale the finer tessellation would inflate appearance-rebuild cost; if that ever matters, the fidelity constant can become zoom-adaptive without touching callers.)
- Rounded clipping is only enabled when `cornerRadius > 0`; otherwise the sceneFunc skips `context.clip()` entirely, saving a canvas state push per node per frame.
- The `updateVideoAppearance` action bails out when every patched field equals the current value, so a slider dragged at its committed position never triggers a downstream React re-render or Konva redraw.
- The selection outline and hover outline remain rectangular (bounding box). Both stay imperative and pooled; squircle clipping does not change that contract.

Known limitations / v2 work:

- Per-corner radii (TL/TR/BR/BL). The data model is single-radius today; the storage shape can grow to `number | [tl, tr, br, bl]` without a breaking change at the type-level boundary.
- A rounded hover/selection outline would require tracing the squircle path in the overlay; left out to keep the bounding-box hit area predictable.

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
- **Seek indicator geometry.** Both seek indicators — the committed playhead (package `cursor.tsx`, sky) and the hover-preview ghost cursor (`TimelineHoverGhostCursor`, white) — share identical geometry so they always align: a 1 px line spanning the **full timeline height** (`top-0` through the ruler down to the panel bottom), with the 12×22 teardrop pin head at the **very top of the line** (`top-0`, inside the 32 px ruler) — the classic NLE look. The head overlaps the ruler's label band (labels render at roughly y 9–24, `-translate-y-full` above the bottom-anchored major ticks) only while the playhead is directly over a label, which is the accepted trade-off. Mid-line head placements were tried (24 px / 26 px offsets, below the label band) and rejected: a head floating partway down the line reads as a bead on a string, not a playhead. The line itself is a **fading gradient**, not a solid stroke: solid for the top 65 %, then to transparent at the bottom (`bg-gradient-to-b … from-65% to-transparent`), so the tail doesn't compete with the clips it crosses. The committed cursor draws it as a 2 px background halved to 1 px by the legacy `scaleX(0.5)` body transform — **not borders** — so the app themes it through a `from-*` color in the `cursor` classNames slot (`from-sky-400`), and the ghost uses the same gradient at `w-px` (`from-white/70`). Pin head fills must be **opaque** — the ghost head uses `#b5b5b5` (the opaque equivalent of white/70 on the dark footer) rather than an alpha white, because a translucent fill lets the seek line show through the head. If either pin's offset or the gradient stops change, update the other in lock-step; the two pins live in different files (package cursor vs app overlay) and nothing enforces the match.

Editing behavior:

- Moving a clip changes `start` / `end` while preserving its current source trim.
- Resizing the left edge changes `sourceIn`.
- Resizing the right edge changes `sourceOut`.
- Clip move and resize interactions use timeline guide-line snap and timeline edge auto-scroll. Timeline grid snap is **disabled** (`ENABLE_TIMELINE_GRID_SNAP = false` in `timeline-panel.tsx`) so clip edges move continuously rather than locking to the ruler subdivision grid; with `gridSnap=false` the package falls back to a 1 px move step (imperceptible) while the guide-line snap keeps its 8 px magnet threshold to other clip edges and the playhead. Guide-line snap picks the **nearest** candidate edge: the adsorption scans in `row_rnd.tsx` (move, resize-left, resize-right) track the running minimum distance, fixing the inherited react-timeline-editor bug where `minDis` was never updated so the *last* guide within range silently won — the magnet could jump to the playhead or a farther edge instead of the one being aimed at.
- `onActionMoving` / `onActionResizing` accept a third return shape besides `true`/`false`: an adjusted `{ start, end }` span. `EditAction` converts it back to pixels, renders it, and returns the corrected transform to `RowDnd`, which continues the drag from the clamped position. This is the **clamp-don't-reject** primitive the Zoom track uses to slide clips flush against obstacles instead of freezing them short.
- Screen, camera, and media clips are independent. Moving or trimming one clip does not alter the others.
- Clicking a timeline clip selects the matching canvas video node; selecting a canvas node highlights its clip.

Zoom track:

- A dedicated **Zoom track** is the last (bottom) lane, present whenever at least one video lane exists (`buildTimelineRows` appends a `zoom` row after the role rows; the lane shows even when empty so it can be hovered to add). Its clips are `CanvasZoomClip { id, start, end, enabled, focus, scale, radialBlur, transition, radialBlurSettings }` (timeline seconds plus normalized output-camera/filter settings) — a **standalone** persisted array, deliberately not yet the auto-generated `ZoomKeyframe` model from `docs/auto-zoom-plan.md`. `focus` is the user-picked zoom anchor, not a camera center, so it can target edge/corner content without exposing outside-artboard pixels. Legacy `easePreset` values (`smooth`, `snappy`, `slow`) are still read and converted into explicit transition values, but the editor no longer exposes preset names as the primary control.
- **Output effect, not workspace scaling.** Zoom clips drive the composition zoom camera sampled by `zoom-scene.ts` using composition time. The camera scales and offsets the artboard's background/content groups inside the artboard clip while leaving the artboard border, pixel grid, hover outline, selection outline, and sidebar chrome unzoomed. Disabled clips remain visible in the Zoom track but sample as identity in both preview and export.
- **Continuous zoom (welding adjacent clips).** A single clip's span represents **normal → zoom → hold → normal**, BUT two **near-adjacent** clips are *welded*: the camera transitions directly from the first clip's settled state to the second's (scale **and** focus, e.g. `2.5x@A → 1.7x@B`) across A's ease-out, the gap, and B's ease-in — it never drops to `1x` between them. This removes the "pump" when several zooms sit back-to-back. Welding engages only when the inter-clip gap is small *relative to the clips' durations* — `gap ≤ clamp(ZOOM_WELD_GAP_FRACTION·min(durA,durB), 0.12s, 0.6s)` (`zoom-scene.ts`), so clips with a real gap keep their wide beat and render exactly as before. The weld blend uses the **spring** glide (`springEase`) and the same `getZoomVisibleWindow`/focus-anchor math, so the subject stays framed throughout the pan. It is computed entirely inside the shared `sampleZoomCameraAtTime`, so **preview, hover preview, and export weld identically** (no schema/UI change — the behavior is automatic and responds to the user dragging clips closer/apart). Radial blur during a weld tracks the *smaller* scale swing, so a `2.5→1.7` weld blurs gentler than a full zoom-from-`1x`. A single clip, and well-separated clips, are byte-identical to the previous per-clip behavior.
- **Cursor follow (`auto` mode, spring).** An `auto` clip's focus **spring-follows the recorded cursor** while held — a port of Cap's zoom-focus model (`pixi/zoom-spring.ts`). It is computed offline (the whole cursor track is known up front), so it stays a pure function of `(clip, cursor track)` and preview == export. The follow reads recorded cursor metadata even when `cursorCustomRenderingEnabled` is false; that switch hides only the custom cursor sprite, not the camera path. A `manual` clip gets **no path** and renders as a plain fixed-focus zoom around its stored `focus`.
  - **How it follows.** `computeZoomFollowPaths` → `ZoomFollowPaths` in `zoom-scene.ts`: for each `auto` clip, sample the cursor's artboard focus every `8 ms` over the hold and drive a **mass-spring-damper** (`stiffness 200, damping 40, mass 2.25` — Cap's `ScreenMovementSpring`) toward it. The target is **predictive**: because the whole cursor track is known before preview/export sampling, each live target blends slightly toward the cursor's near-future position (`FOCUS_INTENT_LOOKAHEAD_MS = 280`, `FOCUS_INTENT_BLEND = 0.58`, capped by the lag leash). This normalizes hard L-shaped cursor moves into smoother diagonal camera intent — e.g. a cursor that moves right then down no longer makes the camera visibly chase right then drop. The spring gives the cinematic lag + settle (the camera trails the cursor and eases in, never sticking to the pointer). A **lag leash** caps the trailing/leading distance at `clamp(viewportHalf·0.65, 0.12, 0.28)` of the frame (snap back + bleed velocity) so a fast flick never drags the cursor out of the window; **edge-snap** (`0.25`) pins the view to a frame edge near the cursor (and keeps the visible window inside the artboard, so no separate centre clamp); a **null** cursor sample holds the previous target. The smoothed focus is baked into `8 ms` keyframes and `sampleZoomCameraAtTime` lerps between them, so it stays pure/deterministic for export and arbitrary seeking.
  - **Settled state is time-varying.** The held branch reads the follow focus at `t`; ease-out anchors on the **final** held frame (glides out from where it settled, not a snap back); welds blend clip A's final follow focus → clip B's initial focus. Ease-in anchors on **where the follow begins** (the spring's seed = the cursor at the clip start — or the first on-screen sample if the cursor is off-screen exactly there — edge-snapped), so the zoom-in lands exactly where the follow takes over. The seed falls back to screen **centre**, never the clip's stored `focus` (in auto mode that focus may be a leftover from manual editing, so seeding from it would start / drift the follow at a stale point).
  - **Export parity.** The cursor position is the same `mapCursorSampleToArtboard` hotspot the overlay renders (`sampleCursorArtboardFocus` in `cursor-scene.ts`). The editor precomputes paths off the hot path (a `useCallback` rebuilt when clips / cursor track / artboard / **cursor state** change, stored in `followPathsRef`, re-run after the async cursor-track load) from `CursorController.getArtboardFocusAt(time)`. Because that sampler reads the controller's `state` (screenVideo / source mapping), the rebuild **must run after the state is applied** — it is therefore also invoked from the cursor-state effect (after `setState`), not only the clips/artboard effect, so a post-refresh `auto` clip doesn't bake a static seed path before the state lands. The cursor sidecar remains loaded when custom cursor rendering is disabled; the preview hides the sprite while still rebuilding follow paths from the metadata. Pixi `Application.init()` is also async, so `getCursorData()` can finish before `CursorController` exists; immediately after the controller is created, `pixi-canvas.tsx` rebuilds follow paths and reapplies the current camera so project-open auto clips do not wait for a later Zoom edit (Regenerate or Auto/Manual toggle) to start following. The exporter builds a frame-quantized `CursorFocusSampler` over the frame plan and calls `computeZoomFollowPaths` **once** before the render loop — same engine, same mapping — so **preview, hover, and export follow identically**. No follow when the cursor sidecar is missing / corrupt, the hotspot is off-video, or the time is outside every screen clip (the sampler returns `null`), nor on identity frames.
  - **Follow motion blur (directional).** The follow pan (scale held) gets a **directional** motion blur — a smear along the travel direction — not the radial zoom-blur (which is for scale changes). `panBlurFor` in `zoom-scene.ts` derives a signed smear vector (a resolution-independent fraction of the artboard) from the spring-smoothed focus velocity via a central difference, scaled by the zoom depth (`scale − 1`) and a fixed shutter — so the blur grows with the follow speed and falls to zero when the camera settles. It rides on the `ZoomCamera.panBlurX/panBlurY` fields and is mapped onto a Pixi `MotionBlurFilter` by the shared `pixi/zoom-pan-blur.ts` module (the directional mirror of `pixi/zoom-blur.ts`), attached by both the editor scene and the export stage, with the filter-input size = artboard × viewport scale (preview) / output size (export) — so the smear is the same proportion of the frame in **preview and export** (export parity). It is **follow-only**: zoom ease-in/out and continuous-zoom welds keep their radial blur and set `panBlur = 0`. Tuning constants (`ZOOM_PAN_BLUR_*`) live in `zoom-scene.ts`; default is **subtle** (gain `0.3`, capped at `0.14` of the artboard).
    - **Cursor stays crisp under the pan blur.** The blur wraps a new `zoomedContent` container (bg + grid + video nodes) but **not** the cursor: the cursor moved into its own `cursorCamera` (mirrors the content camera's zoom transform + an artboard-rect mask) that sits beside `zoomedContent` inside `composite`. So the cursor is excluded from the directional pan blur (it keeps only its own velocity blur from `cursor-sprite.ts`) while still sharing the **radial** zoom blur, which stays on the whole `composite`. The export stage (`build-stage.ts`) mirrors this exact split (`zoomedContent` + `cursorCamera` + `cursorMask`) so preview and export composite identically; the snapshot path neutralizes both filters and resets all three cameras.
    - **No edge halo under the pan blur.** The directional `MotionBlurFilter` samples symmetrically `±velocity` with premultiplied-alpha disabled, so at the artboard edges it averages the opaque frame against the transparent region just outside it — the composite's **alpha falls off in a ring at the edges and smears outward**. Because the Pixi canvas is transparent (`backgroundAlpha: 0`) over the white "paper" DOM backdrop, that ring used to reveal a **white halo** during cursor-follow reframes (and the opaque-black clear in export). Two pieces fix it, shared by preview (`scene.ts`) and export (`build-stage.ts`): (1) a **`backingCamera`** — an unfiltered, zoom-mirrored copy of the background fill/wallpaper drawn **behind** the clipped `composite`, so the fade ring shows the same background instead of the backdrop; and (2) a **`clip`** container whose artboard-rect mask wraps the filtered `composite`, clipping the outward smear so it can't escape onto the workspace. The per-camera masks still clip content *before* the blur; the `clip` mask clips the filtered result *after* it. The backing is empty when `backgroundEnabled` is false (the white paper is the intended surface there, so the ring is white-on-white — no artifact). The **radial** zoom blur samples one-sidedly toward the focus (inward), so it never reaches past the outer edge and never produced this halo — only the pan blur did.
  - **Tuning** lives in `pixi/zoom-spring.ts` (spring constants, lag leash, edge-snap, `8 ms` sampling) and `ZOOM_FOLLOW_DEFAULTS` in `zoom-scene.ts` (which re-exports them as overridable params). Values are ported verbatim from Cap. The follow applies to manual and auto-generated `auto` clips alike.
- The full clip span represents **normal → zoom → hold → normal**. Defaults are enabled, center focus `{ x: 0.5, y: 0.5 }`, mode `auto` (cursor-follow), `2.0x` scale, `50%` Strength, and transition `{ durationMs: 1000 }` (Cap's `ZOOM_DURATION`). **The amount ramp is a mass-spring-damper** (`springEase` / `springEaseOut` in `pixi/zoom-spring.ts`, port of Cap's `spring_ease`) fit into the `durationMs` window — the persisted `transition.curve` field is now **vestigial** (kept for legacy file tolerance; the renderer always uses the spring). The Pixi-style zoom-blur look is baked (`ZOOM_RADIAL_BLUR_SHADER.strength = 1`, inner radius is `2%`, outer radius is infinite, `maxKernelSize = 32`) and shared by preview and export. Scale clamps to `1x-4x`, Strength clamps to `0-100%`, Duration clamps to `150-2000 ms`, and focus stays normalized to the full artboard. Legacy `easeIn`/`easeOut`/`speed`/`curve`/`easePreset` remain parsed for old projects, but the current editor exposes only mode, scale, Strength, and Duration.
- Selecting a Zoom clip opens the top-level **Zoom** sidebar tab via `SidebarSelectionBridge`. The tab shows an **Auto/Manual mode toggle**, an unzoomed clip-start focus preview with a draggable focus point (the manual fixed-point picker — **disabled in `auto` mode**, where the focus is cursor-driven), the visible zoom window rectangle, an enabled switch, scale, **Strength** (`radialBlur`), and **Duration** (`transition.durationMs`) controls. The ease curve and blur look are baked (the amount ramp is the spring), so the old 4-way curve picker, ease-fraction slider, and full per-clip blur-filter panel stay removed. Dragging the focus point writes the raw normalized anchor anywhere in the artboard, including edges/corners; the visible-window rectangle is derived from that fixed anchor and current scale, so it stays inside the artboard while the point remains the zoom origin. The radial zoom blur origin uses the same anchor as the zoom camera, so an edge target produces blur centered on that edge subject instead of streaking toward the middle of the visible window. The preview frame is a **snapshot of the composed scene**, not raw video: each time a Zoom clip is selected, `useSceneSnapshotUrl` calls `captureSceneSnapshot` (`src/components/editor/canvas/scene-snapshot.ts` — a module-level bridge `PixiCanvas` registers/unregisters on mount; deliberately not provider context), which invokes `CanvasScene.captureCompositeSnapshot`: a synchronous `renderer.extract.canvas` of the artboard composite (background fill, video nodes with corners/border/shadow, cursor overlay) at a capped width (`ZOOM_PREVIEW_SNAPSHOT_WIDTH` 1280, never upscaled past the artboard). During the extract the zoom-clip camera and radial blur are neutralized and the pixel grid hidden, all restored before returning — so the snapshot is the **unzoomed** scene with no editor chrome, and nothing flashes on screen (extract renders offscreen). This means any appearance change (border, padding, background…) shows in the preview automatically. The canvas becomes a temp PNG object URL (`<img>` covering the box; revoked on replacement/unmount). Video content reflects the **current playhead frame**, not the clip start — the accepted trade-off of snapshotting the live scene instead of an offscreen clip-start render. Choosing or dragging a focus point does **not** move the main playhead and triggers no re-snapshot.
- Zoom clips also honor the paused **Hover preview** path. `pixi-canvas.tsx` subscribes to `subscribeHoverTime` and samples the manual Zoom camera at the hovered composition time while hover preview is active, then falls back to the committed playhead when the hover channel emits `null`. The provider resolves media frames through the active timeline clip for that video id, so split/trimmed clips preview the segment under the ruler instead of whichever clip was last in the array. This keeps the video frame, cursor overlay, zoom camera, and radial blur synchronized during secondary seek without writing `timelineTime`.
- **Radial zoom blur** is a shared custom postprocess (`src/lib/motion-blur/radial-zoom-blur.ts`) used by editor preview and export, not a Konva filter. `sampleZoomCameraAtTime` weights the `radialBlur`/Strength amount by the **on-screen zoom velocity** — `motion = clamp((scaleVelocity / scale) · ZOOM_BLUR_MOTION_GAIN)` — so blur tracks how fast the magnification is changing. Velocity is a single smooth bump that is ~0 at the ease boundaries (blur ramps on/off seamlessly) and peaks mid-transition; for a fixed Duration, a larger target scale such as `4x` produces higher velocity than `2x`, so the blur grows naturally with the distance covered in the same time. Hold frames have zero velocity and stay sharp. The shader ports Pixi `ZoomBlurFilter`: 32 one-sided samples from the current pixel toward `ZoomCamera.radialBlurCenterX/Y`, randomized lookup phase, parabolic sample weights, baked 2% inner-radius feathering, and `radius = -1` (infinite outer radius). This avoids the doubled text edges produced by the older symmetric shutter blur. The preview blurs only the artboard region (cropped from the layer canvases), so its texture matches the exporter's artboard-sized canvas exactly. If WebGL2 is unavailable, `createRadialZoomBlurRenderer()` returns `null` and the camera still renders sharply.
- **Add by hover + click.** Hovering anywhere over the zoom lane shows a translucent dashed **ghost clip** (`ZoomGhost`) that adapts its internal UI to the rendered width: full `+ Add Zoom` when there is room, icon-only for medium gaps, and a plain dashed marker for hairline gaps where a fixed-size icon would read as overlap. The hovered seek is the committed start; `placeZoomSpan` resolves the actual non-overlapping placement by rejecting clicks inside an existing clip and shrinking the right edge before the next clip or timeline end when needed. If the right-side room is below `MIN_ZOOM_CLIP_SECONDS`, the ghost is hidden and click does nothing. A single click commits that exact preview (`addZoomClip`); the existing resize handles adjust it afterward. The added size is a **fixed on-screen pixel width** (`DEFAULT_ZOOM_CLIP_PIXELS`, 120 px) — responsive to zoom rather than a fixed number of seconds: it is converted to seconds at the current `scaleWidth`/`scale`, so the chip is always the same size on screen while the duration it represents scales with the timeline zoom. It is floored at `MIN_ZOOM_CLIP_SECONDS` (`0.5` s — see "Tiny Zoom Clips" under Problems for why this floor is interaction-sized, not frame-sized). Placement is **magnetized** (`ZOOM_ADD_SNAP_PIXELS`, 8 px converted to seconds at the current zoom and passed as `placeZoomSpan`'s `snapSeconds`): an anchor within that distance after the previous clip's end (or `0`) snaps flush back to it, and an end stopping within it of the next clip's start (or the timeline end) extends flush — so click-adds beside a neighbour land exactly adjacent instead of leaving a sub-minimum, forever-unfillable micro-gap. Snapped placements re-validate identically without snapping, so the snapless `addZoomClip` re-check always commits exactly the previewed span. The Zoom ghost is intentionally **independent from the secondary hover seek**: secondary hover preview stays paused-only, but the zoom-lane ghost still follows the pointer and can add clips while playback is running. "Add" is gated on ghost **visibility**, which is how spurious adds are avoided: the ghost is hidden over an existing clip and during any drag (and cleared on drag start), so a click on a clip or a drag-end click never adds. Hover/add are driven through the package's new `onRowHover` callback (the hover sibling of `onClickRow`, wired in `edit_row.tsx`). The ghost position is written imperatively from a subscriber so per-mousemove preview never re-renders the heavy `<Timeline>`; the only React state is the mount/unmount boolean. Very small spans render at exact subpixel width and drop fixed-size content when it cannot fit, so the marker does not visually overlap neighbouring clips. The overlay also clips itself to the visible timeline viewport because it is rendered as a sibling above the package timeline rather than inside the timeline's own overflow box. The `placeZoomSpan` math in `src/lib/zoom-clips.ts` is shared by the ghost preview and the `addZoomClip` commit so preview === committed.
- Performance: hover placement scans the current zoom clips linearly and does not sort or allocate lane structures on mousemove; restore-time normalization is the only sorted pass. Runtime camera sampling maps restored clips through defaults and finds the active clip by composition time. The current implementation is isolated and low-allocation; if the Zoom track grows beyond thousands of clips, replace the scan with an interval index without changing the provider/timeline/export contract.
- **Move / resize / settings / select / delete** mirror the video clips and reuse the package: move/resize commit through `moveZoomClip` / `resizeZoomClip`; settings patches flow through `updateZoomClip` and `sanitizeZoomClipPatch`. Overlaps are prevented in real time by **clamping, not rejecting**: `onActionMoving` / `onActionResizing` return an adjusted span from `clampZoomMove` / `clampZoomResize` (`src/lib/zoom-clips.ts`), so a drag that pushes into a neighbour, past the timeline bounds, or under the minimum duration slides flush against the obstacle and pins there. (The old `return false` model froze the clip at the last sampled valid pointer position, leaving an arbitrary gap that depended on drag speed.) The same helpers run again at commit (`moveZoomClip` / `resizeZoomClip` in the provider), so dragged preview === committed span, and a **weld pass** (`ZOOM_WELD_EPSILON_SECONDS`, 1 ms) erases pixel↔time float residue by setting near-adjacent edges exactly equal to the neighbour edge / `0` / `timelineDuration` — flush clips abut with a zero-second gap in `project.json`, never a float-approximate one. The gap bounds are computed once from the clip's committed span (`getZoomGapBounds`), so neighbours act as walls for the whole drag: a clip cannot jump over another clip. **Every clip with a positive span is a wall/obstacle** — placement and clamping deliberately do *not* gate obstacles on a duration floor, because a clip that drifted below the floor (float residue from a resize-to-minimum, legacy data) would otherwise be invisible to collision checks and silently overlapped (this was the overlapping-clips bug). A clip found *overlapping* the reference (legacy/corrupt state) is walled off on the side where most of it lies, so dragging resolves the overlap rather than preserving it. Restored/persisted zoom clips are also passed through `normalizeZoomClips` on hydration and undo/redo restore so older or hand-edited `project.json` files cannot reintroduce overlaps; its keep-threshold is `ZOOM_CLIP_DEGENERATE_SECONDS` (1/60 s), not the 0.5 s creation floor, so legacy short clips survive hydration, keep their real duration on move (`clampZoomMove` preserves duration), and grow to the creation floor the first time an edge is resized — capped by the gap so the growth can never cross a neighbour. Clicking a zoom clip selects it (`selectZoomClip`); a zoom clip and a video are **mutually exclusive** selections (each `select*` clears the other), because the right-panel inspector and canvas selection outline key off `selectedItemId`. Removal is `removeZoomClip`, reachable by Delete/Backspace on the selected clip (`editor-workspace`'s global keydown, in a branch above the video-selection block) — there is no on-clip remove button. All mutations are undoable (`zoom-add` / `zoom-move` / `zoom-resize` / `zoom-settings` / `zoom-remove` history tags flow through the normal autosave→history pipeline).
- **Narrow-chip behavior.** Committed zoom chips use the same content-density ladder as the hover ghost (`ZOOM_CHIP_LABEL_MIN_WIDTH` 76 px → icon + label + scale, `ZOOM_CHIP_ICON_MIN_WIDTH` 20 px → icon only, below → empty marker chip), driven by the rendered width computed in `renderAction` from the clip span × current zoom — so a fixed-size icon never bleeds past a narrow chip and reads as overlapping its neighbour. In the package, the resize handles adapt to the action width (`stretchHandleWidth` in `edit_action.tsx`: 10 px wide normally, shrinking to 4 px on narrow actions, and `0` below 16 px) so two fixed 10 px handles can no longer swallow a small chip whole and make it move-impossible; hairline actions are move-only — zoom the timeline in to resize them.
- **Vertical placement of the ghost** assumes the footer timeline does not scroll vertically (it is sized to show its handful of lanes): `rowTop` is computed from the ruler height + edit-area margin + `(rows.length - 1) * ROW_HEIGHT`, minus the tracked `scrollTop`. If a future change makes the lane stack tall enough to scroll vertically, the ghost band would need a measured row rect instead.

Playback sync behavior:

- **Autoplay on open.** Opening a project starts playback once, automatically, so the user does not have to press Play after every open / refresh / project switch. Hydration arms a session-only `autoplayPendingRef` when the opened project has playable media — fast path: `restoredClips.length > 0`; slow path (fresh recording): a screen or camera asset with valid dims will be added. The flag is **not** fired inline at hydration time (the video elements don't exist yet); instead the first timeline video element to finish loading consumes it inside `registerTimelineVideoElement` and calls `playTimeline()`, so playback begins from a decoded first frame rather than a blank canvas. It is gated on `timelineDurationRef.current > 0` and skipped when `document.hidden`. Both `playTimeline()` and `pauseTimeline()` clear the flag, so any explicit transport action a user takes before a slow-loading video registers wins (no surprise autoplay afterward), and additional elements registering later only sync to the live playing state instead of restarting. The flag is reset in the project-switch reset block and re-armed by the incoming project's hydration path. It is session-only — never persisted to `project.json` and not in undo history (like the playhead and `isTimelinePlaying`). Autoplay is **opt-out** via the Settings window's **"Autoplay on open"** switch (Editor section of `src/app/recording-settings/page.tsx`, default ON, app-level flag at `openscreen:autoplayOnOpen` in `localStorage` — helpers in `src/components/editor/canvas/autoplay-preference.ts`; moved out of the titlebar on 2026-06-07). The provider reads the flag **at fire time** inside `registerTimelineVideoElement`, not at arm time, so a toggle applies to the very next open with no change event or reload — even from the separate Settings `BrowserWindow`, since all windows share the same origin's `localStorage`; while OFF the armed flag simply never fires (and is cleared by the usual transport/reset paths).
- The committed playhead is the source of truth for media time and the transport readout.
- Timeline hover preview seeking is paused-only and uncommitted. Pointer movement over the ruler or tracks samples the active media frame, cursor overlay, and manual Zoom camera through `hoverPreviewTimeRef` / `subscribeHoverTime`, without changing the transport readout or writing `timelineTime`. Media preview intentionally follows the old Konva path: the provider resolves the active clip source time, seeks the registered `HTMLVideoElement`, and lets the canvas node's redraw callback paint that same live video element after the seeked frame is available. Per-element `HTMLVideoElement.currentTime` writes are coalesced and cancelled by any committed seek, playback start, or drag so hover never owns persisted timeline state.
- Scrubbing the ruler, clicking the time area, pressing skip controls, or dragging the playhead seeks every registered video element to the sampled source frame. Committed (paused) seeks are **coalesced to one in-flight seek per element**, mirroring the hover pipeline: while a seek is still decoding, further scrub moves do not issue a fresh `currentTime` write — they only advance `timelineTimeRef`, and the in-flight seek's completion handler reissues toward the latest playhead. This keeps every expensive long-GOP decode aimed at the newest target instead of thrashing the decoder with one write per pointermove (which previously left the preview lagging the cursor in visible steps). The in-flight target per element is tracked in `committedSeekStateRef`, with the same 250 ms safety-timeout repaint the hover path uses.
- When a committed seek lands, `onTimelineVideoSeeked` paints it via the canvas-video-node redraw callback and, if the playhead has since moved, reissues a single follow-up seek toward the live target. Every landed committed frame is a real position along the scrub path, so painting it keeps the preview moving in step with the drag while the reissue converges on the live playhead. The older match-gated path (`shouldDrawTimelineVideoFrame`) still runs as the fallback for entry-less `seeked` events — playback redraws and genuinely stray seeks — so stale playback frames are still suppressed.
- The Pixi `VideoController` drives its `seeked` redraw through `requestVideoFrameCallback` when available, so the video sprite is composited in lockstep with the seeked frame actually being presented rather than a tick early (which could otherwise flash the pre-seek frame during a fast scrub). It falls back to an immediate `scene.renderNodeNow(id)` only where rVFC is unavailable.
- **Frame stepping.** `stepTimelineFrame(±1)` advances the playhead by exactly one source frame (pausing playback first if running). It snaps the current time to the frame grid of the clip under the playhead before stepping, so repeated steps stay on frame boundaries even after a free scrub. Bound to `,` / `.` in `editor-workspace`'s global keydown (skipped while typing in an input, and not triggered with zoom/Shift modifiers) and to the two inner transport chevrons. Frame duration is `1 / fps`, where fps is the per-clip measured source rate or `DEFAULT_TIMELINE_FPS` (60, the recorder default) until a clip has played.
- **Source fps is session-only and measured lazily.** `CanvasVideoNode` samples `requestVideoFrameCallback` metadata (`mediaTime` / `presentedFrames`) during playback, derives a median rate, snaps it to a common rate within 5 %, and reports it once via `registerTimelineVideoFps`. The provider holds it in `videoFpsRef` (a `Map<videoId, number>`). It is **not** persisted to `project.json`, not part of undo history, and is cleared on project switch and element unregister — it only refines frame-step granularity for non-60 fps (typically imported) clips. Before a clip's first playback, stepping uses the 60 fps default.
- During playback the active clip whose range covers the playhead acts as the master clock: the controller reads its native `currentTime` and projects the timeline time from `clip.start + (element.currentTime - clip.sourceIn)`. The primary audio video is preferred; otherwise any visible clip works. This keeps the cursor lockstep with the frames being painted and prevents the rAF/decoder tug-of-war that used to manifest as frames jumping back and forth. The rAF estimate is only used when no master is available, or as a safety bound when the master jumps wildly (e.g., after tab-visibility gaps).
- The master video is never seeked during natural playback; the controller only ensures it is playing. Secondary visible videos play at their native rate and are only re-aligned when drift grows past `TIMELINE_PLAYBACK_DRIFT_SECONDS` (250 ms). Clips that just became active are precisely seeked into place on the same frame they become visible.
- When the playhead is before a clip starts or after it ends, the canvas hides that clip's media node and disables its hit testing.
- When the playhead lands on the very end of the timeline, the longest clip(s) stay visible and sample `sourceOut - 1 ms` so the canvas holds their last frame instead of going blank. Clips that end earlier in the timeline still hide at their own boundary; the hold only applies to clips whose `end` is within `TIMELINE_END_HOLD_EPSILON_SECONDS` of `timelineDuration`.
- A hidden inactive clip remains in editor state and in the timeline; scrub back into the clip range to show and edit the canvas node again.
- Mute is owned by the provider/video-controller bridge from `primaryAudioVideoId`, so there is one source of truth for the audible track.
- Video frame redraws still target the Pixi video node/content path only, so timeline playback does not repaint unrelated editor chrome through React.

Hover preview behavior:

- Hover-preview seek is **paused-only**. While the timeline is playing, `onTimeAreaHover` calls into `updateHoverPreviewTime` are dropped silently; the ghost cursor is not mounted; playback continues uninterrupted.
- The `@openscreen/timeline` package fires `onTimeAreaHover(time | null)` from an `onMouseMove`/`onMouseLeave` pair on the **timeline root** (`timeline.tsx`), so hovering anywhere over the component — the ruler **or** the tracks/lanes — previews that frame. (The `TimeArea` ruler overlay only owns click-to-seek now; centralizing on the root means crossing the ruler↔tracks boundary never emits a spurious `null` that would flicker the ghost.) Pointer-x is converted to time with the same `parserPixelToTime` + `maxCursorTime` clamp the ruler click uses, reading `scrollLeft` live from the `ScrollSync` instance. The package suppresses these events while the main playhead is being dragged (`draggingCursorRef`, shared with the `Cursor`) **or** while a clip is being moved/resized or a row reordered (`draggingActionRef`, set by `EditArea` on action/row drag start and cleared on end, which also drops any active hover on drag start), so no interaction ever produces a competing hover stream.
- The same hover time drives output-effect preview. `editor-workspace.tsx` keeps the current hover time in a ref and samples the manual Zoom camera from it, so hovering over a Zoom clip shows the zoom and radial blur at that uncommitted composition time. Seek-completion redraws also refresh the radial blur overlay after the video frame lands, so a paused hover does not leave a stale blurred composite. When hover ends, the provider emits `null`, the workspace resamples at the committed playhead, and no project/persistence state changes.
- The provider keeps the live hover position in `hoverPreviewTimeRef` (no React state per mouse move) and exposes `subscribeHoverTime` for the ghost cursor, **canvas cursor overlay**, and manual Zoom camera to follow (all placed/sampled imperatively, no React state on the hover hot path). Timeline media resolution is clip-at-time aware (`videoId -> clips[] -> active clip`) so a split source video does not disappear or seek against the wrong segment during ruler hover. The only mounted-vs-unmounted decision is the `isHoverPreviewActive` boolean.
- Hover seeks are coalesced via `requestAnimationFrame` and dispatched at most one in-flight per video element. Each in-flight write records its target source time in `hoverSeekStateRef`; the canvas-video-node hands every `seeked` event back to the provider, which paints the landed video-element frame and then reissues toward the latest hover target if the pointer moved. In Pixi, the duck-typed node handle maps Konva's `layer.draw()` redraw contract to `scene.renderNodeNow(id)`, so the live `VideoSource` texture is uploaded when the browser has a decoded frame and then rendered immediately.
- Every committed write (`syncTimelineMedia`) calls `cancelInFlightHoverSeeks()` first, so `setTimelineTime`, `pauseTimeline`, `playTimeline`'s end-of-tick pause, clip move/resize, and duration clamp all kill the hover pipeline before they issue committed seeks. Hover never writes committed state — the coupling is strictly one-way.
- A 250 ms per-entry safety timeout guards against rare browser coalescing where a new `currentTime` write lands on the same decoded frame and no `seeked` ever fires.
- A `document.visibilitychange = hidden` listener tears down all hover state so a tab-away mid-hover can't deliver stale `seeked` frames after the user returns.
- Hover leave (pointer exits the timeline, the user clicks, the user presses play, or the user starts a cursor or clip drag) calls `syncTimelineMedia(timelineTime, …)` which snaps every visible video back to the committed frame within a single seek.

Performance notes:

- Timeline playback uses refs, media elements, and imperative subscribers for hot-path sync.
- React state for the public playhead value is committed on a short interval (`TIMELINE_STATE_COMMIT_INTERVAL_MS`, 80 ms) during both playback **and** scrubbing, not on every decoded video frame or pointermove. The playhead itself stays smooth because the tick subscribers move the cursor imperatively on every update; only the React mirror (the transport readout and disabled-state) is throttled. Discrete transitions (play, pause, duration clamp) commit immediately via `commitTimelineTimeState`; scrub moves use the trailing-edge `scheduleTimelineTimeState`.
- Timeline visibility is derived from the active clip set. The controller only toggles the registered media node handle on ids whose active state changed, and media sync applies playback work to the active set plus newly inactive ids.
- The active clip-set scan is cached by the nearest timeline clip boundary, so playback does not loop across every clip on every animation frame. A full scan happens after clip/video changes, node registration, or crossing the next clip start/end boundary.
- Hover preview and committed scrubbing share the same visibility cache and seek primitives (`safeSeekElement`, `getSeekableTimelineSourceTime`, `resolveTimelineFrame`, `syncTimelineVisibility`) and both coalesce to a single in-flight seek per element. Both paint landed `HTMLVideoElement` frames through the same canvas node redraw callback; there is no secondary editor hover decoder, proxy texture, or preview frame cache.
- Pixi keeps the Konva redraw contract by registering a duck-typed node whose `getLayer().batchDraw()` calls `scene.renderNodeNow(id)`. Paint uses `HTMLVideoElement.readyState >= 2` only as a `VideoSource.update()` upload guard. Once a video node has uploaded one frame, the sprite stays renderable while timeline-visible, so fast hover seeks hold the last good frame instead of flickering blank while the decoder is between frames. This matches the old `CanvasVideoNode` behavior where an rVFC callback called `layer.draw()` after a seeked video frame was available.
- The implementation keeps the existing constant Pixi container/layer count and does not add DOM overlays per canvas node.

## Cursor Overlay

A themed SVG cursor drawn on top of the screen recording, driven by the cursor metadata the mac-addon captured into the recording's input sidecars (`mousemoves-0.json`, `mouseclicks-0.json`, + the `input` manifest entry). It replaces the OS cursor baked into the video with a crisp, restylable, hotspot-accurate pointer (Screen Studio-style). See `docs/screen-recording-addon.md` → Input capture for the capture side.

Files:

- `src/lib/cursors/cursor-manifest.ts` — **generated** by `scripts/generate-cursor-manifest.mjs`. A typed index of every cursor SVG (24 sets, 159 set SVGs) with its hotspot (0..1 fraction, parsed from the `<asset>-<variant>__<hotXpct>-<hotYpct>.svg` filename), intrinsic size, rendered alpha bounds, and per-asset optical scale. Re-run `pnpm generate:cursors` after adding/replacing assets in `public/assets/cursors/`; the generator measures alpha bounds with `sips` on macOS and falls back to the full SVG box if measuring is unavailable.
- `src/lib/cursors/cursor-set.ts` — maps a captured `cursorId` (NSCursor name) → themed asset via `NS_NAME_TO_ASSET` (mirrors Screen Studio's `macos/index.ts`), with fallback to the base set for incomplete custom sets. Helpers: `resolveCursorAsset`, `cursorDrawOrigin`, `cursorRenderSize`.
- `src/lib/cursors/cursor-track.ts` — pure processing: `rawSamplesFromMoves` + `clickEventsFromClicks` → `buildSmoothedTrack` (a deterministic zero-phase smoothing pass over a fixed 120 Hz track) → `sampleCursorAtTime`. Deterministic so playback, backward scrub, and export all agree; zero-phase means it smooths the recorded path without adding an explicit timeline delay.
- `src/components/editor/canvas/cursor-scene.ts` — **the single source of truth for cursor placement**, shared by the live editor and the exporter (same role `video-scene-draw.ts` plays for video appearance). Owns the render constants (`CURSOR_SET_DEFAULT` / `CURSOR_SET`, `CURSOR_POINTER_CURSOR_ID`, `CURSOR_BOX_HEIGHT_POINTS`, `CURSOR_SCALE`, `CURSOR_SMOOTHING_MODES`, `CURSOR_MOTION_ROTATION_*`), `buildCursorTrack` (raw IPC data → track, applying the selected smoothing mode), `placeCursor` (pure: sample + selected cursor set + optional pointer override + display→artboard mapping + click press scale + side-lean amount → `{ url, size, offset, position, rotation, motionRotationDeg, onScreen }`), `computeCursorBlur`, and `projectFolderFromObjectUrl`. Because the cursor is part of the output video, the editor preview and the encoded frame call the _same_ cursor-scene helpers, so they stay pixel-identical.
- `src/components/editor/canvas/canvas-cursor-overlay.tsx` — `CanvasCursorOverlay`, one `Konva.Image` inside the artboard clip group, above the videos. Imperatively applies `placeCursor` on every playhead tick **and on every timeline hover-scrub tick** (hover anywhere over the ruler or tracks), so the cursor tracks the previewed frame exactly like the video does.
- `public/assets/cursors/` — the SVG/PNG assets extracted from Screen Studio (166 files total; 159 SVGs in the selectable sets `macos`, `macos-tahoe`, `touch`, `halloween`, `custom-1..20`). Default render set is `macos`.

Data flow:

- `projects:getCursorData(folder)` (read-only IPC, `electron/ipc/projects.ts`) reads the recording's `mousemoves-0.json`, optional `mouseclicks-0.json`, and the `input` output's `session.processTimeStartMs` / `displayBoundsPoints`, then returns `CursorTrackData`. If a legacy sidecar is already recording-relative, IPC uses a `0` process-time start instead of subtracting a huge host timestamp, so move and click events are not filtered away as negative. The overlay resolves `folder` from **`project.path`** (the project provider's loaded summary); `projectFolderFromObjectUrl(screenVideo.objectUrl)` is kept only as a fallback for sessions without a project record.
- **Validation + diagnostics in `loadCursorTrackData`**: every null-return path `console.warn`s a reason on main-process stdout (`no recording.json`, `unreadable recording.json`, `manifest names no mousemoves file`, `mousemoves sidecar unreadable/corrupt`, `mousemoves sidecar is empty`, `invalid displayBoundsPoints`) — except the no-`input`-entry case, which is normal for recordings made before input capture existed. `displayBoundsPoints` must be finite and > 0 (a 0×0 display would silently break all placement math downstream), and a non-finite manifest clock anchor is warned before being coerced to 0.
- **"Cursor data unavailable" notice (session-only)**: the canvas's cursor-track effect reports `track === null` to the provider (`reportCursorTrackUnavailable`), which stores a session-only `cursorTrackUnavailable` flag in a dedicated context slice (`useEditorCanvasCursorData()`, modeled on the save-status slice so it never re-renders hot canvas paths; reset on project switch and deliberately **not persisted**). The Cursor panel renders an inline destructive-tinted notice under its header when the flag is set while a screen recording exists and custom rendering is on: the cursor won't appear in the preview or the export. Early-bail cases (no screen recording, custom rendering off) report `false` — the notice is inapplicable, not "unavailable".
- On load it builds the smoothed track once for the selected smoothing mode; on every playhead tick (`subscribeTimelineTicks`) it samples by **source time** and places the cursor imperatively with the persisted cursor set. Changing smoothing mode rebuilds the track from cached `CursorTrackData` off the frame loop; changing cursor style only re-resolves the SVG for the existing single Konva image. Both changes re-place at the current committed playhead.
- **Timeline hover-scrub preview** ([Hover preview](#timeline) below): the overlay also subscribes to `subscribeHoverTime`. While a hover preview is active the video frame seeks to the hovered (uncommitted) time; the cursor follows it by sampling through the active screen clip at the same hover time, so split clips map to the correct recording source time. On hover-end the channel emits `null` and the overlay restores the cursor to the committed playhead. The Pixi cursor controller re-places when cursor state or the loaded cursor track arrives, so an enabled cursor renders on initial load without waiting for a later video interaction.
- `place()` hides the node when no track is loaded yet (or when the screen video has no resolvable `objectUrl`, so the track fetch bails). Without this guard the node keeps its last bitmap and draws at the image's natural size at `(0, 0)` — a static, oversized cursor stranded on the canvas if the recording's URL ever fails to resolve.
- **In export** (`src/components/editor/export/`): the cursor is part of the output video, so the export pipeline composes it too when custom cursor rendering is enabled. `build-stage.ts` → `buildCursorOverlay` first honors `state.artboard.cursorCustomRenderingEnabled`; if it is false, no cursor node or sidecar load is created. Otherwise it resolves the project folder from `ExportStartPayload.projectPath` (preferred; the URL-derivation fallback covers payloads that predate the field), fetches the same `getCursorData`, builds the track via `buildCursorTrack` using `state.artboard.cursorSmoothingMode`, clamps `state.artboard.cursorSetId`, pre-decodes every distinct cursor SVG the track references from that selected set (or only that set's pointer SVG when the pointer override is enabled), and adds one cursor `Konva.Image` on top of the video nodes in the content layer (matching the editor's z-order). `run-export.ts`'s frame loop calls `placeCursor` with the screen clip's `sourceTimeSec` and selected cursor set / pointer override / click press / side-lean amount straight from the frame plan — so the cursor honors trims/splits and only shows while the screen clip is active — then swaps `node.image(...)` to the matching pre-decoded SVG (or the selected CPU/GPU sprite-blur renderer's padded canvas when motion blur is active), so the exported cursor style, shape override, path, click press, rotation behavior, and smear match the preview (see [Cursor Motion Rotation](#cursor-motion-rotation) and [Cursor Motion Blur](#cursor-motion-blur)). Disabled custom rendering, no screen recording, no cursor sidecar, or an unresolvable folder ⇒ `cursor` is null and export proceeds **silently** without it (accepted behavior; the editor-side cursor panel notice is the user-visible signal that cursor data is unavailable before they export).

Time + coordinate mapping (the precise part):

- **Time**: timeline seconds → screen recording source seconds via the screen clip (`t − clip.start + clip.sourceIn`), ×1000 = recording-relative ms = the cursor track's time base (= `processTimeMs − session.processTimeStartMs` for current sidecars, or raw `processTimeMs` for legacy sidecars that were already relative). `session.processTimeStartMs` is anchored to the screen video's **first-frame** host time (not stream start), so cursor source time 0 lines up with video source time 0 — without this the cursor lags the video by ScreenCaptureKit's ~100–200 ms startup delay. Sampling by source time makes trims/offsets free. **Outside the captured sample range the cursor is held, not hidden**: `sampleCursorAtTime` clamps the query time into `[firstSample, lastSample]` and returns the boundary position. The leading/trailing gaps are stationary periods (event capture emits nothing while the mouse doesn't move), so holding the nearest known position is exactly correct. The mac-addon also bookends the recorded stream with start/end samples (see `docs/screen-recording-addon.md` → Boundary bookends), so freshly recorded tracks already span the full session; the renderer-side hold additionally covers older recordings that lack those bookends. The only hide path is the off-crop test below.
- **Position**: display-relative logical point → display fraction (`x / displayWidth`) → source pixel (`× intrinsicWidth`) → cover-crop (`getVideoCoverCrop`) → node-local px → rotate by the node rotation and offset by the node `(x, y)` → artboard coords. Off-crop points hide the cursor.
- **Hotspot**: the cursor SVG is placed via Konva `offset = hotspot × renderSize`, so the hotspot pixel lands exactly on the artboard point and rotation/scale pivot on it.
- **Rotation**: base cursor rotation matches the screen-video rotation, then `placeCursor` adds the optional velocity-derived motion rotation. The hotspot position and offset do not change when the lean changes; only the existing cursor node's `rotation` changes around that hotspot.
- **Size**: `CURSOR_BOX_HEIGHT_POINTS × CURSOR_SCALE × sizeMultiplier × asset.opticalScale × referenceScale × clickScale`. `referenceScale` converts captured display points into artboard/output pixels from a stable artboard-sized reference frame, so the default/min/max look matches the fitted screen-video baseline, but resizing the screen video later changes only the mapped cursor path, not the cursor sprite size. `asset.opticalScale` is derived from rendered alpha bounds against the `macos` asset for the same cursor shape, so changing cursor style does not make visually larger SVG sets jump in canvas size while the user's size setting remains unchanged. Cosmetic only (position/hotspot/timing are exact — the hotspot offset is `hotspot × renderSize`, so it scales with the final box and the pointer stays pinned). The base constants live in `cursor-scene.ts` (shared by the editor and exporter, so both move together). `sizeMultiplier` is the **user-adjustable cursor size** — see [Cursor Size](#cursor-size) below.

Performance posture:

- One constant, non-listening Konva image node and no extra layer (rides the content layer's `batchDraw`). Scales to the 5000-node stress case trivially.
- No per-frame React state: position/size/offset/visibility are imperative; only the cursor _bitmap_ is React state and changes only when the cursor _shape_ changes. The smoothed track is precomputed once per screen recording or smoothing-mode change, so per-tick work is one binary search + constant math.
- Cursor SVGs are cached in a module-level `Map` shared across mounts.

This state is **session-only / derived** — the cursor track, including click events, is loaded from the recording sidecars on demand and is never written to `project.json` (see Project Persistence). The cursor _custom rendering switch_ ([Custom Cursor Rendering](#custom-cursor-rendering)), _style_ ([Cursor Style](#cursor-style)), _pointer override_ ([Cursor Pointer Override](#cursor-pointer-override)), _smoothing mode_ ([Cursor Smoothing](#cursor-smoothing)), _click press scale_ ([Cursor Click Press](#cursor-click-press)), _size_ ([Cursor Size](#cursor-size)), _motion rotation_ ([Cursor Motion Rotation](#cursor-motion-rotation)), _motion blur_ intensity, and _motion blur backend_ ([Cursor Motion Blur](#cursor-motion-blur)) are persisted per-project settings.

### Custom Cursor Rendering

The sidebar **Cursor** tab header has a right-aligned switch, matching the Background tab header switch. It controls whether the custom cursor overlay is rendered at all. The **Click downscale**, **Smoothing**, **Side lean**, and **Motion blur** controls render a one-line muted helper description under their labels (same pattern as the Background panel sliders); the description dims together with the control when it is disabled. The **Always use pointer** switch, the **Stabilize cursor type** switch, the **Cursor style** picker, and the **Size** slider intentionally have no description.

- **Project-level state** on `EditorArtboard.cursorCustomRenderingEnabled`. Persisted; mutated via `setCursorCustomRenderingEnabled` (history tag `cursor-custom-rendering`). Optional on disk and defaults to `true`, so old projects keep their current custom cursor rendering after a refresh.
- **Preview path**: when disabled, `CanvasCursorOverlay` returns no `Konva.Image`, clears the cached track fetch path, and hides any previous node during the toggle. No layer count changes are introduced; the cursor still uses at most one non-listening Konva image when enabled.
- **Export parity**: `build-stage.ts` returns `cursor: null` before loading sidecars when `cursorCustomRenderingEnabled === false`, so the MP4 omits the custom cursor overlay exactly like the editor preview. The other cursor settings remain persisted and are used again when the switch is turned back on.

### Cursor Style

The sidebar **Cursor** tab exposes a **Cursor style** picker backed by the bundled cursor sets already in `public/assets/cursors/sets`. It mirrors the Background tab's Wallpaper grid: 5 Squircle square tiles per row, two rows visible while collapsed, a bottom fade over hidden rows, and a ghost chevron button that expands only when more rows exist. Every tile previews that set's pointer/arrow asset in the same fixed preview box and applies the same generated optical scale used by the canvas, so oversized SVG artwork does not dominate the picker.

- **Project-level state** on `EditorArtboard.cursorSetId`. Persisted; mutated via `setCursorSetId` (history tag `cursor-set`). Optional on disk and defaults to `macos`, which preserves the pre-picker cursor look for old and new projects. Unknown persisted values also clamp to `macos`.
- **Preview path**: `CanvasCursorOverlay` keeps the selected set in a ref read by the per-frame `place()` closure and passes it through `placeCursor` / `computeCursorBlur`. Changing style reuses the same single `Konva.Image`; it only changes which SVG URL is resolved/cached and which generated `opticalScale` is applied, so no nodes, layers, DOM overlays, per-frame React state, or hidden size-setting mutations are added.
- **Export parity**: `build-stage.ts` clamps `state.artboard.cursorSetId`, pre-decodes cursor SVGs from that selected set (or just that set's pointer when the pointer override is enabled), stores it on `ExportCursorHandle`, and `run-export.ts` passes it to `placeCursor` / `computeCursorBlur` every frame. The MP4 therefore uses the same selected cursor style and optical size normalization as the editor preview.
- **Scope**: the picker is built-in styles only. User-uploaded cursor assets are intentionally out of scope for this pass.

### Cursor Pointer Override

The sidebar **Cursor** tab exposes an **Always use pointer** switch. When enabled, every captured `cursorId` (`iBeam`, resize cursors, pointing hand, etc.) resolves through `placeCursor` as `CURSOR_POINTER_CURSOR_ID` (`"arrow"`, mapped to the themed pointer asset). Timing, smoothing, position, hotspot pinning, cursor size, click press, and motion blur still use the same sampled track; only the displayed cursor asset changes.

- **Project-level state** on `EditorArtboard.cursorAlwaysUsePointer`. Persisted; mutated via `setCursorAlwaysUsePointer` (history tag `cursor-always-use-pointer`). Optional on disk and defaults to `false` for old projects.
- **Preview path**: `CanvasCursorOverlay` keeps the flag in a ref read by the per-frame `place()` closure. Toggling the switch re-places the same single `Konva.Image` immediately; it does not add nodes, layers, DOM overlays, or per-frame React state.
- **Export parity**: `build-stage.ts` stores the flag on `ExportCursorHandle` and pre-decodes only the pointer asset when it is enabled. `run-export.ts` passes the same flag to `placeCursor` and `computeCursorBlur`, so the MP4 uses the same pointer-only rendering as the editor preview.

### Cursor Type Stabilization

The sidebar **Cursor** tab also exposes a **Stabilize cursor type** switch that suppresses brief cursor-SHAPE flicker — the macOS cursor type changing and reverting within a fraction of a second (e.g. an `iBeam` blip while brushing past a text field, or a `pointingHand` flicker crossing a link). Unlike **Always use pointer** (which forces every shape to the arrow), this keeps genuine shape changes and only drops the transient ones, so it is disabled while Always-use-pointer is on (then redundant).

- **How it works**: a **minimum-dwell debounce** applied at track-build time. `stabilizeCursorIds` (`src/lib/cursors/cursor-track.ts`) walks the captured `cursorId` runs and relabels any run shorter than `CURSOR_TYPE_STABILIZE_MS` (`150 ms`) to the previously committed shape, so a flicker collapses to the steady shape. Only the `cursorId` timeline changes — position, smoothing, hotspot, clicks, size, and blur are untouched. The final run persists to the recording end (kept), and a short leading run is kept as the initial shape.
- **Project-level state** on `EditorArtboard.cursorTypeStabilization`. Persisted; mutated via `setCursorTypeStabilization` (history tag `cursor-type-stabilization`). Optional on disk and **defaults to `false`** for old projects (opt-in, so existing recordings render unchanged).
- **Preview = export**: it is a `buildCursorTrack` option (sibling of `smoothingMode`), so both the editor (`pixi-canvas.tsx`, which rebuilds the track when the toggle changes) and the exporter (`build-stage.ts`) feed the same flag into the same pure debounce — the MP4 and the preview get the identical stabilized shape timeline.

### Cursor Smoothing

Screen-Studio-style cursor path smoothing, controlled from the sidebar **Cursor** tab with a compact `Button size="xs"`-referenced header-pill selector styled like the Background tab's Wallpaper / Color header (the pill selector is the shared `SelectionPills` in `src/components/editor/selection-pills.tsx`, also used by the Video panel's border Alignment). The selected pill uses the same Motion layout transition as the tab header. The modes are **Rapid**, **Quick**, **Default**, and **Slow**. All four mode buttons stay on one row with Reset. All four modes smooth; Rapid is the lightest, not a raw path. Default is the project default, and Slow applies the softest path.

- **No explicit delay is added.** The editor has the complete recorded cursor track, so `buildSmoothedTrack` runs a deterministic forward/backward zero-phase smoothing pass at 120 Hz. That removes jitter and softens turns without shifting the cursor later on the timeline. Slow can look more floaty because it rounds the path more, but the sampled time remains the screen clip's source time. The same preset also chooses the motion-rotation averaging window, so Rapid/Quick/Default/Slow progressively soften cursor rotation changes without adding a live chase-spring, and it sets the click press/release/overshoot timing (see [Cursor Click Press](#cursor-click-press)) so the click feel matches the path glide.
- **Project-level state** on `EditorArtboard.cursorSmoothingMode` (`"rapid" | "quick" | "default" | "slow"`). Persisted; mutated via `setCursorSmoothingMode` (history tag `cursor-smoothing`). Default **`"default"`** (`CURSOR_SMOOTHING_MODE_DEFAULT`); unknown persisted values clamp back to default.
- **Preview path**: `CanvasCursorOverlay` caches the raw `CursorTrackData` after the first IPC load. Switching modes rebuilds only the derived `SmoothedCursorTrack` from that cached data and re-places the one Konva cursor image at the committed playhead. No extra canvas nodes, DOM overlays, or per-frame React state are introduced.
- **Export parity**: `build-stage.ts` reads `state.artboard.cursorSmoothingMode` and builds the export cursor track with the same mode before frame rendering starts. `run-export.ts` still samples via shared `placeCursor`, so the exported cursor path matches the editor preview.

### Cursor Motion Rotation

Cursor motion rotation is **side lean only** (the direction-follow "rotation" mode was removed 2026-06-06 — `cursorForwardVector`, the direction constants, and the mode plumbing are gone). The sidebar **Cursor** tab exposes it as a plain **Side lean** section: one 0–100 % intensity slider + Reset, identical in layout to the Size / Click downscale / Motion blur sliders (the old None → Side lean → Rotation checkpoint slider with snap dots and under-rail labels was removed with the mode). New projects default to **35 %** (`CURSOR_MOTION_ROTATION_DEFAULT = 0.35`). The control writes only the persisted amount; it does not add another scene node or per-frame React state.

- **Side lean behavior**: `placeCursor` computes horizontal velocity over `CURSOR_MOTION_ROTATION_WINDOW_SEC = 0.08` second local-frame samples. Positive local X velocity (moving right) adds clockwise rotation; negative local X velocity (moving left) adds counter-clockwise rotation. Vertical-only movement produces near-zero lean. The velocity saturates at `CURSOR_MOTION_ROTATION_SATURATION_PX_PER_SEC = 900`, then clamps to `±10deg × cursorMotionRotation`.
- **Rotation behavior**: the same local-frame velocity computes the full 2D travel vector. `placeCursor` derives each cursor asset's forward direction from its rendered alpha bounds and hotspot, then rotates the sprite toward the movement direction with a bounded `±45deg × cursorMotionRotation` cap. Center-hotspot cursors (iBeam/crosshair-style shapes) have little or no direction-follow strength, so they do not spin awkwardly; pointer-like cursors rotate the most.
- **Rotation smoothing**: after the raw side-lean / direction target is derived, `placeCursor` averages multiple zero-phase samples around the current source time. The averaging window depends on `cursorSmoothingMode`: Rapid uses the shortest window and Slow uses the widest. This smooths sudden direction flips without per-frame state, timers, or React renders; scrub/export remain deterministic because both paths sample the same recorded future/past cursor data.
- **Hotspot accuracy**: the lean only changes the existing Konva image node's `rotation`. The sampled artboard position, render size, hotspot-derived offset, click scale, and cursor asset do not change, so the pointer tip stays pinned while the sprite tilts around it.
- **Project-level state** on `EditorArtboard.cursorMotionRotation` (0..1). Persisted; mutated via `setCursorMotionRotation` (history tag `cursor-motion-rotation`). Optional on disk and defaulted/clamped by `parseArtboard` so old projects load without a schema version bump. The legacy `cursorMotionRotationMode` field is still parsed tolerantly for v1 compatibility but ignored (old "rotation" projects render as side lean); new saves omit it.
- **Preview path**: `CanvasCursorOverlay` keeps the amount, mode, and smoothing preset in refs and passes them to `placeCursor` and `computeCursorBlur` from the imperative tick/hover path. Changing the checkpoint slider re-places the same single non-listening Konva image immediately; it does not add nodes, DOM overlays, layout reads, or per-frame React state.
- **Export parity**: `build-stage.ts` clamps `state.artboard.cursorMotionRotation` and `state.artboard.cursorMotionRotationMode` onto the export cursor handle and stores the already-clamped smoothing preset. `run-export.ts` passes all three to shared `placeCursor` / `computeCursorBlur` per frame. The exported cursor rotation and the preview cursor rotation are deterministic because both use the same zero-phase rotation smoothing math.

### Cursor Click Press

Recorded mouse clicks can gently press the cursor sprite down from the sidebar **Cursor** tab's **Click downscale** slider. The slider is expressed as a downscale percentage: larger values shrink the cursor further while the mouse button is down. This is part of the output video, not editor chrome.

- **Source**: `projects:getCursorData` reads `mouseclicks-0.json` when present and stores normalized down/up events on the derived cursor track. Missing click sidecars are valid; the cursor simply stays at scale `1`.
- **Curve**: the press is not linear. `placeCursor` uses a small ease-out press, then a damped release/rebound with a small overshoot. The hotspot remains pinned because the Konva offset scales with the sprite.
- **Timing follows the smoothing preset.** The press-in duration, release duration, and release overshoot come from a per-`cursorSmoothingMode` table (`CURSOR_CLICK_PRESS_PARAMS` in `cursor-scene.ts`), so the click feel matches the cursor's path glide — Rapid clicks crispest and Slow softest, the same Rapid→Slow personality as [Cursor Smoothing](#cursor-smoothing). `default` is pinned to the previously-shipped **70 ms** press / **220 ms** release / **0.09** overshoot so existing projects look identical; Rapid is `45 / 150 / 0.06`, Quick `58 / 185 / 0.075`, Slow `95 / 300 / 0.12`. Only the *timing* scales with the preset — the press **depth** stays the user's Click downscale slider.
- **Project-level state** on `EditorArtboard.cursorClickPressScale`. Persisted; mutated via `setCursorClickPressScale` (history tag `cursor-click-press-scale`). Default is `CURSOR_CLICK_PRESS_SCALE_DEFAULT = 0.78`, shown as **22 %** downscale in the UI. `1` means no shrink.
- **Export parity**: `build-stage.ts` stores `clickPressScale` on `ExportCursorHandle`, and `run-export.ts` passes it to shared `placeCursor` per frame; the smoothing preset is already threaded into `placeCursor` too, so the MP4 click press timing and depth both match preview.

### Cursor Size

User-adjustable render size for the recorded cursor, controlled from the sidebar **Cursor** tab (`src/components/editor/cursor-panel.tsx`, wired into `src/components/editor/sidebar.tsx`). It's a multiplier over the reference-frame base box: **`1` is the minimum** and **`CURSOR_SIZE_MAX` (4) is the max**; the slider presents it as a percentage (100 %–400 %). New projects (and legacy `project.json` files that predate the setting) open at **`CURSOR_SIZE_DEFAULT` (2.2 → 220 %)**, and the panel's Reset returns to that default. Bounds, default, and clamp all live in `cursor-scene.ts` (`CURSOR_SIZE_MIN/MAX/DEFAULT`, `clampCursorSize`) as the single source of truth.

- **Accuracy is preserved at every size.** Size scales the render box (`renderHeight`/`renderWidth`) only; `placeCursor` derives the Konva `offset` from `hotspot × renderSize`, so the hotspot pixel stays exactly on the recorded artboard point, and the source-time sampling is untouched — position and timing don't move when you resize. The cursor render size uses the stable `referenceSize` passed by preview/export, so it does **not** inherit later screen-video resize/scale; only the mapped position follows the resized video.
- **Style changes auto-normalize visually.** The persisted `cursorSizeMultiplier` never changes when the user picks another cursor set. Instead each bundled cursor asset carries a generated `opticalScale` from rendered alpha bounds, relative to the matching `macos` asset, and `placeCursor` applies it before hotspot offset calculation. This fixes cursor sets whose SVGs contain less padding / larger artwork without sacrificing pointer precision.
- **Project-level state** on `EditorArtboard.cursorSizeMultiplier` (one screen recording per project, so size is global to the artboard — sibling to `padding`). Persisted; mutated via `setCursorSizeMultiplier` (history tag `cursor-size`, coalesced like the other adjustment sliders). The editor overlay reads it through `useEditorCanvasArtboard`, holds it in a `sizeRef` updated in the render body (so the tick/hover closures read the latest value without re-subscribing), and re-places immediately when it changes while paused.
- **Export parity**: `build-stage.ts` reads `state.artboard.cursorSizeMultiplier` into `ExportCursorHandle.sizeMultiplier`; `run-export.ts` passes it to `placeCursor` per frame, so the exported video matches the preview at the chosen size. `placeCursor`'s 4th argument is an options object for size, click press scale, pointer override, cursor set, motion rotation, and reference size.

### Cursor Motion Blur

Screen-Studio-style directional motion blur on the moving cursor, controlled by a **single 0–100 % intensity slider** in the sidebar **Cursor** tab. The blur _velocity is derived from how fast the cursor actually moves_ — the user only sets the amount; everything else (direction, length, kernel) is computed.

- **Derivation** lives in `cursor-scene.ts` `computeCursorBlur(...)` (pure, shared by editor + exporter). It samples `placeCursor` at `sourceSeconds` and at `sourceSeconds − 1/120 s` with the same size, click press scale, reference size, cursor set, pointer-override, motion-rotation, and smoothing options, takes the artboard displacement, rotates it into the cursor's **local** frame using the cursor's final placement rotation (video rotation plus motion rotation, because the blur runs on the sprite bitmap before the node's rotation transform), converts speed → smear length via a fixed shutter (`1/30 s`) scaled by intensity, **caps it at 200 px** (bounds look + cache cost), and returns `MotionBlurOptions { velocityX, velocityY, kernelSize, offset: 0 }`. Below ~1.5 px it returns `null` (draw sharp). Frame-rate-independent: the fixed sample window + shutter make the preview and any export fps blur identically. Tuning constants (`CURSOR_BLUR_*`) live in `cursor-scene.ts`.
- **Rendering — selectable GPU / CPU backend** (`src/lib/motion-blur/sprite-motion-blur.ts`, `createSpriteMotionBlurRendererForBackend`). The default **GPU** path runs the directional-blur shader on WebGL2 (premultiplied, so the smear feathers into the transparent margin). The sidebar **Blur renderer** uses the same compact header-pill selector style as Cursor smoothing and can force the **CPU** path, which uses the same Pixi-derived `applyMotionBlur` math. If GPU is selected but WebGL2 cannot be created, the renderer falls back to CPU. Both paths return a **reused** padded canvas that the cursor `Konva.Image` consumes via `node.image(...)`. **There is no per-frame `node.cache()` and no Konva filter pipeline** — that CPU rasterise-and-filter-every-frame path was the lag; injecting a pre-blurred canvas is the fix. When `computeCursorBlur` returns `null` the node draws the sharp SVG. The padded canvas is expanded by `motionBlurPadding(blur)` per side so the smear spills past the cursor; the node `offset` is shifted by that padding so the hotspot stays pinned. The WebGL upload flips Y so the output canvas displays upright; the renderer inverts the Y velocity uniform at the shader boundary so its canvas-space direction matches PixiJS and the CPU `ImageData` path (positive Y = down). The renderer reuses its scratch/GL/output canvases across frames, so the hot path allocates nothing. Blur only runs while moving — a still pointer draws the sharp SVG.
- **Project-level state** on `EditorArtboard.cursorMotionBlur` (0..1; sibling to `cursorSizeMultiplier`) and `EditorArtboard.cursorMotionBlurBackend` (`"gpu" | "cpu"`). Persisted; mutated via `setCursorMotionBlur` (history tag `cursor-motion-blur`, coalesced) and `setCursorMotionBlurBackend` (history tag `cursor-motion-blur-backend`). Defaults: **0.2** (`CURSOR_MOTION_BLUR_DEFAULT`) and **GPU** (`CURSOR_MOTION_BLUR_BACKEND_DEFAULT`). The overlay reads intensity through `motionBlurRef`, recreates the one reusable renderer only when the backend changes, and re-places immediately while paused. Pointer accuracy is unchanged by either setting because `placeCursor` still owns hotspot placement and the blur padding is compensated in the Konva offset.
- **Export parity**: `build-stage.ts` reads `state.artboard.cursorMotionBlur` and `state.artboard.cursorMotionBlurBackend`, creates one selected-backend renderer per export (disposed in `dispose`), and falls back to CPU if requested GPU is unavailable; `run-export.ts` calls the same `computeCursorBlur` + `renderer.render(...)` + `node.image(...)` injection per frame, so the exported smear matches the preview frame-for-frame.
- `konvaMotionBlurFilter` (the `Konva.Filters` wrapper over `applyMotionBlur`) is **no longer on the cursor path**; it survives only for the `/motion-blur-lab` comparison page. The lab now compares three synchronized renderers from one rAF clock: the real `pixi-filters` `MotionBlurFilter`, the project WebGL2 sprite renderer injected into `Konva.Image`, and the Konva CPU cache/filter path. Stop returns all three panels to the sharp sprite so the no-blur preview can be checked separately from motion blur.

Known limitations / v2:

- Full-display recordings only. Region/window captures would need the source-rect offset folded into the display→source mapping.
- Custom app cursors (`cursorId = custom-N` from the addon) fall back to the pointer; using the captured PNG from the recording's `cursors/` folder is future work.
- "Hide when idle" and shake removal (Screen Studio cursor options) are not implemented.
- Cursor style selection is limited to the bundled sets. User-uploaded cursor styles are not implemented.

## Fullscreen Preview Mode

A distraction-free playback mode: the "Preview" titlebar button (left of Export, `title-bar-preview-button.tsx`) fullscreens the workspace and plays the composition start-to-end like a native video player.

Design principle — **reuse the live playback engine, do not build a second stage.** Preview is the existing live Konva stage, presented via the browser Fullscreen API with a fill-fit transform and editor chrome hidden. The export pipeline's offscreen stage (`export/build-stage.ts`) stays reserved for deterministic frame-accurate export; duplicating the master-clock / audio / cursor engine for real-time preview was explicitly rejected.

State and ownership:

- `isPreviewMode` is session-only state on the provider (view context). `enterPreview()` / `exitPreview()` are **pure toggles** — all DOM/playback side effects live in `editor-workspace.tsx`. Not persisted, not in undo history; reset in the project-switch reset block.
- **Enter** (workspace effect keyed on `isPreviewMode`): `containerRef.requestFullscreen()` (a rejection calls `exitPreview()`), then `setTimelineTime(0)` + `playTimeline()`.
- **Exit** (same effect, guarded so initial mount is a no-op): `pauseTimeline()`, `document.exitFullscreen()` if still fullscreen, and repaint the user's saved `viewTransform`.
- A mount-once `fullscreenchange` listener calls `exitPreview()` when the document drops out of fullscreen (Esc / OS gesture) while still in preview, so the state flag always tracks reality. The two exit paths (button vs. fullscreenchange) are idempotent and don't loop.
- **Visibility / blur pause**: the provider listens for `document.visibilitychange` during any active playback and for `window.blur` while playback is active. Both paths call the same `pauseTimeline()` used by the Pause button. The broader blur guard covers macOS Space switches / occlusion cases where Chromium may throttle the renderer before `document.hidden` changes. Before committing, `pauseTimeline()` samples the visible primary/master video element's native `currentTime`, projects it back into timeline space, and only then notifies tick subscribers and syncs media. The cursor overlay therefore returns to the same frame the video was actually showing after the app is hidden, minimized, or preview focus is lost.

Fill-fit:

- A dedicated layout effect applies `getPreviewFillTransform(viewportSize, artboard)` (zero-padding contain-fit) imperatively via `applyStageViewTransform` whenever preview is active. It recomputes on the fullscreen resize (the workspace `ResizeObserver` reports the screen size → `setViewportSize` → this effect) and on artboard change.
- The normal transform-sync layout effect early-returns while `isPreviewMode` so it doesn't fight the fill-fit; it still keeps `viewTransformRef` current for restore-on-exit.
- `setViewportSize` (provider) skips its auto-fit/clamp transform mutation during preview, so the persisted user view survives untouched.
- Contain-fit keeps the artboard sharp (the canvas re-rasterizes at display pixel density via `Konva.pixelRatio`, capped 3); letterbox bars are the black container background. No crop, no distortion.

Chrome + interaction gating while preview:

- Container background switches to black; the white artboard backdrop DOM is not rendered.
- The `PreviewControls` DOM overlay covers the canvas and swallows pointer input, so canvas hover/click-select never fires in preview. The pixel grid is already hidden below its `visibleFromScale`.
- The global keydown handler, while preview, maps **Space → toggle play/pause** and mutes every other editor shortcut (undo/redo, zoom, frame-step, Delete). Esc is left to the browser to exit fullscreen.

Controls (`preview-controls.tsx`, DOM overlay mounted only in preview, `z-[60]`):

- Native-player feel: a full-surface click target toggles play/pause; an auto-hiding bottom transport (filled play glyph / pause, scrub bar, elapsed / total clock) fades out ~2.5 s into playback and reappears on pointer move; an always-on Exit button (top-right) and the cursor hide while controls are hidden.
- The scrub-bar fill and elapsed clock are driven imperatively from `subscribeTimelineTicks` (no per-frame React render). Scrubbing pauses playback, then commits via `setTimelineTime` (which re-notifies subscribers so the bar tracks while paused).
- **End of timeline**: the live engine auto-pauses at `timelineDuration` (no loop). The overlay detects `!isTimelinePlaying && timelineTime ≥ duration` and shows a centered **Replay** button (`setTimelineTime(0)` + `playTimeline()`).

The cursor overlay and audio need zero preview-specific code — both ride the existing playback engine (tick subscription and `shouldPlayAudio`).

Performance: reuses the single content-layer redraw; adds no per-node DOM, no per-node listeners, and no per-frame React state. Holds the 5000-node stress invariant.

## Interaction Model

The transformer was removed entirely (2026-06-06): no move/resize/rotate gestures, no transform handles or rotation knob, no marquee, no multi-select, no lock, no duplicate, no arrow-key nudge, no floating selection toolbar, no rotation readout. **Video placement is never gesture-driven** — it is derived from the artboard settings (`src/lib/video-placement.ts`). Canvas node interaction is hover + click-to-select only, owned by `SelectionController` (`pixi/selection-controller.ts`).

Selection (single-select only):

- Click a video to select it. The provider's `selectedItemId` is the single source of truth; the canvas draws one plain selection outline (no handles).
- **The artboard is itself selectable.** Clicking the empty artboard (or the padding margin around the videos) selects it — `selectedItemId` becomes the `ARTBOARD_SELECTION_ID` sentinel and `SidebarSelectionBridge` routes the sidebar to the **Background** tab. The artboard participates as a synthetic `CanvasNode` (id = sentinel, rect `(0, 0, w, h)` at the world origin) built in `pixi-canvas.tsx`, so the controller's hit-test and the scene's outlines reuse the exact node path. Hit priority: videos (top-most z first) → artboard → pasteboard.
- Click the pasteboard (outside the artboard) to deselect. Video selection opens the Video tab via `SidebarSelectionBridge`; artboard selection opens the Background tab.
- `Delete` or `Backspace` detaches the selected video (remove-from-canvas, not a project delete — see Project Persistence → "Detached videos"). The shortcut lives in `editor-workspace.tsx`'s editor-level keydown (after the zoom-clip Delete branch), not in a canvas controller. Ignored while typing in editable controls, with Cmd/Ctrl/Alt held, and when the artboard sentinel is selected (nothing to detach).

Hovering:

- Moving the pointer over an unselected video shows a hover outline around its bounds and a `pointer` cursor (selectable affordance).
- Moving the pointer over the empty artboard (no video under it) shows the same hover outline around the artboard bounds; the cursor stays the default arrow — the outline alone is the selectable affordance, so the whole canvas doesn't read as a button.
- The hover outline is one stage-level screen-space `Graphics`, not one outline per node. Hit-testing is one delegated DOM `pointermove` → pure `hitTestNodes` (O(n) rect containment, top-most z wins, artboard as the constant-cost fallback) → one overlay redraw only when the hovered node changes. At a future 5000+-node scale, swap the linear hit-test for a spatial index without changing the controller surface.
- Hover outline is hidden while Space-pan is armed, when leaving the canvas, and when the hovered node (video or artboard) is the current selection.

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

**Removed.** Canvas snapping (Figma-style alignment guides, equal-spacing distance guides, dimension match, grid snap) was a Konva-era feature deleted at the PixiJS cutover (`src/lib/editor-canvas-snap.ts` and `snap-guide-overlay.tsx` no longer exist), and the drag/resize/nudge gestures it served were removed with the transformer — placement is settings-derived, so there is nothing left to snap. Timeline snapping (`@openscreen/timeline`) is unrelated and untouched.

## Workspace Theme

The outer workspace background color is a theme token:

- CSS variable: `--editor-workspace`
- Tailwind color: `bg-editor-workspace`
- Value: `#1e1e1e`

Use this token for future editor workspace surfaces instead of hardcoding the color.

## Auto-Zoom

Auto-zoom is a **generator of ordinary zoom clips**, not a separate camera system.
After a recording finishes and opens for the first time, it reads the captured
**clicks** and emits plain `CanvasZoomClip`s onto the [Zoom track](#timeline-and-playback)
— choosing only **when** (`start`/`end`). It is a port of **Cap's** model (see
`docs/auto-zoom-algorithm.md` for the full algorithm + constants); this section
covers the editor wiring. Every generated clip is `mode: "auto"`, so its focus
spring-follows the recorded cursor at render time (see [Composition Zoom Camera]
below) — the clip's stored `focus` is only the ease-in anchor.

**Generation — click clustering.** `generateZoomClipsFromClicks` keeps down-clicks,
ignores trailing clicks in the last `1000 ms`, pads each into `[t − 300 ms,
t + 2500 ms]`, **merges windows by interval-gap** (a window joins the growing
cluster when it starts within `2500 ms` of the cluster's end, so a run of clicks
~5 s apart chains into one long zoom — far fewer, longer clips), and emits each
cluster as an `auto` clip at `scale 2.0`. Deterministic ids → idempotent
re-generation. A generated clip is indistinguishable from a hand-made one and is
fully editable / movable / deletable.

**Runs once automatically, plus a manual Regenerate.** Generation fires in the
provider's slow-path hydration (first open of a fresh recording); the clips are
autosaved into `project.json`, so every later open restores them via the fast
path and the one-shot never re-runs. The Zoom panel's **Regenerate auto-zoom**
button (`regenerateAutoZoom`) re-runs on demand and **replaces** the whole Zoom
track in one atomic undo step.

Modules and wiring:

- **`src/lib/auto-zoom/generate-from-clicks.ts`** — the pure, deterministic generator
  (no React/DOM/`Date.now()`/`Math.random()`; identical clicks yield byte-identical
  clips, ids included). Emits via `withZoomClipDefaults` + `normalizeZoomClips`.
- **`src/components/editor/canvas/auto-zoom-scene.ts`** — the renderer-side adapter
  (`autoZoomClicksFromCursorData`). Maps each captured click through the screen
  clip's source↔timeline inversion (`timelineS = clip.start + (sourceS − sourceIn)`,
  dropping trimmed-out samples) and through the **shared** `displayPointToArtboard`
  cover-crop chain ÷ artboard size (dropping off-video samples). Reusing the cursor
  overlay's mapping guarantees a zoom's anchor lands on the pixel the cursor sat on.
- **`src/components/editor/canvas/cursor-scene.ts`** — `displayPointToArtboard` lives
  here (and `placeCursor` calls it) so the cursor overlay and auto-zoom share one
  cover-crop/rotation mapping rather than duplicating it.
- **`src/components/editor/canvas/provider.tsx`** — `computeAutoZoomClips` is the
  shared core (read cursor data via `projects:getCursorData`, build the clicks,
  run the generator). The slow path arms `autoZoomPendingRef`; a one-shot effect
  fires once the screen video **and** its timeline clip are committed and commits
  under the `zoom-auto-generate` tag (only when it produces clips).
  `regenerateAutoZoom` re-runs the core and replaces the track under the
  `zoom-regenerate` tag, doing nothing when generation couldn't run (so it never
  silently wipes the track) and leaving `autoZoomPendingRef` untouched. Both tags
  are in `ALWAYS_NEW_ENTRY_TAGS`, so a single `Cmd+Z` removes the whole batch.
  Failures (missing/corrupt sidecars) emit no clips and never block the editor.

**Auto vs manual mode.** The `mode` field (`"auto" | "manual"`) is set from the
Zoom panel's Auto/Manual toggle. `auto` spring-follows the cursor; `manual` holds
the fixed stored `focus` (set by dragging the focus dot). Hand-added clips default
to manual; generated clips are auto; legacy clips with no persisted `mode` default
to auto. The field is **additive + optional** (no schema version bump).

What auto-zoom does **not** do (vs the earlier removed pipeline): no importance
scoring / typing / drag / double-click heuristics, no frame-analysis content
bounds (`engagedRects`), and **no zoom-out-to-fit reveal** — Cap's auto mode is
pure cursor-follow. `engagedRects` stays a tolerated legacy schema field but is no
longer populated or read.

Limitations: whole-display recordings only (window/region would need target-rect
normalization, like the cursor overlay); the ease-in anchor is artboard-normalized
and baked at generation time, so moving/resizing the screen video on the artboard
afterward drifts it — the same property manual clips have.

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
        <file>.mp4   # LEGACY imported assets — the import UI/pipeline was
                     # removed (recordings are the only video source); files
                     # already here keep loading via `relativePath`
```

Schema (`electron/ipc/project-schema.ts`):

- `version: 1` — first line of every read; mismatches fall back to "no saved state" and the renderer re-synthesises defaults.
- `artboard: { presetId, width, height, background, padding, backgroundEnabled?, cursorCustomRenderingEnabled?, cursorSetId?, cursorSizeMultiplier?, cursorAlwaysUsePointer?, cursorTypeStabilization?, cursorSmoothingMode?, cursorClickPressScale?, cursorMotionRotation?, cursorMotionRotationMode?, cursorMotionBlur?, cursorMotionBlurBackend? }`. `backgroundEnabled` (Background tab master switch) and all cursor fields are **optional on disk** (absent in pre-feature files): `parseArtboard` defaults `backgroundEnabled` to `true` (only an explicit `false` turns the background off — when off, preview and export paint no fill/wallpaper **and** the padding effect is neutralized: `getPaddingInsetPx` returns 0 so every video re-lays out full-bleed cover-fit via the standard derived-placement flow, while the stored `background`/`padding` values are kept), `cursorCustomRenderingEnabled` to `true`, `cursorSetId` to `"macos"` (unknown values also default to `"macos"`), `cursorSizeMultiplier` to `2.2` (clamp `[1, 4]`), `cursorAlwaysUsePointer` to `false`, `cursorTypeStabilization` to `false`, `cursorSmoothingMode` to `"default"`, `cursorClickPressScale` to `0.78` (click press target scale, clamp `[0.5, 1]`), `cursorMotionRotation` to `0.35` (clamp `[0, 1]`), `cursorMotionRotationMode` to `"side-lean"` (legacy field — the "rotation" mode was removed; the value is parsed for compatibility, ignored by the editor, and omitted from new saves), `cursorMotionBlur` to `0.2` (clamp `[0, 1]`), and `cursorMotionBlurBackend` to `"gpu"` (unknown values also default to GPU), so old projects keep loading without a version bump — see [Custom Cursor Rendering](#custom-cursor-rendering), [Cursor Style](#cursor-style), [Cursor Pointer Override](#cursor-pointer-override), [Cursor Type Stabilization](#cursor-type-stabilization), [Cursor Smoothing](#cursor-smoothing), [Cursor Motion Rotation](#cursor-motion-rotation), [Cursor Click Press](#cursor-click-press), [Cursor Size](#cursor-size), and [Cursor Motion Blur](#cursor-motion-blur).
  - `background` is either `null`, `{ type: "color", value }`, or `{ type: "wallpaper", value, blurRadius? }`. For wallpapers, `value` is a stable `WallpaperId` from `src/lib/wallpapers.ts` — wallpaper assets ship with the app and are not copied per-project.
- `videos: ProjectVideo[]` — one entry per project video (both on-canvas and detached). The per-video `x/y/width/height/rotation/locked` fields are **kept for v1 compatibility but are derived-then-persisted**: the editor recomputes placement from the artboard settings (`src/lib/video-placement.ts`) on hydration and at every settings change, writes the recomputed values back on autosave (`rotation` always `0`), and ignores `locked`. Each entry includes its `source`:
  - `{ kind: "recording", assetRole: "screen" | "camera" }` — file path **and byte size** resolve through `project.assets` (which itself resolves from `recording.json`); deliberately no `fileSize` on the recording source, so the size never goes stale relative to the on-disk `.mov`.
  - `{ kind: "imported", relativePath, fileSize }` — `relativePath` is always inside `<project>/assets/videos/<id>/`.
  - `onCanvas?: boolean` — **optional, back-compat-safe** (added without a version bump per the "adding optional fields is safe" rule). Missing or `true` means the video is on the canvas; `false` marks a **detached** video (removed from the canvas but kept in the project). `serializeProjectState` writes on-canvas videos first with the field omitted (so legacy `project.json` stays byte-identical and the post-hydration fingerprint is a no-op), then appends detached videos tagged `onCanvas: false`.
- `timelineClips: ProjectTimelineClip[]` — `start`, `end`, `sourceIn`, `sourceOut` per clip. Only on-canvas videos have a clip; detached videos carry none.
- `zoomClips?: ProjectZoomClip[]` — **optional, back-compat-safe** (added without a version bump per the "adding optional fields is safe" rule). Manual [Zoom track](#timeline-and-playback) segments (`id`, `start`, `end` in timeline seconds) plus optional persisted camera settings (`enabled`, `mode`, normalized `focus`, `scale`, `radialBlur`, and `transition`). `mode` (`"auto" | "manual"`, optional/additive, default `auto`) selects cursor-follow vs fixed-focus; `focus` persists the full-artboard anchor (the fixed point in manual, the ease-in anchor in auto). The Pixi-style zoom-blur strength, 2% inner radius, and outer radius are baked (`ZOOM_RADIAL_BLUR_SHADER.strength`, `centerSize = 0.02`, renderer `radius = -1`) and the amount ramp is the **spring** (the legacy `transition.curve` is parsed but ignored); new saves no longer write `radialBlurSettings`. Legacy files that still carry the older full `radialBlurSettings` object (or the older `easePreset`) keep loading because the schema parses them tolerantly, but the renderer ignores those old blur-radius knobs. `serializeProjectState` **omits the key entirely when empty** so legacy `project.json` stays byte-identical, and omits default-valued settings per clip to keep the saved file small. `parseProjectState` parses it **tolerantly** (absent → `undefined`; malformed entries are dropped rather than rejecting the whole project, unlike the required `timelineClips`). The renderer applies `withZoomClipDefaults` and normalizes restored clips into a single non-overlapping lane via `normalizeZoomClips` before state is committed. Included in `fingerprintProjectState` so a zoom edit triggers a save and an undo step. Zoom clips are part of the output video: editor preview and export both sample them by composition time through the shared zoom camera helpers. On the first open of a fresh recording these clips may be produced by [Auto-Zoom](#auto-zoom) (one-shot, then persisted like any manual clip); thereafter they are indistinguishable from hand-placed clips, so no `source`/provenance field is stored. Each clip also carries an **optional, additive** `engagedRects` array (`{ t, rect: {x,y,width,height} }`, artboard-normalized) — a **legacy** field from the removed zoom-out-to-fit reveal. The spring follow does not use it, and generation no longer writes it; it is parsed tolerantly and omitted when empty so old `project.json` files keep loading unchanged.
- `updatedAtUnixMs` — refreshed by main on every successful write.

Not persisted: selection (including the **selected zoom clip** `selectedZoomClipId`, session-only and mutually exclusive with the video `selectedItemId`; reset on project switch), playhead time, timeline zoom/scroll, viewport transform, measured viewport size / renderer resolution (session-only Pixi preview layout), **fullscreen preview state (`isPreviewMode`)** (session-only flag for [Fullscreen Preview Mode](#fullscreen-preview-mode); reset on project switch), the **open-time autoplay flag** (`autoplayPendingRef`, session-only — armed by hydration, consumed by the first video element to load; see [Autoplay on open](#timeline-and-playback); reset on project switch), the zoom-track **hover ghost** (imperative preview, never state), hover preview state, measured per-clip source fps (`videoFpsRef`, re-measured each session for frame-stepping), the **cursor track and click events** (loaded on demand from the recording's input sidecars via `projects:getCursorData` and re-built each session for both the cursor overlay and `auto` Zoom follow — see [Cursor Overlay](#cursor-overlay)), cursor asset `visualBounds` / `opticalScale` metadata (generated from bundled assets, not project state), the in-memory undo/redo history (`historyRef`), the session-only video URL cache (`sessionVideoUrlsRef`, holding `file://` URLs for both recordings and imports), runtime `objectUrl` strings, the **screen-source pixel size** (`sourceVideoDimsRef` + its reactive `sourceVideoDims` state mirror, session-only — re-derived from the project's screen asset by both hydration paths and reset on project switch; feeds `resolveAutoArtboard` for the Auto preset and the preset dropdown's Auto-row subtext), all `*Ref` runtime state. The view always re-fits the artboard on load.

Hover preview and cursor-track readiness are session-only. The clip-at-time lookup is derived from persisted `timelineClips`, but the live hover time, pending hover seeks, cursor track object, SVG decode retries, and Pixi render invalidations are rebuilt every session and never written to `project.json`.

Pixi renderer lifecycle recovery is also session-only. The visibility/focus warm-up frame counter, WebGL context-restored repaint, and WebGPU device-loss `canvasEpoch` remount are runtime safeguards for the preview surface; they do not describe the project, do not affect export pixels, and are never persisted.

The **active sidebar tab + open/collapsed flag** are persisted, but **app-level in `localStorage`** (`openscreen:sidebarTab`, see [Layout Resizing](#layout-resizing)) — not in `project.json`, because they are editor chrome that applies across projects, like the renderer backend preference. They are not reset on project switch. The Settings window's **"Remember sidebar tab"** switch (default ON) opts out: while OFF, tab state is plain session-only and the stored entry is cleared.

Derived-on-load (not persisted, but reconstructed every hydration): a recording's `CanvasVideoItem.fileSize` is read back from `ProjectAsset.fileSize`, not from `project.json`. Both hydration paths (fast-path restore and slow-path synthesis) and both undo/redo restores route through `resolveFileSizeForRestore`. Imported videos keep their persisted `source.fileSize` instead.

Export source URLs are also runtime-only. `ProjectSummary.assetUrlsByVideoId` is computed by main when a project loads, but the slow path after a fresh recording starts with no saved `project.json`, so that map can be empty while the renderer already has valid screen/camera `objectUrl` file URLs. The Export button therefore builds its payload with `buildExportAssetUrlsByVideoId(videos, project.assetUrlsByVideoId)`, preferring each live `CanvasVideoItem.objectUrl` and falling back to the project-summary URL. Nothing about that URL map is written back into `project.json`.

Hydration (in `src/components/editor/canvas/provider.tsx`):

- Fast path — `project.state` present: write the saved `artboard`, `videos`, `timelineClips`, and `zoomClips` into state. **Placement is recomputed, not trusted**: on-canvas videos run through `applyAutoLayout(restoredVideos, savedArtboard)` before commit, so saved `x/y/width/height/rotation` are replaced by the settings-derived layout (legacy projects with manually-positioned or rotated videos snap to the derived placement on load; rotation becomes 0). The recomputed list also feeds the hydrated snapshot that seeds the autosave fingerprint and the history baseline, so the fingerprint matches in-memory state — **no redundant save on open**; the on-disk file keeps its legacy numbers until the next genuine edit writes the recomputed values (idempotent, fully convergent — no save loop). Saved `videos` are split by `onCanvas`: `onCanvas !== false` videos go to the live `videos` list, `onCanvas === false` videos go to the `detachedVideos` list (Video-tab-only, no canvas node; their placement is recomputed later by `addVideoToCanvas` if re-added). Clips are filtered to those whose `videoId` is an on-canvas video (defensive against a stale clip pointing at a detached video). Zoom clips are defaulted and normalized before commit so legacy span-only clips activate with the current defaults; missing optional transition fields hydrate through `withZoomClipDefaults`, and legacy `transition.speed` / `easeIn` / `easeOut` values are converted to a duration. Each video's `objectUrl` — including detached ones — is taken from `ProjectSummary.assetUrlsByVideoId[video.id]` (main resolves URLs for the entire `state.videos` array, so a detached video's file URL is ready the moment it is re-added). Missing files leave that entry undefined — the renderer keeps the node so the user can see what is broken instead of silently dropping it.
- Slow path — `project.state` is `null` (first open after a recording, or schema mismatch): the existing flow runs (probe screen/camera metadata via `readVideoMetadata`, pick an Auto vs Wide preset, add videos with `source: { kind: "recording", assetRole }`) and explicitly starts with an empty Zoom track. The next user edit creates `project.json`.

Autosave:

- A single effect watches `artboard`, `videos`, `detachedVideos`, `timelineClips`, and `zoomClips`. Any change schedules a `setTimeout` after `PROJECT_STATE_AUTOSAVE_DEBOUNCE_MS` (500 ms) that calls `window.api.projects.saveState(project.path, snapshot)`. Every `serializeProjectState` call site (autosave drain, synchronous flush, both hydration seeds) passes `detachedVideosRef.current` as the 4th argument and `zoomClipsRef.current` as the 5th. `transition.durationMs` is persistable because it changes output pixels; default `1000 ms` (Cap's `ZOOM_DURATION`) is elided from `project.json` while non-default durations are written under the existing optional `transition` object. The export snapshot still omits detached videos but now includes `zoomClips`, because manual zoom changes output pixels.
- `window` `blur` and `beforeunload` listeners flush the pending timer synchronously so quick edits before quit make it to disk.
- A "single writer + pending" pair (`autosaveInFlightRef` / `autosavePendingRef`) collapses concurrent writes — at most one IPC save is in flight, and any change made during it triggers one follow-up write when it returns.
- Both the debounced effect and the flush listeners gate on `hydratedProjectIdRef.current === project.id`, so saves never fire before hydration completes or with the wrong project's path.

Imported video files (LEGACY — import removed):

- The video-import pipeline (`addVideoFile`, the `projects:importAsset` IPC, and the main-side copy into `<project>/assets/videos/<id>/`) was **removed** — screen and camera recordings are the only video sources. Nothing in the app can create a `{ kind: "imported" }` video anymore.
- **Loading tolerance is retained**: `parseProjectState` still accepts `{ kind: "imported", relativePath, fileSize }` sources and `resolveAssetUrlsForState` still resolves their `relativePath` against the project folder (guarded by `isPathInside`), so old `project.json` files with imported videos keep rendering, exporting, and round-tripping through undo. A regression test in `persistence.test.ts` locks this in.
- Because imports no longer exist, the previously documented orphaned-asset concern (files left in `assets/videos/` after delete) is moot — no code path can create new orphans; any existing files are either referenced by `project.json` or inert.

Detached videos (remove-from-canvas / add-back lifecycle):

- "Delete" from the canvas — the `Delete` / `Backspace` shortcut with a video selected — is **non-destructive**. `deleteVideo(id)` moves the whole `CanvasVideoItem` from `videos` to `detachedVideos`, drops its timeline clip, clears selection if it was selected, and **does not revoke its object URL** (the file still belongs to the project). The same path applies to both recordings and imported videos.
- The renderer keeps two in-memory lists: `videos` (on canvas, the only list every existing consumer — canvas nodes, timeline, playback, export, padding, primary-audio — reads) and `detachedVideos` (Video-tab-only). Detached videos are deliberately **not** a flag on `videos` so the 5000-node hot paths never iterate or filter a detached entry.
- The Video tab lists `videos` then `detachedVideos`; on-canvas cards show **Select** (calls `selectItem`), detached cards show **Add** (calls `addVideoToCanvas`). The card chrome is identical — only the affordance label and click action differ.
- `addVideoToCanvas(id)` is the inverse: it moves the item back to `videos`, mints a **fresh full-length** `createTimelineClip` (the pre-removal trim/position on the timeline is intentionally _not_ restored), and selects the restored video. The item keeps its appearance (corners/border), but its placement is **recomputed against the current artboard settings** (derived placement — `computeVideoPlacement`, rotation reset to 0) so it lands per today's padding/preset. The item is **appended** to `videos`, so a re-added video returns to the top of the canvas z-order (front-most) rather than its original stacking index — "re-add = bring to front", matching how a freshly imported video lands.
- Both `deleteVideo` and `addVideoToCanvas` are destructive-flush + history-tagged actions (`"delete"` / `"add"`, both in `ALWAYS_NEW_ENTRY_TAGS`), so each is exactly one undo step. Undo/redo restore re-splits the snapshot's `videos` by `onCanvas`, so detach and re-add round-trip through history cleanly.
- There is **no permanent-delete UI** today: a detached video persists in `project.json` (with `onCanvas: false`) indefinitely. Removing it from the project entirely (and deleting the underlying imported asset) is a future affordance.

Atomic writes:

- `writeJsonAtomic` (shared from `electron/ipc/fs-utils.ts`) writes to a `.<name>.<pid>-<ts>-<rand>.tmp` sibling first, then `rename`s on top. POSIX `rename` on the same filesystem is atomic, so a crash mid-write leaves either the previous or the new file — never a torn JSON. Any failure — `writeFile` _or_ `rename` — unlinks the tmp so a read-only or full disk doesn't accumulate `.tmp` orphans. Used for `project.json`, `active-project.json`, and `window-bounds.json`.
- **Per-folder save mutex.** `projects:saveState` serializes its filesystem sequence (existence check → `updatedAtUnixMs` stamp → atomic write) per project folder via a promise-chain map (`withFolderSaveLock`). A single renderer already serializes its own autosaves (`autosaveInFlightRef`), so this guards the **multi-window** case: two editor windows on the same project can no longer interleave between the `fs.access` check and the write. Last-writer-wins is still the semantic for whole-file state (each window writes its full snapshot), but writes can never tear or land out of timestamp order. Validation (`parseProjectState`) runs outside the lock — it's pure.

Safety invariants for the autosave pipeline:

- **Cross-project bail.** `flushAutosave` captures `projectPath` once and re-checks `projectRef.current.path` at the top of every drain-loop iteration. If the user switches projects mid-save, the drain stops and the indicator silently rolls over to the new project's autosave; we never write the new project's data to the old project's `project.json`.
- **Status reset on project switch.** The hydration effect's reset block clears `autosaveTimerRef`, `autosaveRetryTimerRef`, `autosavePendingRef`, `lastWrittenSerializedRef`, the in-memory save error, and resets `saveStatus` to `saved` — so the cloud indicator can never strand on `saving` or `error` after a switch.
- **Skip redundant first save.** A fingerprint (JSON minus `updatedAtUnixMs`) of the last successful write lives in `lastWrittenSerializedRef`. Fast-path hydration seeds it from the hydrated snapshot built **after** the placement recompute (`applyAutoLayout`), so the autosave effect's immediate post-hydration run sees no diff and skips the IPC — even for legacy files whose on-disk placement differs from the derived layout. The indicator still briefly flashes `saving` (optimistic), then settles back on `saved`.
- **`beforeunload` prompt during unsaved work.** If a debounce timer is pending, a save is in flight, or another follow-up is queued, we call `event.preventDefault()` + set `event.returnValue = ""` so the platform shows its "Leave site?" prompt. Closing anyway still loses at most the 500 ms-debounced edit (the IPC round-trip won't complete), but the prompt nudges the user to wait for the indicator to settle.
- **Auto-retry on transient errors.** When a save fails, `flushAutosave` schedules a single retry after `PROJECT_STATE_AUTOSAVE_RETRY_MS` (5 s). A new user edit supersedes the retry (the autosave-trigger effect clears `autosaveRetryTimerRef`). A project switch also cancels it.
- **Path containment.** `isPathInside` rejects any legacy imported-asset `relativePath` that resolves outside the project folder, so a hand-edited `project.json` can't aim reads at arbitrary paths. (The write-side sanitisers went away with the import pipeline.)

Performance notes:

- Saving is debounced to 500 ms and writes the full document; payload size is dominated by `videos[]` which is small even at thousands of nodes (~100 bytes per video). For a true 5000-node stress case, the JSON would land at ~500 KB — still cheap, but if it grows further we should switch to a binary or delta format rather than ship denser per-node fields.
- The serialiser allocates two fresh arrays per save (`videos.map`, `timelineClips.map`). The autosave debounce keeps this off the interaction hot path; it never runs inside drag, transform, or playback ticks.

Save status indicator (`src/components/editor/save-status-indicator.tsx`):

- A cloud icon lives in the titlebar (right of the Open project button). Subscribes only to the dedicated `useEditorCanvasSaveStatus()` slice so frequent video/timeline updates don't re-render it.
- States: `idle` (hidden — no project loaded yet), `saving` (`CloudLoadingIcon`, gently animated), `saved` (`CloudSavingDone01Icon`), `error` (same `CloudSavingDone01Icon` tinted with `text-destructive`, error reason shown under the tooltip label).
- The provider sets `saving` whenever the debounce timer is scheduled or a save is in flight, and resolves to `saved` or `error` inside `flushAutosave`'s `finally`. The fast-path hydration also seeds `saved` so the indicator doesn't lie about pending writes immediately after open.

Opening a project without recording:

- The recorder-bar settings menu has an **Open project** item. It opens a native folder picker rooted at `~/Documents/openscreen/`, validates the folder via `loadProjectFromFolder` (must have a `recording.json`), and if valid promotes the path to the **sticky active project**. The recorder bar then closes and an editor route pinned to that folder opens. Invalid folders surface an error dialog; cancel is silent.
- Editor windows are **project-pinned** with a `projectPath` URL query. `ProjectProvider` checks that query first and loads it through `projects.open(path)`; after any successful initial load or titlebar picker open, it writes the loaded `project.path` back into the current URL with `history.replaceState` and sets the native/document title to `{project-name}-openscreen`. This keeps each editor window tied to the project it is showing on refresh, while the sticky active project remains the no-query fallback.
- After a successful recording, `main.ts` promotes the recorded folder through `setActiveProjectFromFolder` and opens an editor route pinned to that folder. If another editor window already exists (for example an older project was opened, then the user returned to the recorder and captured again), the new recording opens in a separate editor window so the existing project window is not silently reused or replaced. If no editor exists, the normal editor window is created.
- Recorder access from global OS surfaces is intentional and non-destructive: the application menu (`File > New Recording`), macOS Dock context menu, Windows system tray menu, and macOS menu-bar status item open or focus the `Recorder - openscreen` window while preserving every editor window. The tray/status item uses the app icon as a native tray icon (`templateImage` on macOS) and exposes the same menu on primary click and context click. If a recording is active, those commands focus the recording controls instead of opening another recorder. App-icon/Dock activation and taskbar relaunches restore the last focused editor window when any editor exists; they use a side-effect-free permission check, so they do not reload a project route, hide editor windows, or open the recorder unless no editor window exists.
- Native project pickers are parented to the invoking editor window when available (`BrowserWindow.fromWebContents(event.sender)`), so multi-window project opens attach to the correct surface.
- Sticky active project (`activeProject` in `electron/ipc/projects.ts`):
  - In-memory in the main process and persisted to `<userData>/active-project.json` so it survives both window reloads (Cmd+R) and full app restarts. The file is written **atomically** (shared `writeJsonAtomic`) and persists `{ path, sessionId }` — the recording's `sessionId` (from `recording.json`) is the project's identity; the absolute path is just its current location. Legacy `{ path }`-only files keep reading (sessionId resolves to `null`). Write failures `console.warn` unconditionally (a silently stale active project is confusing to debug).
  - `projects:getLatest` checks it first, before the recorder hint and the "newest folder by mtime" fallback. Without this, refreshing the editor after switching from Project A to Project B would silently snap back to A because A's folder was modified more recently.
  - **Identity recovery on stale path.** If the stored path no longer loads but a `sessionId` is stored, `getLatest` scans the projects root for the folder whose `recording.json` carries that sessionId and reopens it through `setActiveProjectFromFolder` (re-persisting the corrected path). A moved/renamed project folder is therefore re-found instead of silently falling back to a _different_ project. This is recovery of the same project the user had open — not a fallback promotion — so it doesn't violate the "getLatest never promotes" rule. The scan runs only on the stale-path miss, never on the hot path.
  - **Every "open a project" path funnels through `setActiveProjectFromFolder`** so the choice is always persisted: the recorder-bar settings menu's "Open project" entry, native src/app/menu "Open Project" commands, the titlebar's folder picker (`projects:pickAndOpen`), project-pinned editor boots through the programmatic `projects:open(path)` IPC, and `main.ts`'s recording-stop branch. The function validates the folder via `loadProjectFromFolder` (`recording.json` must exist), captures the manifest's `sessionId`, returns the loaded `ProjectSummary` on success so callers don't double-load, and writes the record to disk for restart persistence.
  - `projects:getLatest` is the _only_ read-only path — it never promotes a fallback result to active, so the active slot only changes in response to explicit user opens, successful recordings, or identity recovery of the already-active project.
  - Self-heals if the folder is missing **and** identity recovery fails: the slot is cleared and `getLatest` falls through to the legacy "newest by mtime" path.

App-chrome persistence (not in `project.json`):

- **Window bounds** (`electron/window-bounds.ts` → `<userData>/window-bounds.json`, atomic writes): the editor window persists position + size, the camera preview persists position + size (square, min 140), the recorder bar and export window persist position only (size stays owned by `windowConfigs`). Saves are debounced 500 ms on `move`/`resize`, flushed on window close, and skipped while fullscreen/maximized/minimized so a fullscreen quit never persists screen-sized bounds. On restore, saved bounds must still intersect a connected display's work area (≥ 40×20 px) or the window falls back to its default placement — so an unplugged monitor can't strand a window off-screen. Multiple editor windows share the single `editor` slot (last move/resize wins). Like the sidebar-tab localStorage slot, this is machine-level chrome, deliberately not project state.

Known limitations:

- A missing asset on reload renders an empty `objectUrl` — the video element will fail. We surface no UI for this yet; treat reporting a "broken video" placeholder + recovery affordances as a follow-up. (The **cursor** sidecar case is now surfaced: see [Cursor Overlay](#cursor-overlay).)
- `beforeunload` flushes are best-effort — the platform does not guarantee an async IPC round-trip completes before the window is destroyed. The 500 ms debounce keeps the worst-case loss tight.
- Two editor windows on the same project are last-writer-wins at the snapshot level (each writes its full `project.json`); the per-folder save mutex prevents torn/interleaved writes but not lost updates between windows.

## Export Pipeline

Exporting reads the same `ProjectStateV1` snapshot the autosave writes, replays the timeline frame-by-frame onto an offscreen **PixiJS `Application`** (WebGPU→WebGL2, same shared scene modules as the preview), and feeds each composed frame to a WebCodecs-backed encoder via [Mediabunny](https://mediabunny.dev/). The encoded container streams **straight to a temp file on disk** through the `export:stream*` IPC (Mediabunny `StreamTarget`, 16 MiB chunks, positional writes) — peak renderer memory stays bounded regardless of output size. Audio is mixed window-by-window through a separate streaming mixer (`streamTimelineAudio`) running **concurrently with the video frame loop**, so it adds no wall-clock time of its own and peak RAM stays bounded regardless of source-file size or timeline duration.

Trigger:

- Editor titlebar Export button (`src/components/editor/title-bar-export-button.tsx`). Disabled when the project has no timeline clips. On click it serialises the current state with `serializeProjectState(artboard, videos, timelineClips, [], zoomClips)`, resolves export source URLs with `buildExportAssetUrlsByVideoId(videos, project.assetUrlsByVideoId)`, and calls `window.api.export.openWindow({ settings, state, assetUrlsByVideoId, outputBaseName, projectPath })`. `projectPath` is the absolute project folder; the export stage uses it to load cursor sidecars directly (instead of re-deriving the folder from a video file URL) and threads it `run-export.ts → buildExportStage → buildExportCursor`. Detached videos are deliberately excluded, but Zoom clips are included because they change output pixels. The live URL merge is required for immediate post-recording export: before a reload, `ProjectSummary.assetUrlsByVideoId` can still be empty because main computed it before the slow-path canvas videos were synthesized and autosaved. The main process stashes the payload and opens the Export window.

Window:

- Separate `BrowserWindow` configured in `electron/windowConfigs.ts` (`exportWin`, **560×280**, vibrancy `under-window`, hidden titlebar — same chrome family as Recording Quality and Permissions). The `createExportWindow` site in `main.ts` falls back to 480×560 if the config is somehow missing; the configured value is what actually ships.
- Route: `/export/` (`src/app/export/page.tsx`). States: `loading`, `ready` (settings form), `running` (progress + cancel), `done` (success + Reveal in Finder + Export again), `error` / `cancelled` (retry / close). The source editor window is hidden when encoding starts (`export:markPreparing` → main calls `hideEditorWindow(sourceEditorWindow)`). The same source editor is shown again on `cancel`, `error`, or when the export window closes — **not** on `done`, because the user is supposed to see the success surface (Reveal in Finder / Export again) before dismissing.

IPC (`electron/ipc/export.ts`):

- `export:openWindow` — receives `ExportStartPayload`, stashes it, opens the window. If an export window is already open, brings it forward without replacing the payload or resetting state (close + reopen is the way to get a fresh snapshot).
- `export:getStartPayload` — read-once payload pull from the export window.
- `export:getSettings` / `export:setSettings` — persisted to `<userData>/export-settings.json` via the same coercion path used by `defaultExportSettings()` (`src/lib/editor-project/export-settings.ts`).
- `export:markPreparing` — flips phase + hides the editor, and starts a `powerSaveBlocker('prevent-app-suspension')` so macOS App Nap can't starve a minimized export window mid-encode (the export window also sets `backgroundThrottling: false`; display sleep is deliberately NOT blocked). Every terminal path stops the blocker.
- `export:streamBegin(format)` / `export:streamWrite(position, Uint8Array)` / `export:streamAbort` — the streamed-output channel. `streamBegin` opens a hidden `.pending-export-<ISO>.<ext>` temp file in the exports folder (always superseding a stale stream); `streamWrite` is one positional `fs.write` per Mediabunny chunk (~16 MiB) — positional, not append, because the MP4/WebM muxers seek back to patch sizes and write the index at finalize. Awaiting the write before resolving propagates disk backpressure up into the renderer's encode loop. Position/size are sanity-bounded (64 GiB / 64 MiB). `streamAbort` discards the temp file (idempotent — cancel, reportError, and window-close also discard). A startup sweep deletes orphaned `.pending-export-*` files left by a hard crash.
- `export:reportProgress`, `export:reportDone()`, `export:reportError` — state machine; `reportDone` (no payload — the bytes already streamed) settles outstanding writes, closes the handle, and **renames** the temp file to `~/Documents/openscreen/exports/<base>-<ISO>.<ext>`. All three refuse to mutate state once the phase is terminal (`done`/`error`/`cancelled`) — see the state-machine notes below.
- `export:cancel` — refuses for terminal phases (a late cancel after `done` would otherwise resurrect the state machine, with catastrophic consequences for the just-written output). For active phases, flips to `cancelled`, discards the streamed temp file, stops the power blocker, and restores the editor. The export window's own `AbortController` short-circuits the in-flight `runExport` promise.
- `export:revealOutput` — `shell.showItemInFolder`, gated to paths inside the exports directory.
- `export:closeWindow` — pure window operation; **does not touch state.phase** so a terminal phase survives the close and the `disposeExportPendingPayload` cleanup correctly leaves the output alone. The window's `closed` handler in `main.ts` calls `disposeExportPendingPayload` and restores the editor.

**State-machine invariants** — `done`, `error`, and `cancelled` are terminal. Every IPC handler checks `TERMINAL_PHASES.has(state.phase)` before mutating, so a late or duplicate IPC can never resurrect a finished job. The `disposeExportPendingPayload` cleanup only deletes `state.outputPath` when phase is **not** terminal — a successful `done` job is "the user's file now" and must never be touched. (This combination fixes the bug where clicking Done used to call `cancel` first, flip the phase, and trigger a phantom delete of the just-saved video.)

Settings (`electron/ipc/export-schema.ts` + mirror in `src/types/api.d.ts` + renderer-side helpers in `src/lib/editor-project/export-settings.ts`):

- `format: 'mp4-avc' | 'mp4-hevc' | 'webm-vp9'`. Probed on mount with Mediabunny's `canEncodeVideo`; unsupported codecs are dimmed in the dropdown.
- `resolution: 'artboard' | '720p' | '1080p' | '1440p' | '4k'`. Aspect-preserving fit via `exportResolutionPixels` — long edge snaps to the target preset, short edge follows the artboard's aspect ratio, **and** the result is capped to the preset's nominal 16:9 pixel budget so near-square artboards at 4K don't blow past H.264 Level 5.2's 9.4 Mpx ceiling. Both dimensions are rounded to even pixels so AVC/HEVC accept them.
- `fps: 30 | 60`. (FPS is informational for the probe — `canEncodeVideo` doesn't take it.)
- Audio is **always** muxed when any source clip has an audio track. There is no `includeAudio` toggle.

`exportResolutionPixels` lives **only** in `src/lib/editor-project/export-settings.ts`. The electron-side `export-schema.ts` deliberately does not duplicate it — see the comment in that file. The basic helpers (`defaultExportSettings`, `coerceExportSettings`, `exportContainerExtension`) are duplicated across the two modules because the renderer's tsconfig excludes `electron/`; those three MUST stay byte-equivalent, and the unit tests in `src/lib/editor-project/__tests__/export-settings.test.ts` lock the behaviour in.

**No quality knob.** We deliberately don't expose a quality dropdown because users already pick a resolution. Instead `computeScreenContentBitrate` in `run-export.ts` derives a single text-content-tuned bitrate from `(codec, width, height, fps)` — anchored at 14 Mbps for 1080p H.264, ~2× what Mediabunny's `QUALITY_HIGH` would have produced. Mediabunny's `QUALITY_*` constants assume natural-video content where ~6 Mbps for 1080p H.264 looks fine; for terminal output / code / design tools that same bitrate is the dominant source of visible text blur. The encoder is also given `contentHint: 'text'` and a 1 s `keyFrameInterval` (more frequent I-frames preserve static text). Audio is pinned to 128 kbps AAC / Opus.

**Safety guards in `run-export.ts`**:

- `MAX_TIMELINE_SECONDS = 4 h` — refuse to start an export above this. A multi-hour blocking encode that crashes near the end is unrecoverable; users with longer content should trim first.
- `MAX_OUTPUT_PIXELS = 3840 × 2160` — refuse output dimensions above the 4K nominal pixel budget. The pixel-budget cap in `exportResolutionPixels` already keeps presets in line; this catches custom artboards at `resolution: 'artboard'`.
- Active timeline clips must resolve to source media before the export stage is built. Missing source URLs now fail the job instead of producing a correct-duration white background encode.
- Source decoder startup is fail-fast for every active source. If Mediabunny/WebCodecs cannot open a source (for example an unsupported recording codec), the export surfaces an error instead of silently skipping that clip. The frame loop additionally tracks, per source, whether it ever produced a decoded canvas; after the loop it fails the job (naming the offending file) if any source that had active frames decoded **zero** frames end-to-end, which catches "decoder opened but never produced pixels" failures before a blank file can be written. This is deliberately a per-source _total_, not a per-frame window: a clip whose audio track outlasts its video track yields `null` for its trailing frames, and that must still export the frames it has rather than abort.
- Every `await` inside the frame loop, the audio mixer, and the audio-presence probe checks the `AbortSignal` so cancel response is at most one frame's latency.

Rendering pipeline (`src/components/editor/export/`):

- `build-stage.ts`: builds an offscreen Pixi `Application` from a `ProjectStateV1` snapshot (WebGPU preferred, WebGL2 fallback, gated by `rendererPreferenceChain()` + a 1px readback probe — see "Export (migrated)"). The scene mirrors the editor: a `world` container carrying the artboard→output scale (all node coordinates stay in artboard space), background + content zoom cameras with rect masks, the shared `background.ts` surface (color / wallpaper cover-crop + blur), per-video nodes, the shared `CursorSprite` above them in the content camera, and the shared radial `zoom-blur` filter on the composite. It also mirrors the preview's **anti-halo** structure: a zoom-mirrored unfiltered `backingCamera` (fill/wallpaper) behind the composite and a `clip` mask around the filtered composite, so the pan blur's edge alpha-falloff reveals the background instead of the opaque-black clear (see [Follow motion blur](#timeline-and-playback) and the backing helper `buildExportSurface`). Each video node is a `Sprite` over an **explicit Pixi `ImageSource`** whose upload resource is swapped per frame: a decoded `VideoFrame` on the fast path, or a reused intrinsic-size staging canvas (`drawImage` + `update()`) on the fallback path. Appearance (squircle mask + border via `applyVideoAppearance`) and cover-crop (`Texture.frame` rectangle) are computed once at build time. Nodes start non-renderable; the loop activates them per frame. `buildExportCursor` returns null only when there is no screen recording / no cursor sidecar; otherwise it builds the smoothed track for auto-zoom follow. When `cursorCustomRenderingEnabled` is false it returns a data-only handle with no `CursorSprite`, so export skips the visible cursor but still computes spring cursor follow from the recorded metadata. When the overlay is enabled, it also clamps the persisted cursor options and pre-decodes every cursor SVG so the per-frame loop never awaits.
- `source-frames.ts`: source-side WebCodecs decode pipeline. `planExportFrames` walks the timeline once and produces (a) a per-output-frame list of active clips and (b) the monotonic sequence of source timestamps each unique source video will be asked about. `SourceFrameProvider.create({...})` opens a Mediabunny `Input` over `UrlSource` (HTTP Range streaming — does **not** blob the whole file into memory) and picks one of two modes:
  - **Direct `VideoFrame` mode** (`VideoSampleSink.samplesAtTimestamps`) — chosen by `canUseDirectVideoFrames` when the track has rotation 0 and coded size == intrinsic size (true for our own recordings). `.next()` yields a `VideoFrame` that the render loop hands to `node.setFrame(...)` and closes after `app.render()`. This skips two full-resolution canvas blits per source frame (Mediabunny's sample→canvas draw and the node's canvas→canvas staging draw); for hardware-decoded sources the texture upload is a GPU→GPU transfer. `toVideoFrame()` on a decoder-backed sample is a refcounted wrapper (no pixel copy), and Mediabunny clones samples for duplicate timestamps, so every yielded frame is independently closable.
  - **Canvas fallback mode** (`CanvasSink.canvasesAtTimestamps`, pool of 4) — rotation metadata or a coded/intrinsic size mismatch means the canvas preprocessing is actually needed.
  Either way Mediabunny decodes each source packet **at most once** when timestamps are monotonic and pre-fetches a few frames ahead of the consumer. The create path is wrapped in try/catch so a failure between `new Input` and the iterator handoff disposes the Input rather than leaking it.
- `decode-audio.ts` (`streamTimelineAudio`): **window-based streaming mixer**. The previous implementation `fetch(file://…) → arrayBuffer() → OfflineAudioContext.decodeAudioData()` per source loaded the entire source video file into RAM and then allocated a single timeline-sized output `AudioBuffer` — for a 2 GB recording and a 1 h timeline that's ~2 GB transient + ~1.4 GB decoded, easily crashing the export window. The current pipeline:
  1. Opens one Mediabunny `Input` per unique source URL (HTTP Range streaming).
  2. Builds one `AudioBufferSink.buffers(sourceIn, sourceOut)` async iterator per timeline clip — lazy decode, packet-by-packet.
  3. Walks the output timeline in fixed 0.5 s windows. For each window: allocate a window-sized `AudioBuffer` (~192 KB at 48 kHz stereo), mix-add every overlapping clip's decoded chunks into it (so overlapping clips compose instead of clobbering), `await audioSource.add(windowBuffer)` to honour encoder backpressure, then drop the window buffer to GC.
     Peak RAM stays bounded under ~10 MB regardless of timeline length or source size. Output sample rate is the max observed across all sources; mismatched sources are linearly resampled inline.
- `run-export.ts`: orchestrates the loop. Emits an `onStage(stage)` callback at every phase boundary (`preparing`, `decoding-audio`, `encoding`, `muxing-audio`, `finalizing`) so the export window can swap its headline + status text in step with the pipeline. **Hardware-encode probe**: before configuring the encoder, `probePreferHardwareEncode` asks Mediabunny's `canEncodeVideo` whether `hardwareAcceleration: 'prefer-hardware'` is supported for this exact codec/size/bitrate; only then is the hint pinned (Chromium's `'no-preference'` hardware/software policy is undocumented, and pinning blindly rejects the config on machines without a hardware encoder). The resolved `VideoEncoderConfig` is captured via `onEncoderConfig` for the perf log. **Probe-before-add**: because Mediabunny doesn't let you remove a track after `output.start()`, the runner first calls `probeHasAnyAudio` (all unique sources probed in parallel) to check `getPrimaryAudioTrack()`. If any source has audio, an `AudioBufferSource` is added; otherwise the file is video-only. The source-decoder spin-up still runs active sources in parallel, but any missing metadata or decoder failure aborts the job; successful-but-blank exports are worse than a visible error because they look complete until playback. Right after `output.start()`, the audio mixer is **kicked off concurrently** with the frame loop (AbortError propagates — it IS the cancel path; any other audio failure degrades to silence). For each output frame:
  1. Sample the manual Zoom camera with `sampleZoomCameraAtTime(state.zoomClips ?? [], state.artboard, t, zoomFollowPaths)`; `applyZoomCamera` updates the camera containers and attaches/detaches the shared zoom-blur + pan-blur filters. The `zoomFollowPaths` are the **spring cursor-follow paths**, precomputed once up front via `computeZoomFollowPaths` from the export's own cursor sampler — the **same** function the preview uses, fed the **same** clips. That shared, deterministic recompute (a pure function of clips + cursor track) is the preview↔export parity contract: the in-hold spring follow renders pixel-identically in both.
  2. Hide every video node (so a clip that ended last frame doesn't ghost a stale image).
  3. In parallel, `await provider.next()` for each active source → `node.setFrame(decoded)`. A returned `VideoFrame` is collected into a per-iteration close list; a canvas is staged through the node's reused 2D canvas.
     3b. If `handles.cursor.cursorSprite` is present, place the cursor for this frame via the shared `CursorSprite.render(...)` using the screen clip's `sourceTimeSec` from the frame plan (honors trims/splits; hidden when the screen clip isn't active). A data-only cursor handle may still be present solely for auto-zoom follow when custom cursor rendering is disabled.
  4. `handles.app.render()` — Pixi uploads the dirty textures and composites the whole scene (cameras, masks, cursor, zoom-blur filter) into `app.canvas`.
  5. Close every `VideoFrame` collected this iteration (uploads happened inside render; open frames pin decoder memory and can stall WebCodecs). A `finally` guarantees this on error paths too.
  6. `await videoSource.add(t, 1/fps)` — Mediabunny captures `app.canvas` into a `VideoFrame` synchronously (GPU-side, no pixel readback) and encodes; the await is backpressure only (the encoder runs ~4 frames deep in parallel). Never fire-and-forget; the render and the add stay in the same task so the WebGL drawing buffer is captured before it can be cleared.
  7. Periodic `onProgress` callback (~10 Hz) with `{ framesDone, framesTotal, etaSeconds }`, reported through IPC. The page renders a realtime `Frame N of M · WxH · ETA` line plus a cycling micro-phrase (`Composing`, `Painting frames`, `Buffering encoder`, …) so the user sees the export actively breathing during the long encoding phase.

  Per-leg wall-clock accumulators (`decodeWaitMs` — stalls on the source decoders; `renderMs` — Pixi render + texture uploads; `encodeWaitMs` — encoder/muxer/disk backpressure) are logged once at the end in dev builds as `[export] perf`, alongside the renderer backend, the hardware-acceleration decision, the per-source direct-vs-fallback mode count, and the resolved encoder config — the first thing to read when an export is slower than expected.

  The progress bar is a **single monotonic determinate bar** spanning the whole pipeline (`computeOverallPct` in `src/app/export/page.tsx`): `preparing` → 0, `decoding-audio` → 4%, `encoding` → 4%–96% scaled by `framesDone/framesTotal`, `muxing-audio` → 98%, `finalizing` → 99%. It starts fresh at 0, advances once through the real render, and never resets. (It previously used an indeterminate sliding segment for the non-encoding phases; the segment reached the track's right edge — reading as "100%" during prep — and then the determinate encoding bar appeared at 0, reading as a reset. The weighted single bar removes both illusions.)

- After the frame loop and `videoSource.close()`, the concurrently-running audio mixer is awaited (usually it finished long before the last video frame; the `muxing-audio` stage is only visible when audio decode is the bottleneck). If audio mixing failed or produced no samples (edge case: every source's audio decode failed), a single tiny silent buffer is pushed so the track isn't empty (Mediabunny requires at least one packet per declared track before finalize). Then `output.finalize()` flushes the muxer through the stream IPC, and the page calls `export:reportDone()` to rename the temp file into place.

Why this is fast — what we removed:

- **No per-frame `<video>.currentTime` seek.** Each seek invalidated the decoder and re-decoded from the prior keyframe (50–200 ms per call). With a sequential `VideoDecoder` pipeline, every source packet is decoded **once**, in order, while we hand frames to the encoder. For text-heavy 1080p exports this alone is the difference between ~5 fps and ~30+ fps export throughput.
- **No per-frame canvas staging on the source path (2026-06-07).** The old path did three full-resolution copies per source frame — Mediabunny's `VideoFrame`→pooled-canvas draw, the node's canvas→canvas staging draw, then a canvas→GPU `texImage2D` — ~60 MB/frame of memory traffic for a 2880×1800 retina recording. Direct `VideoFrame` mode collapses them into one GPU-side texture upload (Pixi v8's `ImageSource` accepts `VideoFrame` resources natively on both WebGL and WebGPU).
- **No CPU pixel readback on the encode path.** `CanvasSource.add()` wraps `app.canvas` in a `VideoFrame` on the GPU (verified in Mediabunny's source — `new VideoSample(canvas)` → `new VideoFrame(canvas)`); there is no `readPixels`/`extract.pixels` anywhere in the per-frame loop. Eliminating readback is the same optimization Screen Studio credits for ~70–80 % of its export-time win — we get it via Mediabunny's design.
- **No serial audio stage (2026-06-07).** The windowed mixer runs concurrently with the frame loop; the muxer interleaves the two tracks with per-track backpressure.
- **No `HTMLVideoElement` lifecycle overhead.** No `loadedmetadata` waits, no rVFC safety nets, no off-DOM stalls. The source files are streamed in via HTTP Range requests through `UrlSource`.
- **No fetch+arrayBuffer+decodeAudioData for audio.** Mediabunny `AudioBufferSink` streams source packets the same way the video sink does, so audio decode never holds the full source file in JS heap.
- **No whole-file buffering (2026-06-07).** The old `BufferTarget` held the entire output in renderer memory, silently made the MP4 muxer default to `fastStart: 'in-memory'` (whole-file assembly at finalize), then structured-cloned the `ArrayBuffer` over IPC and copied it again into a `Buffer` — ~4× the file size in transient memory plus a multi-second finalize stall on long exports. `StreamTarget` streams 16 MiB chunks to disk as they're produced and makes finalize cheap.

Performance / scaling notes:

- Constant container/layer structure regardless of video count — scales to 5000+ nodes.
- Pointer events are disabled on the offscreen app (`eventFeatures` all false); no transformer, no interaction listeners.
- `app.canvas` is allocated once at output size (`resolution: 1`) and re-rendered in place; Mediabunny's `CanvasSource` wraps it directly into a `VideoFrame` — no `getImageData` round-trips.
- Manual Zoom adds no nodes per clip during export. Camera sampling is pure math per frame; the shared `ZoomBlurFilter` is attached only while a camera reports non-zero blur.
- Source decode and encode are both WebCodecs-backed and execute on browser-internal threads (`encodeQueueSize` runs ~4 deep behind the loop). The driver in `run-export.ts` is a single pure async function with an `AbortSignal`.
- The audio mixer holds at most one window-sized `AudioBuffer` plus the per-source decoder pre-fetch (typically a handful of packets per active clip) — peak RAM constant under ~10 MB.
- Decoded-`VideoFrame` lifetime is one loop iteration (decode → upload in render → close); the decoder's own pre-fetch queue (≤8 decoded samples) is the only standing frame inventory.

Per-window CSP / `webSecurity`:

- The export window opts in to `webSecurity: false` (in `createExportWindow`) so cross-origin `<video>` loads from `file://` don't taint the canvas, which would break `new VideoFrame(canvas, …)`.
- The CSP `connect-src 'self' app: file:` is scoped to the export window only via a per-`webContentsId` check in `onHeadersReceived`. Every other window keeps the tighter base CSP (`connect-src 'self' app:`).
- No window's CSP allows `'unsafe-eval'`, in dev or packaged. PixiJS v8 generates uniform/UBO sync code with `new Function` and its renderer `init()` throws without it, so `pixi/create-app.ts` side-effect imports `pixi.js/unsafe-eval` (static, CSP-safe replacements). **Never `new Application()` outside `createPixiApplication()`** — it is the only module that guarantees the import. The same CSP is enforced under `pnpm dev`, so a violation reproduces without packaging.

Cancellation:

- `AbortController.abort()` inside the export page rejects the next `await` in `runExport` (the concurrent audio mixer re-throws AbortError too). The outer `finally` disposes the offscreen Pixi `Application`; the inner `finally` disposes every `SourceFrameProvider` (which cancels in-flight HTTP Range requests, closes the WebCodecs `VideoDecoder`, and closes pre-fetched samples); a per-iteration `finally` closes any `VideoFrame`s pulled for the aborted frame. The streamed temp file is discarded twice over: `runExport`'s catch calls `export:streamAbort`, and main's `cancel` / `reportError` / window-`closed` handlers call the same idempotent discard.
- The renderer-side `cancelEncode` is guarded: it sends the `cancel` IPC only when an `AbortController` is active. This prevents the "click Done on the success screen → file gets deleted" bug by ensuring the cancel handler never runs after a terminal phase.

Known limitations:

- HEVC encode availability varies by OS/GPU. The codec probe hides it when missing.
- The driver runs on the export window's main thread. Long-duration 4K60 exports may stutter the export window's UI (progress bar) under encoder backpressure; the editor stays fully responsive because it's a separate window. The source decode and encode are both already WebCodecs-backed and run on browser-internal threads, so moving the driver itself to a Worker is mostly a UI-stutter mitigation, not a perf win.
- Non-monotonic source timestamps (rare: two clips referencing the same source at out-of-order source times) still work but lose the per-packet decode optimisation of the `…AtTimestamps` sinks — the decoder re-seeks per timestamp jump.
- **Every output frame is rendered and encoded, even when nothing changed.** Screen recordings are often mostly static (ScreenCaptureKit itself delivers no samples while the screen idles, so consecutive output frames map to the *same* decoded sample — detectable via the sample timestamp). Skipping render+encode for unchanged frames and extending the previous frame's duration would cut encode work 2–10× on tutorial-style content, at the cost of a variable-frame-rate output. Deliberately not implemented (2026-06-07) — revisit as an opt-in "fast export" if needed.
- A `prefer-hardware` probe success doesn't *guarantee* Chromium uses the hardware encoder for every frame, only that the config is accepted; `chrome://media-internals` is the ground truth when investigating. The `[export] perf` log line records what was requested and the resolved config.
- If the GPU context is lost mid-export the job fails (Pixi would re-upload textures whose `VideoFrame` resources are already closed); the export is short-lived enough that we fail the job rather than handle resume.
- Audio sample-rate conversion uses linear interpolation inline per output frame. This is fine for the common 44.1 → 48 kHz conversion at screen-recording quality; a polyphase resampler would be sharper for extreme rate ratios but the cost/benefit doesn't justify it today.
- Wallpaper backgrounds load via `fetch(/assets/...)`. On a packaged build this resolves to `app://./assets/...`, which is on the allowlisted protocol — works, but the bitmap is loaded fresh per export.
- Radial zoom blur requires WebGL2 in the renderer/export window. If unavailable, manual Zoom clips still apply the camera transform and export sharp frames; only the blur postprocess is skipped.
- The export settings live in `<userData>/export-settings.json`, **not** inside `project.json`. This is intentional — last-used export preferences are a user-level setting, not project state. Keep them out of `ProjectStateV1`.
- Hard ceilings: timelines above 4 hours and outputs above the 4K nominal pixel budget are refused at the start of `runExport`. Beyond these the failure modes shift from "slow" to "OOM mid-encode", which is unrecoverable; failing early gives the user actionable feedback.

## Problems, Decisions, And Solutions

### React-Konva And Next.js SSR

Problem:

- `react-konva` is browser-only and should not be imported into server-rendered modules.

Decision:

- `EditorWorkspace` is loaded through `next/dynamic` with `ssr: false` from `src/components/editor/main.tsx`.

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
- Video frame callbacks redraw only the Pixi video/content path.
- The grid layer is `listening={false}`.
- The selection outline lives in the screen-space overlay, so decoded video frames do not repaint selection chrome while a video is selected.
- Video nodes stay passive: one delegated DOM pointer handler (`SelectionController`) hit-tests via pure math, avoiding thousands of per-node interaction callbacks in large scenes.
- Timeline playback keeps media control in provider refs. Registered `HTMLVideoElement`s are sampled from the playhead without per-frame React state writes for each canvas node.
- Timeline active-clip visibility uses a cached boundary window, so steady playback between clip starts/ends reuses the current visible id set instead of rescanning every timeline clip on each `requestAnimationFrame`.
- Timeline hover preview is paused-only and gated. Every video `seeked` event flows through the provider's single `onTimelineVideoSeeked(id, element, redrawLayer)` decision: if the element has a live hover entry, redraw the landed decoded frame and then reissue toward the latest hover ref if it moved; otherwise fall back to the committed-time gate. Hover does not exact-match `currentTime` to the requested target because browser seeks can settle up to a decoded frame away during random access. Hover never writes committed state and every committed write cancels the hover pipeline first.
- Paused video `seeked` events are not blindly redrawn. The video node asks the timeline controller whether the decoded frame still matches the committed playhead target before running the redraw callback, so out-of-order seek completions do not create a forward/back frame flash.
- During playback the master active clip drives the cursor from its native `currentTime`; the controller never re-seeks the master and only nudges secondary videos when drift exceeds `TIMELINE_PLAYBACK_DRIFT_SECONDS`. This replaces the older per-frame drift-correction that could trigger small back-and-forth seeks when rAF jitter pushed the rAF-accumulated time above the 80 ms threshold.
- When the src/app/window is hidden, minimized, or loses focus, playback is paused by committing the active video element's actual frame time instead of the last rAF-estimated playhead time. This prevents the cursor tick stream from resuming ahead of or behind the rendered video after browser throttling, macOS Space occlusion, or media suspension.
- Explicit user actions (scrub, click, skip, clip move/resize, play start, clip activation) still go through a single forced sync that snaps every visible video to the target source frame within `TIMELINE_FORCE_SEEK_EPSILON_SECONDS`.
- Inactive clip visibility is implemented by toggling the existing media node handle's `visible` and `listening` state from the timeline controller; it does not add thumbnail canvases, extra Pixi nodes, or DOM overlays.
- Hover bounds use one reusable non-listening overlay graphic. The hover path does not create React state updates, per-node mouse handlers, per-node DOM overlays, or `getClientRect()` scans across the scene.
- Keep video nodes memoized, avoid new per-item callback props from the workspace render loop, and do not update React state on decoded video frames.

References:

- Konva performance guidance: keep computation low, be careful with layer count, use non-listening layers for passive graphics.

### Radial Zoom Blur Preview Overflow

Problem:

- During composition zoom camera transitions, the editor preview could show the blurred video spilling beyond the artboard while export remained correct.
- The Konva artboard clip groups were not the cause. The sharp source layers were clipped; the preview-only DOM radial-blur overlay was being drawn over the workspace.
- `<canvas>` is a replaced element. With only `absolute inset-0`, changing `canvas.width` / `canvas.height` to the high-DPI backing-store size (`viewport * Konva.pixelRatio`) could influence the element's CSS layout size, so the artboard crop was painted onto an oversized overlay canvas.

Decision:

- Keep the radial-blur backing store in device pixels for sharpness.
- Explicitly set the overlay canvas CSS width/height to the viewport's CSS-pixel size, and keep `h-full w-full` on the element.
- Continue drawing only the cropped artboard region back into place. Do not add extra Konva layers or node caches.

Result:

- Preview and export both clip the composition zoom camera to the artboard.
- The fix is constant-cost and scales to large scenes: it changes one DOM canvas' CSS sizing and adds no per-node work.

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

### Squircle Radius / Smoothness Rendering Accuracy (2026-06-06)

Problem (three distinct artifacts reported together as "radius and smoothness not rendering smoothly"):

1. **Self-intersecting outlines at high radius + smoothing.** The original port clamped only the radius to `min(w,h)/2` but left the smoothing extension `p = (1 + smoothing) · radius` unclamped, so `p` could reach `min(w,h)` — twice the per-corner budget. Any combo with `(1 + smoothing) · radius > min(w,h)/2` (with the default 0.6 smoothing, the top ~37 % of the radius slider; **always** for the camera-circle preset `r = min/2, s = 1`) traced edges backwards and overlapped the corner curves. PixiJS's earcut triangulation renders that as notches/spikes/wrong fills, and the border stroke loops over itself — which also read as "the border doesn't hug the corner".
2. **Faceted corners under zoom.** PixiJS tessellates `arc()` with a fixed step count (`6·r^⅓·sweep/π`) that ignores fidelity settings, and béziers default to `bezierSmoothness = 0.5` (≈0.25 px tolerance in artboard units). Both are computed in local space, so the ≤4× composition zoom camera magnifies the segments into visible polygon facets.
3. **Jagged corners while zoom blur is active.** Pixi `Filter.antialias` defaults to `"off"`, so the `ZoomBlurFilter` pass renders the whole artboard composite — including the stencil-masked squircle videos — into a non-multisampled texture. The renderer's `antialias: true` MSAA was silently lost exactly when zoom clips play.

Decision / fix:

- Ported the figma-squircle budget clamp into `computeSquircleCornerParams` (new required `budget` param, `preserveSmoothing` redistribution — see the Squircle math bullets under Video Appearance). All three `compute*Params` helpers in `video-scene-draw.ts` pass their own box's budget (node, border box, spread-grown shadow caster). Within-budget combos are bit-identical to the old output, so the visual regression risk is confined to the previously-broken zone.
- The corner arc is now emitted as ≤45° cubic béziers and every curve carries a `CURVE_FIDELITY = 0.98` per-call tessellation hint (~0.02 px tolerance), keeping the whole outline on PixiJS's adaptive code path. Per-call beats raising the renderer-wide `bezierSmoothness` init option: no global side effects, and the shared trace carries its fidelity into both preview and export by construction.
- `createZoomBlurFilter()` and the shadow `BlurFilter` (set in the shared `applyVideoAppearance`) now use `antialias: "inherit"`, preserving the render target's MSAA through filter passes. The cursor `MotionBlurFilter` is left alone on purpose — its input is a rasterized SVG sprite whose edges come from texture alpha, not geometry, so the AA pass would cost without visible benefit.

Result:

- Circle preset and max-radius/max-smoothing combos trace clean convex outlines (regression-tested); border and shadow stay concentric with the clip at every alignment/offset/spread; corners stay smooth at 4× zoom and during zoom-blur ramps in both preview and export.
- Remaining known ceiling: the squircle clip is still a stencil mask, so edge quality inside any *non*-filter pass is bounded by the renderer's MSAA (4×–8× samples — sub-pixel at DPR 2). If that ever shows, the escalation path is an SDF-style shader clip; deliberately not done now because an analytic squircle SDF only approximates the Figma bézier path and would break clip/border/shadow parity with the shared trace.

References:

- figma-squircle (budget clamp + preserveSmoothing reference): https://github.com/phamfoo/figma-squircle
- PixiJS mask antialiasing history: pixijs/pixijs#2792, #3266, #6429, #9651.

### Zoom Blur Edge Halo (white casting around the artboard, 2026-06-16)

Problem:

- A soft **white halo** appeared around the artboard whenever a zoom clip moved or the cursor-follow camera reframed. The Pixi canvas is transparent (`backgroundAlpha: 0`) and a `bg-white` "paper" `<div>` sits directly behind it (the drop-shadow surface). The directional **`MotionBlurFilter`** (the follow pan blur on `zoomedContent`) samples the input texture symmetrically along `±velocity` **without clamping to the input frame** and with premultiplied-alpha disabled (verified in `pixi-filters` `motion-blur` shader; it also sets `padding = |velocity|`). At the artboard edges those samples land in the transparent padding, so the composite's **alpha falls off in a ring at the edges and smears outward past the artboard rect**. The transparent canvas then let the white div show through → the halo. It only showed during blur because that is the only time edge alpha drops below 1. The **radial** `ZoomBlurFilter` pulls samples one-sidedly *toward* the focus (inward), so it never reaches past the outer edge — which is why pure manual zooms never showed the halo, only auto cursor-follow did. In export the identical falloff revealed the opaque-black clear (a black edge fade) instead of white.

Decision / fix (shared by `scene.ts` preview and `build-stage.ts` export, so preview ↔ export stay pixel-identical):

- **Background backing (`backingCamera`).** An unfiltered, zoom-mirrored copy of the background fill/wallpaper drawn **behind** the blurred composite. It shares the wallpaper texture and mirrors the zoom camera's scale/offset, so it stays pixel-aligned with the composite's own (blurred) background at every depth. The fade ring now reveals the same background instead of the backdrop. When `backgroundEnabled` is false the backing is empty on purpose — the white paper is the intended artboard surface there, so the ring is white-on-white (no artifact).
- **Composite clip (`clip` + `clipMask`).** The filtered `composite` is wrapped in a `clip` container whose artboard-rect mask clips the blur's outward smear so it can't escape onto the workspace. The per-camera masks still clip content *before* the blur; this mask clips the filtered result *after* it. (Putting the mask on a dedicated parent — not on `composite` itself — keeps the filter→mask order unambiguous.)

Why not other approaches: clamping the blur to the input frame would need a forked `MotionBlurFilter` shader (GLSL **and** WGSL for the WebGPU export) and `filterArea`/`padding` tuning against Pixi's pooled-texture sampling — fragile. Bleeding a single oversized background avoids the duplicate layer but changes wallpaper framing (cover-crop has no source headroom in its limiting dimension). The backing keeps the existing framing exactly and reuses only well-understood masking + opaque fills. Cost is one extra fully-occluded background quad per frame (constant layer count — scales fine to large scenes).

Result:

- No white halo in the preview and no black edge fade in the export during follow reframes; edges stay opaque and show the continued background. Verified by `pnpm typecheck` and the canvas/export test suites (131 tests green); no schema/persistence change.

### Canvas Module Refactor

Problem:

- The first implementation concentrated provider state, workspace behavior, rendering nodes, transformer logic, grid drawing, and footer controls into a few broad files.

Decision:

- Split the editor canvas into focused modules under `src/components/editor/canvas/`.
- Rename artboard/canvas helpers into `src/lib/editor-canvas.ts` so the file owns editor canvas constants and math, not only artboard presets.
- Keep UI controls near the canvas feature they control: `ArtboardPresetDropdown` and `CanvasZoomMenu`.

Result:

- Workspace behavior, video rendering, transformer behavior, grid drawing, and state management can now be read and changed independently without changing runtime behavior.

### Zoom Blur Reads As Black On Dark Recordings

Problem (reported 2026-06-06, "preview goes completely black during the zoom transition"):

- During a manual Zoom clip's ramp-in/ramp-out, the whole preview appears black; the hold and non-zoom segments render fine. Pausing or scrubbing onto a ramp frame holds the black frame on screen.

Debugging (isolated Electron harness driving the production `CanvasScene` + `applyZoomBlur` + `sampleZoomCameraAtTime` with the real project geometry — `auto` 3420×2224 artboard, `ipad-17-dark` wallpaper, padding 129, the real HEVC `screen.mov` — and pixel-readback sampling per ramp phase):

- **The rendering pipeline is correct.** Verified empirically: ZoomBlurFilter works on WebGPU and WebGL, with render groups, child masks, nested cursor `MotionBlurFilter`, dynamic mid-playback `filters` attach/detach, `resolution: 2`, and the real video texture. A focus-point marker stays sharp at the configured center (no center/units mismatch — pixi filter resolution is 1, so `applyZoomBlur`'s CSS-px input size matches `uInputSize`). Measured streak lengths match theory exactly (`strength × dist/(1 − strength)`; dots at +200/+400/+800 artboard px produced 34/56/83 px visible streaks at strength 0.146).
- **The black frame is the designed strength doing what it says on dark content.** Chain at defaults (Strength 0.5, scale 2, 600 ms ramps): smootherstep slope peak 1.875 / 0.6 s → `scaleVelocity ≈ 3.1/s` → `motion = (scaleVelocity / scale) × ZOOM_BLUR_MOTION_GAIN(0.14) ≈ 0.29` → `radialBlur = 0.5 × 0.29 ≈ 0.146` → ZoomBlurFilter `strength 0.146` (cap 0.22). That smears every pixel along ~15 % of its distance to the focus — 100–160 artboard px at the edges of a 3420-wide artboard. A dark-mode screen recording is ~90 % near-`#1e1e1e` pixels; the sparse bright text gets averaged 10–30× dimmer along the streak and disappears, so the mid-ramp frame collapses to a near-uniform `rgb(30,30,30)` — perceived as "completely black". Bright content (wallpaper photo) at the same strength looks like a normal dramatic zoom blur.
- The amount bump is intentionally asymmetric (`motion` divides by the *current* scale, so ramp-in peaks harder than ramp-out at the same slope).

Fix (2026-06-06) — retuned for screen content, in the shared modules so preview/export parity is automatic:

- `ZOOM_BLUR_MOTION_GAIN` (src/lib/zoom-clips.ts) 0.14 → **0.05**: a default clip now peaks at filter strength ≈ 0.052 instead of 0.146.
- `ZOOM_BLUR_STRENGTH_CAP` (pixi/zoom-blur.ts) 0.22 → **0.10**: bounds the worst-case edge streak to ~5 % of the artboard width even when a per-clip Strength of 1 saturates the velocity bump.
- Verified with the same harness: at the retuned peak the mid-ramp frame keeps the recording's terminal text legible under a clearly visible radial streak (no black frame), and the ramp still reads as a Screen-Studio-style speed cue. Existing `project.json` files need no change — the per-clip Strength slider semantics are unchanged, only the velocity→strength mapping moved.

### WebGPU Renderer Fallback

Problem:

- The preview was initialized with a hard-coded `preference: "webgpu"` and the export tried `["webgpu", "webgl"]` in an init `try/catch` loop. Both crashed with `ReferenceError: GPUTextureUsage is not defined` (thrown from `app.render()` in `scene.ts`) in environments that expose `navigator.gpu` but **not** the WebGPU global constant namespaces (`GPUTextureUsage`, `GPUShaderStage`) that PixiJS's GPU backend reads directly when uploading textures.
- The failure is *post-init*: an adapter is acquired, `app.init()` succeeds, and an empty-stage render (and the export's 1px readback probe) pass — the crash only fires on the **first real video-texture upload**. So neither the preview's `paint()` try/catch nor the export's init-loop fallback could recover; the editor showed a dead canvas and the export silently broke mid-encode.

Decision:

- `pixi/renderer-preference.ts` has a module-private `preferredRendererBackend()` — returns `"webgpu"` only when both `GPUTextureUsage` and `GPUShaderStage` exist on `globalThis`, otherwise `"webgl"`. Presence of those globals is an exact predictor of whether the WebGPU texture path will throw, so this is a static check rather than a runtime probe.
- Both the preview (`pixi-canvas.tsx`) and the export (`build-stage.ts`) create their renderer through `createPixiApplication()` (`pixi/create-app.ts`), which iterates `rendererPreferenceChain()`. The chain drops `"webgpu"` from the fallback list when the globals are absent — never handing PixiJS a preference that would crash after init.
- When the globals *are* present we still defer to PixiJS's own adapter detection (it falls back to WebGL on its own if no GPU adapter is available).
- **User preference (added 2026-06-06):** the titlebar's **Renderer** dropdown (`src/components/editor/title-bar-renderer-menu.tsx`, right section before Preview/Export) persists a `"webgpu" | "webgl"` choice in `localStorage` (`openscreen:rendererBackend`, app-level — deliberately not `project.json`, since it describes the machine, not the document). `preferredRendererBackend()` applies the choice with the globals gate still on top (a forced WebGPU pick can never crash an unsupported environment), and `rendererPreferenceChain()` follows it so the **export window** (same origin, shared `localStorage`) renders on the same backend as the preview. Changing the preference dispatches `RENDERER_BACKEND_CHANGE_EVENT`; `editor-workspace.tsx` bumps a `key` on `<PixiCanvas>`, remounting the whole Application immediately — the same teardown/re-init path React strict mode exercises.

Result:

- One shared module gates WebGPU for both preview and export; affected environments transparently run on WebGL2 instead of crashing. The `app.render()` try/catch in `scene.ts:paint()` remains a guard for transient per-frame upload races, not for missing-globals failures (which are now prevented up front).
- Runtime loss recovery is separate from backend selection: the preview observes `GPUDevice.lost` after init and remounts the Pixi `Application` on non-`destroyed` losses. That handles macOS / Chromium GPU-resource interruptions that happen after WebGPU was valid at startup; export remains deterministic and uses its existing create-once/offscreen renderer path per job.

### Timeline Clip Gaps And Drag Accuracy (2026-06-07)

Problem:

- Users always saw a gap between adjacent Zoom clips, even ones placed flush by `placeZoomSpan`. Two independent causes:
  1. **Rendering:** the timeline `action` slot used `p-1`, insetting every clip chip 4 px on each side inside its action box. Two clips abutting exactly in time still rendered an 8 px gutter plus borders and rounded corners — flush never *looked* flush.
  2. **Interaction:** `onActionMoving` / `onActionResizing` returned `false` on overlap, and the package dropped the whole step. Pointer events are sampled discretely, so pushing a clip into a neighbour froze it at the last sampled valid position — an arbitrary real gap that depended on drag speed. The 8 px guide-line magnet that should close the gap was also unreliable: the package's adsorption scan never updated `minDis`, so the *last* guide within range won instead of the nearest (often the playhead or a video-row edge).
- Commits compounded this: `moveZoomClip` / `resizeZoomClip` silently `return`ed on overlap (visible jump-back), and pixel↔time conversions left sub-millisecond float residue between "flush" edges in `project.json`.

Decision:

- **Clamp, don't reject.** The package callbacks now accept an adjusted `{ start, end }` return; `RowDnd` applies the corrected transform and the drag continues from there. The panel computes the correction with `clampZoomMove` / `clampZoomResize` (`src/lib/zoom-clips.ts`): the clip slides flush against the neighbour / timeline bound / minimum duration and pins there. Neighbours act as walls (gap bounds come from the committed span via `getZoomGapBounds`), preserving the old "can't cross a neighbour" behavior.
- **Weld on commit.** The same helpers run in the provider commits; edges within `ZOOM_WELD_EPSILON_SECONDS` (1 ms — float-residue scale, far below one frame at 60 fps, so it never overrides an intentional gap) of a gap bound are set exactly equal to it.
- **Nearest-guide fix.** The three adsorption scans in `row_rnd.tsx` track the running minimum distance, so the magnet deterministically picks the closest edge.
- **Hairline gutter.** The `action` slot is now `px-px py-1` (1 px horizontal inset instead of 4 px) for all lanes, and the zoom ghost insets split into `ZOOM_GHOST_INSET_X = 1` / `ZOOM_GHOST_INSET_Y = 4` to match — time-flush clips read as touching with a thin seam.

Result:

- Dragging a zoom clip into its neighbour lands flush every time, at any drag speed, with a zero-second gap in the persisted data; covered by `clampZoomMove` / `clampZoomResize` / `getZoomGapBounds` cases in `src/lib/__tests__/zoom-clips.test.ts`. Video-row clips keep their existing free-move behavior (no same-row collision yet — candidate follow-up alongside drag tooltips and keyboard frame nudges).

### Tiny Zoom Clips (2026-06-07)

Problem:

- `MIN_ZOOM_CLIP_SECONDS` was `1/60` s — frame-sized, chosen so the hover ghost could cover visually-tiny gaps. In practice it allowed creating zoom clips that render as sub-pixel/hairline slivers: impossible to grab (the two fixed 10 px resize handles swallow the whole chip, so the body has no move surface), useless as zooms (a 16 ms clip cannot express even the minimum 150 ms in/out ramps), and hostile to guide-line snapping.
- Worse, tiny clips opened an **overlap door**: `isUsableZoomClip` gated obstacles on `end - start >= MIN`, and a clip resized *to* the minimum can land one float-ulp **below** it (`(start + MIN) - start < MIN` — catastrophic cancellation). Such a clip was invisible to `placeZoomSpan` and `getZoomGapBounds` while still rendering — the add-ghost and drags overlapped it, producing visibly overlapping clips on the Zoom track.

Decision:

- **Two floors.** `MIN_ZOOM_CLIP_SECONDS = 0.5` is the **creation/resize floor** (hover-ghost adds and resize clamps). `ZOOM_CLIP_DEGENERATE_SECONDS = 1/60` is the **validity floor**: `normalizeZoomClips` keeps legacy clips at least this long (no silent data loss on hydration), `clampZoomMove` preserves their real duration on move, and any resize grows them to the creation floor — capped by the gap so growth never crosses a neighbour (`clampZoomResize`'s walls beat the floor).
- **Obstacles are never duration-gated.** Any positive-span clip blocks placement and acts as a clamp wall, killing the float-ulp overlap door. A clip found overlapping the reference (legacy state) is walled off on its nearer side so dragging resolves the overlap.
- **Adds are magnetized** (`snapSeconds` in `placeZoomSpan`): anchors snap flush to the previous clip's end / timeline start, ends extend flush to the next clip's start / timeline end, within 8 px — sub-minimum micro-gaps can no longer be created by hover-adds.
- **Narrow chips degrade gracefully**: adaptive resize-handle widths in the package and the shared content-density ladder for committed chips (see Timeline And Playback → Narrow-chip behavior).

Result:

- Zoom clips can no longer be created or resized below 0.5 s; existing tiny clips survive, remain movable (move-only below 16 px rendered width), and grow to a usable size on first resize; overlaps can no longer be produced by adds or drags, and pre-existing overlaps resolve on drag or hydration. Covered by the sub-minimum-obstacle, snap, duration-preservation, and wall-beats-floor cases in `src/lib/__tests__/zoom-clips.test.ts`.

### Packaged build shows no canvas preview (CSP blocks PixiJS init)

Problem:

- In the packaged app (`pnpm build:mac`) the editor showed no PixiJS canvas while `pnpm dev` worked. Packaged windows get `CSP_BASE` from `electron/main.ts`, which has no `'unsafe-eval'`; PixiJS v8's `AbstractRenderer._unsafeEvalCheck()` throws `Current environment does not allow unsafe-eval, please use pixi.js/unsafe-eval module` during `app.init()`. `void init()` swallowed the rejection, so the host stayed empty with no visible error. The export renderer failed the same way.
- Why it shipped: dev had **no CSP at all** (`onHeadersReceived` was gated on `!isDev`), so any CSP-incompatible dependency worked in dev and only broke after packaging. Each renderer also constructed its own `Application`, so a fix had to be repeated per call site.

Decision:

- **One renderer factory.** `pixi/create-app.ts` → `createPixiApplication()` owns the `pixi.js/unsafe-eval` import and the WebGPU→WebGL2 fallback; preview and export both call it.
- **Same CSP in dev.** `CSP_BASE` / `CSP_EXPORT` are now installed in dev too. The only dev relaxation is `script-src 'unsafe-inline'` (`INLINE_SCRIPT_SOURCES`), because `next dev`'s inline bootstrap scripts change every compile and can't be hash-pinned. `'unsafe-eval'` stays off in both; `next dev` + Turbopack HMR / Fast Refresh run fine without it.
- The editor's `init()` rejection is logged (`[PixiCanvas] renderer init failed:`).
- Rejected: adding `'unsafe-eval'` to the CSP — it would make any injection bug a code-execution bug.

Result / verification (2026-11-11):

- The original packaged build, inspected via `--remote-debugging-port`, threw the exact error above with zero `<canvas>` elements.
- Under `pnpm dev` with the new CSP: `new Function` is blocked (`Evaluating a string as JavaScript violates the following Content Security Policy directive…`); temporarily removing the import from `create-app.ts` reproduces the packaged failure in dev; with the import the canvas mounts.
- Pitfall when probing CSP over CDP: `Runtime.evaluate` defaults `allowUnsafeEvalBlockedByCSP: true`, so evals run from DevTools (including inline scripts it injects synchronously) are exempt and falsely report eval as allowed. Pass `allowUnsafeEvalBlockedByCSP: false`.

## References

- Konva zoom relative to pointer: https://konvajs.org/docs/sandbox/Zooming_Relative_To_Pointer.html
- Konva video on canvas: https://new.konvajs.org/docs/sandbox/Video_On_Canvas.html
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
- `/motion-blur-lab` renders PixiJS, Konva GPU, and Konva CPU panels side by side; Auto Move drives all three from one clock; Stop returns all three to the sharp sprite; the GPU blur direction matches PixiJS/CPU after the WebGL Y-velocity correction.
- Cursor panel exposes a persisted Blur renderer switch (GPU default, CPU option); the live cursor overlay and export both use the selected backend while keeping sharp-at-rest rendering and hotspot/padding-compensated placement.
- Cursor panel exposes persisted Smoothing modes (Rapid, Quick, Default, Slow); the editor rebuilds the derived cursor track off the frame loop and export builds with the same mode.
- Cursor panel exposes a persisted Cursor style picker for the 24 bundled sets using the same 5-column expandable Squircle grid pattern as Background wallpapers; preview and export resolve cursor SVGs from the selected set while keeping one non-listening cursor node.
- Cursor panel exposes a persisted Motion section as a single None → Side lean slider (35 % default); preview/export pass the same amount into shared cursor placement so the pointer leans without hotspot drift. (The direction-follow Rotation mode was removed 2026-06-06.)
- Leaving the app, minimizing it, or blurring fullscreen preview pauses playback at the active video element's actual frame; returning to the app keeps the video frame, playhead, and cursor overlay in sync.

Known unrelated project issue:

- Full `pnpm lint` has failed on pre-existing unrelated files outside this canvas work. Use targeted lint for changed files unless the broader lint cleanup is part of the task.

## PixiJS canvas

The editor canvas — **preview and export** — is **PixiJS v8** (`src/components/editor/canvas/pixi/`). The migration from Konva/react-konva is complete; both packages were uninstalled and there is no Konva fallback. `editor-workspace.tsx` is a thin shell that mounts `<PixiCanvas>` and owns only the outer chrome + the keyboard not already handled by the controllers (undo/redo, frame-step, zoom-clip delete, selected-video delete, preview Space→play) + preview enter/exit (fullscreen + play).

### Architecture (imperative controllers, no @pixi/react)

React owns state + UI; PixiJS lives in imperative controllers that talk to the existing `EditorCanvasProvider` through a thin bridge in `pixi-canvas.tsx`. PixiJS's own event system is **off** (`eventFeatures` all false) — all input is DOM listeners on the host. Rendering is **on-demand**: `app.init({ autoStart:false })`, every scene mutation calls `requestRender()` (one rAF), and a continuous loop runs only during playback (`beginPlayback`/`endPlayback`). The interactive preview is **WebGPU-first** to match the target Pixi renderer path; `createPixiApplication()` (`pixi/create-app.ts`) walks `rendererPreferenceChain()` (`pixi/renderer-preference.ts`), which skips WebGPU in environments that expose `navigator.gpu` yet lack the `GPUTextureUsage` / `GPUShaderStage` globals PixiJS reads at texture-upload time (see *WebGPU Renderer Fallback* under Problems). Resize safety comes from painting immediately after renderer resize rather than falling back to WebGL. Colors go through `resolveCanvasPalette` (PixiJS can't parse `oklch`). The artboard's white "paper" drop shadow stays a DOM `<div>`. Video sprites are `renderable` when timeline-visible and at least one frame has successfully uploaded; `videoEl.readyState >= 2` only gates new `VideoSource.update()` uploads, so rapid seeks keep the last good texture visible instead of blanking. `app.render()` is wrapped in try/catch as a final upload-race guard. The provider-facing Pixi node handle maps Konva-style `batchDraw()` to `scene.renderNodeNow(id)`, which paints immediately after seek/rVFC callbacks; this keeps hover/seek redraw semantics aligned with the old Konva transport while avoiding WebGPU uploads from undecoded frames. Return-from-hidden recovery is preview-only and session-only: `visibilitychange` back to visible, Page Lifecycle `resume`, `pageshow`, and `focus` synchronously paint once and then run six rAF warm-up paints so video `VideoSource.update()` has several chances to refill GPU textures after macOS / Chromium throttling. WebGL `webglcontextlost` is logged and Pixi handles the context restore; `webglcontextrestored` triggers the same warm-up. WebGPU device loss is observed via `GPUDevice.lost`; non-`destroyed` losses bump a local `canvasEpoch`, cleanly destroying and recreating the Pixi `Application` with `releaseGlobalResources: true` so stale pooled GPU resources are not reused.

During hover, `pixi-canvas.tsx` only applies the uncommitted hover time to editor-side overlays such as the cursor overlay and manual Zoom camera. The media frame itself is still driven by the provider's registered `HTMLVideoElement` seek pipeline, just like the old Konva canvas: `CanvasVideoNode` used `image={videoElement}` and `layer.draw()`, while Pixi uses a `VideoSource` texture and `scene.renderNodeNow(id)` to upload and render the same live element after `seeked` / rVFC.

Workspace resize contract: `pixi-canvas.tsx` measures the host in CSS pixels, uses Pixi `autoDensity:true`, resizes the renderer backing store, and writes the canvas element's CSS `width` / `height` to the same CSS-pixel values in the same rAF. Do **not** use `width:100%; height:100%` to stretch the canvas during sidebar collapse/expand; that displays old pixels at a non-uniform scale and creates the elastic-artboard artifact. After the renderer resize and view-transform update, call `CanvasScene.renderNow()` in the same resize frame so the browser does not present stale artboard/content pixels in the new surface. ResizeObserver bursts and window resize events are still coalesced to one renderer resize per animation frame, with the device-pixel-ratio cap re-sampled so moving the window between displays can refresh resolution without per-node work.

Viewport resize is not a gesture: the provider's `setViewportSize` returns the exact fit/clamp transform it computed for the new viewport, and Pixi applies that through `ViewportController.setExternalViewTransform`. It must not call the gesture path (`setViewTransform`) during sidebar animation, because that marks the view as custom and can fight the auto-fit state while the workspace is still changing size.

Scene graph (`pixi/scene.ts`):

```
app.stage
└─ world (render group)                 ← viewport pan/zoom
   └─ artboard (logical px)
      ├─ backgroundCamera → surface { color | wallpaper(cover,+blur) }  [clipped]
      ├─ grid                            [unzoomed]
      ├─ contentCamera → nodesLayer → per node: wrapper{ content(sprite, squircle mask), border }  [clipped]
      └─ border                          [unzoomed, 1/scale]
   (backgroundCamera + contentCamera carry the composition zoom-clip camera)
├─ hover / selection overlays            ← STAGE children, screen space (constant size at any zoom)
```

### Files (`src/components/editor/canvas/pixi/`)

- `create-app.ts` — `createPixiApplication()`: the only place an `Application` is constructed (preview and export). Owns the `pixi.js/unsafe-eval` import and the WebGPU→WebGL2 init fallback; an optional `verify` callback can reject a backend (the export's readback probe).
- `pixi-canvas.tsx` — `Application` lifecycle + provider bridge; owns the host, the white backdrop div, and the preview fill-fit. Selection state is the provider's `selectedItemId` (no canvas-side selection state).
- `cursor-sprite.ts` / `cursor-controller.ts` — the cursor as one Sprite + a `MotionBlurFilter`; `CursorSprite` is shared by the preview controller and the export. `computeCursorBlur` → filter velocity/kernelSize/offset (zero velocity = sharp).
- `zoom-blur.ts` — maps a `ZoomCamera`'s radial-blur amount/center/settings onto a `ZoomBlurFilter` (preview + export).
- `scene.ts` — the scene graph, on-demand render/playback loop, background/grid, per-node video sprites (cover-crop via a dynamic `Texture.frame`), appearance, zoom camera, and the screen-space hover + selection outlines (plain rectangles, no handles).
- `viewport-controller.ts` — wheel/pinch/drag zoom + pan, provider-synced view transform (`setExternalViewTransform` syncs without a feedback loop).
- `selection-controller.ts` — hover + click-to-select only (the transformer with its move/resize/rotate gestures, marquee, and keyboard node commands was removed 2026-06-06 — placement is settings-derived via `src/lib/video-placement.ts`); hit-tests via the pure `src/lib/node-transform.ts`. Hit priority: videos → artboard (a synthetic `CanvasNode` with `ARTBOARD_SELECTION_ID`; selecting it routes the sidebar to the Background tab) → pasteboard (deselect).
- `video-controller.ts` — reconciles the video list, owns the `<video>` elements, runs the rVFC playback loop + FPS measurement, and bridges to the provider transport via a **duck-typed node handle** (the provider only calls `visible()`/`listening()`/`getLayer().batchDraw()` on registered nodes; Pixi maps that draw request to `scene.renderNodeNow(id)` so seek redraws upload the current frame before painting).
- `video-appearance.ts` — native squircle clip + border, sharing `computeSquircleParams` / `computeBorderParams` (`video-scene-draw.ts`) and `src/lib/squircle.ts` with the exporter. (The blurred-caster drop shadow this module also drew was removed entirely on 2026-06-06 — see *Drop shadow removed* under Video Appearance.) The squircle path carries its tessellation fidelity in the trace (see *Squircle Radius / Smoothness Rendering Accuracy* under Problems).
- `background.ts` — framework-agnostic wallpaper cover-crop/blur (reused by the export later).
- `pixel-grid.ts` — high-zoom pixel grid.
- `node-model.ts` — read-side `CanvasVideoItem → CanvasNode` mapping (never persisted).
- New pure libs at repo root: `src/lib/node-transform.ts` (+test), `src/lib/theme-colors.ts`.

### Migrated (preview), green at typecheck + lint + 147 unit tests

Viewport (pan/zoom/fit) · background fill / cover-cropped wallpaper (+blur) · pixel grid · multi-video playback + inactive-clip windowing (provider transport unchanged) · video appearance (squircle/border) · composition zoom-clip camera · hover + click-to-select. (The originally-migrated group selection/marquee/move/resize/rotate transformer was later removed — 2026-06-06 — in favor of settings-derived placement; the migrated drop shadow was likewise removed entirely on 2026-06-06.)

### Phase 2 (done) — cursor + blur via native pixi-filters

Both deferred effects now use **native `pixi-filters`** (the custom WebGL renderers in `src/lib/motion-blur/*` were literal ports of these), applied directly to display objects — no canvas round-trips, no DOM overlay, no per-frame extract. They render in **both the Pixi preview and the export**.

- **Cursor — `MotionBlurFilter`** (`pixi/cursor-sprite.ts`, shared by `pixi/cursor-controller.ts` + the export): one cursor Sprite with the sharp SVG texture and a `MotionBlurFilter` whose `velocity/kernelSize/offset` come from `computeCursorBlur` (zero velocity = sharp; the filter forces kernelSize 0 and auto-pads). The GPU/CPU `cursorMotionBlurBackend` setting is now moot (the filter is GPU).
- **Radial zoom blur — `ZoomBlurFilter`** (`pixi/zoom-blur.ts`): attached to the artboard `composite` (bg + grid + content + cursor) during zoom ease; `strength`/`center`/`innerRadius`/`radius` from the zoom camera (center in filter-input px = artboard × viewport scale in preview, output px in export). The artboard border stays outside the composite so it never blurs.

Pure derivation math (`computeCursorBlur`, `sampleZoomCameraAtTime` + `radialBlurSettings`) is unchanged.

### Cutover (done)

Konva is fully removed: `editor-workspace.tsx` is a thin Pixi shell; the Konva canvas + transformer + cursor overlay + snap-guide overlay + `artboard-*` components, `src/lib/editor-canvas-snap.ts`, the custom `src/lib/motion-blur/*` renderers (the cursor/zoom blurs are now native pixi-filters), and the `/motion-blur-lab` route are deleted; the `openscreen:pixiCanvas` flag and the `cursorMotionBlurBackend` setting are gone (removing an optional schema field needs no migration — old `project.json` files still validate and drop the unused key on next save); and `konva` + `react-konva` are uninstalled. Canvas snapping is gone (only Shift→45° rotation remains; timeline snapping untouched).

### Export (migrated)

`build-stage.ts` + `run-export.ts` render through an **offscreen Pixi `Application`** (WebGPU→WebGL2 with a 1px readback probe), reusing the shared `video-appearance.ts` + `background.ts` + `planExportFrames`. The renderer comes from `createPixiApplication()` (`pixi/create-app.ts`, readback probe passed as `verify`), which iterates `rendererPreferenceChain()` (`pixi/renderer-preference.ts`); the chain **omits the WebGPU attempt entirely** when its globals are missing — init would otherwise succeed and the failure would surface only as `GPUTextureUsage is not defined` on the first per-frame video-texture draw, which the init `try/catch` (and the empty-stage readback probe) can't see. `app.canvas` feeds Mediabunny's `CanvasSource` directly — the per-layer composite blit is gone. Sources are `close()`d early so the muxer can plan ahead. The export reuses the shared `cursor-sprite.ts` + `zoom-blur.ts`, so it renders the **cursor** and **radial zoom blur** in parity with the preview, and now applies wallpaper **blur** too (the old Konva export skipped it). The bitrate ladder, frame plan, audio, and abort handling are unchanged.

### Export speed pass (2026-06-07)

Five changes, no output-pixel changes (preview ↔ export parity untouched — the scene modules and color conversions are identical; decoded YUV→RGB now happens in the texture upload instead of a 2D canvas draw, both via Chromium's same color pipeline):

1. **Direct `VideoFrame` decode path** — `SourceFrameProvider` uses `VideoSampleSink` + `sample.toVideoFrame()` when `canUseDirectVideoFrames` passes (rotation 0, coded == intrinsic); export nodes swap the frame in as the Pixi `ImageSource` upload resource. Two of three full-res per-frame copies on the source path eliminated. Canvas mode remains as fallback.
2. **Hardware-encode probe** — `probePreferHardwareEncode` pins `hardwareAcceleration: 'prefer-hardware'` only when `canEncodeVideo` confirms it; resolved encoder config logged via `onEncoderConfig`.
3. **Concurrent audio** — `streamTimelineAudio` runs alongside the frame loop instead of after it.
4. **Streamed output** — `StreamTarget({chunked: true})` → `export:streamBegin/streamWrite/streamAbort` IPC → positional writes into `.pending-export-*` temp file → `reportDone()` renames. Replaces `BufferTarget` + ArrayBuffer-over-IPC (~4× file size in transient memory) and avoids the MP4 muxer's `fastStart: 'in-memory'` default.
5. **Anti-throttling** — `backgroundThrottling: false` on the export window + `powerSaveBlocker('prevent-app-suspension')` for the duration of the job, so minimizing the window can't starve the encode.

Per-leg timing (`decodeWaitMs` / `renderMs` / `encodeWaitMs`) plus backend/encoder diagnostics log as `[export] perf` in dev builds.

### Known limitations / follow-ups

- Descriptive "Konva" references elsewhere in this doc and in `docs/normal-term.md` predate the migration; the behavior they describe now runs on PixiJS.

### Behavior decisions

- **Transformer removed (2026-06-06):** placement is settings-derived (`src/lib/video-placement.ts`) for every video role; no move/resize/rotate gestures, handles, rotation knob/readout, marquee, multi-select, arrow nudge, lock, duplicate, or selection toolbar. Canvas interaction is hover + click-to-select (`selection-controller.ts`) plus the workspace-level Delete shortcut. Selection is single-select and lives solely on the provider (`selectedItemId`, session-only).
- **Snapping removed** from the Pixi path: with no gestures there is nothing to snap. Timeline snapping (`@openscreen/timeline`) is untouched.
- **Workspace resize** is editor-only chrome: sidebar collapse/expand, window resize, fullscreen preview entry/exit, and device-pixel-ratio changes resize the Pixi preview surface and may update session viewport state, but they do not change `project.json` and are not part of export pixels.
- **Persistence:** `CanvasNode` is a read-side derivation of `CanvasVideoItem`; placement fields are derived-then-persisted (see Project Persistence) — `rotation` writes as 0, `locked` round-trips but is ignored.
- **Renderer:** WebGPU by default with a user preference (titlebar Renderer dropdown, persisted in `localStorage`) to force WebGL2; the WebGPU-globals gate always wins. Preview paints immediately after layout-driven renderer resizes and after visibility/focus resume. If WebGPU reports a non-destroy device loss, the preview remounts the Pixi `Application`; export keeps its offscreen fallback-on-failure init loop and honors the same preference.

### Verification

`pnpm typecheck`, targeted `pnpm exec eslint src/components/editor/canvas/pixi`, and `pnpm exec vitest run` (147 tests) are green for the Pixi migration. Full Electron visual/interaction verification is still useful for release sign-off.

2026-06-07 export speed pass: `pnpm typecheck` (renderer + electron) and `pnpm exec vitest run` (183 tests, including the new `canUseDirectVideoFrames` suite) are green. Manual checks for sign-off: export a retina screen recording with audio + a zoom clip and compare pixel parity against preview; read the `[export] perf` console line (expect `directVideoFrameSources: 1/1`, `hardwareAcceleration: prefer-hardware` on Apple Silicon for H.264/HEVC); cancel mid-encode and confirm no `.pending-export-*` file remains in `~/Documents/openscreen/exports/`; minimize the export window mid-encode and confirm throughput holds; export a multi-minute 4K timeline and watch renderer memory stay flat.

2026-06-06 transformer removal: `pnpm typecheck` (renderer + electron) and `pnpm exec vitest run` (136 tests, including the new `src/lib/video-placement.test.ts` suite) are green. Manual checks for sign-off: open a legacy project with off-center/rotated/locked videos → every video snaps to derived placement with the save indicator staying "Saved"; click/hover/deselect; Delete detaches the selected video while zoom-clip Delete still works; padding slider + preset change relayout every video; confirm drag/resize/rotate/marquee/Cmd+D/Cmd+Shift+L/arrow-nudge are gone; export matches preview.

2026-06-06 macOS Space / GPU resume hardening: `pnpm exec eslint src/components/editor/canvas/pixi/pixi-canvas.tsx src/components/editor/canvas/provider.tsx`, `git diff --check`, `pnpm typecheck`, and `pnpm exec vitest run` (134 tests) are green. Manual check still needed on macOS: play a project on WebGPU, switch to another Space for several minutes, return, confirm playback is paused on the committed video frame, press Play, and verify the Pixi canvas no longer blinks; repeat with the Renderer menu forced to WebGL.

2026-06-04 resize fix: `pnpm exec eslint src/components/editor/canvas/pixi/pixi-canvas.tsx` and `pnpm typecheck` are green. Visual verification should specifically collapse/expand the editor sidebar and confirm the artboard no longer shows canvas bitmap stretch or white edge strips during the animation.

2026-06-06 squircle radius/smoothness accuracy: `pnpm typecheck` (renderer + electron), `pnpm exec vitest run` (146 tests, including the new 12-test `src/lib/squircle.test.ts` suite), and targeted eslint on every touched file are green. Manual checks for sign-off: select a video → drag the Radius slider to max with smoothing 0.6 and 1.0 (no notches/spikes; border + shadow stay concentric); camera circle preset renders a clean circle; play a zoom clip and confirm corners stay smooth mid-ramp (blur pass) and at 4× hold (tessellation); export a clip with rounded corners + zoom and compare against preview.

2026-06-06 drop-shadow removal: `pnpm typecheck` (renderer + electron) and `pnpm exec vitest run` (145 tests — the `computeShadowParams` budget test was removed with the feature) are green. The `shadow*` fields are gone from `CanvasVideoItem` / `ProjectVideo` / `VideoStyleSource`, the schema validator, both persistence serializers, the Video panel (Shadow group + `ColorAlphaSwatch` + `src/lib/rgba-color.ts` deleted), the Pixi preview node tree, and the export stage. Manual check for sign-off: open a legacy project whose `project.json` still carries shadow fields → it loads cleanly and the next save drops the fields; select a video → the Settings view shows only Corners and Border; export and confirm no shadow is rendered.

Local browser smoke (`http://localhost:3535`, DPR 2) confirmed sidebar collapse/expand keeps the Pixi canvas CSS size and backing-store attributes in lock-step (`canvas.width = cssWidth * DPR`, `canvas.height = cssHeight * DPR`) mid-animation. The fit scale now follows the changing workspace (`43% → 51%` on collapse, then `51% → 47% → 44% → 43%` on expand), which verifies resize no longer freezes the previous viewport transform. With an empty artboard, any visible mid-animation edge is viewport clipping, not bitmap stretch.

Follow-up resize fix: local geometry sampling showed the remaining visual artifact was a stale resize frame, not aspect distortion: the artboard stayed 16:9 and the canvas stayed DPR-correct, while the fit scale legitimately changed during sidebar animation. `CanvasScene.renderNow()` now paints immediately after each renderer resize + external view update while keeping the preview renderer WebGPU-first. Re-verify by collapsing/expanding the sidebar and checking that the wallpaper/video content no longer appears stretched or compacted between fit-scale steps.
