# Performance

Konva performance is mostly about two budgets: draw fewer pixels, and make fewer nodes participate in rendering and hit detection. When a user reports lag, stutter, slow dragging, slow zooming, high memory, mobile jank, or a scene with thousands of objects, use this reference first.

## Fast triage workflow

1. Reproduce the hot path: dragging, zooming, panning, hover tooltip, free drawing, animation, image filter slider, resize, or initial load.
2. Record the scene budget: stage size, device pixel ratio, layer count, shape count, listening node count, cached node count, filter count, and React component count.
3. Measure before changing code. Use Chrome DevTools Performance, the React Profiler for react-konva apps, and a temporary `Konva.Animation` FPS label if useful.
4. Apply the biggest lever first: stage pixels, layer split, `listening: false`, culling/removing offscreen nodes, drag layer, caching, then React state churn.
5. Measure again. Some Konva "optimizations" are tradeoffs; keep only the ones that move the real interaction.

## Mental model

- A `Stage` owns DOM and multiple canvas elements.
- Every `Layer` is a visible scene canvas, and interactive layers also maintain a hidden hit canvas for event detection.
- A redraw cost is roughly proportional to affected layer pixels, device pixel ratio, number/complexity of drawn nodes, and any offscreen buffer work.
- Node count matters even when a node is transparent or offscreen. Remove or virtualize large inactive sets.
- In React, React rendering cost is separate from Konva drawing cost. A smooth Konva drag can still feel bad if `onDragMove` re-renders thousands of JSX nodes.

## Stage and pixel budget

Keep the stage close to viewport size. Do not create a 20000 x 20000 stage for an infinite canvas or map; keep the viewport-sized stage and pan/zoom the content coordinates.

```javascript
const stage = new Konva.Stage({
  container: 'container',
  width: viewport.width,
  height: viewport.height,
});
```

For mobile, include the viewport meta tag so the browser does not scale Konva output:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no" />
```

On high-DPI devices, Konva renders crisp canvases by default. If retina devices are the bottleneck, set the global pixel ratio before creating any stage or layer:

```javascript
Konva.pixelRatio = 1;
```

For a special layer-level override, use the layer canvas wrapper:

```javascript
layer.getCanvas().setPixelRatio(1);
```

Keep export quality separate from runtime quality:

```javascript
const png = stage.toDataURL({ pixelRatio: 2 }); // high-quality export only
```

Throttle stage resizes. A `ResizeObserver` that updates `Stage` size on every micro change can force expensive canvas reallocations.

## Layer management

Use layers to isolate redraw cadence, not for object organization. Groups are for organization; layers are real canvases.

Good default for editors:

- `backgroundLayer`: grid/background/image, often `listening: false`
- `mainLayer`: normal editable content
- `overlayLayer`: selection, Transformer, guides, tooltip
- `dragLayer`: optional, only while dragging a node in a heavy scene

Avoid more than 3-5 layers unless you have measured a real benefit. A layer per object is almost always wrong.

```javascript
const backgroundLayer = new Konva.Layer({ listening: false });
const mainLayer = new Konva.Layer();
const overlayLayer = new Konva.Layer();
stage.add(backgroundLayer, mainLayer, overlayLayer);
```

`FastLayer` is deprecated. For non-interactive rendering, use `new Konva.Layer({ listening: false })` or `<Layer listening={false}>`.

## Hit detection and event work

Disable listening wherever events are unnecessary. This removes nodes from the hit graph, so Konva can skip event-detection work.

```javascript
backgroundLayer.listening(false);
gridGroup.listening(false);
shape.listening(false);
```

React:

```jsx
<Layer listening={false}>
  <Rect width={width} height={height} fill="#f5f5f5" />
