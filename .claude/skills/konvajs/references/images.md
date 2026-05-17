# Images and exports

## Loading images — vanilla

`Konva.Image` takes an **`HTMLImageElement`**, not a URL.

```javascript
const img = new window.Image();
img.crossOrigin = 'anonymous';   // REQUIRED if you'll export and the URL is cross-origin
img.onload = () => {
  const node = new Konva.Image({
    x: 50, y: 50, image: img,
    width: 200, height: 150,
  });
  layer.add(node);
};
img.src = '/cat.jpg';
```

Helper:

```javascript
Konva.Image.fromURL('/cat.jpg', (node) => {
  node.setAttrs({ x: 50, y: 50 });
  layer.add(node);
}, (err) => console.error(err));
```

## Loading images — react-konva via `use-image`

```bash
npm install use-image
```

```jsx
import useImage from 'use-image';
import { Image as KImage } from 'react-konva';

function URLImage({ src, ...props }) {
  const [img, status] = useImage(src, 'anonymous');
  // status: 'loading' | 'loaded' | 'failed'
  return img ? <KImage image={img} {...props} /> : null;
}
```

Pass `'anonymous'` to set crossOrigin. Pass `'use-credentials'` for cookies/auth.

## Image sources besides URLs

`image` can be any of:
- `HTMLImageElement`
- `HTMLCanvasElement` — e.g., draw something with 2D context then use it as a Konva.Image source
- `HTMLVideoElement` — drive frames manually (next section)
- `ImageBitmap`

## Video as a Konva.Image

The Konva node only sees the current frame. You must invalidate per frame:

```javascript
const video = document.createElement('video');
video.src = '/movie.mp4';
video.crossOrigin = 'anonymous';
video.muted = true; video.loop = true;
await video.play();

const node = new Konva.Image({ x: 0, y: 0, image: video, width: 640, height: 360 });
layer.add(node);

const anim = new Konva.Animation(() => { /* just trigger redraw */ }, layer);
anim.start();
```

## Cropping

Crop a sub-rectangle out of the source:

```javascript
new Konva.Image({
  image: img,
  width: 200, height: 200,    // displayed size
  cropX: 100, cropY: 50,
  cropWidth: 400, cropHeight: 400,  // region of source to use
});
```

## CORS — the canvas-tainting trap

If you load an image from a different origin without `crossOrigin='anonymous'`, the canvas becomes "tainted":
- `toDataURL()`, `toBlob()`, `toImage()` will throw `SecurityError: Tainted canvases may not be exported.`
- You can still display the image — just can't export.

The remote server must also send `Access-Control-Allow-Origin` for the request to succeed in anonymous mode. If it doesn't, you'll get a load error.

Workarounds when you don't control the source:
- Proxy the image through your own server
- Use a CORS-friendly CDN
- For data URLs, ignore — same-origin

## Exporting to image / blob

Any node (Stage, Layer, Group, or Shape) can be exported.

```javascript
// Synchronous data URL
const url = stage.toDataURL({ pixelRatio: 2 });  // 2× for retina

// Promise / callback to Blob (use for downloads, FormData uploads)
stage.toBlob({ mimeType: 'image/png', pixelRatio: 2 }).then((blob) => {
  const url = URL.createObjectURL(blob);
  // …
});

// Promise / callback to HTMLImageElement
stage.toImage({ mimeType: 'image/jpeg', quality: 0.92 }).then((img) => {
  document.body.appendChild(img);
});

// As a canvas element (for further processing)
stage.toCanvas({
  callback: (canvas) => { /* … */ },
  pixelRatio: 2,
});
```

Options for all of the above:
- `mimeType` — `'image/png'` (default) | `'image/jpeg'` | `'image/webp'`
- `quality` — for jpeg/webp, 0–1
- `pixelRatio` — multiplier on output resolution; `2` for retina, higher for print
- `x`, `y`, `width`, `height` — sub-rectangle to export (defaults to the node's bounding box)
- `imageSmoothingEnabled` — defaults to true; set false for crisp pixel art exports

## Download as a file

```javascript
const link = document.createElement('a');
link.download = 'design.png';
link.href = stage.toDataURL({ pixelRatio: 2 });
link.click();
```

For very large exports (e.g., 4K), prefer `toBlob` + `URL.createObjectURL` to avoid massive base64 strings.

## Export to PDF

Konva does not output PDF directly. Use `jspdf`:

```javascript
import jsPDF from 'jspdf';
const data = stage.toDataURL({ pixelRatio: 2 });
const pdf = new jsPDF({ orientation: 'landscape', unit: 'px',
  format: [stage.width(), stage.height()] });
pdf.addImage(data, 'PNG', 0, 0, stage.width(), stage.height());
pdf.save('design.pdf');
```

## High-DPI / retina

Konva auto-detects `devicePixelRatio` and sets the internal canvas resolution. You can override:
- `Konva.pixelRatio = 1` — global, lower-res for perf
- Per export: `stage.toDataURL({ pixelRatio: 2 })`

## react-konva worked example: image picker

```jsx
function ImageStage() {
  const [src, setSrc] = useState(null);
  const stageRef = useRef(null);

  const onFile = (e) => {
    const file = e.target.files[0];
    if (file) setSrc(URL.createObjectURL(file));
  };
  const onExport = () => {
    const url = stageRef.current.toDataURL({ pixelRatio: 2 });
    const a = document.createElement('a');
    a.download = 'export.png'; a.href = url; a.click();
  };

  return (
    <>
      <input type="file" accept="image/*" onChange={onFile} />
      <button onClick={onExport}>Export PNG</button>
      <Stage ref={stageRef} width={800} height={600}>
        <Layer>
          {src && <URLImage src={src} x={0} y={0} width={800} height={600} />}
        </Layer>
      </Stage>
    </>
  );
}
```

## Common pitfalls

- **Forgot `crossOrigin: 'anonymous'`** — image displays but `toDataURL` throws.
- **Forgot to wait for image load** — `Konva.Image` was constructed with an Image that hasn't loaded; you see nothing or a flicker.
- **`cropX/cropY` units are source pixels, not displayed size.**
- **`pixelRatio: 2` exports are 4× the byte size**. For uploads, `toBlob` is much better than `toDataURL`.
- **SVG `<img>`** works as an image source, but rendering precision may differ from native SVG; converters/loaders sometimes flatten gradients.
