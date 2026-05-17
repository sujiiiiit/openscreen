# End-to-end patterns

Recipes for the things people actually build. Each pattern lists the key Konva pieces and a sketch of the code.

---

## 1. Freehand drawing / whiteboard

**Pieces**: stage events, `Konva.Line` per stroke, vector points array, mode toggle for eraser via `globalCompositeOperation`.

```jsx
function Whiteboard() {
  const [tool, setTool] = useState('pen');
  const [lines, setLines] = useState([]);
  const isDrawing = useRef(false);

  const handleDown = (e) => {
    isDrawing.current = true;
    const pos = e.target.getStage().getPointerPosition();
    setLines([...lines, { tool, points: [pos.x, pos.y] }]);
  };
  const handleMove = (e) => {
    if (!isDrawing.current) return;
    const stage = e.target.getStage();
    const point = stage.getPointerPosition();
    setLines((prev) => {
      const last = prev[prev.length - 1];
      const updated = { ...last, points: last.points.concat([point.x, point.y]) };
      return [...prev.slice(0, -1), updated];
    });
  };
  const handleUp = () => { isDrawing.current = false; };

  return (
    <>
      <select value={tool} onChange={(e) => setTool(e.target.value)}>
        <option value="pen">Pen</option>
        <option value="eraser">Eraser</option>
      </select>
      <Stage width={800} height={600}
        onMouseDown={handleDown} onMousemove={handleMove} onMouseup={handleUp}
        onTouchStart={handleDown} onTouchMove={handleMove} onTouchEnd={handleUp}>
        <Layer>
          {lines.map((line, i) => (
            <Line key={i}
              points={line.points}
              stroke="#df4b26" strokeWidth={5}
              tension={0.5}
              lineCap="round" lineJoin="round"
              globalCompositeOperation={line.tool === 'eraser' ? 'destination-out' : 'source-over'}
            />
          ))}
        </Layer>
      </Stage>
    </>
  );
}
```

Optimizations for long sessions: simplify points (Ramer-Douglas-Peucker) when the user lifts the pen. Limit redraws by accumulating points and `setLines` on rAF.

---

## 2. Design editor (select / drag / resize / rotate)

**Pieces**: state-driven shape list, per-shape ref, `Transformer` attached to current selection, deselect on empty click, the scale-reset trick.

See `transformer.md` for the canonical `EditableRect` component. Compose multiple types (`EditableRect`, `EditableImage`, `EditableText`) sharing the same selection state.

Selection model:

```jsx
const [shapes, setShapes] = useState(initialShapes);
const [selectedId, setSelectedId] = useState(null);

const update = (id, patch) =>
  setShapes((arr) => arr.map((s) => (s.id === id ? { ...s, ...patch } : s)));
```

Keyboard:
```jsx
useEffect(() => {
  const onKey = (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      setShapes((arr) => arr.filter((s) => s.id !== selectedId));
      setSelectedId(null);
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [selectedId]);
```

---

## 3. Infinite canvas — pan + zoom

**Pieces**: stage `draggable: true` for pan; wheel handler for zoom centered on pointer; clamp scale; show grid that scrolls.

```jsx
const stageRef = useRef(null);
const [scale, setScale] = useState(1);
const [stagePos, setStagePos] = useState({ x: 0, y: 0 });

const onWheel = (e) => {
  e.evt.preventDefault();
  const stage = stageRef.current;
  const SCALE_BY = 1.05;
  const old = stage.scaleX();
  const pointer = stage.getPointerPosition();
  const mousePointTo = {
    x: (pointer.x - stage.x()) / old,
    y: (pointer.y - stage.y()) / old,
  };
  const direction = e.evt.deltaY > 0 ? -1 : 1;
  const next = Math.max(0.1, Math.min(8, direction > 0 ? old * SCALE_BY : old / SCALE_BY));
  setScale(next);
  setStagePos({
    x: pointer.x - mousePointTo.x * next,
    y: pointer.y - mousePointTo.y * next,
  });
};

<Stage
  ref={stageRef}
  width={window.innerWidth} height={window.innerHeight}
  draggable
  scaleX={scale} scaleY={scale}
  x={stagePos.x} y={stagePos.y}
  onWheel={onWheel}
  onDragEnd={(e) => setStagePos({ x: e.target.x(), y: e.target.y() })}
>
  <Layer>{/* content */}</Layer>
</Stage>
```

