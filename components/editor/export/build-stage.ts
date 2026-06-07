import "pixi.js/advanced-blend-modes"
import {
  Application,
  Container,
  Graphics,
  ImageSource,
  Rectangle,
  Sprite,
  Texture,
  TilingSprite,
} from "pixi.js"

import type { ProjectStateV1, ProjectVideo } from "@/types/api"
import {
  blurredWallpaperPadding,
  computeCoverCrop,
  getNoiseTexture,
  loadBlurredWallpaperBitmap,
  loadWallpaperBitmap,
  resolveWallpaper,
} from "@/components/editor/canvas/pixi/background"
import {
  applyVideoAppearance,
  type NodeAppearance,
} from "@/components/editor/canvas/pixi/video-appearance"
import {
  CursorSprite,
  preloadCursorImages,
  type CursorPlaceOptions,
} from "@/components/editor/canvas/pixi/cursor-sprite"
import {
  buildCursorTrack,
  clampCursorClickPressScale,
  clampCursorMotionBlur,
  clampCursorMotionRotation,
  clampCursorSetId,
  clampCursorSize,
  clampCursorSmoothingMode,
  CURSOR_CLICK_PRESS_SCALE_DEFAULT,
  CURSOR_MOTION_BLUR_DEFAULT,
  CURSOR_MOTION_ROTATION_DEFAULT,
  CURSOR_POINTER_CURSOR_ID,
  CURSOR_SET_DEFAULT,
  CURSOR_SIZE_DEFAULT,
  CURSOR_SMOOTHING_MODE_DEFAULT,
  projectFolderFromObjectUrl,
  type CursorVideoGeometry,
} from "@/components/editor/canvas/cursor-scene"
import { getVideoCoverCrop } from "@/components/editor/canvas/video-cover-crop"
import type { ZoomCamera } from "@/components/editor/canvas/zoom-scene"
import {
  applyZoomBlur,
  createZoomBlurFilter,
} from "@/components/editor/canvas/pixi/zoom-blur"
import { rendererPreferenceChain } from "@/components/editor/canvas/pixi/renderer-preference"
import type { SmoothedCursorTrack } from "@/lib/cursors/cursor-track"
import { resolveCursorAsset } from "@/lib/cursors/cursor-set"

/**
 * One exportable video node. The render loop pushes each decoded source frame
 * via {@link setFrame}; nodes outside their active clip are hidden so a clip
 * that ended last frame doesn't ghost.
 *
 * `setFrame` accepts either a decoded `VideoFrame` (fast path — becomes the
 * texture's upload resource directly; caller closes it after the stage
 * renders) or any `CanvasImageSource` (fallback — staged through a reused 2D
 * canvas).
 */
export interface ExportVideoNode {
  setFrame(source: CanvasImageSource | VideoFrame): void
  hide(): void
}

/** The recorded-cursor overlay for the export, placed per frame from the plan. */
export interface ExportCursorHandle {
  cursorSprite: CursorSprite
  track: SmoothedCursorTrack
  video: CursorVideoGeometry
  /** Which video the cursor follows — used to find the active screen clip. */
  screenVideoId: string
  options: CursorPlaceOptions
  motionBlur: number
}

export interface ExportStageHandles {
  /** The offscreen Pixi application; `app.canvas` is the export composite. */
  app: Application
  outputSize: { width: number; height: number }
  nodesByVideoId: Map<string, ExportVideoNode>
  /** Recorded-cursor overlay, or null when the composition has no cursor data. */
  cursor: ExportCursorHandle | null
  /** Apply the composition zoom-clip camera (scale + offset) for a frame. */
  applyZoomCamera: (camera: ZoomCamera) => void
  dispose: () => void
}

