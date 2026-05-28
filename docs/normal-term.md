# Editor Canvas Terminology

Use this table when discussion language and implementation language differ. Prefer the industry term in code, docs, comments, and commit messages.

| Discussion term             | Preferred term                  | Meaning in this editor                                                                                      |
| --------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Outer canvas                | Workspace or pasteboard         | The bounded editor surface around the artboard.                                                             |
| Inner canvas                | Artboard or frame               | The editable output area with a chosen aspect ratio and pixel size.                                         |
| Canvas section              | Workspace section               | Top editor section containing the fixed/collapsible sidebar and Konva workspace.                            |
| Timeline section            | Timeline panel                  | Resizable bottom editor panel reserved for timeline/playback UI.                                            |
| Sidebar section             | Editor sidebar                  | Fixed-width left editor panel with its own collapse animation; it is not resizable.                         |
| Fit canvas                  | Fit artboard to viewport        | Recenter and scale the artboard so it fits inside the available workspace.                                  |
| Canvas zoom                 | Viewport zoom                   | The zoom scale applied to the workspace view.                                                               |
| Canvas position             | Viewport translation            | The `x` and `y` camera offset used to pan the workspace.                                                    |
| Zoom shake                  | Bound-clamp jump or zoom jitter | A visible shift when pointer-centered zoom collides with pan bounds.                                        |
| Square grid                 | Pixel grid                      | A high-zoom grid where each cell is one artboard pixel.                                                     |
| Outer grid                  | Workspace grid                  | A future grid drawn on the dark pasteboard outside the artboard.                                            |
| Video on canvas             | Video node or media node        | A live `HTMLVideoElement` rendered through `Konva.Image`.                                                   |
| Hover bounds                | Hover outline                   | Non-selecting bounds shown around the canvas node under the pointer.                                        |
| Rotation degree             | Rotation readout                | Transient degree label shown while rotating a selected canvas node.                                         |
| Cover like DOM              | Object-fit cover crop           | Preserve media aspect ratio while the frame crops the visible source area.                                  |
| Stretched video             | Aspect distortion               | Non-uniform scaling of the video pixels; avoid it for normal media frames.                                  |
| Resize handles              | Transformer                     | Konva transform controls for resizing and rotating the selected node.                                       |
| Toolbar above element       | Selection toolbar               | Floating DOM action bar positioned above the selected canvas node.                                          |
| Lock element                | Lock node                       | Disable movement and transforms while keeping selection visible.                                            |
| Ratio dropdown              | Artboard preset dropdown        | Footer menu for Wide, Vertical, Portrait, Standard, and Square presets.                                     |
| Zoom percentage in timeline | Canvas zoom menu                | Footer menu and readout for fit, 50%, 100%, 200%, zoom in, and zoom out.                                    |
| Background add video button | Media import action             | Local `video/*` file picker in the Background tab.                                                          |
| Player controls             | Timeline transport controls     | Theme-colored skip, play/pause, and playback time controls in the top toolbar.                              |
| Timeline block              | Timeline clip                   | Non-destructive clip range that references one canvas video.                                                |
| Left labels in timeline     | Track label rail                | Fixed row-name column beside timeline lanes; omitted while keeping a 30 px start inset.                     |
| Color on tracks             | Role-colored track background   | Role-tinted lane background; currently omitted in favor of neutral lanes.                                   |
| Lines every second          | Timeline grid background        | Full-height time grid in the lane area; currently disabled for a cleaner editor UI.                         |
| Grpd snap / grid snap       | Timeline grid snap              | Snap timeline clip move/resize operations to ruler subdivisions.                                            |
| Auxiliary line snap         | Timeline guide-line snap        | Snap clip edges to other clip edges or the playhead, with temporary vertical guides.                        |
| Auto scroll                 | Timeline edge auto-scroll       | Scroll the visible timeline while dragging near the edge.                                                   |
| Ruler time style            | Ruler tick label format         | Clock-style ruler labels such as `0:15`; only compact major dots stay visible while labels keep a wide gap. |
| Timeline zoom               | Timeline zoom                   | Increase or decrease timeline horizontal density.                                                           |
| Fit timeline                | Fit longest clip to width       | Default view that scales the widest timeline clip block to the visible width.                               |
| Play cursor                 | Playhead                        | Current committed timeline time used to sync canvas media.                                                  |
| Secondary seek              | Removed timeline hover preview  | Former paused-only hover playhead; hover no longer seeks canvas media or changes the transport readout.     |
| Hover frame sequence        | Removed canvas hover seeking    | Former hover-driven media seeking path; pointer movement no longer drives video decoder seeks.              |
| Preview seek                | Removed hover preview seek      | Former uncommitted media seek from timeline hover; removed from the editor.                                 |
| Lagged preview frames       | Removed hover preview drift     | Visible delay from the removed hover-preview seek path.                                                     |
| Frames going forth and back | Stale seek redraw               | An older completed media seek repainting the canvas after a newer committed playhead seek.                  |
| Cut video edge              | Source trim                     | Non-destructive source in/out change from resizing a timeline clip.                                         |
| Frozen clip frame           | Inactive clip visibility        | Hide a media node outside its active timeline clip range instead of holding a frame.                        |
| Total timeline length       | Timeline duration               | The playback duration, initially longest source asset and then furthest clip end.                           |
| Sync with canvas            | Playback sync                   | Keep media element source times aligned with the committed timeline playhead and Konva redraws.             |
| Step-and-step scrub / jumpy preview | Committed seek coalescing | One in-flight committed (scrub/click/skip) seek per element that paints each landed frame and reissues toward the latest playhead, so the preview tracks the drag instead of lagging in chunks. Tracked in `committedSeekStateRef`. |
| Step one frame / nudge the playhead | Frame step                | Move the playhead by exactly one source frame (`stepTimelineFrame`); bound to `,` / `.` and the inner transport chevrons, and snapped to the clip's frame grid. |
| Clip frame rate / fps       | Source fps (measured)           | Per-clip source frame rate measured during playback via `requestVideoFrameCallback`; session-only (`videoFpsRef`), drives frame-step granularity, defaults to 60. |
| Pink line during drag       | Snap guide                      | Pink dashed line drawn while a node snaps to an artboard or peer edge.                                      |
| Smart guides                | Alignment guides                | Snap guides drawn between a dragged node and other nodes on the artboard.                                   |
| Even-spacing arrows         | Distance guides                 | Equal-spacing segments shown when the dragged node lands between neighbors.                                 |
| Hold Cmd to ignore snapping | Snap override modifier          | Cmd or Ctrl held during drag or resize, which disables snapping for that interaction.                       |
| Arrow keys nudge            | Keyboard nudge                  | Move a selected node by 1 artboard pixel per arrow key, 10 with Shift.                                      |
| Margin around the recording | Artboard padding                | Inset of the screen-role video from each artboard edge, stored in artboard pixels for direct control.       |
| Fit inside padded box       | Padded contain-fit              | Aspect-preserving fit of a screen-role video inside the padded inner rect; reveals background on the sides. |
| Border radius / rounded corners | Corner radius                  | The squircle corner radius applied to a video node, stored in artboard pixels.                              |
| Smooth corners / iOS corners | Corner smoothing (squircle)    | Per-node 0–1 smoothing factor; 0 = circular arc, 0.6 = macOS look, 1 = fully continuous-curvature squircle. |
| Round camera                | Camera squircle (max radius)    | Default camera appearance: corner radius = ½·min(w,h), smoothing = 1. Renders identically to the prior elliptical sceneFunc but goes through the unified squircle pipeline. |
| Outline / stroke / frame    | Node border                     | Per-node squircle-following stroke. Width 0 hides it; offset (signed) and alignment (inside/center/outside) control where it sits relative to the node edge. |
| Border thickness            | Border width                    | Stroke width in artboard pixels. `0` disables the border for the whole render path. |
| Border outline color        | Border color                    | CSS color for the stroke; defaults to `#000000`.                                            |
| Stroke alignment / inside-outside stroke | Border alignment   | Where the stroke sits relative to the (already-offset) centerline: `inside`, `center`, or `outside`. Matches Figma stroke alignment. |
| Border gap                  | Border offset                   | Signed gap in artboard px between the node edge and the stroke centerline; positive pushes outward, negative pulls inward. |
| Drop shadow / box shadow    | Node drop shadow                | Per-node squircle-following drop shadow rendered behind the video via an off-canvas-cast trick. Skipped entirely when alpha is 0 or every spatial field is 0. |
| Shadow distance / X & Y     | Shadow offset                   | Signed displacement of the cast shadow from the silhouette, in artboard px. |
| Shadow softness             | Shadow blur                     | Gaussian blur radius of the shadow, in artboard px. `0` means a sharp duplicate cast. |
| Shadow expand / inflate     | Shadow spread                   | Figma-style spread. Positive grows the shadow caster silhouette outward (corner radius grows with it); negative shrinks. |
| Shadow color with opacity / hex 8 | Shadow color (rgba)       | The shadow color string, with alpha baked into the value (`rgba(R, G, B, A)`). Hex is tuned via the swatch popover; the alpha channel is exposed as a sibling Opacity slider so the user can tune transparency without re-opening the swatch. |
| Click-to-open panel         | Sidebar selection bridge        | Mounting that auto-routes any video selection (canvas or timeline) to the Video tab and opens the sidebar.  |
| File item / file in video tab | Video file card               | One `Squircle` row in the Video tab's list view, showing a video's file name + formatted file size. On-canvas cards show **Select** (selects the video); detached cards show **Add** (re-attaches it). |
| Delete video / remove from canvas | Detach video (remove from canvas) | `deleteVideo(id)` — moves a video off the canvas/timeline into `detachedVideos` without removing it from the project or deleting its file. The opposite of a true delete. |
| Add back / re-add video     | Re-attach video                 | `addVideoToCanvas(id)` — puts a detached video back on the canvas with a fresh full-length timeline clip; keeps its stored position/size/appearance. |
| Removed-but-kept video      | Detached video                  | A project video with `onCanvas: false` — not on the canvas/timeline, no clip, but still listed in the Video tab and persisted in `project.json`. |
| Unknown size                | File size fallback              | The `"Unknown size"` label shown by `formatFileSize` when a video's `fileSize` is `0` or non-finite (genuinely unknown byte count). |
| Project file / save file    | Project state file              | `project.json` next to `recording.json`; the autosaved `ProjectStateV1` document that fully describes the editor arrangement. |
| Project folder              | Project folder                  | `~/Documents/openscreen/<ISO-timestamp>/`; one self-contained folder per recording, holding `recording.json`, the `.mov` files, `project.json`, and `assets/`. |
| Dragged-in video / external file | Imported asset             | A user-supplied video file copied into `<project>/assets/videos/<id>/`. Recorded screen/camera tracks are NOT imported assets — they stay where the recorder put them. |
| Background image preset     | Wallpaper                       | A stock background image shipped with the app and referenced by stable `WallpaperId`; not copied per project. |
| Auto-save / save-on-edit    | Autosave                        | The 500 ms debounced write of the current editor state into `project.json`, with extra flushes on window blur and `beforeunload`. |
| Step back / take back       | Undo                            | Restore the previous document snapshot from the in-memory `historyRef` (Cmd/Ctrl+Z). Restores `{ artboard, videos, timelineClips }` only. |
| Redo / replay               | Redo                            | Re-apply the next snapshot after one or more undos (Cmd/Ctrl+Shift+Z). |
| Undo step                   | History snapshot                | One `{ artboard, videos, timelineClips }` `ProjectStateV1` entry held in the in-memory undo stack. Pushed by the autosave-aligned push site. |
| Action category             | Commit tag                      | Action-category label (`transform`, `appearance`, `nudge`, `lock`, `add`, `delete`, `duplicate`, `preset`, `background`, `padding`, `grain`, `clip-move`, `clip-resize`) stamped by each action; read by the push site to decide between coalesce and new entry. |
| Bundle window               | Coalesce window                 | The 2 s window during which same-tag pushes replace the top entry instead of appending. |
| Save as video / render out  | Export                          | Encode the current `ProjectStateV1` snapshot into a single `.mp4` / `.webm` file under `~/Documents/openscreen/exports/`. |
| Export settings window      | Export window                   | Separate vibrancy-panel `BrowserWindow` (`exportWin` in `electron/windowConfigs.ts`) hosting the settings form + progress UI for an export job. |
| Time on the output timeline | Composition time                | Output-timeline position `T_c` in seconds, in `[0, timelineDuration]`. Drives `frame = T_c × fps`. |
| Time inside a source clip   | Source time                     | Per-clip seek position `T_s = sourceIn + (T_c − clip.start)`, in seconds. Computed only for clips active at `T_c`. |
| Frame-by-frame render loop  | Export frame loop               | The sequential per-frame loop in `run-export.ts`: seek active clips → `stage.draw()` → composite → `videoSource.add()`. |
| Combined output canvas      | Export composite                | The single stable `<canvas>` flattened from every Konva layer each frame; the only canvas Mediabunny's `CanvasSource` ever reads. |
| Export render surface       | Export stage                    | The vanilla-Konva `Konva.Stage` built from a `ProjectStateV1` snapshot. Sized to the output's pixel dimensions, scaled so all node attrs stay in artboard space. |
| Blank white output          | Missing export source frames    | Export failure mode where active timeline clips produce no decoded source canvases, leaving only the artboard background for the correct duration. |
| Custom cursor / fake cursor / SVG cursor | Cursor overlay              | A themed SVG cursor (`CanvasCursorOverlay`) drawn on top of the screen video, driven by the recording's captured cursor track. Replaces the OS cursor with a crisp, restylable, hotspot-accurate pointer. |
| Cursor shape / pointer image | Cursor asset                   | One themed SVG (per `cursorId`) in a cursor set under `public/assets/cursors/sets/<set>`, with a hotspot encoded in its filename (`<asset>-<variant>__<hotXpct>-<hotYpct>.svg`). Resolved via `lib/cursors/cursor-set.ts`. |
| Cursor click point          | Cursor hotspot                  | The point within a cursor SVG that sits exactly on the recorded pointer position (a 0..1 fraction of the SVG box). Drives the Konva offset so rotation/scale pivot on it. |
| Smoothed cursor path        | Cursor track                    | The pre-integrated, spring-smoothed, time-indexed cursor trajectory (`lib/cursors/cursor-track.ts`), sampled by the screen recording's source time. Session-only / derived — never persisted. |
| Cursor size / cursor magnification / bigger pointer | Cursor size (`cursorSizeMultiplier`) | User-adjustable render-size multiplier for the cursor overlay (`1` = recorded-accurate minimum, default `2.7` = 270 %, max `4`). Sidebar Cursor tab; stored on `EditorArtboard`, persisted, applied identically in editor + export. Scales the render box only — position/hotspot/timing stay exact. |
| Fullscreen play / present / preview the video | Fullscreen preview          | Session-only mode (`isPreviewMode`) that fullscreens the workspace, fill-fits the artboard, hides all editor chrome, and auto-plays the composition start-to-end like a video player. Launched by the titlebar "Preview" button; reuses the live playback engine. |
| Fill the screen / no black margins | Fill-fit (preview contain-fit) | The zero-padding contain-fit transform (`getPreviewFillTransform`) used only in fullscreen preview. Preserves aspect (letterbox bars, no crop); distinct from the normal `getFitViewTransform` which keeps a 96 px margin. |
| Preview player bar / play overlay | Preview controls               | The DOM overlay (`preview-controls.tsx`) shown only in fullscreen preview: click/Space toggle, auto-hiding transport + scrub bar, Exit button, and a Replay button at the end. |