For a grid that visually stays the same density at all zooms, draw the grid in screen space (compute step in stage-relative units = `step / scale`).

---

## 4. Snap to grid

```javascript
const SNAP = 20;
shape.on('dragmove', (e) => {
  shape.position({
    x: Math.round(shape.x() / SNAP) * SNAP,
    y: Math.round(shape.y() / SNAP) * SNAP,
  });
});
```

Or use `dragBoundFunc` for hard constraints (the position is clamped before the visual updates):

```javascript
draggable: true,
dragBoundFunc(pos) {
  return { x: Math.round(pos.x / SNAP) * SNAP, y: Math.round(pos.y / SNAP) * SNAP };
}
```

## 5. Smart guides (snap to other shapes)

```javascript
function findSnaps(activeNode, others) {
  const guides = [];
  const me = activeNode.getClientRect();
  for (const o of others) {
    const r = o.getClientRect();
    // Left edges
    if (Math.abs(me.x - r.x) < 5) guides.push({ axis: 'x', value: r.x });
    // Centers
    if (Math.abs((me.x + me.width / 2) - (r.x + r.width / 2)) < 5)
      guides.push({ axis: 'x', value: r.x + r.width / 2 - me.width / 2 });
    // Right edges
    if (Math.abs((me.x + me.width) - (r.x + r.width)) < 5)
      guides.push({ axis: 'x', value: r.x + r.width - me.width });
    // (same for y)
  }
  return guides;
}
```

On `dragmove`, find snaps, draw guide lines on a guide-layer, and adjust position.

---

## 6. Image annotation / labeling

**Pieces**: background `Konva.Image`, a Group for annotations, rectangles/polygons drawn by the user, label text per annotation, draggable handles.

For polygon drawing: track a `points` array in state, render `Konva.Line` with `closed: true`, draw small Circle handles at each vertex. Each handle is draggable; its `onDragMove` updates the corresponding index in `points`.

For class labels, attach data to nodes via `setAttr('label', 'person')` and read back on serialization.

Export annotations to JSON: just `JSON.stringify(annotationsState)` (your own model). Or `Node.toJSON()` if you trust the Konva tree.

---

## 7. Connected diagrams (boxes with arrows)

**Pieces**: a Group per node (Rect + Text), draggable; connectors as custom `Konva.Shape` (bezier path) that reads endpoint positions from referenced node ids.

```javascript
function connector(fromId, toId, store) {
  return new Konva.Shape({
    listening: false,
    sceneFunc(ctx, shape) {
      const from = store.get(fromId).getAbsolutePosition();
      const to   = store.get(toId).getAbsolutePosition();
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      const mx = (from.x + to.x) / 2;
      ctx.bezierCurveTo(mx, from.y, mx, to.y, to.x, to.y);
      ctx.strokeShape(shape);
    },
    stroke: '#888', strokeWidth: 2,
  });
}
```

On node `dragmove`, call `connectorLayer.batchDraw()`.

---

## 8. Undo/redo

Maintain history of your app state, not the Konva tree:

```javascript
const history = [];
let cursor = -1;

function commit(state) {
  history.splice(cursor + 1);
  history.push(structuredClone(state));
  cursor = history.length - 1;
}
function undo() { if (cursor > 0) apply(history[--cursor]); }
function redo() { if (cursor < history.length - 1) apply(history[++cursor]); }
```

Commit on logical actions (drag-end, transform-end, add, delete, paste).

---

## 9. Copy / paste