export interface BuildStageOptions {
  state: ProjectStateV1
  assetUrlsByVideoId: Record<string, string>
  outputSize: { width: number; height: number }
  /** Off-DOM container the canvas attaches to (hidden via CSS display:none). */
  container: HTMLDivElement
  /**
   * Absolute project folder — preferred source for cursor sidecar loading.
   * When absent, the folder is derived from the screen video's file URL.
   */
  projectPath?: string
}

/**
 * Build an offscreen PixiJS scene that mirrors the editor preview for a single
 * artboard composition, sized to the export's output pixel dimensions. It
 * reuses the SAME shared modules as the live canvas — `video-appearance.ts`
 * (squircle/border/shadow), `background.ts` (wallpaper cover-crop/blur, grain),
 * and `getVideoCoverCrop` — so the encoded frame matches the on-screen preview.
 *
 * Each video clip becomes a Sprite whose texture wraps a per-node reused canvas;
 * `run-export.ts` draws the decoded source frame onto it and calls
 * `texture.source.update()` each output frame. The whole scene renders into one
 * canvas (`app.canvas`), which Mediabunny's `CanvasSource` snapshots directly —
 * no per-layer composite blit.
 *
 * Phase 1 omits the cursor overlay and the radial zoom blur (deferred); the
 * zoom-clip camera transform IS applied. WebGPU is preferred with a WebGL2
 * fallback, gated by a readback probe so a non-snapshottable WebGPU canvas
 * falls back rather than producing a blank export.
 */
export async function buildExportStage(
  options: BuildStageOptions
): Promise<ExportStageHandles> {
  const { state, assetUrlsByVideoId, outputSize, container, projectPath } =
    options
  const { artboard } = state

  const app = await createExportApp(outputSize, container)

  // world carries the artboard→output scale so every node stays in artboard
  // coordinates (identical math to the editor preview).
  const world = new Container()
  world.scale.set(outputSize.width / artboard.width)
  app.stage.addChild(world)

  const artboardContainer = new Container()
  world.addChild(artboardContainer)

  // Composition zoom-clip cameras, clipped to the artboard — same structure as
  // the editor scene (background fill + content zoom together).
  const backgroundCamera = new Container()
  const contentCamera = new Container()
  const backgroundMask = new Graphics()
    .rect(0, 0, artboard.width, artboard.height)
    .fill(0xffffff)
  const contentMask = new Graphics()
    .rect(0, 0, artboard.width, artboard.height)
    .fill(0xffffff)
  backgroundCamera.mask = backgroundMask
  contentCamera.mask = contentMask

  const surface = new Container()
  backgroundCamera.addChild(surface)
  const nodesLayer = new Container()
  contentCamera.addChild(nodesLayer)
  // Wrap bg + content so the radial zoom blur filter acts on the whole
  // composition (incl. the cursor) at once — same structure as the editor scene.
  const composite = new Container()
  composite.addChild(
    backgroundCamera,
    backgroundMask,
    contentCamera,
    contentMask
  )
  artboardContainer.addChild(composite)
  const zoomBlur = createZoomBlurFilter()
  let zoomBlurOn = false

  await buildExportSurface(surface, artboard)

  const nodesByVideoId = new Map<string, ExportVideoNode>()
  for (const video of state.videos) {
    if (!assetUrlsByVideoId[video.id]) continue // missing asset — skip clip
    const built = buildExportVideoNode(video)
    if (!built) continue
    nodesLayer.addChild(built.wrapper)
    nodesByVideoId.set(video.id, built.handle)
  }

  // Cursor sits above the video nodes in the content camera (same z-order as the
  // editor preview), so it zooms + clips with the content.
  const cursor = await buildExportCursor(
    state,
    assetUrlsByVideoId,
    contentCamera,
    projectPath
  )

  const applyZoomCamera = (camera: ZoomCamera) => {
    backgroundCamera.scale.set(camera.scale)
    backgroundCamera.position.set(camera.offsetX, camera.offsetY)
    contentCamera.scale.set(camera.scale)
    contentCamera.position.set(camera.offsetX, camera.offsetY)
    // The export filter input is the output canvas, so center maps to output px.
    const on = applyZoomBlur(zoomBlur, camera, outputSize.width, outputSize.height)
    if (on !== zoomBlurOn) {
      composite.filters = on ? [zoomBlur] : []
      zoomBlurOn = on
    }
  }

  const dispose = () => {
    nodesByVideoId.clear()
    cursor?.cursorSprite.destroy()
    zoomBlur.destroy()
    try {
      app.destroy({ removeView: true }, { children: true })
    } catch {
      // best-effort
    }
  }

  return { app, outputSize, nodesByVideoId, cursor, applyZoomCamera, dispose }
}