</Layer>
```

For many similar interactive shapes, prefer event delegation over one custom handler closure per node:

```javascript
layer.on('click tap', 'Circle', (e) => {
  selectNode(e.target.id());
});
```

`Konva.hitOnDragEnabled` is `false` by default for performance. Enable it only when hover/intersection behavior during drag is truly required:

```javascript
Konva.hitOnDragEnabled = true; // rare
```

## Shape count, visibility, and culling

Every node has a cost just to exist. If thousands of objects are hidden, offscreen, filtered out, or at opacity 0, do not leave all of them active in the scene graph.

Use `hide()` for short-lived visibility toggles. Hidden nodes are not hit-detectable, but they still occupy memory and tree traversal:

```javascript
node.hide();
```

Use `remove()` when you will reuse a node later, and `destroy()` when it is gone for good:

```javascript
node.remove();  // detach, keep reusable
node.destroy(); // detach and release Konva references
```

For large maps, timelines, seat maps, spreadsheets, or diagrams, virtualize: render only visible nodes plus a margin. Prefer app-data bounds for virtualization so hidden nodes can become visible again when the viewport changes.

```javascript
const visible = intersectsBounds(item.bounds, expandedViewport);
node.visible(visible);
```

For already-mounted visible nodes, `node.isClientRectOnScreen(margin)` is a useful diagnostic helper.

If nodes only translate and never rotate/scale/skew, reduce transform math:

```javascript
marker.transformsEnabled('position');
```

## Dragging smoothness

Dragging one node inside a heavy layer redraws that heavy layer every move. Move the active node to a light drag layer, then move it back on drag end.

```javascript
let sourceLayer = null;

node.on('dragstart', () => {
  sourceLayer = node.getLayer();
  node.moveTo(dragLayer);
});

node.on('dragend', () => {
  node.moveTo(sourceLayer);
});
```

If exact z-order matters, restore order from app state after drag rather than relying on the temporary layer move.

In React, avoid `setState` on every `onDragMove` for heavy scenes. Let Konva mutate the node during drag and commit final coordinates on `onDragEnd`.

```jsx
<Rect
  draggable
  x={shape.x}
  y={shape.y}
  onDragEnd={(e) => {
    updateShape(shape.id, { x: e.target.x(), y: e.target.y() });
  }}
/>
```

For live coordinates, update a ref or throttle state updates with `requestAnimationFrame`.

## Caching

Cache complex, stable nodes or groups, especially when filters are used. After caching, Konva draws the cached bitmap instead of replaying all drawing commands.

Good candidates:

- Complex `Group`s with many children that move/rotate as a unit
- Text-heavy labels reused across frames
- Custom `sceneFunc` shapes with expensive drawing
- Nodes that use function filters
- Static decorations redrawn often because another sibling on the same layer changes

Poor candidates:

- Simple rectangles/circles/lines without filters
- Nodes whose geometry or paint changes every frame
- Thousands of tiny individual shapes where cache memory is worse than direct draw

Prefer caching a group over caching every child:

```javascript
const markerCluster = new Konva.Group({ listening: false });
// add many child shapes...
markerCluster.cache({ pixelRatio: 1, hitCanvasPixelRatio: 1 });
```

For custom shapes, provide a cache bounding box. Use `drawBorder: true` while debugging cache bounds:

```javascript
customShape.cache({
  x: -50,
  y: -50,
  width: 100,
  height: 100,
  offset: 8,
  drawBorder: true,
});
```

When cached content changes, clear and recreate the cache:

```javascript
node.clearCache();
node.cache({ pixelRatio: 1 });
```

## Filters and visual effects

Konva supports function filters and CSS filter strings. Function filters use pixel manipulation and require `cache()`. CSS filter strings can use native browser performance and do not require caching when used alone. Mixed CSS/function filter arrays require caching.

```javascript
// CSS filters only: no cache required.
node.filters(['blur(4px)', 'brightness(1.15)']);

