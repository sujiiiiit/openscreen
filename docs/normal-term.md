# Editor Canvas Terminology

Use this table when discussion language and implementation language differ. Prefer the industry term in code, docs, comments, and commit messages.

| Discussion term             | Preferred term                  | Meaning in this editor                                                                |
| --------------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| Outer canvas                | Workspace or pasteboard         | The bounded editor surface around the artboard.                                       |
| Inner canvas                | Artboard or frame               | The editable output area with a chosen aspect ratio and pixel size.                   |
| Canvas section              | Workspace section               | Top editor section containing the fixed/collapsible sidebar and Konva workspace.      |
| Timeline section            | Timeline panel                  | Resizable bottom editor panel reserved for timeline/playback UI.                      |
| Sidebar section             | Editor sidebar                  | Fixed-width left editor panel with its own collapse animation; it is not resizable.   |
| Fit canvas                  | Fit artboard to viewport        | Recenter and scale the artboard so it fits inside the available workspace.            |
| Canvas zoom                 | Viewport zoom                   | The zoom scale applied to the workspace view.                                         |
| Canvas position             | Viewport translation            | The `x` and `y` camera offset used to pan the workspace.                              |
| Zoom shake                  | Bound-clamp jump or zoom jitter | A visible shift when pointer-centered zoom collides with pan bounds.                  |
| Square grid                 | Pixel grid                      | A high-zoom grid where each cell is one artboard pixel.                               |
| Outer grid                  | Workspace grid                  | A future grid drawn on the dark pasteboard outside the artboard.                      |
| Video on canvas             | Video node or media node        | A live `HTMLVideoElement` rendered through `Konva.Image`.                             |
| Hover bounds                | Hover outline                   | Non-selecting bounds shown around the canvas node under the pointer.                  |
| Rotation degree             | Rotation readout                | Transient degree label shown while rotating a selected canvas node.                   |
| Cover like DOM              | Object-fit cover crop           | Preserve media aspect ratio while the frame crops the visible source area.            |
| Stretched video             | Aspect distortion               | Non-uniform scaling of the video pixels; avoid it for normal media frames.            |
| Resize handles              | Transformer                     | Konva transform controls for resizing and rotating the selected node.                 |
| Toolbar above element       | Selection toolbar               | Floating DOM action bar positioned above the selected canvas node.                    |
| Lock element                | Lock node                       | Disable movement and transforms while keeping selection visible.                      |
| Ratio dropdown              | Artboard preset dropdown        | Footer menu for Wide, Vertical, Portrait, Standard, and Square presets.               |
| Zoom percentage in timeline | Canvas zoom menu                | Footer menu and readout for fit, 50%, 100%, 200%, zoom in, and zoom out.              |
| Background add video button | Media import action             | Local `video/*` file picker in the Background tab.                                    |
| Player controls             | Playback controls               | Timeline/play/pause/trim/audio controls, intentionally not implemented yet.           |
| Pink line during drag       | Snap guide                      | Pink dashed line drawn while a node snaps to an artboard or peer edge.                |
| Smart guides                | Alignment guides                | Snap guides drawn between a dragged node and other nodes on the artboard.             |
| Even-spacing arrows         | Distance guides                 | Equal-spacing segments shown when the dragged node lands between neighbors.           |
| Hold Cmd to ignore snapping | Snap override modifier          | Cmd or Ctrl held during drag or resize, which disables snapping for that interaction. |
| Arrow keys nudge            | Keyboard nudge                  | Move a selected node by 1 artboard pixel per arrow key, 10 with Shift.                |
