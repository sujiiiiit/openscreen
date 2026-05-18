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

## Current Scope

Implemented:

- Canva-like bounded editor workspace using Konva and react-konva.
- Two-section resizable layout: fixed/collapsible sidebar plus workspace in the top section, timeline panel in the bottom section.
- Artboard presets: Wide 16:9, Vertical 9:16, Portrait 4:5, Standard 4:3, Square 1:1.
- Local video import from the Background tab.
- Live video playback inside the artboard.
- Timeline panel with top transport controls, playhead scrubbing, unlabeled neutral media lanes, and editable clips.
- Non-destructive source trims for timeline clips.
- Playhead-driven playback sync for screen, camera, and imported media.
- Selection, dragging, resizing, and rotation through Konva `Transformer`.
- Hover outline for unselected video nodes.
- Fixed bottom-center rotation readout while a selected node is rotating.
- Pointer-centered zoom, keyboard zoom, pinch zoom tuning, panning, and zoom dropdown.
- High-zoom artboard pixel grid.
- Snapping with Figma-style alignment guides during drag and resize, plus keyboard arrow nudging with grid snap.
- Workspace theme color token: `editor-workspace` = `#1e1e1e`.

Not implemented yet:

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
| `components/editor/canvas/canvas-video-node.tsx`          | Live video node rendering, frame callbacks, object URL playback, cover crop attrs, and Konva node registration.                                                 |
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
| `types/editor-canvas.ts`                                  | Canvas types: size, artboard, pixel grid settings, view transform, video item, transform patch.                                                                 |
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

- `CanvasVideoItem`: `id`, `fileName`, `objectUrl`, `intrinsicWidth`, `intrinsicHeight`, `durationMs`, `x`, `y`, `width`, `height`, `rotation`, `locked`.
- `CanvasTimelineClip`: `id`, `videoId`, `start`, `end`, `sourceIn`, `sourceOut`.
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
- `registerTimelineVideoElement(id, element | null)`
- `registerTimelineCanvasNode(id, node | null)`
- `setTimelineTime(time)`
- `playTimeline()`, `pauseTimeline()`, `toggleTimelinePlayback()`
- `zoomTimelineIn()`, `zoomTimelineOut()`, `fitTimelineToWidth()`
- `moveTimelineClip(id, start, end)`
- `resizeTimelineClip(id, start, end, direction)`
- `subscribeTimelineTicks(callback)`

Context hooks:

- `useEditorCanvasMedia()`: videos, selection, selected video, import error.
- `useEditorCanvasArtboard()`: current artboard.
- `useEditorCanvasView()`: viewport size and viewport transform.
- `useEditorCanvasTimeline()`: clips, selected clip, playhead time, duration, timeline zoom, fit mode, playback state, primary audio video id.
- `useEditorCanvasActions()`: stable canvas actions.
- `useEditorCanvasTimelineActions()`: stable timeline playback, clip-editing, and media-registration actions.
- `useEditorCanvas()`: compatibility hook that merges every context and should be avoided in hot or narrow components.

`ResizeObserver` updates the viewport size from the workspace area, so the Konva stage follows timeline resizing and sidebar collapse/expand.

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
- The created `objectUrl` is stored and revoked on provider unmount, import failure, or delete when no remaining duplicated video references the same URL.

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
- We do not set `Konva.pixelRatio = 1`; Konva keeps its normal device-pixel-ratio behavior.
- We do not cache video nodes, because caching would freeze or resample moving video.
- We keep image smoothing behavior natural for regular video. Turning smoothing off is more appropriate for pixel art, not normal video.
- Zoom can reveal source detail, but no renderer can invent detail beyond the video file's actual pixels.

## Timeline And Playback

The bottom editor panel now contains the `EditorTimelinePanel`, built on the workspace `@openscreen/timeline` package.

Timeline model:

- Every canvas video receives one `CanvasTimelineClip`.
- `start` and `end` are timeline seconds.
- `sourceIn` and `sourceOut` are non-destructive source seconds.
- Minimum clip duration is `1 / 30` seconds.
- The project timeline duration is the larger of the longest source asset and the furthest edited clip end.
- Timeline transport controls live in the footer's top toolbar, above the ruler and lanes. They use the shared `Button` component, theme foreground/muted colors, `text-xs` proportional timer text in `0:01` / `1:05:00` format, and skip-back/play/skip-forward icon controls. Play/pause uses the same `PlayIcon` / `PauseIcon` pair as the recorder controls.
- The ruler may extend past the longest clip for breathing room, but the playhead is capped at `timelineDuration`: `EditorTimelinePanel` passes `maxCursorTime={timelineDuration}` to the `Timeline` component, which clamps cursor drag and time-area clicks so the user cannot scrub into the empty trailing area.
- Timeline zoom controls live in the footer's top toolbar. Fit is the default timeline view. Zoom in/out changes horizontal density and exits Fit; Fit computes a scale from the visible timeline width so the widest timeline clip block fits the viewport, then scrolls to that clip's start if it begins later in the timeline.
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
- Scrubbing the ruler, clicking the time area, pressing skip controls, or dragging the playhead seeks every registered video element to the sampled source frame.
- `CanvasVideoNode` gates its paused `seeked` redraws through the timeline controller. A decoded frame is allowed to repaint the Konva content layer only when the media element's `currentTime` still matches the committed playhead target. This prevents stale seek redraws where an older completed seek briefly flashes after a newer playhead seek.
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
- React state for the public playhead value is committed on a short interval during playback, not on every decoded video frame.
- Timeline visibility is derived from the active clip set. The controller only toggles Konva `visible` / `listening` on ids whose active state changed, and media sync applies playback work to the active set plus newly inactive ids.
- The active clip-set scan is cached by the nearest timeline clip boundary, so playback does not loop across every clip on every animation frame. A full scan happens after clip/video changes, node registration, or crossing the next clip start/end boundary.
- Hover preview shares the same visibility cache and committed seek primitives (`safeSeekElement`, `getSeekableTimelineSourceTime`, `resolveTimelineFrame`, `syncTimelineVisibility`); only the in-flight bookkeeping and the gate decision are hover-specific.
- The implementation keeps the existing constant Konva layer count and does not add DOM overlays per canvas node.

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