// Function filter: cache required.
image.cache();
image.filters([Konva.Filters.Blur]);
image.blurRadius(8);
```

Do not apply heavy filters to a whole stage on every frame. Apply filters to the smallest node that needs them, update filter parameters only when they change, and cache after the image is loaded.

For image export, remember CORS: load cross-origin images with `crossOrigin = 'anonymous'` or the canvas becomes tainted.

## Perfect drawing, strokes, and shadows

Konva may use buffer canvases to make fill/stroke/opacity combinations visually correct. For large scenes, disable perfect drawing when the visual difference is acceptable:

```javascript
shape.perfectDrawEnabled(false);
```

If a shape has both stroke and shadow, Konva may do extra internal drawing for the stroke shadow. Disable stroke shadows when the stroke itself does not need a shadow:

```javascript
shape.shadowForStrokeEnabled(false);
```

For editors, consider `strokeScaleEnabled: false` so zoom/transform does not make strokes enormous:

```javascript
shape.strokeScaleEnabled(false);
```

This is primarily a UX choice, but it also avoids some pathological stroke costs at high zoom.

## Draw scheduling

In Konva 8 and newer, `Konva.autoDrawEnabled` defaults to `true`, and Konva batches many redraws automatically. Avoid `layer.draw()` inside `mousemove`, `dragmove`, or slider loops.

Use `batchDraw()` when you intentionally control drawing or have disabled auto draw:

```javascript
Konva.autoDrawEnabled = false;

for (const node of nodes) {
  node.setAttrs({ x: node.x() + 10 });
}

layer.batchDraw(); // schedules one rAF draw
Konva.autoDrawEnabled = true;
```

`stage.batchDraw()` is useful when several layers changed and you still want one scheduled update.

## Animation

Use `Konva.Animation` for frame loops instead of raw `requestAnimationFrame`; it integrates with layer redraws and exposes frame data.

```javascript
const anim = new Konva.Animation((frame) => {
  star.rotation(frame.time * 0.05);
}, animLayer);