/**
 * Load the recorded cursor track + build a {@link CursorSprite} for the export
 * (placed per frame by the render loop using the screen clip's source time).
 * Returns null when there is no screen recording / cursor data. Cursor SVGs are
 * pre-decoded so the per-frame loop never awaits.
 */
async function buildExportCursor(
  state: ProjectStateV1,
  assetUrlsByVideoId: Record<string, string>,
  parent: Container,
  projectPath?: string
): Promise<ExportCursorHandle | null> {
  if (state.artboard.cursorCustomRenderingEnabled === false) return null
  const screenVideo = state.videos.find(
    (video) => video.role === "screen" && (video.onCanvas ?? true)
  )
  if (!screenVideo) return null
  const url = assetUrlsByVideoId[screenVideo.id]
  if (!url) return null
  // Prefer the explicit project folder; URL derivation is the legacy
  // fallback for payloads that predate `projectPath`.
  const folder = projectPath ?? projectFolderFromObjectUrl(url)
  if (!folder) return null

  const data = await window.api?.projects.getCursorData(folder)
  const smoothingMode = clampCursorSmoothingMode(
    state.artboard.cursorSmoothingMode ?? CURSOR_SMOOTHING_MODE_DEFAULT
  )
  const track = buildCursorTrack(data ?? null, { smoothingMode })
  if (!track) return null

  const alwaysUsePointer = state.artboard.cursorAlwaysUsePointer === true
  const cursorSetId = clampCursorSetId(state.artboard.cursorSetId)
  const urls = new Set<string>()
  const cursorIds = alwaysUsePointer ? [CURSOR_POINTER_CURSOR_ID] : track.cursorIds
  for (const cursorId of cursorIds) {
    const asset = resolveCursorAsset(cursorId, cursorSetId, CURSOR_SET_DEFAULT)
    if (asset) urls.add(asset.url)
  }
  if (urls.size === 0) return null
  await preloadCursorImages(urls)

  const cursorSprite = new CursorSprite(parent)
  const video: CursorVideoGeometry = {
    x: screenVideo.x,
    y: screenVideo.y,
    width: screenVideo.width,
    height: screenVideo.height,
    rotation: screenVideo.rotation,
    intrinsicWidth: screenVideo.intrinsicWidth,
    intrinsicHeight: screenVideo.intrinsicHeight,
  }
  const options: CursorPlaceOptions = {
    sizeMultiplier: clampCursorSize(
      state.artboard.cursorSizeMultiplier ?? CURSOR_SIZE_DEFAULT
    ),
    clickPressScale: clampCursorClickPressScale(
      state.artboard.cursorClickPressScale ?? CURSOR_CLICK_PRESS_SCALE_DEFAULT
    ),
    cursorSet: cursorSetId,
    alwaysUsePointer,
    motionRotation: clampCursorMotionRotation(
      state.artboard.cursorMotionRotation ?? CURSOR_MOTION_ROTATION_DEFAULT
    ),
    smoothingMode,
    referenceSize: {
      width: state.artboard.width,
      height: state.artboard.height,
    },
  }
  const motionBlur = clampCursorMotionBlur(
    state.artboard.cursorMotionBlur ?? CURSOR_MOTION_BLUR_DEFAULT
  )

  return { cursorSprite, track, video, screenVideoId: screenVideo.id, options, motionBlur }
}

