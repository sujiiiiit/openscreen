# Filters

Konva's filter system is a pipeline of `ImageData → ImageData` functions applied to a node's cached pixels.

## The one rule

**You must `cache()` the node before filters do anything.** Filters operate on cached pixel data; without a cache they silently apply nothing.

```javascript
image.cache();
image.filters([Konva.Filters.Blur]);
image.blurRadius(10);
```

In react-konva:

```jsx
const ref = useRef(null);
useEffect(() => {
  if (img) {
    ref.current.cache();
  }
}, [img]);

<KImage
  ref={ref}
  image={img}
  filters={[Konva.Filters.Blur]}
  blurRadius={10}
/>
```

If the image source changes, `clearCache()` then `cache()` again.

## All built-in filters

Each filter reads parameters from corresponding **node attributes**. So you don't pass options to the filter; you set the param on the node, then list the filter.

| Filter | Param attrs on node | Notes |
|---|---|---|
| `Konva.Filters.Blur` | `blurRadius` (px) | Box blur; cheap |
| `Konva.Filters.Brighten` | `brightness` (-1 to 1) | Additive |
| `Konva.Filters.Brightness` | `brightness` | CSS-compatible multiplicative |
| `Konva.Filters.Contrast` | `contrast` (-100 to 100) | |
| `Konva.Filters.Emboss` | `embossStrength`, `embossWhiteLevel`, `embossDirection` ('top'/'top-left'/.../'left'), `embossBlend` (bool) | |
| `Konva.Filters.Enhance` | `enhance` (-1 to 1) | Histogram stretch |
| `Konva.Filters.Grayscale` | — | |
| `Konva.Filters.HSL` | `hue` (deg), `saturation`, `luminance` | |
| `Konva.Filters.HSV` | `hue`, `saturation`, `value` | |
| `Konva.Filters.Invert` | — | |
| `Konva.Filters.Kaleidoscope` | `kaleidoscopePower` (int), `kaleidoscopeAngle` (deg) | |
| `Konva.Filters.Mask` | `threshold` | Removes alpha based on threshold |
| `Konva.Filters.Noise` | `noise` (0–1) | |
| `Konva.Filters.Pixelate` | `pixelSize` (int) | |
| `Konva.Filters.Posterize` | `levels` (0–1) | |
| `Konva.Filters.RGB` | `red` (0–255), `green`, `blue` | Tint |
| `Konva.Filters.RGBA` | `red`, `green`, `blue`, `alpha` (0–1) | |
| `Konva.Filters.Sepia` | — | |
| `Konva.Filters.Solarize` | — | |
| `Konva.Filters.Threshold` | `threshold` (0–1) | |

## Pipelines

`filters([...])` is an array applied in order:

```javascript
image.filters([Konva.Filters.Grayscale, Konva.Filters.Blur, Konva.Filters.Brighten]);
image.blurRadius(3);
image.brightness(0.2);
```

## CSS filters as a fast path

`filters` also accepts a CSS filter string for things modern browsers can do natively. When supported, this is much faster than `ImageData` manipulation:

```javascript
image.cache();
image.filters(['blur(8px) brightness(1.2)']);
```

Or mix array + functions:

```javascript
image.filters([
  Konva.Filters.Grayscale,
  'blur(4px)',
]);
```

If a CSS filter is unsupported, Konva falls back to a function filter when possible.

## Custom filter

A filter is a function `(imageData) => void` that mutates pixels in place. `imageData.data` is a `Uint8ClampedArray` of `[r, g, b, a, r, g, b, a, …]`.

```javascript
function RedTint(imageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.min(255, d[i] + 40);  // boost red
  }
}

image.cache();
image.filters([RedTint]);
```

Tip: you can also read attrs off `this` inside the filter (Konva binds `this` to the node):

```javascript
function MyTint(imageData) {
  const intensity = this.getAttr('tintIntensity') || 0;
  // …
}
```

## When to re-cache

After changing what the node *draws* (text content, child positions inside a Group, image source), you must `clearCache()` and `cache()` again. Changing **filter params** like `blurRadius` does NOT require re-caching — Konva re-applies the pipeline.

## Performance

- Function filters cost O(w × h × n_filters) per cache. Avoid filtering huge images or whole layers.
- Lower `pixelRatio` in `cache({ pixelRatio: 1 })` if the source is very large.
- Cache once when the user picks a filter; don't re-cache every frame.
- The CSS-filter path is GPU-accelerated in modern browsers; use it when possible.
- For real-time video filters, prefer a `<canvas>` 2D context with WebGL shaders or `OffscreenCanvas` + WebGL.

## Common pitfalls

- **"My filter does nothing."** You didn't call `cache()`. Or the node is `visible: false`. Or the filter has a non-zero default param you didn't set (e.g., `blurRadius` defaults to 0 ⇒ no blur).
- **"Filter looks pixelated on retina."** Pass `cache({ pixelRatio: window.devicePixelRatio })`.
- **"Hit detection is wrong after caching."** Use `drawHitFromCache()` if needed, or accept that the cached bounds become the hit region.
- **"Filter changes don't update in react-konva."** Make sure the ref-based `cache()` runs after the image actually loads (in a useEffect that depends on the image).
