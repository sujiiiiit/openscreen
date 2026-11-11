# openscreen — Project Plan

## Where you are today

**Working:**
- **Recorder (native, mac-addon)** → writes `~/Documents/openscreen/<id>/{screen.mov, camera.mov, recording.json}`. The manifest already has dimensions, duration, codec, audio tracks, timing.
- **Project IPC (`electron/ipc/projects.ts`)** — `getLatest()`, `open()`, `pickAndOpen()`. But "project" today = "recording folder + manifest." There is no saved editor state yet.
- **Editor canvas** — Konva stage, artboard presets, video nodes, transform/snap/rotate, sidebar, resizable panels. All state in `EditorCanvasProvider` (`src/components/editor/canvas/provider.tsx`) — purely in-memory React state. Nothing persists.
- **Timeline packages forked** (`packages/timeline`, `packages/timeline-engine`) but not integrated.

**Missing / mixed up:**
1. **Bridge from recorder → editor.** `ProjectProvider` knows about the last recording; `EditorCanvasProvider` only consumes `File` uploads via `addVideoFile`. They don't talk.
2. **Persisted project state** — closing the app loses every edit.
3. **Undo/redo** — nothing.
4. **Timeline ↔ canvas integration** — timeline fork is there but not wired to canvas video state.
5. **Export/render pipeline** — not started.

---

## Decision 1: Project file format

This is the most important fork — get it wrong and you'll fight it for months.

**Three real options:**

| Option | Pros | Cons |
|---|---|---|
| **A. Folder-based** (what you have, augment with `project.json`) | Easy, fast, media stays on disk untouched, easy backup, no extract step | Looks like a folder unless you do the macOS package trick |
| **B. macOS package bundle** (`.openscreen` is a directory Finder shows as a single file via `LSTypeIsPackage`) — *this is what Screen Studio does* | Looks like one file in Finder; internally identical to A | Mac-only UX; on Windows/Linux it's just a folder |
| **C. Zip single file** | Truly portable, one file everywhere | Reading/seeking large video inside a zip is slow → you'd extract to a cache anyway → why bother during editing |

**Recommendation: A + B together.** On disk, the project is always a folder. On macOS, give it the `.openscreen` extension and register it as a package — Finder hides the internals and double-click opens your app. Cross-platform fallback is just a folder. For real sharing/portability, ship a separate "Export bundle" action that zips it.

**Suggested layout inside the project:**

```
my-project.openscreen/        ← Finder sees as one file (Mac), folder elsewhere
├── project.json              ← editor state: artboard, layers, timeline edits, version
├── recording.json            ← original recorder manifest (you already write this)
├── assets/
│   ├── screen.mov            ← from the recorder (or symlink to original)
│   ├── camera.mov
│   └── imported/             ← user-imported media
├── thumbnail.png             ← for a project picker UI later
└── history/                  ← optional, crash-recovery undo
```

**`project.json` schema (initial sketch):**

```json
{
  "schemaVersion": 1,
  "id": "...",
  "name": "Untitled",
  "createdAtUnixMs": 0,
  "updatedAtUnixMs": 0,
  "artboard": { "presetId": "wide", "width": 1920, "height": 1080 },
  "viewTransform": { "scale": 1, "x": 0, "y": 0 },
  "layers": [
    {
      "id": "...",
      "type": "video",
      "assetRef": "screen",
      "x": 0, "y": 0, "width": 1920, "height": 1080,
      "rotation": 0, "locked": false,
      "trim": { "inMs": 0, "outMs": 12000 }
    },
    {
      "id": "...",
      "type": "video",
      "assetRef": "camera",
      "x": 1480, "y": 760, "width": 400, "height": 300,
      "rotation": 0, "locked": false
    }
  ],
  "timeline": { "durationMs": 12000, "clips": [] },
  "background": { "kind": "solid", "color": "#000" }
}
```

Two important rules:
- **Always include `schemaVersion`** and write a migration function from day 1. Cheap insurance.
- **Asset references are relative to the project folder.** Never absolute paths — projects must be movable.

---

## Decision 2: Undo/redo

Two patterns, pick one for your scale:

**A. Snapshot-based** — push the whole serializable scene into a `past[]` array on each commit. Pros: trivial to implement, hard to break. Cons: memory grows with state size × history length.

**B. Command-based** — every action is `{ do(), undo() }`. Pros: small per-step memory, easy to log, supports collab later. Cons: more code, every action must implement both directions.

**Recommendation: snapshot-based.** Your scene state (layers, artboard, transform) is small JSON — a hundred snapshots is well under a megabyte. The complexity savings are huge. You can always migrate later.

**Critical detail:** commit at the *end* of an interaction, not every frame. Three commit signals:
- `dragend`, `transformend` on Konva nodes
- Discrete actions: add/delete/duplicate, preset change, lock toggle
- Input blur for text inputs (later)

