# Agent Instructions

When changing the Konva editor canvas, keep `docs/editor-canvas.md` and `docs/normal-term.md` updated before the final response.

Update that doc for changes to:

- Konva or react-konva usage.
- Workspace, artboard, viewport transform, zoom, pan, grid, or transformer behavior.
- Video import, playback, quality, redraw, or object URL handling.
- Editor layout, footer zoom controls, aspect ratio presets, background upload flow, or workspace theme tokens.
- New problems, solved problems, known limitations, references, or verification steps.

Use industry terms consistently in implementation and documentation. If the user uses a plain-language phrase such as "inner canvas", map it to the preferred term in `docs/normal-term.md` and update that file when new shared terminology appears.

When working on Konva or react-konva code, use the Konva skill and keep the implementation focused on quality, performance, and editor-grade interaction behavior.

For every editor canvas change, reason about large-scene performance before finalizing. Treat `5000+` canvas nodes as the stress case even when the current feature only uses one selected video. Prefer patterns that scale: constant layer counts, no DOM overlay per canvas node, no per-frame React state updates, no hot-path layout reads, no per-node expensive listeners when delegation or hit testing is enough, no `getClientRect()` loops across many nodes, and redraw only the layers that actually changed. If a feature would not scale to thousands of nodes, document the limitation and keep the implementation isolated so it can be replaced with culling, indexing, batching, or virtualization later.

After code changes, run targeted checks for touched files and `pnpm typecheck` when practical. Note any checks that cannot be run.