anim.start();
```

Attach animations only to layers that actually change. Put static labels/backgrounds in another layer so they do not redraw each frame.

For complex animated nodes, cache the node before animating transforms:

```javascript
star.cache();
```

Stop animations when hidden or unmounted:

```javascript
return () => anim.stop();
```

Avoid driving high-frequency animation through React state. Use refs and native Konva node mutation in the animation loop.

## React-specific performance

Treat React work and Konva work separately.

- Keep large shape arrays stable with `useMemo` or an external store.
- Wrap heavy shape components in `React.memo`.
- Use stable handlers from `useCallback`.
- Avoid creating fresh object/array props in hot parents when memoization matters.
- Commit drag/transform state on end events, not every move.
- Put tooltip/hover state in a separate layer or mutate a Konva tooltip node imperatively for very large scenes.
- For 10000+ mostly-static nodes, consider creating the Konva nodes imperatively in one `useEffect` and use React only for UI controls.

React render order controls canvas order. For normal z-order changes, reorder arrays. For temporary overlays such as active drag, use a separate layer or `react-konva-utils` `Portal` rather than imperative `zIndex()` calls from React-managed components.

```jsx
const Shape = React.memo(function Shape({ shape, onChange }) {
  return (
    <Rect
      {...shape}
      draggable
      onDragEnd={(e) => onChange(shape.id, { x: e.target.x(), y: e.target.y() })}
    />
  );
});
```

In React Strict Mode, effects may run more than once in development. Make `cache()`, animation setup, and event binding idempotent, and always return cleanup.

## Memory and cleanup

Use `destroy()` for deleted nodes, layers, and stages. Use `remove()` only when the node will be reused.

Destroy direct `Konva.Tween` instances after use. The `node.to(...)` shortcut handles tween lifecycle for the common case.

```javascript
const tween = new Konva.Tween({
  node,
  x: 200,
  duration: 0.3,
  onFinish() {
    tween.destroy();
  },
});
tween.play();
```

When manually binding events, namespace handlers so cleanup is easy:

```javascript
stage.on('mousemove.selection', handleMove);
stage.off('.selection');
```

For vanilla Konva in a React/Vue/Svelte component, destroy the stage on unmount:

```javascript
return () => stage.destroy();
```

`Konva.releaseCanvasOnDestroy` defaults to `true` and helps avoid canvas memory leaks on Safari; do not disable it unless you know why.

## Hit testing and collision checks

Use `stage.getIntersection(pos)` or `layer.getIntersection(pos)` for point hit testing. It uses the hit graph and ignores nodes with `listening: false`.

Avoid `getAllIntersections(pos)` in hot paths. It redraws shapes into a temporary canvas and is intentionally expensive.

For broad collision or selection, maintain your own spatial index or bounding boxes in app data, then use Konva hit testing only for final confirmation.

## Common recipes

### 10000 shapes with tooltip

- One layer for circles.
- One layer for tooltip, with tooltip nodes `listening: false`.
- Stable generated data.
- Event delegation from the layer/stage.
- Move only the tooltip node on hover; avoid rerendering every circle.

### 10000 draggable shapes

- One main layer for shapes.
- One drag layer.
- On pointer down or drag start, move the active node to the drag layer and call `startDrag()` if you are delegating from the stage.
- Move the node back on mouseup/dragend.
- Keep React state updates to drag end.

### Infinite canvas / large map

- Stage is viewport-sized.
- Content group/layer is panned and zoomed.
- Render only visible nodes plus margin.
- Disable listening for background tiles and grid.
- Cache complex static tiles or clusters.

### Image editor

- Load images once with CORS if export is required.
- Cache before function filters.
- Prefer CSS filter strings when they cover the effect.
- Update filter parameters on input, but debounce expensive re-cache operations.
- Export with `toBlob`/`toDataURL({ pixelRatio })` only on demand.

### Free drawing

- Keep the current stroke as one `Line`; append points imperatively during pointer move.
- Batch draw rather than forcing immediate draws.
- Commit final stroke data to state on pointer up.
- For eraser, `globalCompositeOperation` affects scene rendering but not hit graph; account for that in selection/hit logic.

## Performance checklist

- [ ] Stage is viewport-sized, not world-sized.
- [ ] Mobile viewport meta is present.
- [ ] `Konva.pixelRatio = 1` tested on slow retina devices if needed.
- [ ] Layer count is intentional, usually 1-4.
- [ ] Non-interactive layers/groups/shapes use `listening: false`.
- [ ] Hidden/offscreen/filtered-out nodes are removed, destroyed, or virtualized.
- [ ] Dragging uses a dedicated drag layer in heavy scenes.
- [ ] Complex stable nodes/groups are cached; simple dynamic nodes are not.
- [ ] Function filters are cached; CSS filters are preferred where enough.
- [ ] `perfectDrawEnabled(false)` and `shadowForStrokeEnabled(false)` are used where visual output allows.
- [ ] `batchDraw()` is used for manual imperative loops; `draw()` is not called in pointermove loops.
- [ ] Animations affect only needed layers and stop on cleanup.
- [ ] React state updates do not happen every drag/animation frame unless throttled and measured.
- [ ] Direct tweens, event handlers, caches, and stages are cleaned up.

## Official docs checked

Use these official Konva pages when validating or extending this reference:

- https://konvajs.org/docs/performance/All_Performance_Tips.html
- https://konvajs.org/docs/performance/Layer_Management.html
- https://konvajs.org/docs/performance/Listening_False.html
- https://konvajs.org/docs/performance/Shape_Caching.html
- https://konvajs.org/docs/performance/Batch_Draw.html
- https://konvajs.org/docs/performance/Disable_Perfect_Draw.html
- https://konvajs.org/docs/performance/Optimize_Strokes.html
- https://konvajs.org/docs/performance/Optimize_Animation.html
- https://konvajs.org/docs/performance/Avoid_Memory_Leaks.html
- https://konvajs.org/api/Konva.html
- https://konvajs.org/api/Konva.Node.html
- https://konvajs.org/api/Konva.Layer.html
- https://konvajs.org/api/Konva.FastLayer.html
- https://konvajs.org/docs/sandbox/Drag_and_Drop_Stress_Test.html
- https://konvajs.org/docs/sandbox/10000_Shapes_with_Tooltip.html
- https://konvajs.org/docs/sandbox/20000_Nodes.html
