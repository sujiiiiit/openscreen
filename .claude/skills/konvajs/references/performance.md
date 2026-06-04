# Performance

Konva runs on the CPU (2D canvas). With care you can render thousands of shapes smoothly; without care, a hundred shapes can stutter. Apply these in order of impact.

## 1. Disable listening on non-interactive nodes

Single biggest free win. Every interactive shape draws to both the scene canvas AND a hidden hit canvas.

```javascript
backgroundGrid.listening(false);
decorations.listening(false);
```

Whole layer: `layer.listening(false)`.

In react-konva: `<Rect listening={false} ... />`.

## 2. Keep layer count low

Each Layer is a `<canvas>` element + a hit canvas + compositing cost. Aim for 1–3 total Layers in normal apps.

Use Groups for organization, NOT Layers. Common useful layer split:
- Layer 1: static background (grid, image, doesn't change)
- Layer 2: main content (most shapes)
- Layer 3: drag/transform overlay (only the active node)

If you don't need redraw isolation, just use one Layer.

## 3. Use a drag layer for many-shape scenes

When dragging in a heavy scene, the whole Layer redraws each frame. Move the active node to a light Layer:

```javascript
node.on('dragstart', () => node.moveTo(dragLayer));
node.on('dragend',   () => node.moveTo(mainLayer));
```

Order of magnitude faster for 500+ shapes.

## 4. `perfectDrawEnabled: false` for fill+stroke+opacity shapes

When a shape has all three, Konva renders to a buffer first to prevent edge artifacts. If you can live with a tiny seam, disable it.

```javascript
rect.perfectDrawEnabled(false);
```

## 5. `shadowForStrokeEnabled: false`

If your stroked shapes have shadows, this skips an extra draw pass.

```javascript
rect.shadowForStrokeEnabled(false);
```

Caveat: open lines won't get a shadow. Closed shapes work fine.

## 6. Cache complex subtrees

If a Group has many shapes and rarely changes, cache it:

```javascript
complexLogo.cache();
// when it changes:
complexLogo.clearCache();
```

`cache({ pixelRatio: 1 })` if you're memory-bound (e.g., dozens of cached groups on retina).

## 7. `transformsEnabled: 'position'` for shapes that only translate

```javascript
node.transformsEnabled('position');   // skip rotation/scale matrix math
```

Useful for many small markers/icons that just move.

## 8. Limit pixel ratio on huge stages

```javascript
Konva.pixelRatio = 1;   // global; halves draw work on retina
// or per-stage via stage.canvas.setPixelRatio(1)
```

## 9. Stage size matters

A full-window stage on a 5K display is a LOT of pixels. If you can fit your stage in a smaller div (with internal pan/zoom for content), do so. Smaller stage = less GPU memory + less per-frame work.

## 10. `batchDraw` over `draw`

If you're updating many attributes in a tight loop, prefer mutating then calling `layer.batchDraw()` once. With `Konva.autoDrawEnabled = true` (default) Konva already batches per rAF, but explicit `batchDraw` lets you opt out and aggregate.

For ultra-tight loops, temporarily disable auto-draw:

```javascript
Konva.autoDrawEnabled = false;
// … many mutations …
layer.batchDraw();
Konva.autoDrawEnabled = true;
```

## 11. Avoid `intersects()` and `getAllIntersections()` in hot paths

Both create a temp canvas and redraw — slow. Use `stage.getIntersection(point)` (single pixel read) for hit testing.

## 12. Avoid redrawing during animation when nothing changed

`Konva.Animation` redraws each frame. If your callback sometimes makes no visible change, return without doing work and Konva won't redraw if you don't mutate.

For continuous external state (e.g., audio reactive), it's fine to redraw every frame.

## 13. Keep filters off the hot path

Filters require `cache()`, which is O(w × h). Don't filter the whole stage live. Cache + filter once when params change.

Use CSS filter strings (`'blur(8px)'`) when possible — GPU accelerated.

## 14. Strokes — `strokeScaleEnabled: false` for editors

Independent of perf, but: when the user zooms or scales, you usually want stroke widths to stay constant in screen pixels. Setting this avoids the visual surprise (and avoids the buffer-canvas perf cost of perfect-draw when strokes get huge).

## 15. Remove hidden shapes

`visible: false` still keeps the node in the tree. If you have thousands of toggle-able shapes, `node.remove()` (or `node.destroy()` if not reused) is leaner.

## 16. Pool / reuse nodes for very dynamic scenes

For a particle-style scene with creation churn, allocate a pool of `Konva.Circle` nodes once and reposition them rather than create/destroy.

## 17. Profile, don't guess

- Chrome DevTools → Performance tab. Record while interacting. Look for long "Paint" / "Composite Layers" frames.
- Konva ships a way to toggle a debug border (`tr.toggleHitCanvas()` on a Layer shows the hit canvas — useful for understanding why something does/doesn't get events).

## React-specific perf

- **State updates re-render React tree, which re-renders the whole `<Stage>` subtree.** Memoize shapes (`React.memo`) keyed on stable shape objects. With 1000 shapes and one moving, naive code re-renders all 1000 components — each is cheap, but it adds up.
- **Don't drive position from React state every `onDragMove`.** Read it back only on `onDragEnd`. Or use a ref to bypass React during drag.
- **Split heavy state.** Use a separate store (Zustand/Jotai/Redux) and have each shape subscribe to its own slice. Then a position update for shape #42 only re-renders shape #42's component.
- **Stage size changes are expensive.** Resize on a throttle.
- **Avoid inline object literals as props** (`fill={{...}}`) — they break memoization.

## Quick checklist for an editor

- [ ] One main layer + one drag layer
- [ ] Background grid in its own layer, `listening: false`, `transformsEnabled: 'position'`
- [ ] `strokeScaleEnabled: false` on all editable shapes
- [ ] `perfectDrawEnabled: false` where seams aren't visible
- [ ] Move dragging node to drag layer
- [ ] Memo'd shape components, state in a fine-grained store
- [ ] `onDragEnd` writes to state; `onDragMove` does NOT
- [ ] Transformer's `boundBoxFunc` enforces min sizes
- [ ] Reset `scaleX`/`scaleY` on `transformend` and bake to `width`/`height`
