# Agent Instructions

When changing the Konva editor canvas, keep `docs/editor-canvas.md` and `docs/normal-term.md` updated before the final response.

Update that doc for changes to:

- Konva or react-konva usage.
- Workspace, artboard, viewport transform, zoom, pan, grid, or transformer behavior.
- Video import, playback, quality, redraw, or object URL handling.
- Editor layout, footer zoom controls, aspect ratio presets, background upload flow, or workspace theme tokens.
- New problems, solved problems, known limitations, references, or verification steps.

When changing project persistence — the `project.json` schema, the autosave pipeline, hydration, asset copy, the save-status indicator, or the "Open project" surface — keep the **Project Persistence** section of `docs/editor-canvas.md` updated before the final response.

Treat the autosaved `project.json` as the single source of truth for what survives a refresh / app restart. For every new editor feature, decide explicitly whether its state is persistable or session-only, and wire it accordingly:

- **`electron/ipc/project-schema.ts`** owns `ProjectStateV1` and `parseProjectState`. Mirror every type change in `types/api.d.ts` and update the renderer-side `persistence.ts` serializers in lock-step. **Never mutate existing v1 field shapes.** Adding *optional* fields is safe (the validator tolerates missing optionals and old `project.json` files keep loading). Adding a *required* field, renaming, or changing a field's type requires bumping the version and adding a `migrateProjectState` branch — otherwise existing user projects fail validation and silently load as synthesized defaults, losing their work.
- **`components/editor/canvas/persistence.ts`** holds the pure serialize/deserialize helpers. Every persisted field on `CanvasVideoItem` / `EditorArtboard` / `CanvasTimelineClip` needs a matching pair. `fingerprintProjectState` deliberately excludes `updatedAtUnixMs` and must keep doing so — anything that should *not* trigger a redundant save (timestamps, ids that change every call) must be elided from the fingerprint.
- **`components/editor/canvas/provider.tsx`** owns hydration and the autosave-trigger effect. New persistable state must (a) be a dependency of the autosave effect, (b) be applied in **both** hydration paths (fast-path direct restore from `project.state` *and* slow-path synthesis from `project.assets`), and (c) be reset alongside the existing slots in the hydration effect's project-switch reset block so the new project starts clean.
- **`electron/ipc/projects.ts`** — every code path that surfaces a project in the editor must funnel through `setActiveProjectFromFolder`. That's the only place the sticky `activeProjectPath` is set (in-memory + persisted to `<userData>/active-project.json`); skipping it breaks "refresh returns to the same project". `projects:getLatest` is the only read-only path and must never promote a fallback result to active. Imported user assets are written under `<project>/assets/<kind>/<id>/<filename>` via a sanitised IPC handler — never blob-URL'd, because blob URLs don't survive a refresh.
- **Save status surface** (`saveStatus` / `saveError` + `SaveStatusIndicator`) — if your feature can produce write failures the user should see, route them through this state machine, not a parallel mechanism. New "saving" sources (e.g. a future asset-rename IPC) should set `saving` on schedule, `saved` or `error` on completion, and respect the 500 ms debounce + retry timer contract.
- **Session-only state** (selection, playhead, timeline zoom/scroll, view transform, hover preview) is intentionally **not** persisted. If you add a new piece of state and decide to keep it session-only, say so in the Project Persistence section of `docs/editor-canvas.md` so a future agent doesn't accidentally persist it.

**Export parity — anything that is part of the output video must be wired into the export pipeline, not just the editor preview.** The editor canvas (`components/editor/canvas/`) is only the *preview*; the encoded video is produced separately by `components/editor/export/` (`build-stage.ts` builds an offscreen vanilla-Konva stage, `run-export.ts` draws each frame and feeds it to Mediabunny/WebCodecs). For every new editor-canvas feature, decide explicitly whether it is part of the final output:

- **Part of the output video** (e.g. the cursor overlay, video appearance, background, grain — anything composited onto the artboard that the viewer should see in the exported file): you MUST also render it in the export pipeline, or it will show in the editor but silently be missing from the export. Share the rendering/placement code between the editor and the exporter so the two stay pixel-identical — the established pattern is a pure module both call (`video-scene-draw.ts` for video appearance, `cursor-scene.ts` for the cursor). Do not duplicate the math; extract it. The export draws on a constant layer count with `pixelRatio=1` and no React — adapt to that, and gate per-frame visibility from the frame plan (`planExportFrames`) so trims/splits are honored. Add/extend a test and update the **Export Pipeline** + relevant feature section of `docs/editor-canvas.md`.
- **Editor-only / non-output** (selection handles, hover outlines, transformer, snap guides, grids, toolbars, the playhead): leave it out of the export — these are interaction chrome, not pixels the viewer wants. Say so in the doc if it's ambiguous.

When in doubt, ask: "if the user exports right now, do they expect to see this in the MP4?" If yes, it goes through the export pipeline.

Use industry terms consistently in implementation and documentation. If the user uses a plain-language phrase such as "inner canvas", map it to the preferred term in `docs/normal-term.md` and update that file when new shared terminology appears.

When working on Konva or react-konva code, use the Konva skill and keep the implementation focused on quality, performance, and editor-grade interaction behavior.

For every editor canvas change, reason about large-scene performance before finalizing. Treat `5000+` canvas nodes as the stress case even when the current feature only uses one selected video. Prefer patterns that scale: constant layer counts, no DOM overlay per canvas node, no per-frame React state updates, no hot-path layout reads, no per-node expensive listeners when delegation or hit testing is enough, no `getClientRect()` loops across many nodes, and redraw only the layers that actually changed. If a feature would not scale to thousands of nodes, document the limitation and keep the implementation isolated so it can be replaced with culling, indexing, batching, or virtualization later.

After code changes, run targeted checks for touched files and `pnpm typecheck` when practical. Note any checks that cannot be run.
