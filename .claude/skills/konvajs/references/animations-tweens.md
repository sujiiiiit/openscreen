# Animations and Tweens

Two complementary tools:
- **`Konva.Animation`** — per-frame callback. You compute new attribute values yourself.
- **`Konva.Tween`** — declarative "go from A → B over t seconds with easing E".

Plus the **`node.to({...})`** shortcut for one-off tweens.

## Konva.Animation

```javascript
const anim = new Konva.Animation((frame) => {
  // frame.time      — total elapsed ms since anim.start()
  // frame.timeDiff  — ms since last frame
  // frame.frameRate — fps (approximate)
  const dx = 50 * (frame.timeDiff / 1000);  // 50 px/sec
  rect.x(rect.x() + dx);
}, layer);   // pass the layer(s) to redraw — can be array

anim.start();
anim.stop();
anim.isRunning();
```

- Pass `null` for the layer and call `layer.batchDraw()` yourself if you need to control redraw.
- The callback runs on `requestAnimationFrame`; expect ~60fps when the tab is visible.

## Konva.Tween — declarative

```javascript
const tween = new Konva.Tween({
  node: rect,
  duration: 1,                       // seconds
  easing: Konva.Easings.EaseInOut,
  x: 200, y: 100,
  rotation: 360, opacity: 0.5,
  fill: 'red',                       // colors interpolate too
  onUpdate: () => { /* per frame */ },
  onFinish: () => { /* called once */ },
});

tween.play();
tween.pause();
tween.reverse();   // play in reverse from current time
tween.reset();     // back to start, paused
tween.seek(t);     // jump to time t (seconds)
tween.finish();    // jump to end
tween.destroy();   // cleanup
```

Tweens animate **any numeric attribute**. Colors are interpolated as RGBA.

## The shortcut: node.to({...})

For one-off tweens, skip the constructor:

```javascript
rect.to({
  duration: 0.5,
  x: 400, fill: 'green',
  easing: Konva.Easings.EaseOut,
  onFinish: () => console.log('done'),
});
```

Identical to a Tween but reuses the underlying machinery, and is cleaned up automatically.

## Easings (all 16)

`Konva.Easings.<name>`:

- `Linear` (default if not specified — although docs say default is Linear; sometimes referred to as identity)
- `EaseIn`, `EaseOut`, `EaseInOut`
- `StrongEaseIn`, `StrongEaseOut`, `StrongEaseInOut`
- `BackEaseIn`, `BackEaseOut`, `BackEaseInOut`
- `ElasticEaseIn`, `ElasticEaseOut`, `ElasticEaseInOut`
- `BounceEaseIn`, `BounceEaseOut`, `BounceEaseInOut`

Picking guide:
- `EaseInOut` — smooth and general
- `StrongEaseOut` — feels "snappy" at start, settles softly (great for "land here" motions)
- `BackEaseOut` — overshoots then settles (Material/iOS feel)
- `ElasticEaseOut` — exaggerated overshoot
- `BounceEaseOut` — physical bounce

## Chaining tweens

There's no built-in `then()`. Chain via `onFinish`:

```javascript
new Konva.Tween({ node, duration: 0.5, x: 100,
  onFinish() {
    new Konva.Tween({ node, duration: 0.5, y: 200 }).play();
  },
}).play();
```

Or write a tiny helper that returns a Promise:

```javascript
const tweenP = (node, props) =>
  new Promise((resolve) => node.to({ ...props, onFinish: resolve }));

await tweenP(rect, { duration: 0.5, x: 100 });
await tweenP(rect, { duration: 0.5, y: 200 });
```

## Animation vs Tween — which one?

- **Tween**: you know start/end values and want a smooth interpolation. UI transitions, hover effects, "fly in" entrances.
- **Animation**: physics, continuous motion, motion driven by external input (audio levels, scroll position), parametric paths, particle systems.

## Sprite — frame animation from an image sheet

For pixel-art / 2D character animation, `Konva.Sprite` is purpose-built:

```javascript
new Konva.Sprite({
  image: sheet,
  animation: 'walk',
  animations: {
    idle: [/* x,y,w,h per frame */],
    walk: [/* … */],
  },
  frameRate: 10,
}).start();
```

See `shapes.md` for full Sprite config.

## React patterns

`Konva.Animation` and `Konva.Tween` work the same in react-konva — start them in `useEffect`, stop in cleanup. **Don't store the animation in state**; it's mutable. Use a ref.

```jsx
const rectRef = useRef(null);
useEffect(() => {
  const anim = new Konva.Animation((frame) => {
    rectRef.current.rotation((frame.time * 0.1) % 360);
  }, rectRef.current.getLayer());
  anim.start();
  return () => anim.stop();
}, []);
```

Or use the imperative shortcut on event:

```jsx
<Rect ref={rectRef}
  onClick={() => rectRef.current.to({ duration: 0.3, scaleX: 1.2, scaleY: 1.2,
    onFinish: () => rectRef.current.to({ duration: 0.3, scaleX: 1, scaleY: 1 }),
  })}
/>
```

## Performance

- Each running Animation calls back at rAF rate. Tens of concurrent animations are fine; hundreds may stutter.
- A Tween can update many attributes per node cheaply; prefer one Tween per node over multiple.
- If many shapes share the same motion, animate their **parent Group** instead.
- For non-visible animation (offscreen tab), `requestAnimationFrame` is paused — animations effectively stop until the tab is visible again.

## Stopping all animations

```javascript
Konva.Animation.stopAll?.();   // not built in
// Track them yourself; or stop the layer's animations by destroying the layer.
```

## Cleanup checklist

- `anim.stop()` in component unmount
- `tween.destroy()` if you keep references in a list
- Remove event listeners attached just to drive an animation