function appearanceOf(video: ProjectVideo): NodeAppearance {
  return {
    cornerRadius: video.cornerRadius,
    cornerSmoothing: video.cornerSmoothing,
    borderWidth: video.borderWidth,
    borderColor: video.borderColor,
    borderOffset: video.borderOffset,
    borderAlignment: video.borderAlignment,
  }
}

function buildExportVideoNode(
  video: ProjectVideo
): { wrapper: Container; handle: ExportVideoNode } | null {
  const intrinsicW = Math.max(1, video.intrinsicWidth)
  const intrinsicH = Math.max(1, video.intrinsicHeight)

  // Staging canvas for the fallback path (rotated / size-mismatched
  // sources) and the texture's initial placeholder resource. On the
  // VideoFrame fast path it is never drawn into — the decoded frame itself
  // becomes the upload resource, so the per-frame canvas→canvas blit and
  // canvas→GPU upload collapse into one (GPU→GPU for hardware-decoded
  // sources).
  const reusedCanvas = document.createElement("canvas")
  reusedCanvas.width = intrinsicW
  reusedCanvas.height = intrinsicH
  const reusedCtx = reusedCanvas.getContext("2d")
  if (!reusedCtx) return null

  // Explicit ImageSource (not Texture.from's CanvasSource) so the upload
  // resource can be swapped per frame between the staging canvas and a
  // decoded VideoFrame. Fixed pixel size = intrinsic dims; every swapped
  // resource matches, so uploads hit the no-realloc texSubImage2D path.
  const imageSource = new ImageSource({
    resource: reusedCanvas,
    width: intrinsicW,
    height: intrinsicH,
    resolution: 1,
    label: `export-video-${video.id}`,
  })
  const cover = getVideoCoverCrop(
    { width: intrinsicW, height: intrinsicH },
    { width: video.width, height: video.height }
  )
  const texture = new Texture({
    source: imageSource,
    dynamic: true,
    frame: new Rectangle(
      cover.cropX,
      cover.cropY,
      cover.cropWidth,
      cover.cropHeight
    ),
  })

  const sprite = new Sprite(texture)
  sprite.width = video.width
  sprite.height = video.height
  sprite.renderable = false // until the first frame is drawn for this clip

  const content = new Container()
  content.addChild(sprite)
  const squircleMask = new Graphics()
  content.mask = squircleMask
  const borderGfx = new Graphics()

  const wrapper = new Container()
  wrapper.addChild(content, squircleMask, borderGfx)
  wrapper.pivot.set(video.width / 2, video.height / 2)
  wrapper.rotation = video.rotation
  wrapper.position.set(video.x + video.width / 2, video.y + video.height / 2)

  // Appearance + cover-crop are fixed across frames in the export (node size
  // doesn't change), so they're computed once here.
  applyVideoAppearance({
    squircleMask,
    borderGfx,
    width: video.width,
    height: video.height,
    appearance: appearanceOf(video),
  })

  const handle: ExportVideoNode = {
    setFrame(source) {
      if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame) {
        // Fast path: upload straight from the decoded frame. The caller
        // keeps the frame open until after app.render() (the upload happens
        // inside render), then closes it.
        imageSource.resource = source
      } else {
        if (imageSource.resource !== reusedCanvas) {
          imageSource.resource = reusedCanvas
        }
        reusedCtx.drawImage(source, 0, 0, intrinsicW, intrinsicH)
      }
      imageSource.update()
      sprite.renderable = true
    },
    hide() {
      sprite.renderable = false
    },
  }

  return { wrapper, handle }
}

