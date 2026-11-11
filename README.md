# OpenScreen

A macOS app that turns a raw screen recording into a polished product demo.

You record your screen, camera and mic. OpenScreen then edits the recording for you: it zooms in where you clicked, redraws a smooth cursor, puts the video on a styled background with rounded corners, and exports an MP4. You can adjust everything on a timeline afterwards, but you don't have to.

Built with Electron + Next.js for the app, a native **Objective-C++ addon** (ScreenCaptureKit, AVFoundation, VideoToolbox) for recording, **PixiJS on WebGPU** for the editor, and **WebCodecs + Mediabunny** for export.

> **Platform:** macOS 13 (Ventura) or newer. Recording is macOS-only (the native addon is `os: darwin`).

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Setup](#setup)
  - [1. Install tools](#1-install-tools)
  - [2. Clone and install](#2-clone-and-install)
  - [3. Build the native addon](#3-build-the-native-addon)
  - [4. Run in development](#4-run-in-development)
  - [5. Grant macOS permissions](#5-grant-macos-permissions)
  - [6. Build a release (DMG)](#6-build-a-release-dmg)
- [Using OpenScreen](#using-openscreen)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Recording settings](#recording-settings)
- [Export settings](#export-settings)
- [Where files are stored](#where-files-are-stored)
- [macOS version support](#macos-version-support)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Further docs](#further-docs)

---

## Features

**Recording (native, `packages/mac-addon`)**
- Record a **display**, a **window** or a **region**, with a picker that follows macOS Spaces.
- **System audio** (all apps or selected apps) and **microphone** are muxed into the screen file. The **camera** goes to its own file, with a floating live camera preview.
- **HEVC or H.264** through VideoToolbox, in MOV or MP4, at native Retina resolution and up to the display's refresh rate.
- **Accurate colour**: capture is converted to sRGB on the GPU and tagged BT.709, so recordings on Display-P3 Macs look the same as macOS's own `Cmd+Shift+5` recordings instead of washed out.
- **Pause / resume** into one continuous file, plus restart and delete.
- **Cursor and input capture**: every mouse move (about 120 Hz), click and cursor shape (all 38 system cursors), plus opt-in keystrokes, saved as JSON next to the video. The timeline is anchored to the first video frame, so the cursor lines up exactly with the video.
- Option to leave the system cursor out of the video, so the editor can draw its own.

**Editor**
- **Artboard** presets: Wide 1920×1080, Vertical 1080×1920, Standard 1440×1080, Portrait 1080×1350, Square 1080×1080.
- **Background**: wallpaper or solid colour, with blur, padding and an on/off switch.
- **Video appearance**: corner radius with squircle smoothing, border, offset and alignment. Layout fits the artboard automatically.
- **Cursor**: redrawn from the recorded data, with smoothing, a click press (downscale) animation, motion blur, and a side lean in the direction of movement. Brief cursor-shape flicker is smoothed out.
- **Auto-zoom**: clicks are grouped into zoom clips on the timeline. In **auto** mode the camera follows the cursor with a spring and looks slightly ahead of it. In **manual** mode it holds a fixed point. Zoom in/out uses a radial zoom blur, and fast reframes use a directional pan blur.
- **Timeline**: video and zoom tracks, split clips, hover preview, frame stepping.
- **Undo / redo** and **autosave** (500 ms debounce) to `project.json`, with a save status icon in the title bar.
- **Renderer choice**: WebGPU (default) or WebGL2 from the title bar menu. Preview and export always use the same backend.
- Fullscreen preview player.

**Export**
- **MP4 (H.264)**, **MP4 (HEVC)** or **WebM (VP9)**, at artboard size, 720p, 1080p, 1440p or 4K, 30 or 60 fps.
- The same PixiJS scene code renders the preview and the export, so the file matches what you saw, frame for frame, including blurs.
- Codec support is **probed at runtime**, so formats the machine can't encode are disabled instead of failing.
- The output is **streamed to disk** while encoding (written to a hidden `.pending-…` file, then renamed when done), so multi-GB exports don't sit in memory. Limit: 4 hours and 4K.

---

## How it works

```
┌──────────────────────── Electron main process ─────────────────────────┐
│  electron/main.ts, windowConfigs.ts                                     │
│  electron/ipc/                                                          │
│   ├─ recorder.ts      start/pause/stop, quality settings, output folder │
│   ├─ permissions.ts   screen, mic, camera, accessibility (+ input mon.) │
│   ├─ window-picker / display-target   what to record                    │
│   ├─ projects.ts      open/save project.json, assets, active project    │
│   └─ export.ts        streamed writes of the encoded file to disk       │
│                │                                                        │
│                ▼  N-API                                                 │
│  @openscreen/mac-addon (Objective-C++)                                  │
│   RecorderSession ─┬─ ScreenTrack ── SCStream ─► AVAssetWriter ─► screen.mov
│                    │   ├─ SystemAudioTrack  (muxed)                     │
│                    │   └─ MicrophoneTrack   (muxed, macOS 15+)          │
│                    ├─ CameraTrack ── AVCaptureSession ─► camera.mov     │
│                    └─ InputTrack + CursorTrack ── CGEventTap ─► *.json  │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │ preload.ts (contextBridge IPC)
┌────────────────────────────────▼───────────────────────────────────────┐
│  Renderer windows (Next.js, static export)                              │
│   /recorder  /recording-controls  /window-picker  /camera               │
│   /permissions  /recording-settings  /export   and the editor (/)       │
│                                                                         │
│  Editor: React state (EditorCanvasProvider) ─► PixiJS scene (WebGPU/GL) │
│  Export: same scene ─► VideoFrame ─► WebCodecs encoder (Mediabunny)     │
│          ─► StreamTarget chunks ─► IPC ─► file on disk                  │
└─────────────────────────────────────────────────────────────────────────┘
```

1. **Record.** The recorder bar starts a native `RecorderSession`. ScreenCaptureKit sends screen frames and audio, which share one clock, so audio and video stay in sync without resampling. An `AVAssetWriter` encodes them with VideoToolbox. The camera has its own capture session and file. A listen-only `CGEventTap` on its own thread records mouse and keyboard events. Recorded media never goes through per-frame IPC.
2. **Save.** Each recording is a folder with `screen.mov`, `camera.mov`, the input JSON files and a `recording.json` manifest (sizes, codec, timing, files).
3. **Edit.** The editor opens that folder as a project. Your edits live in React state, are drawn by a PixiJS scene, and are saved to `project.json` after 500 ms. Undo/redo snapshots the same state.
4. **Export.** The export window builds the same PixiJS scene off-screen. It decodes source frames (passing `VideoFrame`s straight to textures when no rotation or cropping fix is needed), renders each output frame, and encodes with WebCodecs through Mediabunny. The encoded chunks are written to disk through IPC as they're produced.

---

## Requirements

| What | Version | Notes |
|---|---|---|
| macOS | **13.0+** | 15+ for microphone audio and per-app audio on display/region recordings. See [macOS version support](#macos-version-support) |
| Xcode Command Line Tools | latest | `xcode-select --install`. Needed to compile the addon |
| Node.js | **24.x** recommended | The addon is built against the Node/Electron ABI it's installed with |
| pnpm | 10+ | Workspace with `packages/*` |
| Python 3 | any recent | Used by `node-gyp` |
| Apple Silicon or Intel | either | HEVC is the default codec on Apple Silicon, H.264 on Intel |

---

## Setup

### 1. Install tools

```bash
xcode-select --install          # compilers and the macOS SDK
brew install node@24 pnpm       # or use nvm / fnm / volta for Node
python3 --version               # node-gyp needs Python 3
```

### 2. Clone and install

```bash
git clone https://github.com/sujiiiiit/openscreen.git
cd openscreen
git checkout feat/pixijs-canvas  # the current PixiJS editor (main still has the older Konva editor)
pnpm install
```

`pnpm install` builds native dependencies that are allowed in `package.json` → `pnpm.onlyBuiltDependencies` (`@openscreen/mac-addon`, `electron`, `esbuild`, `node-mac-permissions`).

### 3. Build the native addon

`pnpm dev` and `pnpm build` build it for you, but you can build it on its own:

```bash
pnpm --filter @openscreen/mac-addon build         # node-gyp rebuild
pnpm --filter @openscreen/mac-addon build:debug   # debug build
```

The output is `packages/mac-addon/build/Release/mac_addon.node`. The build targets macOS 13.0 with C++17, libc++ and **ARC** (`-fobjc-arc`, required), and links ScreenCaptureKit, AVFoundation, VideoToolbox, CoreMedia, CoreVideo, CoreGraphics, IOSurface, AudioToolbox, AppKit, Foundation and Accelerate.

If Electron reports a `NODE_MODULE_VERSION` mismatch, rebuild the addon for Electron's ABI:

```bash
npx electron-rebuild -f -w @openscreen/mac-addon
```

### 4. Run in development

```bash
pnpm dev
```

This runs three processes together:

| Name | Process | What it does |
|---|---|---|
| `NEXT` | `next dev --turbopack -p 3535` | Serves the renderer windows on `http://localhost:3535` |
| `TSC` | `tsc -w -p electron` | Compiles the main process and preload to `dist-electron/` |
| `ELEC` | `electronmon .` | Starts Electron once port 3535 and `dist-electron/main.js` are ready, and restarts it when `dist-electron/` changes |

Before that, `dev:prebuild` builds the addon, compiles `electron/` once and copies `electron/dist-package.json` to `dist-electron/package.json`.

Renderer changes hot-reload. Main-process changes restart Electron. **Native changes need the addon rebuilt** (`pnpm --filter @openscreen/mac-addon build`) and then a restart.

### 5. Grant macOS permissions

On first launch the **Permissions** window lists what's missing. Grant these in **System Settings → Privacy & Security**:

| Permission | Needed for | Required |
|---|---|---|
| Screen & System Audio Recording | Screen and system audio | Yes |
| Microphone | Voice | Yes |
| Camera | Camera recording and preview | Yes |
| Accessibility | Mouse and click capture (`CGEventTap`) | Yes |
| Input Monitoring | Keystroke capture | Only if you turn on **Capture keystrokes** |

In development the permissions apply to the app that runs Electron (your terminal or `Electron.app`), so grant them there. macOS usually needs the app restarted after you grant Screen Recording.

To reset permissions while testing:

```bash
tccutil reset ScreenCapture
tccutil reset Accessibility
tccutil reset Microphone
tccutil reset Camera
```

### 6. Build a release (DMG)

```bash
pnpm clean        # delete .next/ out/ dist-electron/
pnpm build        # clean + addon + Next.js static export (out/) + Electron (dist-electron/)
pnpm build:mac    # pnpm build + electron-builder --mac  ->  release/OpenScreen-<version>-<arch>.dmg
pnpm build:mac -- --skip-build     # repackage existing out/ + dist-electron/ (no clean)
pnpm build:mac -- --arch x64       # arm64 (default: host) | x64 | universal
pnpm clean -- --release --addon    # also wipe release/ and packages/mac-addon/build/
```

Signing comes from `.env` (copy `.env.example`). With no `APPLE_SIGNING_IDENTITY` (the default), the app is **ad-hoc signed and not notarized**: it runs on this Mac; on other Macs, right-click → Open, or `xattr -dr com.apple.quarantine /Applications/OpenScreen.app`. Fill in a `Developer ID Application` identity plus `APPLE_ID` / `APPLE_ID_PASSWORD` / `APPLE_TEAM_ID` to get a signed, notarized DMG. Nothing else changes. See [`docs/mac-build.md`](docs/mac-build.md).

---

## Using OpenScreen

1. **Pick what to record** in the recorder bar: display, window or region. Pick audio sources (system audio, mic) and the camera in its menus.
2. **Record.** The recording controls window has **pause/resume**, **stop**, **restart** and **delete**.
3. **Stop.** The recording is saved and opens in the editor, already placed on the artboard.
4. **Edit** in the sidebar tabs:
   - **Background**: wallpaper or colour, blur, padding.
   - **Video**: radius, smoothing, border, offset, alignment.
   - **Cursor**: style, smoothing, click downscale, motion blur, side lean.
   - **Zoom**: generate auto-zoom from clicks, or add clips by hand. Each clip has scale, duration, blur strength and a focus that's **Auto** (follows the cursor) or **Manual** (fixed point), and can be turned off.
5. **Export** from the title bar: pick format, resolution and frame rate. The file goes to `~/Documents/openscreen/exports/`.

To reopen an earlier recording, use **Open project** in the recorder's settings menu. Refreshing or restarting returns to the same project.

---

## Keyboard shortcuts

`Cmd` can be `Ctrl` too.

| Keys | Action |
|---|---|
| `Cmd+Z` / `Cmd+Shift+Z` | Undo / redo |
| `Delete` / `Backspace` | Remove the selected zoom clip, or detach the selected video |
| `,` / `.` | Step the playhead one frame back / forward |
| `Cmd+=` / `Cmd+-` | Zoom the workspace in / out |
| `Cmd+0` | Zoom to 100% |
| `Shift+F` | Fit the artboard in the workspace |
| `Shift+2` | Zoom to 200% |
| Hold `Space` + drag | Pan the workspace |
| `Space` (fullscreen preview) | Play / pause |

---

## Recording settings

Open **Recording Quality** from the recorder's settings menu. Settings are saved to `<userData>/recording-quality.json` and checked by both the main process and the addon before each recording. Unknown values fall back to the defaults.

| Setting | Options | Default |
|---|---|---|
| Codec | `hevc`, `h264` | `hevc` on Apple Silicon, `h264` on Intel |
| Quality | `low`, `medium`, `high`, `xhigh`, `max` (bits per pixel) | `high` |
| Container | `mov`, `mp4` | `mov` |
| Resolution | `native` (Retina pixels), `logical` (1×) | `native` |
| Frame rate | native refresh, 24, 30, 60 | `60` |

Bitrate is `width × height × fps × bits-per-pixel`. Audio is AAC, 48 kHz stereo, 256 kbps. ProRes, HEVC with alpha and HDR are left out on purpose, so every file plays everywhere.

The same window has **Editor** preferences: **Autoplay on open** and **Remember sidebar tab**.

---

## Export settings

| Setting | Options | Default |
|---|---|---|
| Format | `mp4-avc` (H.264), `mp4-hevc` (HEVC), `webm-vp9` (VP9) | `mp4-avc` |
| Resolution | `artboard`, `720p`, `1080p`, `1440p`, `4k` | `artboard` |
| Frame rate | `30`, `60` | `60` |

Saved in `<userData>` and reused for the next export.

---

## Where files are stored

| What | Where |
|---|---|
| Recordings / projects | `~/Documents/openscreen/<id>/` |
| Exports | `~/Documents/openscreen/exports/` |
| Recording quality, export settings, last opened project | `~/Library/Application Support/<app>/` (Electron `userData`) |
| Editor preferences (renderer, autoplay, sidebar tab) | Renderer `localStorage`, shared by every window |

A recording folder:

```
~/Documents/openscreen/<id>/
├── screen.mov             screen video + system audio + mic
├── camera.mov             camera, if recorded
├── recording.json         manifest: sizes, codec, timing, outputs, file map
├── mousemoves-0.json      {x, y, cursorId, processTimeMs, unixTimeMs, ...}
├── mouseclicks-0.json     mouseDown / mouseUp with button and position
├── keystrokes-0.json      only with "Capture keystrokes"
├── cursors.json           cursor shapes (id, hot spot, size)
├── cursors/<id>.png       cursor images at native resolution
├── project.json           editor state (artboard, videos, timeline, zoom clips)
└── assets/<kind>/<id>/…   images you imported
```

Mouse coordinates are logical points relative to the recorded display, top-left origin. Multiply by the manifest's `scaleFactor` to get video pixels.

---

## macOS version support

| Feature | 13 | 14 | 15+ |
|---|---|---|---|
| Display / window / region recording | ✅ | ✅ | ✅ |
| System audio | ✅ | ✅ | ✅ |
| Per-app system audio (display/region) | — | — | ✅ |
| Microphone | ❌ | ❌ | ✅ |
| Built-in camera | ✅ | ✅ | ✅ |
| External / Continuity cameras in the list | ❌ | ✅ | ✅ |
| Cursor / input capture | ✅ | ✅ | ✅ |
| Editor and export | ✅ | ✅ | ✅ |

**Known gap:** on macOS 13 and 14 the mic menu still lets you pick a microphone, but no mic audio is recorded. ScreenCaptureKit mic capture is macOS 15+ and there's no AVFoundation fallback yet. Details are in [`docs/macos-13-compatibility.md`](docs/macos-13-compatibility.md).

---

## Development

### Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Addon + Next.js + Electron with reload (see [step 4](#4-run-in-development)) |
| `pnpm build` | Clean `.next/` `out/` `dist-electron/`, then addon, Next.js static export (`NEXT_EXPORT=1`, output `out/`), Electron |
| `pnpm clean` | Delete build artifacts (`.next/` `out/` `dist-electron/`); `-- --release` / `-- --addon` extend it |
| `pnpm build:next` / `pnpm build:electron` | One part only |
| `pnpm build:mac` | Build and make a DMG in `release/` (`pnpm package` / `pnpm package:mac` are aliases) |
| `pnpm typecheck` | `tsc` for the renderer and for `electron/` |
| `pnpm lint` | ESLint (`eslint-config-next`) |
| `pnpm format` | Prettier with the Tailwind plugin |
| `pnpm test` / `pnpm test:watch` | Vitest |
| `pnpm fallow:audit` | Fallow gate for changed files (uses committed baselines) |
| `pnpm fallow:dead-code` / `pnpm fallow:health` / `pnpm fallow:dupes` | Full-repo Fallow reports (exit 1 while legacy debt remains) |
| `pnpm fallow:baselines` | Regenerate the three Fallow baselines after an intentional cleanup |

### Tests

About 240 Vitest tests in 17 files. They cover the pure logic: auto-zoom generation, zoom and cursor scene math, export frame sources and validation, project schema and persistence, history, video placement, snapping, squircles. They don't need macOS and run anywhere Node runs.

```bash
pnpm test
pnpm exec vitest run src/lib/auto-zoom          # one folder
```

There are no automated tests for the native addon. Check recordings with `ffprobe`. The recipes are in [`packages/mac-addon/README.md`](packages/mac-addon/README.md#verification).

### Workspace packages

| Package | What it is |
|---|---|
| `packages/mac-addon` | The native recorder (Objective-C++, N-API, `node-gyp`) |
| `packages/timeline` | Timeline UI, forked from `react-timeline-editor` and used from source |
| `packages/timeline-engine` | Timeline playback engine (same fork) |

### Conventions

- **Preview and export must match.** Anything that's part of the output video (cursor, background, video appearance, zoom) must be drawn by the export too, using the same pure module (`cursor-scene.ts`, `zoom-scene.ts`, `video-scene-draw.ts`, …). Editor-only things (selection, snap guides, grid, playhead) stay out of it.
- **`project.json` is the source of truth.** Schema changes go through `electron/ipc/project-schema.ts` + `src/types/api.d.ts` + `src/components/editor/canvas/persistence.ts` together. Only add *optional* fields to v1. Anything else needs a version bump and a migration.
- **Performance:** treat 5000+ canvas nodes as the stress case. No per-frame React state, no DOM overlay per node, redraw only what changed.
- **Docs move with code:** changes to the recorder update `docs/screen-recording-addon.md`, and changes to the editor update `docs/editor-canvas.md` and `docs/normal-term.md`. See `AGENTS.md` and `claude.md`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node-gyp` fails: no Xcode / SDK | `xcode-select --install`, then `sudo xcode-select -s /Library/Developer/CommandLineTools` |
| `NODE_MODULE_VERSION` mismatch on start | `npx electron-rebuild -f -w @openscreen/mac-addon` |
| Black or empty recording | Grant **Screen & System Audio Recording** to the app (in dev, your terminal / Electron) and restart it |
| No cursor or clicks in the editor | Grant **Accessibility**. Without it the event tap falls back to a weaker monitor or records nothing |
| Keystrokes not recorded | Turn on **Capture keystrokes** and grant **Input Monitoring** |
| No mic audio | Needs macOS 15+ (see [macOS version support](#macos-version-support)) |
| Colours look washed out | Shouldn't happen (sRGB capture). Check the file with `ffprobe`: it should be tagged `bt709` |
| HEVC export greyed out | The machine can't encode HEVC. Use H.264 or VP9 |
| Editor is blank / renderer errors | Switch the renderer to **WebGL** in the title bar menu |
| `pnpm dev` hangs at "wait-on" | Port 3535 is in use. Free it or change it in `package.json` |
| Packaged app: "OpenScreen is damaged / can't be opened" on another Mac | Ad-hoc build. Right-click → Open, or `xattr -dr com.apple.quarantine /Applications/OpenScreen.app` (see [step 6](#6-build-a-release-dmg)) |

---

## Project layout

```
app/                     Next.js routes, one per window
  page.tsx               editor
  recorder/              recorder bar
  recording-controls/    pause / stop / restart / delete
  window-picker/         window and region picker
  camera/                floating camera preview
  permissions/           permission checklist
  recording-settings/    recording quality + editor preferences
  export/                export window
components/
  editor/
    canvas/              provider (state, autosave, history), scene math, editor workspace
      pixi/              PixiJS scene: background, video, cursor, zoom spring, blurs, viewport
    export/              export pipeline: stage, frame sources, codec probe, run-export
    sidebar/ ...         background, video, cursor and zoom panels, timeline panel, title bar
  ui/                    shadcn/Base UI components
electron/
  main.ts, preload.ts, windowConfigs.ts, mac-spaces.ts
  ipc/                   recorder, permissions, projects, export, pickers, camera preview
lib/
  auto-zoom/             click clustering into zoom clips
  editor-project/        export settings and project helpers
  motion-blur/           blur helpers
  cursors/               cursor assets and manifest
packages/
  mac-addon/             native recorder (src/*.mm, binding.gyp, index.d.ts)
  timeline/, timeline-engine/
docs/                    design docs (below)
types/                   shared types (api.d.ts, editor-canvas.ts, ...)
```

---

## Further docs

| Doc | What's in it |
|---|---|
| [`docs/screen-recording-addon.md`](docs/screen-recording-addon.md) | Recording pipeline, colour, bitrate, input capture, clocks |
| [`docs/recorder-feature-map.md`](docs/recorder-feature-map.md) | Every recorder feature, its files, outputs and support |
| [`docs/recorder-case-map.md`](docs/recorder-case-map.md) | Failure cases: handled, partly handled, not handled |
| [`docs/macos-13-compatibility.md`](docs/macos-13-compatibility.md) | What works on macOS 13/14 and the known gaps |
| [`docs/editor-canvas.md`](docs/editor-canvas.md) | Editor canvas, persistence, history, export pipeline |
| [`docs/fallow.md`](docs/fallow.md) | Fallow setup, policy, baselines, commands, agent integration |
| [`docs/auto-zoom-algorithm.md`](docs/auto-zoom-algorithm.md) | When zooms happen and how the camera follows the cursor |
| [`docs/normal-term.md`](docs/normal-term.md) | Shared terms (plain words → industry terms) |
| [`packages/mac-addon/README.md`](packages/mac-addon/README.md) | Addon API, every quality setting, ffprobe checks |

## Credits

- The auto-zoom model (click clustering and spring cursor-follow) is a port of [Cap](https://github.com/CapSoftware/Cap)'s.
- The timeline packages are a fork of [react-timeline-editor](https://github.com/xzdarcy/react-timeline-editor).
