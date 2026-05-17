# Core Concepts

Read this first. Everything else builds on it.

## The node hierarchy

```
Konva.Node                      (base: every visible thing extends this)
├── Konva.Shape                 (atomic drawable: Rect, Circle, Text, …)
└── Konva.Container             (holds children)
    ├── Konva.Stage             (root; attached to a DOM container <div>)
    ├── Konva.Layer             (one HTML <canvas> element)
    │   └── Konva.FastLayer     (DEPRECATED — use Layer({ listening: false }))
    ├── Konva.Group             (logical grouping; no canvas of its own)
    └── Konva.Label             (Group with a Tag + Text — speech-bubble style)
```

Every node has: `x`, `y`, `width`, `height`, `scaleX`, `scaleY`, `rotation`, `offsetX`, `offsetY`, `skewX`, `skewY`, `opacity`, `visible`, `listening`, `draggable`, `id`, `name`.

## Stage

A Stage is the root. It is **attached to a DOM `<div>` container** and creates one or more `<canvas>` elements inside it (one per Layer, plus a hit canvas per Layer).

```javascript
const stage = new Konva.Stage({
  container: 'app',  // id string, CSS selector, or DOM element
  width: 800,
  height: 600,
});
```

A Stage can:
- have multiple Layers
- be itself transformed (`stage.scale({x: 2, y: 2})`, `stage.position({...})`) — this is how you implement zoom/pan
- receive pointer events that bubble up from shapes
- export everything to image/JSON

```javascript
stage.getPointerPosition();          // absolute, in stage coords
stage.getRelativePointerPosition();  // accounts for the stage's own transform (and any ancestor)
stage.getIntersection({ x, y });     // returns top-most shape at that point (uses hit canvas)
```

## Layer

A Layer is the unit of redraw. It owns:
- a **scene canvas** (visible)
- a **hit canvas** (invisible — used for pointer hit testing by reading pixel color)

```javascript
const layer = new Konva.Layer();
stage.add(layer);
// add shapes to layer.add(shape);
```

Performance rules:
- More layers = more `<canvas>` elements composited every frame. Keep total ≤ 3–5 for typical apps.
- A layer is the granularity of "what redraws together". If a background never changes, put it on its own layer. If most things change together, one layer is fine.
- `layer.batchDraw()` schedules a draw on next `requestAnimationFrame`. With `Konva.autoDrawEnabled = true` (default), Konva calls this for you on any attribute change.
- `layer.listening(false)` disables hit-canvas drawing for that layer — big perf win for non-interactive backgrounds.

## Group

A Group has no canvas. It exists to:
- Apply a shared transform to multiple shapes (`group.x(50)` moves all children).
- Make multiple shapes draggable as one (`group.draggable(true)`).
- Logically organize the scene tree (find by selector, save/load subtrees).

```javascript
const group = new Konva.Group({ x: 100, y: 100, draggable: true });
group.add(rect);
group.add(text);
layer.add(group);
```

## Coordinate system and transforms

- Y axis points **down** (canvas convention). `(0, 0)` is the top-left corner of the parent.
- Each node's `(x, y)` is **relative to its parent**.
- Transforms are applied in this order, top-to-bottom: translate to `(x, y)` → translate by `(-offsetX, -offsetY)` → rotate → scale → skew. To rotate **around a point**, set `offsetX`/`offsetY` to that point and the shape will spin around it.
- `node.getAbsolutePosition()` walks ancestors and gives you the stage-space position.
- `node.getAbsoluteTransform()` returns a `Konva.Transform` matrix you can use to map points.

### Centering rotation/scale

By default, a `Rect` rotates around its top-left. To rotate around its center:

```javascript
new Konva.Rect({
  x: 200, y: 200,
  width: 100, height: 50,
  offsetX: 50, offsetY: 25,   // origin moved to center
  rotation: 45,
});
```

`Circle` and `Ellipse` are different — their `(x, y)` is already the center.

## Listening (events on/off)

`listening` controls whether a node participates in hit detection.

```javascript
node.listening(false);     // skip events for this node (and its descendants)
node.isListening();        // true only if self and all ancestors listen
```

Set `listening: false` on every non-interactive shape you can. The bigger your scene, the more this matters — hit detection rasterizes shapes to the hit canvas. Background grids, decorative overlays, and labels are common candidates.

## Caching

`node.cache()` rasterizes the node to an offscreen canvas and uses that image until invalidated. Three reasons to cache:

1. **Speed.** A complex Group of 200 paths drawn once → cached → blits as a single image.
2. **Filters.** Filters operate on `ImageData`, which only exists after caching. **No cache = filters don't apply.**
3. **Hit detection.** For custom shapes with expensive `sceneFunc`, `drawHitFromCache()` derives a hit region from the cached scene image.

```javascript
group.cache();                // simple
group.cache({ pixelRatio: 2 }); // higher quality
group.clearCache();           // invalidate when contents change
```

For custom `Konva.Shape` (not built-in), pass bounding box: `shape.cache({ x, y, width, height, offset })`.

## The redraw model

- Mutating any attribute (`rect.x(100)`, `circle.fill('blue')`) triggers an auto-draw on the next frame.
- This is governed by `Konva.autoDrawEnabled` (default `true`). Disable it and call `layer.batchDraw()` yourself if you're updating many properties in a tight loop and want to coalesce manually.
- `layer.draw()` is synchronous (immediate). `layer.batchDraw()` schedules at next `rAF` and dedupes.
- In **react-konva**, you don't call `draw()` — react-konva calls it after each commit. But if you mutate via refs (e.g., during drag), Konva itself schedules the redraw.

## Selectors

`find()` and `findOne()` accept simple selectors:

```javascript
layer.find('#myId');           // by id (global, page-wide)
layer.find('.selectable');     // by name (non-unique class-like)
layer.find('Rect');            // by class name
layer.find('Rect, Circle');    // multiple
layer.find(node => node.x() > 100);  // function predicate
```

`id` is global. `name` can be set on many nodes and even space-separated like CSS classes — `node.addName('selected')`.

## Common pitfalls

- **Forgetting `stage.add(layer)` / `layer.add(shape)`.** Nothing renders. In react-konva this can't happen; you compose tags.
- **Trying to put a non-Konva DOM element inside the canvas tree.** Use `<Html>` from `react-konva-utils` or position a DOM element absolutely over the stage.
- **Calling `getIntersection` while dragging** — disabled by default for perf. Set `Konva.hitOnDragEnabled = true` if needed.
- **Mutating `width`/`height` after a Transformer-driven resize and not resetting `scaleX`/`scaleY`** — see `transformer.md`.
- **Pixel ratio surprises.** On retina, the stage canvas is internally 2× pixels. If you read `canvas.width` you'll see the pixel dim, not the CSS dim. Use `stage.width()`/`height()` for logical units.
