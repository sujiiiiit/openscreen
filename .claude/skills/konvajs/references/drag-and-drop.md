# Drag and Drop

Konva ships with full drag-and-drop built in. There is no library to add.

## Enable on any node

```javascript
new Konva.Rect({ /* … */ draggable: true });
// or
rect.draggable(true);
```

This works on shapes, Groups, Layers, and even the Stage itself (drag the entire stage = pan).

## Drag events

```javascript
rect.on('dragstart', (e) => { /* fired once */ });
rect.on('dragmove',  (e) => { /* fired each frame while moving */ });
rect.on('dragend',   (e) => { /* fired once on release */ });
```

In react-konva: `onDragStart`, `onDragMove`, `onDragEnd`.

`e.target` is the dragged node. In a Group with draggable parent, `e.target` is the parent.

## dragBoundFunc — constrain motion

Receives the proposed new absolute position; return where the node should actually go.

```javascript
new Konva.Rect({
  draggable: true,
  dragBoundFunc(pos) {
    // Clamp horizontally to [0, 800]
    return { x: Math.max(0, Math.min(pos.x, 800)), y: pos.y };
  },
});
```

Common uses:
- Locking to an axis: `return { x: pos.x, y: this.absolutePosition().y };`
- Snapping to a grid: `return { x: Math.round(pos.x / 20) * 20, y: Math.round(pos.y / 20) * 20 };`
- Confining inside a parent rect
- Snapping to other shapes (compute candidates each frame)

`pos` is in stage-absolute coords. `this` is the node.

## dragDistance — threshold to start dragging

Global default: 3 pixels. Override globally or per-node:

```javascript
Konva.dragDistance = 5;          // global
rect.dragDistance(0);            // start immediately
```

Useful when you also want clicks: if drag starts immediately, every click becomes a drag.

## Programmatic drag

```javascript
rect.startDrag();   // begin a drag at current pointer position
rect.stopDrag();    // end it
Konva.isDragging(); // is any node currently being dragged?
```

## Drag layer pattern (performance)

For a complex scene, dragging a single node still re-renders the whole layer it lives on. To avoid this, **move the dragged node to a dedicated layer** on `dragstart` and back on `dragend`:

```javascript
const mainLayer = new Konva.Layer();
const dragLayer = new Konva.Layer();
stage.add(mainLayer);
stage.add(dragLayer);

rect.on('dragstart', () => {
  rect.moveTo(dragLayer);
});
rect.on('dragend', () => {
  rect.moveTo(mainLayer);
});
```

Only the (light) drag layer redraws on each move. Worth it for 200+ shapes; not for trivial scenes.

In react-konva, use `<Portal>` from `react-konva-utils` to render a node into a different layer conditionally:

```jsx
import { Portal } from 'react-konva-utils';
<Portal selector=".drag-layer" enabled={isDragging}>
  <Rect ... />
</Portal>
```

## Drag from DOM into the canvas

A common pattern: drag an image from a sidebar `<img>` into the canvas.

```jsx
// On the DOM side
<img
  draggable
  onDragStart={(e) => e.dataTransfer.setData('url', '/cat.jpg')}
/>

// Around the Stage container
<div
  onDragOver={(e) => e.preventDefault()}
  onDrop={(e) => {
    stageRef.current.setPointersPositions(e);
    const pos = stageRef.current.getPointerPosition();
    const url = e.dataTransfer.getData('url');
    addImage(url, pos);
  }}
>
  <Stage ref={stageRef} ... />
</div>
```

`stage.setPointersPositions(e)` lets you re-use Konva's pointer position machinery from a DOM event that didn't originate inside the canvas.

## Drag the whole stage (panning)

```javascript
const stage = new Konva.Stage({ /* … */, draggable: true });
```

Now dragging anywhere on the stage moves all layers. Combine with `wheel`-based zoom for a Figma-style infinite canvas.

To prevent panning when dragging starts on a shape, leave individual shapes `draggable: true` — Konva picks the deepest draggable target.

## Mobile considerations

- `preventDefault` on `touchstart` is necessary to prevent the page from scrolling. Konva does this by default via the `preventDefault` attr — leave it `true` unless you want page scroll.
- Long-press to drag is the usual mobile pattern but Konva doesn't gate this; drag starts on the first pointer move past `dragDistance`. Add a 300ms timer if you want long-press semantics.

## react-konva worked example

```jsx
const [shapes, setShapes] = useState([
  { id: '1', x: 50,  y: 50,  fill: 'red' },
  { id: '2', x: 200, y: 50,  fill: 'green' },
]);

const handleDragEnd = (id) => (e) => {
  setShapes((arr) =>
    arr.map((s) => (s.id === id ? { ...s, x: e.target.x(), y: e.target.y() } : s))
  );
};

return (
  <Stage width={500} height={300}>
    <Layer>
      {shapes.map((s) => (
        <Circle
          key={s.id}
          x={s.x} y={s.y} radius={30} fill={s.fill}
          draggable
          onDragEnd={handleDragEnd(s.id)}
        />
      ))}
    </Layer>
  </Stage>
);
```
