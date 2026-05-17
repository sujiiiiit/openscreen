# Editor Canvas Terminology

Use this table when discussion language and implementation language differ. Prefer the industry term in code, docs, comments, and commit messages.

| Discussion term             | Preferred term                  | Meaning in this editor                                                      |
| --------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| Outer canvas                | Workspace or pasteboard         | The bounded editor surface around the artboard.                             |
| Inner canvas                | Artboard or frame               | The editable output area with a chosen aspect ratio and pixel size.         |
| Fit canvas                  | Fit artboard to viewport        | Recenter and scale the artboard so it fits inside the available workspace.  |
| Canvas zoom                 | Viewport zoom                   | The zoom scale applied to the workspace view.                               |
| Canvas position             | Viewport translation            | The `x` and `y` camera offset used to pan the workspace.                    |
| Zoom shake                  | Bound-clamp jump or zoom jitter | A visible shift when pointer-centered zoom collides with pan bounds.        |
| Square grid                 | Pixel grid                      | A high-zoom grid where each cell is one artboard pixel.                     |
| Outer grid                  | Workspace grid                  | A future grid drawn on the dark pasteboard outside the artboard.            |
| Video on canvas             | Video node or media node        | A live `HTMLVideoElement` rendered through `Konva.Image`.                   |
| Resize handles              | Transformer                     | Konva transform controls for resizing and rotating the selected node.       |
| Ratio dropdown              | Artboard preset dropdown        | Footer menu for Wide, Vertical, Portrait, Standard, and Square presets.     |
| Zoom percentage in timeline | Canvas zoom menu                | Footer menu and readout for fit, 50%, 100%, 200%, zoom in, and zoom out.    |
| Background add video button | Media import action             | Local `video/*` file picker in the Background tab.                          |
| Player controls             | Playback controls               | Timeline/play/pause/trim/audio controls, intentionally not implemented yet. |
