---
name: konvajs
description: Comprehensive guide to building 2D canvas applications with Konva.js and react-konva — covers the Stage/Layer/Shape hierarchy, all shape types, events, drag-and-drop, the Transformer, animations, tweens, filters, image handling, serialization, custom shapes, performance optimization, and common app patterns (drawing apps, design editors, image labelers, seat maps, infinite canvases, snapping, undo/redo). Use this skill whenever the user mentions Konva, react-konva, HTML5 canvas with object-oriented shapes, building a canvas-based editor, design tool, whiteboard, drawing app, image annotation, draggable canvas elements, canvas transformations, or any task that needs interactive 2D graphics in the browser — even if they only describe the goal (e.g. "I want users to drag shapes on a canvas") without naming Konva. Also triggers on questions about canvas performance, exporting canvas to image/PDF, freehand drawing, sprite animation, or porting Fabric.js/PixiJS code.
metadata:
  type: library-guide
  library: konva, react-konva
  version: "9.x / 18.x"
---

# Konva.js & React-Konva

Konva is an object-oriented 2D HTML5 Canvas framework. Instead of issuing imperative `ctx.fillRect(...)` calls, you build a scene graph of **Stage → Layer → Group → Shape** nodes — each node has identity, attributes, events, transforms, and a position in the hierarchy. Konva re-renders the canvas for you.

`react-konva` is the official React binding: each Konva class becomes a React component (`<Stage>`, `<Layer>`, `<Rect>`, `<Circle>`, `<Image>`, `<Transformer>` …). Component tree ↔ scene graph.

This skill covers everything needed to build real applications — design tools, whiteboards, image annotators, seat maps, diagram editors, infinite canvases — in either vanilla Konva or react-konva.

## When this skill is most useful

Use it for any of:

- Building a canvas-based UI: editor, design tool, whiteboard, annotation tool, diagram, planner, map
- Anything involving **draggable shapes**, **resize handles**, or **rotation handles** on a canvas
- **Freehand drawing** / brush / signature / eraser
- **Image manipulation** in the browser: crop, rotate, watermark, filter
- **Exporting** canvas content to PNG/JPEG/Blob/PDF
- **Sprite animation** or frame-based animation
- Porting code from Fabric.js, PixiJS, Paper.js, or raw `<canvas>` to a structured framework
- React performance issues around canvas (re-renders, refs, state sync)

You should reach for this skill even if the user doesn't say "Konva" — phrases like "let users drag images on a canvas", "build a Figma-like editor", "draw arrows between boxes", "free drawing app" all signal it.

## Architecture in one diagram

```
Stage (one <div> container, holds DOM and multiple <canvas> elements)
 └── Layer (one <canvas> element per Layer; this is the unit of redraw)
      └── Group (logical grouping; no own canvas)
           └── Shape (Rect, Circle, Line, Text, Image, Path, Star, Arrow, …)
                or another Group
      └── Transformer (special Group: resize/rotate handles for selected nodes)
```

Critical mental model:
- **Each Layer is a real `<canvas>` DOM element.** Fewer layers = better perf. Don't make a layer per shape.
- **Shapes don't get their own canvas.** They draw onto their parent Layer's canvas.
- **Hit detection** uses a separate hidden hit canvas per Layer (the "hit graph"). Disabling `listening` on subtrees skips this work.
- **The scene graph is mutable.** Calling `shape.x(100)` changes state; Konva auto-redraws (`Konva.autoDrawEnabled = true` by default).
- **In react-konva, you mostly stay declarative**, but for the Transformer and refs to native nodes you must use `useRef` + `useEffect`.

## Installation

```bash
# Vanilla
npm install konva

# React (bring both)
npm install konva react-konva

# Useful companions for react-konva
npm install use-image           # async image loading hook
npm install react-konva-utils   # <Html> portal, <Group> helpers
```

