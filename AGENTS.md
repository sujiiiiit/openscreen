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

After code changes, run targeted checks for touched files and `pnpm typecheck` when practical. Note any checks that cannot be run.
