# react-konva — patterns and pitfalls

`react-konva` is a thin reconciler: every Konva class becomes a React component with **the same props as the Konva constructor config**. Event handlers are `onClick`, `onDragStart`, `onTransformEnd`, etc. (camelCase).

## Setup

```bash
npm install konva react-konva
```

```jsx
import { Stage, Layer, Rect, Circle, Text, Image, Group, Line, Transformer } from 'react-konva';
```

Components available: `Stage, Layer, FastLayer (deprecated), Group, Rect, Circle, Ellipse, Wedge, Arc, Ring, Line, Arrow, Path, Star, RegularPolygon, Text, TextPath, Image, Sprite, Label, Tag, Transformer`.

The companion `react-konva-utils` package adds:
- `<Html>` — portal a DOM subtree into the canvas at a Konva-positioned spot
- `<Group>` enhancements
- `Portal` — render a node into a different layer (e.g., drag layer)

## SSR / Next.js

react-konva is browser-only. In Next.js App Router:

```jsx
// app/canvas/page.tsx (server component)
import dynamic from 'next/dynamic';
const Canvas = dynamic(() => import('./Canvas'), { ssr: false });
export default function Page() { return <Canvas />; }
```

Pages Router: same `dynamic({ ssr: false })`.

For Remix / Vite / CRA, just guard with `typeof window !== 'undefined'` if needed; Vite handles ESM fine in dev and production.

## The one big mental shift: refs to Konva nodes

Most things stay declarative — render shapes from React state, and event handlers update state. But for a few things you need a ref to the underlying Konva node:

- Attaching a `Transformer` to a target node
- Reading exact transformed dimensions on `transformend`
- Programmatically firing tweens, animations, or `cache()`
- Forcing a redraw with `node.getLayer().batchDraw()`

```jsx
const rectRef = useRef(null);
// rectRef.current is the Konva.Rect instance; rectRef.current.x() etc. work.
<Rect ref={rectRef} ... />
```

## Drag — keep state in sync

The most common pattern: render position from state; on drag end (or move) write the new position back.

```jsx
const [pos, setPos] = useState({ x: 50, y: 50 });

<Rect
  x={pos.x} y={pos.y} width={100} height={50} fill="orange"
  draggable
  onDragEnd={(e) => {
    setPos({ x: e.target.x(), y: e.target.y() });
  }}
/>
```

Why `onDragEnd` and not `onDragMove`? Because writing state every move forces a re-render every frame. For 1–10 items it's fine; for hundreds, prefer `onDragEnd` only and let Konva drive the visual during drag.

If you need continuous state (e.g., to show coordinates), keep that "live" value in a `useRef` and read it in a rAF, or accept the cost.

## Performance quick path for large scenes

When the user reports slow dragging, hover jank, slow zoom/pan, mobile lag, or thousands of nodes, read `performance.md` too. The React-specific first moves are:

- Keep generated shape data stable with `useMemo` or an external store.
- Memoize heavy shape components with `React.memo`.
- Use `useCallback` for handlers passed to many children.
- Avoid `setState` inside every `onDragMove`, `onMouseMove`, animation frame, or filter slider tick unless it is throttled and measured.
- Put hover tooltips, guides, Transformer handles, and active drag previews in separate layers.
- For 10000+ mostly-static nodes, consider creating Konva nodes imperatively in `useEffect` and using React only for surrounding UI controls.

React render order is canvas order. Reorder arrays for z-order changes, and use a drag layer or `react-konva-utils` `Portal` for temporary overlays instead of imperative `zIndex()` on React-managed nodes.

### Controlled vs uncontrolled

- **Controlled** (preferred for editor-style apps): React state holds `x`/`y`; Konva renders from it. After drag, write back. This works because react-konva diffs and only changes attributes that differ — and `e.target.x()` already reflects the new value, so writing it back is a no-op visually.
- **Uncontrolled**: omit `x`/`y` props after initial mount and treat Konva as the source of truth. Reading the value requires `ref.current.x()`. Use when state isn't needed elsewhere.

## Transformer pattern (canonical)

`<Transformer>` cannot bind declaratively — you must `useEffect` to call `tr.nodes([shape])` after both refs mount.

```jsx
function EditableRect({ shapeProps, isSelected, onSelect, onChange }) {
  const shapeRef = useRef(null);
  const trRef = useRef(null);

  useEffect(() => {
    if (isSelected) {
      trRef.current.nodes([shapeRef.current]);
      trRef.current.getLayer().batchDraw();
    }
  }, [isSelected]);

  return (
    <>
      <Rect
        ref={shapeRef}
        {...shapeProps}
        draggable
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(e) => onChange({ ...shapeProps, x: e.target.x(), y: e.target.y() })}
        onTransformEnd={() => {
          const node = shapeRef.current;
          const sx = node.scaleX();
          const sy = node.scaleY();
          // Reset scale and bake into width/height
          node.scaleX(1);
          node.scaleY(1);
          onChange({
            ...shapeProps,
            x: node.x(),
            y: node.y(),
            width: Math.max(5, node.width() * sx),
            height: Math.max(node.height() * sy),
            rotation: node.rotation(),
          });
        }}
      />
      {isSelected && (
        <Transformer
          ref={trRef}
          boundBoxFunc={(oldBox, newBox) => {
            if (Math.abs(newBox.width) < 5 || Math.abs(newBox.height) < 5) return oldBox;
            return newBox;
          }}
        />
      )}
    </>
  );
}
```

