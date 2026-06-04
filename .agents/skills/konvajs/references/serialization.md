# Serialization

Konva can serialize/deserialize the scene tree to/from JSON. Useful for save/load, undo/redo snapshots, and copy/paste.

## Serialize

```javascript
const json = stage.toJSON();             // returns a JSON string
const obj  = stage.toObject();           // returns a plain object
```

`toJSON()` walks the tree, captures each node's `className` and `attrs`, and recurses into children.

## Deserialize

```javascript
const stage = Konva.Node.create(json, 'containerId');
// Or:
const stage = Konva.Node.create(JSON.parse(json), document.getElementById('app'));
```

The second argument is the DOM container (only required if recreating a Stage). For subtrees, you can also recreate without a container and `add()` them into an existing parent.

## What does NOT serialize

This is the big caveat. `toJSON()` only persists `attrs`. It does NOT capture:
- **Event handlers** (`.on('click', …)`) — you must rebind after loading
- **Custom `sceneFunc` / `hitFunc`** — function bodies aren't part of attrs
- **Image bitmap data** — `Konva.Image.image` is a live HTMLImageElement; the attr stores a reference, not pixels. After loading you must re-attach images (e.g., from a URL you saved separately)
- **Filters** — the `filters` array contains function references which won't serialize
- **Cached canvas**

Pattern after `Node.create`:

```javascript
const stage = Konva.Node.create(json, 'app');
stage.find('Image').forEach((img) => {
  const url = img.getAttr('src');   // your custom attr
  Konva.Image.fromURL(url, (loaded) => {
    img.image(loaded.image());
    img.getLayer().batchDraw();
  });
});
stage.find('.selectable').forEach((s) => s.on('click', handleSelect));
```

To make image rehydration easy, **store the URL as a custom attribute** when you create the Konva.Image — Konva serializes unknown attrs too.

## Serializing your own app state instead

For most apps you'll want to keep the source of truth in your own data model (an array of shape objects with `{ id, type, x, y, … }`), not Konva's tree. The Konva tree is rendered *from* your state.

In react-konva this is natural — your `useState` holds shape data, components render shapes. To save: `JSON.stringify(shapes)`. To load: `setShapes(JSON.parse(saved))`.

Konva's `toJSON` is most useful when:
- You're using vanilla Konva and want a one-liner snapshot
- You want to copy a subtree of the live tree (e.g., copy/paste — `JSON.parse(node.toJSON())` then `Konva.Node.create`)
- You're building undo/redo snapshots without an external store

## Undo / redo

Two common approaches:

### A. Application state snapshots (preferred)

```javascript
let history = [];
let pointer = -1;

function commit(state) {
  history = history.slice(0, pointer + 1);
  history.push(structuredClone(state));
  pointer = history.length - 1;
}
function undo() { if (pointer > 0) applyState(history[--pointer]); }
function redo() { if (pointer < history.length - 1) applyState(history[++pointer]); }
```

Commit on logical actions (drag end, transform end, add, delete), not every frame.

### B. Konva tree snapshots

```javascript
const snap = stage.toJSON();   // before action
// … user does something
history.push(snap);
// Undo: stage.destroyChildren(); Konva.Node.create(JSON.parse(snap), container);
```

Heavier and requires the image-rehydration trick. Use option A if you can.

## Copy / paste

```javascript
// Copy
const data = node.toJSON();

// Paste
const copy = Konva.Node.create(data);   // detached
copy.position({ x: copy.x() + 20, y: copy.y() + 20 });
layer.add(copy);
copy.draw?.();   // not needed in auto-draw mode
```

Or simpler: `node.clone()` returns a detached copy of the same class, with the same attrs:

```javascript
const copy = node.clone({ x: node.x() + 20, y: node.y() + 20 });
layer.add(copy);
```

`clone()` is preferred when you don't need to round-trip through JSON.

## Custom data on nodes

You can attach any attribute to a node, and it round-trips through `toJSON`:

```javascript
shape.setAttr('payload', { foo: 'bar' });
shape.getAttr('payload');
```

This is the simplest way to carry app data (database ids, source URLs, layer roles) along with shapes.

## react-konva considerations

If your source of truth is React state, just `JSON.stringify(shapesState)` — much simpler than `stage.toJSON()`. Use Konva's serialization only if you also want to capture transient state (like in-progress transforms, ordering inside a Group) that isn't in your model.
