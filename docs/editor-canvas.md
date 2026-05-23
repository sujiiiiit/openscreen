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
| `components/editor/canvas/canvas-video-node.tsx`          | Live video node rendering, frame callbacks, object URL playback, cover crop attrs, squircle sceneFunc with passes for drop shadow (off-canvas-cast technique) and per-node border, hitFunc kept at the node body, and Konva node registration.   |
| `components/editor/video-panel.tsx`                       | Video tab UI: file-card list of every video on the canvas, with the appearance controls (Corners — radius + smoothing; Border — width, color, alignment, offset; Shadow — color with baked alpha, X, Y, blur, spread) shown when a card is selected.              |
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
  - **List view** (no selection): heading + one-line description + a single-column stack of `Squircle` file cards, one per video on the canvas. Each card shows the `FileEmpty02` icon on the left and the file name + file size stacked on the right (formatted via a local `formatFileSize` helper — no monospace digit treatment). Tapping a card calls `selectItem(id)`, which is the single source of truth: canvas Transformer, timeline clip highlight, and the panel itself all derive from it.
  - **Settings view** (video selected): replaces the heading with a `Button variant="link"` "← Videos" affordance at the same `text-sm font-semibold` slot, with its own one-line description below. Clicking it calls `selectItem(null)`, returning the user to list view and clearing the canvas / timeline selection in the same hop. Beneath the heading sit three appearance groups:
    - **Corners** — radius + smoothing.
    - **Border** — width slider, color swatch with native `<input type="color">`, alignment radiogroup of `inside | center | outside`, and offset slider in `[-64, +64]` artboard px. All Border controls except Width are disabled while `borderWidth === 0`, mirroring Figma's "no stroke when width is 0" behaviour.
    - **Shadow** — inline color row (`ColorAlphaSwatch`: a checker-backed native `<input type="color">` swatch with a directly-editable hex text input beside it — no popover), Opacity slider (0–100% — edits the alpha channel of `shadowColor`, default 25%), and X / Y / Blur / Spread sliders. Opacity lives on its own row beside the spatial sliders, but `shadowColor` remains the single source of truth and stores alpha as part of the rgba string.
- When no videos exist yet, list view shows an inline `Squircle` hint pointing at the Background tab.
- The settings-view subtree is keyed on the video id so internal refs reset cleanly across selections.
- `CanvasVideoItem.fileSize` is populated from `File.size` on local uploads and `ProjectAsset.fileSize` on hydration, and falls back to `0` ("Unknown size") for remote streams without a known byte count.

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
- `videos: ProjectVideo[]` — one entry per `CanvasVideoItem`, including its `source`:
  - `{ kind: "recording", assetRole: "screen" | "camera" }` — file path resolves through `project.assets` (which itself resolves from `recording.json`).
  - `{ kind: "imported", relativePath, fileSize }` — `relativePath` is always inside `<project>/assets/videos/<id>/`.
- `timelineClips: ProjectTimelineClip[]` — `start`, `end`, `sourceIn`, `sourceOut` per clip.
- `updatedAtUnixMs` — refreshed by main on every successful write.

Not persisted: selection, playhead time, timeline zoom/scroll, viewport transform, hover preview state, all `*Ref` runtime state. The view always re-fits the artboard on load.

Hydration (in `components/editor/canvas/provider.tsx`):

- Fast path — `project.state` present: write the saved `artboard`, `videos`, and `timelineClips` directly into state. Each video's `objectUrl` is taken from `ProjectSummary.assetUrlsByVideoId[video.id]`, which main computes by joining the project folder with `source.relativePath` (or the resolved recording asset URL). Missing files leave that entry undefined — the renderer keeps the node so the user can see what is broken instead of silently dropping it.
- Slow path — `project.state` is `null` (first open after a recording, or schema mismatch): the existing flow runs (probe screen/camera metadata via `readVideoMetadata`, pick an Auto vs Wide preset, add videos with `source: { kind: "recording", assetRole }`). The next user edit creates `project.json`.

Autosave:

- A single effect watches `artboard`, `videos`, and `timelineClips`. Any change schedules a `setTimeout` after `PROJECT_STATE_AUTOSAVE_DEBOUNCE_MS` (500 ms) that calls `window.api.projects.saveState(project.path, snapshot)`.
- `window` `blur` and `beforeunload` listeners flush the pending timer synchronously so quick edits before quit make it to disk.
- A "single writer + pending" pair (`autosaveInFlightRef` / `autosavePendingRef`) collapses concurrent writes — at most one IPC save is in flight, and any change made during it triggers one follow-up write when it returns.
- Both the debounced effect and the flush listeners gate on `hydratedProjectIdRef.current === project.id`, so saves never fire before hydration completes or with the wrong project's path.

Imported video files:

- `addVideoFile(file)` probes the file with a transient blob URL (for intrinsic size + duration), then ships `file.arrayBuffer()` over IPC to `projects:importAsset`. The main handler writes it to `<project>/assets/videos/<id>/<sanitized-name>` and returns the `file://` URL plus the relative path. The `CanvasVideoItem` ends up with `source: { kind: "imported", relativePath, fileSize }` and uses the returned URL as its `objectUrl`.
- Filenames are sanitised in main (`sanitizeFileName`) and the resolved path is rejected unless it is inside the project folder, so a hostile asset can never escape `<project>/assets/`.

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
