# Transformer

`Konva.Transformer` is the resize/rotate handle widget. It's a special Group that overlays itself on one or more target nodes and emits transform events as the user drags its anchors.

## Critical mental model

The Transformer **does not change `width` or `height` of the target node**. It changes `scaleX` and `scaleY`. This is intentional (lets you transform any shape generically, including Circles and Text). It means:

- A "100-wide" Rect that you drag to twice the size becomes width=100, scaleX=2.
- If you read `width` after a transform, you still get 100.
- Strokes also scale unless you set `strokeScaleEnabled: false`.

The standard fix: on `transformend`, read scaleX/scaleY, multiply into width/height, and **reset scale to 1**.

```javascript
node.on('transformend', () => {
  const sx = node.scaleX();
  const sy = node.scaleY();
  node.scaleX(1);
  node.scaleY(1);
  node.width(node.width() * sx);
  node.height(node.height() * sy);
});
```

For Circles, do this with `radius`. For Stars, `innerRadius`/`outerRadius`. For Text, you may instead want to change `fontSize`.

## Basic vanilla setup

```javascript
const tr = new Konva.Transformer();
layer.add(tr);
tr.nodes([rect]);  // attach to one or more nodes
```

## All configuration

```javascript
new Konva.Transformer({
  // Anchors
  resizeEnabled: true,
  enabledAnchors: ['top-left','top-center','top-right','middle-left','middle-right','bottom-left','bottom-center','bottom-right'],
  anchorSize: 10,
  anchorFill: 'white', anchorStroke: 'black', anchorStrokeWidth: 1,
  anchorCornerRadius: 0,

  // Rotation
  rotateEnabled: true,
  rotateLineVisible: true,
  rotationSnaps: [],            // e.g. [0, 45, 90, 135, 180, 225, 270, 315]
  rotationSnapTolerance: 5,
  rotateAnchorOffset: 50,
  rotateAnchorCursor: 'crosshair',
  rotateAnchorAngle: 0,         // 0 = top-center

  // Border
  borderEnabled: true,
  borderStroke: 'rgb(0,161,255)', borderStrokeWidth: 1,
  borderDash: [],

  // Behavior
  keepRatio: true,              // corner anchors keep aspect (shift to invert in default mode)
  shiftBehavior: 'default',     // 'default' | 'inverted' | 'none'
  centeredScaling: false,
  flipEnabled: true,            // allow flipping by dragging past origin
  ignoreStroke: false,          // ignore stroke when computing transformer bounds
  padding: 0,
  useSingleNodeRotation: true,  // inherit rotation from single attached node
  shouldOverdrawWholeArea: false, // drag-grab anywhere inside transformer bbox

  // Custom hooks
  boundBoxFunc: (oldBox, newBox) => newBox,
  anchorDragBoundFunc: (oldPos, newPos, e) => newPos,
  anchorStyleFunc: (anchor) => { /* style each anchor */ },
});
```

## boundBoxFunc — constrain size/rotation

Called every transform tick. Receive old and new bounding box `{ x, y, width, height, rotation }` in absolute coords; return the box you want.

```javascript
// Minimum size 20x20
boundBoxFunc(oldBox, newBox) {
  if (newBox.width < 20 || newBox.height < 20) return oldBox;
  return newBox;
}
```

```javascript
// Snap rotation to 15°
boundBoxFunc(oldBox, newBox) {
  newBox.rotation = Math.round(newBox.rotation / 15) * 15;
  return newBox;
}
```

```javascript
// Maintain aspect 16:9
boundBoxFunc(oldBox, newBox) {
  const ratio = 16 / 9;
  newBox.height = newBox.width / ratio;
  return newBox;
}
```

## anchorDragBoundFunc — constrain anchor positions

For finer control than boundBoxFunc — e.g., snapping the drag of a single anchor.

```javascript
anchorDragBoundFunc(oldPos, newPos) {
  return { x: Math.round(newPos.x / 10) * 10, y: Math.round(newPos.y / 10) * 10 };
}
```