async function buildExportSurface(
  surface: Container,
  artboard: ProjectStateV1["artboard"]
): Promise<void> {
  // Background master switch (Background tab header): when off, the export
  // paints no fill/wallpaper and no grain — same as the editor preview. The
  // stored values stay in project.json untouched.
  if (artboard.backgroundEnabled === false) return
  const background = artboard.background ?? null

  if (background?.type === "color") {
    const fill = new Graphics()
    fill.rect(0, 0, artboard.width, artboard.height).fill(background.value)
    surface.addChild(fill)
  } else {
    const { src, blurRadius } = resolveWallpaper(background)
    if (src) {
      try {
        const padding = blurRadius > 0 ? blurredWallpaperPadding(blurRadius) : 0
        const bitmap =
          blurRadius > 0
            ? await loadBlurredWallpaperBitmap(src, blurRadius)
            : await loadWallpaperBitmap(src)
        const crop = computeCoverCrop(
          bitmap,
          { width: artboard.width, height: artboard.height },
          padding
        )
        if (crop) {
          const base = Texture.from(bitmap)
          const texture = new Texture({
            source: base.source,
            frame: new Rectangle(
              crop.cropX,
              crop.cropY,
              crop.cropWidth,
              crop.cropHeight
            ),
          })
          const sprite = new Sprite(texture)
          sprite.width = artboard.width
          sprite.height = artboard.height
          surface.addChild(sprite)
        }
      } catch {
        // Wallpaper missing — drop the background rather than failing export.
      }
    }
  }

  const grainAlpha = Math.max(0, Math.min(1, artboard.grain / 100))
  if (grainAlpha > 0) {
    const texture = getNoiseTexture()
    if (texture) {
      const tiling = new TilingSprite({
        texture,
        width: artboard.width,
        height: artboard.height,
      })
      tiling.alpha = grainAlpha
      tiling.blendMode = "overlay"
      surface.addChild(tiling)
    }
  }
}

/**
 * Create the offscreen export renderer, preferring WebGPU and falling back to
 * WebGL2. A 1px readback probe rejects a WebGPU canvas that can't be snapshotted
 * by Mediabunny's `CanvasSource` (which would otherwise yield a blank export),
 * forcing the WebGL2 path instead.
 */
async function createExportApp(
  outputSize: { width: number; height: number },
  container: HTMLDivElement
): Promise<Application> {
  let lastError: unknown = null
  // Skip the WebGPU attempt entirely when its global constants are missing —
  // init would succeed but per-frame video-texture draws in run-export.ts would
  // throw `GPUTextureUsage is not defined`, which the init try/catch can't see.
  for (const preference of rendererPreferenceChain()) {
    const app = new Application()
    try {
      await app.init({
        preference,
        width: outputSize.width,
        height: outputSize.height,
        resolution: 1, // export is already at output pixel size; no DPR scaling
        autoDensity: false,
        antialias: true,
        background: 0x000000,
        backgroundAlpha: 1, // opaque black behind the artboard (matches prior export)
        autoStart: false,
        powerPreference: "high-performance",
        eventFeatures: {
          move: false,
          globalMove: false,
          click: false,
          wheel: false,
        },
      })
      app.canvas.style.display = "block"
      container.appendChild(app.canvas)
      app.render()
      probeReadback(app.canvas)
      return app
    } catch (error) {
      lastError = error
      try {
        app.destroy({ removeView: true }, { children: true })
      } catch {
        // best-effort
      }
    }
  }
  throw new Error(
    `Failed to initialize an export renderer (WebGPU + WebGL2): ${String(lastError)}`
  )
}

/** Throws if the renderer canvas can't be read back into a 2D context. */
function probeReadback(canvas: HTMLCanvasElement): void {
  const probe = document.createElement("canvas")
  probe.width = 1
  probe.height = 1
  const ctx = probe.getContext("2d")
  if (!ctx) throw new Error("2D probe context unavailable")
  ctx.drawImage(canvas as CanvasImageSource, 0, 0, 1, 1)
  ctx.getImageData(0, 0, 1, 1) // throws if the source canvas is unreadable
}

export type { ProjectVideo }
