# Custom Shapes

When the built-in shapes aren't enough, you write a `sceneFunc` that draws to a Konva-wrapped 2D canvas context.

## Minimal example

```javascript
const triangle = new Konva.Shape({
  x: 50, y: 50,
  fill: 'red', stroke: 'black', strokeWidth: 2,
  sceneFunc(ctx, shape) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(100, 0);
    ctx.lineTo(50, 100);
    ctx.closePath();
    ctx.fillStrokeShape(shape);   // applies fill, stroke, shadow from shape's attrs
  },
});
```

`ctx` is a `Konva.Context` — a thin wrapper over the native `CanvasRenderingContext2D` that adds `fillStrokeShape`, `fillShape`, `strokeShape`. The drawing origin is already translated to the shape's `(x, y)`; you draw in local coordinates.

## Konva.Context — what's different from the DOM API

99% of methods are passthroughs to the native context: `beginPath`, `moveTo`, `lineTo`, `arc`, `quadraticCurveTo`, `bezierCurveTo`, `rect`, `roundRect`, `closePath`, `fill`, `stroke`, `clip`, `save`, `restore`, `translate`, `rotate`, `scale`, `transform`, `setTransform`, `createLinearGradient`, etc.

Additions:
- `ctx.fillShape(shape)` — fills using shape's fill attr (gradient/pattern aware)
- `ctx.strokeShape(shape)` — strokes using shape's stroke attrs
- `ctx.fillStrokeShape(shape)` — fill then stroke
- `ctx.getCanvas()` — the wrapper canvas

Always end the path with one of those three; that's what makes your custom shape respect `fill`, `stroke`, `shadow*`, etc. from the shape's attrs.

## In react-konva

```jsx
import { Shape } from 'react-konva';

<Shape
  x={50} y={50}
  width={100} height={100}
  fill="red" stroke="black" strokeWidth={2}
  sceneFunc={(ctx, shape) => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(shape.width(), 0);
    ctx.lineTo(shape.width() / 2, shape.height());
    ctx.closePath();
    ctx.fillStrokeShape(shape);
  }}
/>
```

You'll often want to read custom props off `shape` using `shape.getAttr('myProp')`.

## Custom hit region with hitFunc

By default the hit region equals the scene region. To customize:

```javascript
new Konva.Shape({
  sceneFunc(ctx, shape) { /* fancy art */ },
  hitFunc(ctx, shape) {
    // A simpler shape for hit detection — e.g., bounding box only
    ctx.beginPath();
    ctx.rect(0, 0, shape.width(), shape.height());
    ctx.closePath();
    ctx.fillStrokeShape(shape);
  },
});
```

For very expensive scenes, draw the hit region from a cached scene image:

```javascript
shape.cache();
shape.drawHitFromCache(/* alphaThreshold */ 1);
```

This rasterizes the scene and uses the alpha channel as the hit mask (`alphaThreshold` = 0–255 cutoff).

## Bounding box

If you cache a custom shape, Konva can't infer its bounds — you must pass them:

```javascript
shape.cache({ x: 0, y: 0, width: 100, height: 100, offset: 10 });
```

For `getClientRect()` to be accurate (e.g., to use with Transformer), implement `getSelfRect`:

```javascript
new Konva.Shape({
  /* … */
  getSelfRect() {
    return { x: 0, y: 0, width: 100, height: 100 };
  },
});
```

## Patterns

### Custom connector / edge between two nodes

For diagram editors, draw lines that bind to ports on shapes:

```javascript
new Konva.Shape({
  sceneFunc(ctx, shape) {
    const from = shape.getAttr('from'); // {x, y}
    const to   = shape.getAttr('to');
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    const cx = (from.x + to.x) / 2;
    ctx.bezierCurveTo(cx, from.y, cx, to.y, to.x, to.y);
    ctx.strokeShape(shape);
  },
  stroke: '#666', strokeWidth: 2,
});
```

When endpoint shapes move, update `from`/`to` and the connector redraws.

### Grid background

```javascript
new Konva.Shape({
  listening: false,    // background — no events
  sceneFunc(ctx, shape) {
    const w = shape.getAttr('width');
    const h = shape.getAttr('height');
    const step = 20;
    ctx.beginPath();
    for (let x = 0; x <= w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = 0; y <= h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.strokeShape(shape);
  },
  stroke: '#eee', strokeWidth: 1,
});
```

Set `transformsEnabled: 'position'` on a static background grid for a perf boost.

### Custom dashed selection rectangle

The Transformer's border is automatic, but if you want a custom selection chrome (marching ants), a Shape with dashed stroke and an Animation cycling `dashOffset` works:

```javascript
const marquee = new Konva.Rect({
  stroke: 'rgb(0,161,255)', strokeWidth: 1, dash: [4, 4],
  listening: false,
});
let offset = 0;
new Konva.Animation(() => {
  offset = (offset + 0.5) % 8;
  marquee.dashOffset(offset);
}, layer).start();
```

(Yes, you can use `dashOffset` on any stroked shape.)

## When to write a custom shape vs compose built-ins

- One drawing per Konva node ⇒ custom shape (smaller, lighter).
- Reusable visual that benefits from individual transform/interactivity per part ⇒ Group of built-ins.
- Need filters? Both work, but caching a custom shape is fine.

## Pitfalls

- **Drawing in absolute coords.** Don't call `ctx.moveTo(shape.x(), …)` — the context is already translated. Use local coordinates starting at `(0, 0)`.
- **Forgetting `ctx.fillStrokeShape`.** Without it, your shape ignores its own `fill`/`stroke` attrs.
- **Not implementing `getSelfRect`.** Then the Transformer won't size correctly, `getClientRect()` returns wrong values, and dragging into corners feels weird.
- **Mutating attrs inside sceneFunc.** Don't — it can cause infinite redraws.