See `transformer.md` for the rationale (Transformer mutates `scaleX`/`scaleY`, not `width`/`height`).

## Deselect on empty-stage click

```jsx
const checkDeselect = (e) => {
  // Click on empty area = click on stage itself (no shape target)
  const clickedOnEmpty = e.target === e.target.getStage();
  if (clickedOnEmpty) setSelectedId(null);
};
<Stage onMouseDown={checkDeselect} onTouchStart={checkDeselect}>
```

## Loading images — `use-image`

```bash
npm install use-image
```

```jsx
import useImage from 'use-image';
import { Image as KImage } from 'react-konva';

function URLImage({ src, ...rest }) {
  const [img, status] = useImage(src, 'anonymous');
  // status: 'loading' | 'loaded' | 'failed'
  if (!img) return null;
  return <KImage image={img} {...rest} />;
}
```

`'anonymous'` is the `crossOrigin` value. **Set it if you'll ever export** (toDataURL / toBlob); otherwise the canvas becomes tainted and export throws.

## Stage events — coordinates

```jsx
<Stage
  onMouseDown={(e) => {
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();       // canvas-absolute
    // If stage is panned/zoomed, use relative position:
    const rel = stage.getRelativePointerPosition();
  }}
/>
```

## Embedding DOM (`<Html>` from react-konva-utils)

```jsx
import { Html } from 'react-konva-utils';

<Layer>
  <Html
    groupProps={{ x: 100, y: 100 }}
    divProps={{ style: { pointerEvents: 'auto' } }}
  >
    <input placeholder="Type here" />
  </Html>
</Layer>
```

When to use: inline text editing of a `Konva.Text`, color pickers, complex form widgets. Caveat: HTML inside `<Html>` does NOT appear in `toDataURL()`/`toImage()` exports.

## Common gotchas

### 1. `Image` collides with the DOM `Image`

```jsx
import { Image as KImage } from 'react-konva';   // alias!
```

Otherwise TypeScript/eslint confuses `Image` with `window.Image`.

### 2. React Strict Mode double-mounts

Effects run twice in dev. Idempotent ref-attach code (`tr.nodes([...])`) is fine, but watch for:
- `cache()` called twice — clear cache first
- Animations created in effects — return cleanup to `anim.stop()`

```jsx
useEffect(() => {
  const anim = new Konva.Animation(/* ... */, layer);
  anim.start();
  return () => anim.stop();
}, []);
```

### 3. Re-rendering large canvases is expensive

If state changes cause hundreds of shape components to re-render, prefer:
- Keep shape attributes in a Konva-managed store (Zustand/Jotai) and select narrowly
- Memoize shape components with `React.memo` keyed on stable shape data
- Or, for very large scenes, render imperatively inside one `useEffect` with vanilla Konva, and use React only for the UI chrome

### 4. Conditional `<Transformer>`

Render the Transformer only when something is selected. Rendering it always with `nodes={[]}` works but adds invisible cost.

### 5. Stage size and resize

```jsx
const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
useEffect(() => {
  const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}, []);
<Stage width={size.width} height={size.height} />
```

For container-sized stages, use `ResizeObserver` on the parent div.

### 6. Events are passive by default — `e.evt`

Event handlers receive Konva's `KonvaEventObject<MouseEvent>`. The native DOM event is at `e.evt`.

```jsx
onClick={(e) => {
  e.evt.preventDefault();
  console.log(e.target);                 // the Konva node clicked
  console.log(e.currentTarget);          // the node the handler is attached to
  e.cancelBubble = true;                  // stop bubbling to ancestors
}}
```

### 7. Stage in a flex/grid container

The Stage creates its own `<div>` with absolute-positioned `<canvas>` children. Set the Stage to fill its parent by binding `width`/`height` to measured parent size, OR wrap the Stage in a `position: relative` container.

## TypeScript

react-konva exports types. Common imports:

```ts
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';

const rectRef = useRef<Konva.Rect>(null);
const onDragEnd = (e: KonvaEventObject<DragEvent>) => { /* … */ };
const onTransformEnd = (e: KonvaEventObject<Event>) => { /* … */ };
```

## When NOT to use react-konva

- React Native — not supported. Use `react-native-canvas`, Skia, or `react-native-svg`.
- WebGL-only requirements (thousands of textured sprites) — use PixiJS or three.js instead.
- 3D — Konva is 2D only.
- Highly text-centric editors (rich text formatting per character) — consider Slate/ProseMirror with a canvas overlay.
