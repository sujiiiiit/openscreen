# Events

Konva has a full DOM-like event system. Every Node has `on(event, handler)`, `off(event)`, and `fire(event)`.

## Event catalog

### Mouse
- `mouseenter` / `mouseleave` — fired on enter/leave of a shape (does NOT bubble)
- `mouseover` / `mouseout` — like enter/leave but bubbles
- `mousemove`, `mousedown`, `mouseup`
- `wheel` — scroll/zoom
- `click`, `dblclick`
- `contextmenu` — right-click

### Touch
- `touchstart`, `touchmove`, `touchend`
- `tap`, `dbltap`

### Pointer events (unified mouse + touch + pen)
- `pointerdown`, `pointermove`, `pointerup`, `pointercancel`
- `pointerover`, `pointerenter`, `pointerout`, `pointerleave`
- `pointerclick`, `pointerdblclick`

Use pointer events when you want one code path for desktop + mobile + stylus. Mouse and touch events still fire separately by default.

### Drag
- `dragstart` — pointer began dragging this node
- `dragmove` — every frame during drag
- `dragend` — pointer released

### Transform (only fires on nodes attached to a `Konva.Transformer`)
- `transformstart`
- `transform` — every frame during transform
- `transformend`

### Other
- `xChange`, `yChange`, `widthChange`, … — fired when corresponding attribute changes (any attribute getter has a `<attr>Change` event)
- `add`, `remove` — children added/removed from a container

## Binding (vanilla)

```javascript
rect.on('click', (e) => { /* … */ });
rect.on('dragstart dragmove dragend', (e) => { /* … */ });   // space-separated
rect.on('click.tooltip', (e) => { /* … */ });                // namespaced
rect.off('.tooltip');                                         // remove all namespaced
rect.fire('click');                                           // synthetic dispatch
```

## Binding (react-konva)

CamelCase prop: `on<EventName>`.

```jsx
<Rect
  onClick={...}
  onMouseEnter={...}
  onDragStart={...}
  onDragMove={...}
  onDragEnd={...}
  onTransformEnd={...}
  onWheel={...}
/>
```

## The event object

Handlers receive a `KonvaEventObject`:

```javascript
{
  target,         // the bottom-most node that received the event
  currentTarget,  // the node the listener was attached to
  type,           // 'click', etc.
  evt,            // the underlying native MouseEvent / TouchEvent / PointerEvent / WheelEvent
  pointerId,      // for pointer events
  cancelBubble,   // set to true to stop propagation
}
```

`e.evt` is the native DOM event — use for `preventDefault()`, `stopPropagation()` of the *DOM* event (different from Konva bubbling), `e.evt.deltaY` on wheel, etc.

## Bubbling

Events bubble up the tree: Shape → Group → Layer → Stage. `e.target` is where it started, `e.currentTarget` is where the handler is.

Stop bubbling:

```javascript
rect.on('click', (e) => {
  e.cancelBubble = true;   // ancestors won't fire
});
```

A common pattern: click on a shape selects it; click on empty stage deselects. Detect "empty" by `e.target === stage`:

```javascript
stage.on('click', (e) => {
  if (e.target === stage) setSelected(null);
});
```

In react-konva that becomes `onMouseDown` / `onTap` on `<Stage>` checking `e.target === e.target.getStage()`.

## Mouse position

```javascript
stage.getPointerPosition();          // absolute (canvas pixels — top-left = 0,0)
stage.getRelativePointerPosition();  // relative to a transformed parent (if stage is zoomed/panned)
node.getRelativePointerPosition();   // pointer in node's local coords
```

The relative variant correctly handles a Stage that has been scaled and translated for pan/zoom.

## Hit detection

Konva uses a **hit canvas** per Layer:
- For each shape, it draws the shape onto an invisible canvas using a unique RGB color as the fill.
- On a pointer event, it reads the pixel under the pointer; that color maps back to a node.

Consequences:
- Anti-aliased edges can sometimes miss hits at sub-pixel coords.
- `stage.getIntersection({x, y})` is fast (one pixel read).
- `shape.intersects({x, y})` is **slow** (redraws a temp canvas) — avoid.
- `listening: false` nodes don't draw to the hit canvas → they're invisible to events.

### Custom hit regions

If your shape has a complex sceneFunc but you want a simpler hit region (or vice versa):

```javascript
new Konva.Shape({
  sceneFunc(ctx, shape) { /* fancy drawing */ },
  hitFunc(ctx, shape) {
    ctx.beginPath();
    ctx.rect(0, 0, shape.width(), shape.height());
    ctx.closePath();
    ctx.fillStrokeShape(shape);
  },
});
```

Or derive hit from cached scene image (for very complex shapes):

```javascript
shape.cache();
shape.drawHitFromCache();
```

## Stage-level shortcuts

```javascript
stage.on('contentClick', (e) => { /* legacy alias */ });
```

Stage receives all events that aren't consumed/cancelled.

## Keyboard events

Konva is canvas-based and does not own focus. Bind to `window`:

```javascript
window.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' && selected) selected.destroy();
});
```

In react-konva, do this in `useEffect` and clean up the listener.

## Common patterns

### Distinguish click from drag

By default, a slight pointer move suppresses `click`. Tune with `Konva.dragDistance` (default 3px). If you want a click-or-drag pattern, just bind both and use `dragstart` to set a flag.

### Hover cursor

```javascript
shape.on('mouseenter', () => { stage.container().style.cursor = 'pointer'; });
shape.on('mouseleave', () => { stage.container().style.cursor = 'default'; });
```

### Right-click menu

```javascript
shape.on('contextmenu', (e) => {
  e.evt.preventDefault();   // suppress browser menu
  showMenu(e.evt.clientX, e.evt.clientY, shape);
});
```

### Double-tap on mobile

`dbltap` is fired automatically between two quick `tap`s. Tune the dbl-tap window with `Konva.dblClickWindow` (ms).

### Long-press

Implement manually: on `pointerdown` start a timer; on `pointerup`/`pointermove` cancel it.

```javascript
shape.on('pointerdown', () => {
  longPressTimer = setTimeout(() => handleLongPress(shape), 500);
});
shape.on('pointerup pointercancel pointerleave', () => clearTimeout(longPressTimer));
```

### Pinch-zoom (two-finger)

```javascript
let lastDist = 0;
stage.on('touchmove', (e) => {
  if (e.evt.touches.length !== 2) return;
  e.evt.preventDefault();
  const t1 = e.evt.touches[0], t2 = e.evt.touches[1];
  const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
  if (lastDist) {
    const scale = stage.scaleX() * (dist / lastDist);
    stage.scale({ x: scale, y: scale });
    stage.batchDraw();
  }
  lastDist = dist;
});
stage.on('touchend', () => { lastDist = 0; });
```

### Mouse-wheel zoom centered on pointer

```javascript
const SCALE_BY = 1.05;
stage.on('wheel', (e) => {
  e.evt.preventDefault();
  const oldScale = stage.scaleX();
  const pointer = stage.getPointerPosition();
  const mousePointTo = {
    x: (pointer.x - stage.x()) / oldScale,
    y: (pointer.y - stage.y()) / oldScale,
  };
  const direction = e.evt.deltaY > 0 ? -1 : 1;
  const newScale = direction > 0 ? oldScale * SCALE_BY : oldScale / SCALE_BY;
  stage.scale({ x: newScale, y: newScale });
  stage.position({
    x: pointer.x - mousePointTo.x * newScale,
    y: pointer.y - mousePointTo.y * newScale,
  });
});
```

This is the canonical Figma/Miro-style zoom.