## Multi-selection

```javascript
tr.nodes([rect1, rect2, circle]);
```

The Transformer wraps them all in a single bounding box. Rotations of individual nodes are reset to the group's rotation while attached, unless `useSingleNodeRotation: false`.

## Detach / hide

```javascript
tr.nodes([]);    // empty array hides handles
tr.detach();     // same effect
```

## Events

The events fire on the **target nodes**, not the Transformer:

```javascript
rect.on('transformstart transform transformend', (e) => { /* … */ });
```

The Transformer itself emits `dragstart` / `dragmove` / `dragend` if it's draggable.

## react-konva pattern (canonical)

```jsx
function Shape({ shape, isSelected, onSelect, onChange }) {
  const ref = useRef(null);
  const trRef = useRef(null);

  useEffect(() => {
    if (isSelected) {
      trRef.current.nodes([ref.current]);
      trRef.current.getLayer().batchDraw();
    }
  }, [isSelected]);

  return (
    <>
      <Rect
        ref={ref}
        {...shape}
        draggable
        strokeScaleEnabled={false}
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(e) => onChange({ ...shape, x: e.target.x(), y: e.target.y() })}
        onTransformEnd={() => {
          const node = ref.current;
          const sx = node.scaleX(), sy = node.scaleY();
          node.scaleX(1); node.scaleY(1);
          onChange({
            ...shape,
            x: node.x(), y: node.y(),
            width: Math.max(5, node.width() * sx),
            height: Math.max(5, node.height() * sy),
            rotation: node.rotation(),
          });
        }}
      />
      {isSelected && (
        <Transformer
          ref={trRef}
          rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
          boundBoxFunc={(oldBox, newBox) =>
            Math.abs(newBox.width) < 5 || Math.abs(newBox.height) < 5 ? oldBox : newBox
          }
        />
      )}
    </>
  );
}
```

## Group multi-select selection box

For a Figma-style marquee selection that then drives a Transformer:

```javascript
// 1. On mousedown on empty stage, start a selection rect
// 2. On mousemove, resize it
// 3. On mouseup, find all shapes intersecting the rect and attach Transformer

const box = selectionRect.getClientRect();
const intersecting = layer.getChildren((node) =>
  node !== selectionRect && Konva.Util.haveIntersection(box, node.getClientRect())
);
tr.nodes(intersecting);
```

## Snapping anchors to other shapes

Use `anchorDragBoundFunc` to test against guide lines / other shapes. This is how Figma's smart-guides work.

```javascript
new Konva.Transformer({
  anchorDragBoundFunc(oldPos, newPos) {
    const snap = findNearestSnap(newPos, otherShapes);
    return snap || newPos;
  },
});
```

## Don't transform Text by width — change fontSize

Resizing a Text via the Transformer scales the glyphs, but unless you bake them in, the text will re-wrap at a different width. A common UX choice:

```jsx
onTransformEnd={() => {
  const t = ref.current;
  const sx = t.scaleX();
  t.scaleX(1); t.scaleY(1);
  // Treat the resize as a font-size change
  setText({ ...text, fontSize: text.fontSize * sx, width: t.width() * sx });
}}
```

## Common bugs

- **Transformer doesn't appear.** It must be added to a `Layer`. In react-konva, must be a sibling of the shape inside the same Layer.
- **Transformer is at wrong position after attaching.** Call `tr.forceUpdate()` after large attribute mutations on the node.
- **scaleX keeps growing across multiple transforms.** You forgot to reset to 1 inside `transformend`.
- **Stroke becomes thicker on resize.** Set `strokeScaleEnabled: false` on the shape, or `ignoreStroke: true` on the Transformer.
- **Rotation handle is on the wrong side.** Adjust `rotateAnchorAngle` (0 / 90 / 180 / -90).
- **Anchors are too small on touch devices.** Increase `anchorSize` (e.g., 16–20).
