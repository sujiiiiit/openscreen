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
- Pointer-centered zoom, keyboard zoom, pinch zoom tuning, panning, and zoom dropdown.
- High-zoom artboard pixel grid.
- Workspace theme color token: `editor-workspace` = `#1e1e1e`.

Not implemented yet:

- Timeline editing.
- Player controls.
- Export/render pipeline.
- Audio controls.
- Cropping/masking.
- Snapping and guides.
- Workspace grid outside the artboard.
- Soft-bound zoom settling to remove hard edge jumps completely.

## Packages

- `konva@10.3.0`
- `react-konva@19.2.4`

`react-konva` is browser-only, so the stage is loaded with `next/dynamic(..., { ssr: false })` in `components/editor/main.tsx`.

## Files

| File                                                      | Responsibility                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app/page.tsx`                                            | Top-level editor layout. Wraps the editor in `EditorCanvasProvider`, tooltip provider, vertical resizable panels, sidebar, main workspace, and footer. |
| `components/editor/main.tsx`                              | Client-only dynamic import for `EditorWorkspace`.                                                                                                      |
| `components/editor/background-panel.tsx`                  | Background tab upload UI for adding local video files.                                                                                                 |
| `components/editor/footer.tsx`                            | Footer/timeline placeholder, artboard preset dropdown, and canvas zoom dropdown.                                                                       |
| `components/editor/canvas/provider.tsx`                   | Editor canvas state, video import metadata, artboard state, viewport size, view transform, and actions.                                                |
| `components/editor/canvas/editor-workspace.tsx`           | Konva stage shell, layer composition, viewport sizing, zoom, pan, and keyboard shortcuts.                                                              |
| `components/editor/canvas/artboard-pixel-grid.tsx`        | Custom non-listening pixel grid renderer for high zoom inside the artboard.                                                                            |
| `components/editor/canvas/canvas-video-node.tsx`          | Live video node rendering, frame callbacks, drag/transform persistence, and object URL playback.                                                       |
| `components/editor/canvas/selected-video-transformer.tsx` | Selected node transformer wiring, handle sizing, rotation snaps, and transform constraints.                                                            |
| `components/editor/canvas/artboard-preset-dropdown.tsx`   | Artboard preset dropdown in the footer.                                                                                                                |
| `components/editor/canvas/canvas-zoom-menu.tsx`           | Canvas zoom dropdown and zoom percentage readout.                                                                                                      |
| `components/editor/canvas/canvas-node-constants.ts`       | Shared transformer constants for anchors, snap angles, minimum size, and control colors.                                                               |
| `components/editor/canvas/view-transform-utils.ts`        | Viewport interaction helpers for input target checks, modifier detection, and screen-pixel snapping.                                                   |
| `components/ui/dropdown-menu.tsx`                         | Shared dropdown menu primitives used by artboard and zoom controls.                                                                                    |
| `lib/editor-canvas.ts`                                    | Artboard presets, zoom/grid constants, fit transform, clamped view helpers, and pointer-centered zoom helper.                                          |
| `types/editor-canvas.ts`                                  | Canvas types: size, artboard, pixel grid settings, view transform, video item, transform patch.                                                        |
| `app/globals.css`                                         | Theme tokens, including `--editor-workspace`.                                                                                                          |
| `docs/normal-term.md`                                     | Developer-friendly translation table from discussion terms to industry terms.                                                                          |

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
            SelectedVideoTransformer
    Footer
      ArtboardPresetDropdown
      CanvasZoomMenu
      Timeline placeholder
```

Layer split:

- Background/grid layer is non-interactive and is not redrawn for every video frame.
- Content layer contains videos and the transformer. Video frame updates call `batchDraw()` on this layer only.

## State Model

`EditorCanvasProvider` owns the canvas state and exposes narrowed context hooks so unrelated UI does not subscribe to every canvas state change.

Important types:

- `CanvasVideoItem`: `id`, `fileName`, `objectUrl`, `intrinsicWidth`, `intrinsicHeight`, `x`, `y`, `width`, `height`, `rotation`.
- `EditorArtboard`: `presetId`, `width`, `height`.
- `ViewTransform`: `scale`, `x`, `y`.
- `PixelGridSettings`: `enabled`, `unit`, `majorUnit`, `visibleFromScale`, `opacity`, `color`, `majorOpacity`, `majorColor`, `role`.

Important actions:

- `addVideoFile(file)`
- `selectItem(id | null)`
- `updateVideoTransform(id, patch)`
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
- The created `objectUrl` is stored and revoked on provider unmount or import failure.

For rendering:

- Each `CanvasVideoNode` creates one hidden `HTMLVideoElement`.
- Video element settings: `muted = true`, `loop = true`, `playsInline = true`, `preload = "auto"`.
- The actual `HTMLVideoElement` is passed directly to `Konva.Image` through the `image` prop.
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

Dragging:

- Selected videos are draggable unless pan mode is active.
- Drag end stores `x` and `y` back into provider state.

Transforming:

- Corner anchors only.
- Aspect ratio is preserved with `keepRatio`.
- Rotation is enabled with snaps at 0, 45, 90, 135, 180, 225, 270, and 315 degrees.
- Flip is disabled.
- Minimum transformed size is 32 px.
- On transform end, scale is baked into `width` and `height`, then node scale resets to 1.
- Transformer handles, border, and rotation offset are adjusted by `1 / viewScale` so they remain screen-sized at high zoom.

Panning:

- Space + drag pans.
- Middle mouse drag pans.
- Normal wheel pans the bounded workspace.
- High-frequency zoom and pan commits are coalesced with `requestAnimationFrame`, while a ref keeps pointer math current between React renders.

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
- Snapping.
- Layout guide grid.
- Overlay grid above content.

Terminology reminder: if the user says "outer canvas grid", call it a "workspace grid" or "pasteboard grid". Do not confuse it with the artboard pixel grid.

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

- Split the stage into a background/grid layer and a content layer.
- Video frame callbacks only call `contentLayer.batchDraw()`.
- The grid layer is `listening={false}`.
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
- Memoize `CanvasVideoNode` and pass stable `onNodeChange(id, node)`, `onSelect(id)`, and `onChange(id, patch)` callbacks.
- Coalesce pointer-driven viewport transform commits through `requestAnimationFrame`.
- Bail out of no-op selection, viewport-size, and video-transform state updates.

Result:

- Zoom/pan still updates the stage and zoom menu, but it does not also re-render media import UI, artboard preset UI, or unchanged video node components.

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
