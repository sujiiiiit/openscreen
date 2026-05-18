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
| Click-to-open panel         | Sidebar selection bridge        | Mounting that auto-routes any video selection (canvas or timeline) to the Video tab and opens the sidebar.  |