```javascript
// Cmd+C
if (e.metaKey && e.key === 'c' && selected) {
  clipboard = JSON.parse(selected.toJSON());
  // Or for app-state model: clipboard = structuredClone(shapesMap[selectedId]);
}
// Cmd+V
if (e.metaKey && e.key === 'v' && clipboard) {
  const copy = Konva.Node.create(clipboard);
  copy.x(copy.x() + 20); copy.y(copy.y() + 20);
  layer.add(copy);
}
```

In react-konva with state-driven shapes:

```javascript
const newShape = { ...clipboard, id: nanoid(), x: clipboard.x + 20, y: clipboard.y + 20 };
setShapes((arr) => [...arr, newShape]);
setSelectedId(newShape.id);
```

---

## 10. Keyboard shortcuts

```javascript
const onKey = (e) => {
  if (e.metaKey && e.key === 'z' && !e.shiftKey) { undo(); e.preventDefault(); }
  if (e.metaKey && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { redo(); e.preventDefault(); }
  if (e.key === 'Delete' || e.key === 'Backspace') { delSelected(); }
  if (e.key === 'ArrowUp')    move(0, e.shiftKey ? -10 : -1);
  if (e.key === 'ArrowDown')  move(0, e.shiftKey ?  10 :  1);
  if (e.key === 'ArrowLeft')  move(e.shiftKey ? -10 : -1, 0);
  if (e.key === 'ArrowRight') move(e.shiftKey ?  10 :  1, 0);
};
window.addEventListener('keydown', onKey);
```

In react-konva remember to attach to `window` because the canvas doesn't take focus, and clean up in `useEffect`.

---

## 11. Inline text editing

When the user double-clicks a `Konva.Text`, you can either:

**A. Use `<Html>` from react-konva-utils** to overlay an `<input>` at the text's position.

```jsx
{editingId && (
  <Html groupProps={{ x: editingText.x, y: editingText.y }}>
    <input
      autoFocus
      defaultValue={editingText.text}
      style={{ font: `${editingText.fontSize}px ${editingText.fontFamily}` }}
      onBlur={(e) => commitText(editingId, e.target.value)}
    />
  </Html>
)}
```

**B. Position a regular HTML `<textarea>` over the canvas** using the text node's absolute screen position (`stage.container().getBoundingClientRect()` + `node.absolutePosition()`).

---

## 12. Export to PNG / PDF

```javascript
const url = stage.toDataURL({ pixelRatio: 2 });
const a = document.createElement('a');
a.download = 'design.png'; a.href = url; a.click();
```

For PDF, use `jspdf` (see `images.md`).

To export a specific area, pass `x`, `y`, `width`, `height`:

```javascript
stage.toDataURL({ x: 100, y: 100, width: 400, height: 300, pixelRatio: 2 });
```

To export without the UI chrome (selection handles, guides), set `selectionLayer.visible(false)` before export, then restore.

---

## 13. Seats / floor plan / interactive map

**Pieces**: many small shapes (Rects or custom paths), `listening: true`, hover/click handlers, data attributes via `setAttr` for seat metadata, color updates on selection.

Group seats per row, set `id` per seat:

```javascript
seat.setAttrs({ id: `seat-${row}-${col}`, fill: 'green' });
seat.on('click', () => {
  if (selected.has(seat.id())) { selected.delete(seat.id()); seat.fill('green'); }
  else { selected.add(seat.id()); seat.fill('blue'); }
});
```

For thousands of seats, follow the perf checklist: one Layer, `listening: false` on labels, simple Rects (avoid shadow + perfect draw).

---

## 14. Sticker / badge editor

Drag images from a side panel onto the canvas (see `drag-and-drop.md` "Drag from DOM"); each becomes a `Konva.Image` with a Transformer attached on selection; double-click to flip horizontally (`scaleX(-1)`); export final design.

---

## 15. Heatmap

Best done by drawing once per data update:
- Create a `Konva.Image` with an offscreen `<canvas>` as its source.
- In a 2D context, draw radial gradients per data point onto the offscreen canvas.
- Set the Image's image to the offscreen canvas; `layer.batchDraw()`.

For very large datasets, throttle updates and consider downsampling.
