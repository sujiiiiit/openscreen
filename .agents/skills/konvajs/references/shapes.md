# Shapes — full catalog

Every shape extends `Konva.Shape`, which extends `Konva.Node`. So all shapes inherit position/scale/rotation/opacity/visibility/draggable/listening from Node, and fill/stroke/shadow/dash from Shape.

## Shape-wide styling props (every shape supports these)

```javascript
{
  // Fill — exactly one of these "wins" per fillPriority
  fill: '#ff0000',
  fillEnabled: true,
  fillPriority: 'color',  // 'color' | 'linear-gradient' | 'radial-gradient' | 'pattern'

  // Gradient (linear)
  fillLinearGradientStartPoint: { x: 0, y: 0 },
  fillLinearGradientEndPoint:   { x: 100, y: 100 },
  fillLinearGradientColorStops: [0, 'red', 1, 'blue'],

  // Gradient (radial)
  fillRadialGradientStartPoint: { x: 50, y: 50 }, fillRadialGradientStartRadius: 0,
  fillRadialGradientEndPoint:   { x: 50, y: 50 }, fillRadialGradientEndRadius: 100,
  fillRadialGradientColorStops: [0, 'yellow', 1, 'orange'],

  // Pattern fill (image-tiled)
  fillPatternImage: imageObj,
  fillPatternRepeat: 'repeat',  // 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat'
  fillPatternOffset: { x: 0, y: 0 },
  fillPatternScale:  { x: 1, y: 1 },
  fillPatternRotation: 0,

  // Stroke
  stroke: 'black', strokeWidth: 2, strokeEnabled: true,
  lineJoin: 'miter',  // 'miter' | 'round' | 'bevel'
  lineCap: 'butt',    // 'butt' | 'round' | 'square'
  dash: [10, 5], dashEnabled: true,
  strokeScaleEnabled: true,        // scale stroke when shape is scaled — usually false for editors
  fillAfterStrokeEnabled: false,   // useful for text — fill on top of stroke
  hitStrokeWidth: 'auto',          // expand hit region for thin strokes

  // Shadow
  shadowColor: 'black', shadowBlur: 10,
  shadowOffset: { x: 5, y: 5 }, shadowOpacity: 0.5, shadowEnabled: true,
  shadowForStrokeEnabled: true,    // disable for perf if you have strokes

  // Perf
  perfectDrawEnabled: true,        // turn OFF to skip buffer canvas for fill+stroke+opacity
}
```

