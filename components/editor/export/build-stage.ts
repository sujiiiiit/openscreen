import "pixi.js/advanced-blend-modes"
import {
  Application,
  BlurFilter,
  Container,
  Graphics,
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
import { getVideoCoverCrop } from "@/components/editor/canvas/video-cover-crop"
import type { ZoomCamera } from "@/components/editor/canvas/zoom-scene"

/**
 * One exportable video node. The render loop pushes each decoded source canvas
 * via {@link setFrame}; nodes outside their active clip are hidden so a clip
 * that ended last frame doesn't ghost.
 */
export interface ExportVideoNode {
  setFrame(source: CanvasImageSource): void
  hide(): void
}

export interface ExportStageHandles {
  /** The offscreen Pixi application; `app.canvas` is the export composite. */
  app: Application
  outputSize: { width: number; height: number }
  nodesByVideoId: Map<string, ExportVideoNode>
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
  const { state, assetUrlsByVideoId, outputSize, container } = options
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
  artboardContainer.addChild(
    backgroundCamera,
    backgroundMask,
    contentCamera,
    contentMask
  )

  await buildExportSurface(surface, artboard)

  const nodesByVideoId = new Map<string, ExportVideoNode>()
  for (const video of state.videos) {
    if (!assetUrlsByVideoId[video.id]) continue // missing asset — skip clip
    const built = buildExportVideoNode(video)
    if (!built) continue
    nodesLayer.addChild(built.wrapper)
    nodesByVideoId.set(video.id, built.handle)
  }

  const applyZoomCamera = (camera: ZoomCamera) => {
    backgroundCamera.scale.set(camera.scale)
    backgroundCamera.position.set(camera.offsetX, camera.offsetY)
    contentCamera.scale.set(camera.scale)
    contentCamera.position.set(camera.offsetX, camera.offsetY)
  }

  const dispose = () => {
    nodesByVideoId.clear()
    try {
      app.destroy({ removeView: true }, { children: true })
    } catch {
      // best-effort
    }
  }

  return { app, outputSize, nodesByVideoId, applyZoomCamera, dispose }
}

function appearanceOf(video: ProjectVideo): NodeAppearance {
  return {
    cornerRadius: video.cornerRadius,
    cornerSmoothing: video.cornerSmoothing,
    borderWidth: video.borderWidth,
    borderColor: video.borderColor,
    borderOffset: video.borderOffset,
    borderAlignment: video.borderAlignment,
    shadowColor: video.shadowColor,
    shadowBlur: video.shadowBlur,
    shadowOffsetX: video.shadowOffsetX,
    shadowOffsetY: video.shadowOffsetY,
    shadowSpread: video.shadowSpread,
  }
}

function buildExportVideoNode(
  video: ProjectVideo
): { wrapper: Container; handle: ExportVideoNode } | null {
  const intrinsicW = Math.max(1, video.intrinsicWidth)
  const intrinsicH = Math.max(1, video.intrinsicHeight)

  const reusedCanvas = document.createElement("canvas")
  reusedCanvas.width = intrinsicW
  reusedCanvas.height = intrinsicH
  const reusedCtx = reusedCanvas.getContext("2d")
  if (!reusedCtx) return null

  const base = Texture.from(reusedCanvas)
  const cover = getVideoCoverCrop(
    { width: intrinsicW, height: intrinsicH },
    { width: video.width, height: video.height }
  )
  const texture = new Texture({
    source: base.source,
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
  const shadowGfx = new Graphics()
  const blurFilter = new BlurFilter({ strength: 0 })

  const wrapper = new Container()
  wrapper.addChild(shadowGfx, content, squircleMask, borderGfx)
  wrapper.pivot.set(video.width / 2, video.height / 2)
  wrapper.rotation = video.rotation
  wrapper.position.set(video.x + video.width / 2, video.y + video.height / 2)

  // Appearance + cover-crop are fixed across frames in the export (node size
  // doesn't change), so they're computed once here.
  applyVideoAppearance({
    squircleMask,
    borderGfx,
    shadowGfx,
    shadowBlur: blurFilter,
    width: video.width,
    height: video.height,
    appearance: appearanceOf(video),
  })

  const handle: ExportVideoNode = {
    setFrame(source) {
      reusedCtx.drawImage(source, 0, 0, intrinsicW, intrinsicH)
      texture.source.update()
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
  for (const preference of ["webgpu", "webgl"] as const) {
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