`react-konva` is **browser-only**; it does not work in React Native or SSR (you'll guard with `typeof window !== 'undefined'` or `next/dynamic` in Next.js).

## Hello world — both flavors

**Vanilla:**
```javascript
import Konva from 'konva';

const stage = new Konva.Stage({
  container: 'app',      // id of a <div>
  width: window.innerWidth,
  height: window.innerHeight,
});

const layer = new Konva.Layer();
stage.add(layer);

const rect = new Konva.Rect({
  x: 50, y: 50, width: 100, height: 80,
  fill: 'tomato', stroke: 'black', strokeWidth: 2,
  draggable: true,
});
layer.add(rect);
```

**React:**
```jsx
import { Stage, Layer, Rect } from 'react-konva';

export default function App() {
  return (
    <Stage width={window.innerWidth} height={window.innerHeight}>
      <Layer>
        <Rect x={50} y={50} width={100} height={80}
              fill="tomato" stroke="black" strokeWidth={2}
              draggable />
      </Layer>
    </Stage>
  );
}
```

Notice: **every Konva config field is a React prop with the same name**. There's no separate API — `react-konva` is a thin reconciler over Konva.

## How to use this skill — reference index

The detailed knowledge is split into `references/` files so you can load only what's relevant.

| File | When to read |
|---|---|
| [references/core-concepts.md](references/core-concepts.md) | First read. Stage/Layer/Group/Shape, coordinate system, transforms, listening, caching, redraw model. |
| [references/shapes.md](references/shapes.md) | Full catalog of built-in shapes (Rect, Circle, Ellipse, Line, Arrow, Arc, Ring, Wedge, Star, RegularPolygon, Path, Text, TextPath, Image, Sprite, Label, Tag) with their unique props and quirks. |
| [references/react-konva.md](references/react-konva.md) | React-specific patterns: refs, controlled vs uncontrolled, syncing drag/transform back to state, `<Html>` portal, Next.js/SSR, react-konva-utils, performance pitfalls. |
| [references/events.md](references/events.md) | Every Konva event, event object fields, bubbling and `cancelBubble`, namespacing, stage-level events, pointer events, drag events, transform events, hit detection internals. |
| [references/drag-and-drop.md](references/drag-and-drop.md) | `draggable`, `dragBoundFunc`, `dragDistance`, dragging from group, drag layers for perf, drag-from-DOM-into-canvas pattern. |
| [references/transformer.md](references/transformer.md) | The Transformer in depth: attachment, multi-select, `boundBoxFunc`, the scale-reset pattern, snapping, rotation snaps, anchor customization, react-konva idiom. |
| [references/animations-tweens.md](references/animations-tweens.md) | `Konva.Animation` (per-frame loop), `Konva.Tween` (declarative), the `node.to({...})` shortcut, all 16 easings, chaining and reversing. |
| [references/filters.md](references/filters.md) | All 18 built-in filters, the **`cache()` requirement**, filter parameters, custom filters via `ImageData`. |
| [references/images.md](references/images.md) | Loading images with `use-image`, CORS / `crossOrigin`, `crop`, video as image source, image export (`toDataURL`/`toBlob`/`toImage`), high-DPI exports. |
| [references/serialization.md](references/serialization.md) | `toJSON`/`Node.create`, what does and doesn't serialize, custom shape serialization, design persistence patterns. |
| [references/custom-shapes.md](references/custom-shapes.md) | `sceneFunc`/`hitFunc`, the `Konva.Context` wrapper, why you call `ctx.fillStrokeShape(shape)`, custom hit regions. |
| [references/performance.md](references/performance.md) | Every performance lever Konva exposes — listening, caching, `perfectDrawEnabled`, drag layers, `transformsEnabled`, pixel ratio, stage size, `batchDraw`, animation patterns. |
| [references/patterns.md](references/patterns.md) | End-to-end recipes: free-drawing app, design editor with selection/transform, image labeler, infinite/pan-zoom canvas, snapping to grid/other shapes, undo/redo, copy/paste, keyboard shortcuts, exporting to PDF. |

## Things to absolutely keep in mind

These are the issues that trip people up most often. If the user's question or bug matches one of these, jump there first.

1. **Transformer changes `scaleX`/`scaleY`, not `width`/`height`.** On `transformend` you typically reset scale to 1 and bake it into width/height. See `references/transformer.md`.
2. **Filters require `node.cache()` first.** Without caching, filters silently do nothing. See `references/filters.md`.
3. **Image is async.** `new window.Image()` must finish loading before drawing. In React, use `use-image`. In vanilla, set `imageObj.onload` then construct `Konva.Image`. See `references/images.md`.
4. **`Konva.Image` takes `image:` (HTMLImageElement), not a URL.** Use `Konva.Image.fromURL(url, cb)` or load yourself.
5. **`crossOrigin="anonymous"`** is required if you'll ever `toDataURL()` an image loaded from another origin; otherwise the canvas is tainted and export throws a security error.
6. **react-konva is browser-only.** In Next.js, dynamic-import the canvas component with `{ ssr: false }`.
7. **Don't mix imperative Konva mutations with React state for the same attribute.** Pick one source of truth per attribute. The most common pattern: render from state, mutate during drag/transform, then write back to state on `dragend`/`transformend`.
8. **`zIndex` is sibling-relative**, not global. To bring a shape to the front globally you may need to move it to a different parent.
9. **The drag event target is what was *grabbed*, not always the shape you visualize.** In a `Group` with a draggable parent, `e.target` may be a child. Use `e.currentTarget`.
10. **Layer count costs more than shape count.** A common mistake is making one Layer per object. Use Groups for organization; reserve Layers (typically 1–4 total) for genuine compositing or perf isolation (e.g., a "drag layer" for the currently-moving node).
11. **`stage.getPointerPosition()` returns absolute screen-canvas coords.** If the stage is scaled/panned, convert with `stage.getRelativePointerPosition()` or apply the inverse transform.
12. **Hit detection respects `listening`.** A shape with `listening: false` (or whose ancestor has it) won't receive pointer events and won't be returned by `getIntersection`.

## Two-line decision guide

- "Should I cache this node?" — Yes if it's complex and rarely changes, or you need to filter it. No if it changes every frame.
- "Should I add another Layer?" — Only if it has a clearly different redraw cadence (e.g., a background that never changes + a foreground that changes constantly), or you need it as a drag layer.

## Browser support and key globals

- Konva supports all modern browsers; works on iOS Safari, Android Chrome.
- `Konva.pixelRatio` — global override; set to `1` to disable high-DPI rendering for perf.
- `Konva.dragDistance` — pixels the pointer must move before a drag starts (default `3`).
- `Konva.hitOnDragEnabled` — disabled by default during drag for perf; enable if you need hover effects while dragging.
- `Konva.angleDeg` — degrees by default; set `false` to use radians.

## Beyond this skill

When the user needs something this skill doesn't cover, point them to:
- Official docs: https://konvajs.org/docs/
- API reference: https://konvajs.org/api/Konva.html
- Demos sandbox: https://konvajs.org/docs/sandbox.html
- GitHub: https://github.com/konvajs/konva, https://github.com/konvajs/react-konva

If they need a pre-built design-tool layer (templates, fonts, exports, plugins), the Konva team also maintains the commercial **Polotno SDK** on top of react-konva.