`perfectDrawEnabled` matters: when a shape has fill **and** stroke **and** opacity, Konva draws to a buffer canvas first to avoid double-blending the seam between fill and stroke. Disabling it (when seams aren't visible) is a free win.

`strokeScaleEnabled: false` — critical for editors where the user resizes a shape with the Transformer. Without it, a 2px stroke becomes a 20px stroke at 10× zoom.

## Konva.Rect

```javascript
new Konva.Rect({
  x: 10, y: 10, width: 100, height: 50,
  cornerRadius: 8,   // number or [tl, tr, br, bl]
  fill: 'red', stroke: 'black', strokeWidth: 2,
});
```

## Konva.Circle

```javascript
new Konva.Circle({
  x: 100, y: 100,   // center, not top-left
  radius: 50,
  fill: 'green',
});
```

## Konva.Ellipse

```javascript
new Konva.Ellipse({
  x: 200, y: 100,           // center
  radiusX: 80, radiusY: 40,
  fill: 'purple',
});
```

## Konva.Line

The most versatile shape — used for free-form polylines, splines (with `tension`), and closed polygons.

```javascript
new Konva.Line({
  points: [0, 0, 100, 0, 100, 100, 0, 100],
  stroke: 'black', strokeWidth: 2,
  lineCap: 'round', lineJoin: 'round',
  tension: 0,     // 0 = straight segments. >0 = spline through points.
  closed: false,  // true closes the polygon; fill applies
  fill: undefined, // requires closed: true
});
```

`tension` 0.3–0.5 gives a nice hand-drawn feel.

## Konva.Arrow extends Konva.Line

Same as Line + arrowheads.

```javascript
new Konva.Arrow({
  points: [0, 0, 200, 100],
  pointerLength: 10, pointerWidth: 10,
  pointerAtBeginning: false, pointerAtEnding: true,
  stroke: 'black', fill: 'black', strokeWidth: 2,
});
```

## Konva.Arc

```javascript
new Konva.Arc({
  x: 100, y: 100,
  innerRadius: 40, outerRadius: 70,
  angle: 60,         // sweep in degrees
  rotation: -30,
  fill: 'red',
});
```

## Konva.Ring

A donut. Like Arc with `angle: 360`.

```javascript
new Konva.Ring({ x: 100, y: 100, innerRadius: 40, outerRadius: 70, fill: '#ccc' });
```

## Konva.Wedge

A pie slice.

```javascript
new Konva.Wedge({ x: 100, y: 100, radius: 70, angle: 60, fill: 'red', rotation: -30 });
```

## Konva.Star

```javascript
new Konva.Star({
  x: 100, y: 100,
  numPoints: 5,
  innerRadius: 30, outerRadius: 60,
  fill: 'gold', stroke: 'black',
});
```

## Konva.RegularPolygon

```javascript
new Konva.RegularPolygon({
  x: 100, y: 100, sides: 6, radius: 50, fill: 'blue',
});
```

## Konva.Path

Renders SVG path data. Supports `M m L l H h V v Q q T t C c S s A a Z z`.

```javascript
new Konva.Path({
  x: 0, y: 0,
  data: 'M10,10 L100,10 Q150,10 150,60 L150,100 Z',
  fill: 'lightgreen', stroke: 'darkgreen',
});
```

Useful for icons, logos, route lines, anything you already have in SVG.

## Konva.Text

```javascript
new Konva.Text({
  x: 20, y: 20,
  text: 'Hello\nWorld',
  fontFamily: 'Arial', fontSize: 24,
  fontStyle: 'normal',         // 'normal' | 'italic' | 'bold' | 'italic bold' | '500'
  fontVariant: 'normal',       // 'normal' | 'small-caps'
  fill: 'black',
  align: 'left',               // 'left' | 'center' | 'right' | 'justify'
  verticalAlign: 'top',        // 'top' | 'middle' | 'bottom'
  width: 300,                  // wrap width (omit for no wrap)
  height: 100,                 // for ellipsis to trigger
  padding: 5,
  lineHeight: 1.2,
  wrap: 'word',                // 'word' | 'char' | 'none'
  ellipsis: true,
  letterSpacing: 0,
  textDecoration: '',          // 'underline' | 'line-through' | both space-separated
  fillAfterStrokeEnabled: true, // pleasant for stroked text
});
```

Limitations: there is no native rich-text (per-character color/size) inside a single `Konva.Text`. Workarounds:
- Multiple `Konva.Text` nodes laid out manually
- `charRenderFunc` callback to mutate the context per glyph
- Use `<Html>` for editable text input, render result as `Konva.Text` after blur

Text width measurement: `text.measureSize(string)` (single-line only). For multi-line, use `text.width()` / `text.height()` after rendering.

## Konva.TextPath

Render text along an SVG path.

```javascript
new Konva.TextPath({
  x: 0, y: 0,
  fill: '#333', fontSize: 24, fontFamily: 'Arial',
  text: 'Curving along a path',
  data: 'M10,10 C0,0 10,150 100,100 S300,150 400,50',
});
```

## Konva.Image

```javascript
// Vanilla — manual load
const img = new window.Image();
img.crossOrigin = 'anonymous';
img.onload = () => {
  const k = new Konva.Image({
    x: 50, y: 50, image: img,
    width: 200, height: 150,
    cornerRadius: 8,
  });
  layer.add(k);
};
img.src = '/cat.jpg';

// Or use the helper:
Konva.Image.fromURL('/cat.jpg', (k) => {
  k.setAttrs({ x: 50, y: 50, width: 200, height: 150 });
  layer.add(k);
});
```

`image` can be an `HTMLImageElement`, `HTMLCanvasElement`, or `HTMLVideoElement`. For video, drive frames yourself with an Animation that calls `layer.batchDraw()` each tick.

Crop a region:
```javascript
{ cropX: 100, cropY: 50, cropWidth: 200, cropHeight: 200 }
```

In react-konva, use the `use-image` hook (see `images.md`).

## Konva.Sprite

Frame-based animation from a sprite sheet.

```javascript
new Konva.Sprite({
  x: 0, y: 0,
  image: spriteSheetImageObj,
  animation: 'idle',
  animations: {
    idle: [
      // x, y, w, h per frame
      0, 0, 32, 32,
      32, 0, 32, 32,
      64, 0, 32, 32,
    ],
    walk: [0, 32, 32, 32, 32, 32, 32, 32 /* ... */],
  },
  frameRate: 12,
  frameIndex: 0,
});
sprite.start();  // begin animating
sprite.animation('walk');  // change current animation
```

## Konva.Label + Konva.Tag

A Label is a Group composed of one `Konva.Tag` (background) and one `Konva.Text`. The Tag can have a pointer ("speech bubble" tail).

```javascript
const label = new Konva.Label({ x: 100, y: 100, opacity: 0.9 });
label.add(new Konva.Tag({
  fill: 'black',
  pointerDirection: 'down',   // 'up' | 'right' | 'down' | 'left' | 'none'
  pointerWidth: 10, pointerHeight: 10,
  cornerRadius: 4,
}));
label.add(new Konva.Text({
  text: 'Tooltip', fontSize: 16, padding: 8, fill: 'white',
}));
layer.add(label);
```

Position: with a downward pointer, the Label is placed so that the tip of the pointer is at `(x, y)`.

## Custom shapes via sceneFunc

If none of the built-ins fit, define your own draw function:

```javascript
new Konva.Shape({
  x: 50, y: 50, fill: 'red',
  sceneFunc(ctx, shape) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(100, 0);
    ctx.lineTo(50, 100);
    ctx.closePath();
    ctx.fillStrokeShape(shape);  // applies fill, stroke, shadow from shape attrs
  },
});
```

See `custom-shapes.md` for the full pattern (including custom hit regions via `hitFunc`).

## Quick reference: which shape for what

| Goal | Shape |
|---|---|
| Box, button, card | Rect (with cornerRadius) |
| Dot, marker | Circle |
| Selection ellipse | Ellipse |
| Polyline / polygon / spline | Line (closed / tension) |
| Connector arrow | Arrow |
| Pie chart slice | Wedge |
| Donut chart slice | Arc |
| Progress ring | Arc or Ring |
| Badge / sticker | Star or RegularPolygon |
| Icon from SVG | Path |
| Caption / label | Text |
| Tooltip / pin marker | Label + Tag |
| Text on a curve | TextPath |
| Photo / sticker / drag-and-drop image | Image |
| 2D character / GIF-like loop | Sprite |