Concretely:

```
useHistory<EditorState>({ limit: 100 })
  .commit(nextState)   // pushes past, clears future
  .undo()              // pops past → present, pushes present → future
  .redo()
```

Keyboard: `Cmd+Z` / `Cmd+Shift+Z`. Disable while a drag/transform is in progress.

Skip "selection" from history — selection is UI state, not document state. Same for `viewTransform` (debatable; I'd skip it).

---

## End-to-end flow once done

```
User clicks "Record" on recorder bar
        ↓
mac-addon writes screen.mov + camera.mov + recording.json to <id>/ folder
        ↓
On stop, that folder is upgraded to a real project:
  - assets/screen.mov, assets/camera.mov moved or symlinked
  - project.json written with initial layout (screen filling artboard, camera bottom-right corner)
  - folder renamed to <name>.openscreen
        ↓
Editor window opens, ProjectProvider loads project.json
        ↓
EditorCanvasProvider hydrates layers from project.json (instead of empty)
        ↓
User edits: every commit → history + debounced autosave to project.json
        ↓
Cmd+Z / Cmd+Shift+Z walks history
        ↓
Export → headless render pipeline (next big phase) reads project.json + assets,
         composites in a renderer or via ffmpeg, writes out final mp4
```

The renderer-to-editor handoff is the missing bridge. Everything else builds on top.

---

## Phased plan

### Phase 1 — Bridge recorder → editor (1–2 days)

Goal: end of recording lands you in the editor with the screen + camera already on the canvas.

- Add `addRemoteVideo({ url, width, height, role })` to `EditorCanvasProvider` (no `File` requirement).
- Custom Electron protocol (`media://` or use `file://` with `webSecurity` exceptions) so Konva can render the saved `.mov`.
- `EditorCanvasProvider` consumes `useProject()` on mount; if there's a project with no `project.json` yet, build an initial layout from the manifest (screen fills artboard; camera floats bottom-right).
- Stop using `URL.createObjectURL` for project-loaded media; reserve that for ad-hoc imports.

### Phase 2 — Project file format + autosave (2–3 days)

- Define `project.json` schema + Zod validator + migration scaffold.
- New IPC: `projects:save`, `projects:load`, `projects:createFromRecording`.
- Promote recording folder → `<name>.openscreen` on first save.
- Debounced autosave (e.g., 500 ms after the last commit).
- Register `.openscreen` as a macOS package + file association in `electron-builder.yml`.
- "Recent projects" list (from `~/Documents/openscreen/`).

### Phase 3 — Undo/redo (1–2 days) — **IMPLEMENTED**

- Pure history module at `src/components/editor/canvas/history.ts`; provider exposes `useEditorHistory()` from `src/components/editor/canvas/provider.tsx`.
- Capture is autosave-debounce-aligned (no per-surface wiring on sliders / Konva / timeline). Each provider action tags its commit; the push site inside `flushAutosave`'s drain decides between coalesce and new entry. Destructive actions (`add`/`delete`/`duplicate`/`preset`) call a synchronous `flushAutosaveNow()` so the prior edit window becomes its own undo entry.
- `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` wired in `editor-workspace.tsx`'s key handler; blocked while typing in editable elements, during Transformer rotation/drag, and during pan.
- `canUndo` / `canRedo` are reactive React state on the hook, ready for a future toolbar/menu surface.
- Bonus: persist last N history entries to `<project>/history/` for crash recovery — **still deferred** to Phase 6.
- Full design in `docs/editor-canvas.md` → "Undo / Redo".

### Phase 4 — Timeline integration (3–5 days)

- Pick a serialization format for clips in `project.json` (`{ id, layerId, inMs, outMs, startOnTimelineMs }`).
- Wire the forked timeline to read/write clips through `EditorCanvasProvider`.
- A scrubber that drives video `currentTime` for each canvas video node.
- Trim / split actions become history commits.

### Phase 5 — Export / render pipeline (5–10 days)

- Headless render: a hidden offscreen Konva stage + `MediaRecorder`, OR
- Server-side: ffmpeg compositing driven by `project.json` (more work, much better quality).
- Progress UI in a modal.
- Output to `~/Movies/openscreen/` or user-picked location.

### Phase 6 — Polish & robustness

- Crash-recovery undo (replay `history/` on open).
- "Export bundle" → zip the `.openscreen` into a shareable file.
- Project picker UI on launch.
- Schema migrations for `project.json` v1 → v2 as you add features.

---

## What to do this week

Phase 1 + Phase 2 in that order — until the recorder-editor bridge exists and edits survive a restart, every other improvement is sand. Undo/redo (Phase 3) is short and self-contained, perfect for a follow-up.
