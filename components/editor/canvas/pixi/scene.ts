import "pixi.js/advanced-blend-modes"
import {
  type Application,
  BlurFilter,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
  TilingSprite,
  VideoSource,
} from "pixi.js"

import type { CanvasPalette } from "@/lib/theme-colors"
import type {
  ArtboardBackground,
  CanvasSize,
  NodeTransform,
  ViewTransform,
} from "@/types/editor-canvas"

import { getVideoCoverCrop, type VideoCoverCrop } from "../video-cover-crop"
import {
  IDENTITY_ZOOM_CAMERA,
  zoomCamerasEqual,
  type ZoomCamera,
} from "../zoom-scene"
import {
  blurredWallpaperPadding,
  computeCoverCrop,
  getNoiseTexture,
  loadBlurredWallpaperBitmap,
  loadWallpaperBitmap,
  resolveWallpaper,
} from "./background"
import { drawPixelGrid } from "./pixel-grid"
import { applyVideoAppearance, type NodeAppearance } from "./video-appearance"

/**
 * A mounted video node. Sub-tree (bottom → top):
 *   wrapper → [ shadowGfx, content(→sprite, masked by squircleMask), squircleMask, borderGfx ]
 */
type VideoNodeView = {
  wrapper: Container
  content: Container
  sprite: Sprite
  squircleMask: Graphics
  borderGfx: Graphics
  shadowGfx: Graphics
  blurFilter: BlurFilter
  source: VideoSource
  texture: Texture
  videoEl: HTMLVideoElement
  intrinsic: CanvasSize
  appearance: NodeAppearance
  width: number
  height: number
  crop: VideoCoverCrop | null
  /** Timeline-window visibility (from the provider); combined with readyState. */
  timelineVisible: boolean
}

/** Artboard edge stroke, matching openscreen's Konva `rgba(0,0,0,0.10)` 1px border. */
const ARTBOARD_BORDER_COLOR = 0x000000
const ARTBOARD_BORDER_ALPHA = 0.1

/**
 * Owns the PixiJS scene graph for the editor canvas. Mirrors openscreen's Konva
 * layer tree:
 *
 *   stage → world (render group) → artboard → {
 *     backgroundCamera → surface (bg fill / wallpaper / grain),   [clipped]
 *     grid,
 *     contentCamera → nodesLayer (video nodes),                   [clipped]
 *     border,
 *   }
 *   stage → { hover, selection, marquee overlays }                [screen space]
 *
 * The `world` container is the viewport camera: pan/zoom is applied to it as
 * `scale` + `position` (see {@link applyView}). `backgroundCamera`/`contentCamera`
 * are the composition zoom-clip camera (Screen-Studio-style), applied later in
 * the migration; they sit *inside* the artboard clip so zoomed content is masked
 * to the artboard, exactly like openscreen's two Konva camera groups.
 *
 * Overlays (hover/selection/marquee) live on the stage, not under the scaled
 * world, so transform handles stay a constant screen size at every zoom.
 *
 * The artboard's white "paper" drop shadow is a DOM `<div>` (a CSS box-shadow)
 * this scene keeps glued to the artboard's on-screen rect — matching openscreen,
 * and far cheaper than a Pixi filter that would re-blur on every camera move.
 *
 * Rendering is on-demand: nothing draws until {@link requestRender} schedules a
 * single frame, so a static artboard costs no GPU while idle. During playback
 * the scene switches to a continuous loop (see {@link beginPlayback}).
 */
export class CanvasScene {
  private readonly app: Application
  private readonly world: Container
  private readonly artboard: Container

  /** Composition zoom-clip camera for the background fill/grain. */
  private readonly backgroundCamera = new Container({
    label: "background-camera",
  })
  /** Composition zoom-clip camera for the editable content. */
  private readonly contentCamera = new Container({ label: "content-camera" })
  private readonly backgroundMask = new Graphics({ label: "background-mask" })
  private readonly contentMask = new Graphics({ label: "content-mask" })
  /** Artboard background fill / wallpaper / grain. */
  private readonly surface = new Container({ label: "surface" })
  private readonly backgroundHolder = new Container({ label: "bg-fill" })
  private readonly grainHolder = new Container({ label: "grain" })
  /** Editable nodes — one wrapper container per video (populated later). */
  private readonly nodesLayer = new Container({ label: "nodes" })

  private readonly gridGfx = new Graphics({ label: "grid" })
  private readonly gridMask = new Graphics({ label: "grid-mask" })
  /** Crisp artboard edge, redrawn at `1 / scale` so it stays ~1 screen px. */
  private readonly borderGfx = new Graphics({ label: "artboard-border" })

  /** Hover bounds for unselected nodes, drawn in screen space below the overlay. */
  private readonly hoverGfx = new Graphics({ label: "hover" })
  /** Selection border + transform handles, drawn in screen space on the stage. */
  private readonly overlayGfx = new Graphics({ label: "overlay" })
  /** Marquee rectangle, drawn in screen space on the stage. */
  private readonly marqueeGfx = new Graphics({ label: "marquee" })

  private readonly backdropEl: HTMLElement | null

  private palette: CanvasPalette
  private artboardSize: CanvasSize
  private lastView: ViewTransform = { scale: 1, x: 0, y: 0 }
  private lastViewport: CanvasSize = { width: 0, height: 0 }
  private lastBackground: ArtboardBackground | null = null
  private lastGrain = 0
  /** Bumped per setBackground so a stale async wallpaper load is ignored. */
  private surfaceGen = 0

  /** One view per mounted video node, keyed by video id. */
  private readonly nodeViews = new Map<string, VideoNodeView>()
  /** Last applied composition zoom-clip camera (skips redundant re-applies). */
  private lastZoomCamera: ZoomCamera = IDENTITY_ZOOM_CAMERA

  private rafId: number | null = null
  private destroyed = false
  private playing = false
  private playbackRaf: number | null = null

  constructor(
    app: Application,
    palette: CanvasPalette,
    artboardSize: CanvasSize,
    backdropEl: HTMLElement | null = null
  ) {
    this.app = app
    this.palette = palette
    this.artboardSize = artboardSize
    this.backdropEl = backdropEl

    this.world = new Container({ isRenderGroup: true, label: "world" })
    this.artboard = new Container({ label: "artboard" })

    this.backgroundCamera.mask = this.backgroundMask
    this.backgroundCamera.eventMode = "none"
    this.backgroundMask.eventMode = "none"
    this.surface.eventMode = "none"
    this.backgroundHolder.eventMode = "none"
    this.grainHolder.eventMode = "none"
    this.surface.addChild(this.backgroundHolder, this.grainHolder)
    this.backgroundCamera.addChild(this.surface)

    this.gridGfx.mask = this.gridMask
    this.gridGfx.eventMode = "none"
    this.gridMask.eventMode = "none"

    this.contentCamera.mask = this.contentMask
    this.contentMask.eventMode = "none"
    this.contentCamera.addChild(this.nodesLayer)

    this.borderGfx.eventMode = "none"

    // Paint order (first child = bottom): bg fill → grid → content → border.
    this.artboard.addChild(
      this.backgroundCamera,
      this.backgroundMask,
      this.gridGfx,
      this.gridMask,
      this.contentCamera,
      this.contentMask,
      this.borderGfx
    )
    this.world.addChild(this.artboard)
    app.stage.addChild(this.world)
    app.stage.addChild(this.hoverGfx)
    app.stage.addChild(this.overlayGfx)
    app.stage.addChild(this.marqueeGfx)

    this.rebuildArtboardGeometry()
  }

  getArtboardSize(): CanvasSize {
    return this.artboardSize
  }

  /** Apply the viewport transform (pan/zoom) to the world container. */
  applyView(viewTransform: ViewTransform, viewportSize: CanvasSize) {
    this.lastView = viewTransform
    this.lastViewport = viewportSize

    this.world.scale.set(viewTransform.scale)
    this.world.position.set(viewTransform.x, viewTransform.y)

    this.updateBackdrop()
    this.redrawGrid()
    this.redrawBorder()
    this.requestRender()
  }

  /**
   * Apply the composition zoom-clip camera (Screen-Studio-style) to the content
   * + background cameras. Identity (scale 1 / offset 0) resets them. The
   * radial-blur postprocess is deferred to phase 2; only the transform migrates.
   */
  applyZoomCamera(camera: ZoomCamera) {
    if (zoomCamerasEqual(this.lastZoomCamera, camera)) return
    this.lastZoomCamera = camera
    this.backgroundCamera.scale.set(camera.scale)
    this.backgroundCamera.position.set(camera.offsetX, camera.offsetY)
    this.contentCamera.scale.set(camera.scale)
    this.contentCamera.position.set(camera.offsetX, camera.offsetY)
    this.requestRender()
  }

  setArtboardSize(size: CanvasSize) {
    this.artboardSize = size
    this.rebuildArtboardGeometry()
    this.redrawGrid()
    // Cover-crop + grain coverage depend on the artboard size.
    this.setBackground(this.lastBackground, this.lastGrain)
    this.requestRender()
  }

  setColors(palette: CanvasPalette) {
    this.palette = palette
    this.redrawGrid()
    this.requestRender()
  }

  /**
   * Render the artboard background (color fill or cover-cropped wallpaper with
   * optional blur) plus the film-grain overlay. Wallpaper bitmaps load async; a
   * generation token discards a stale load if the background changes mid-flight.
   * Background fill + grain are clipped to the artboard via the background mask.
   */
  setBackground(background: ArtboardBackground | null, grain: number) {
    this.lastBackground = background
    this.lastGrain = grain
    const gen = ++this.surfaceGen
    this.clearHolder(this.backgroundHolder)
    this.clearHolder(this.grainHolder)

    const { width, height } = this.artboardSize

    if (background?.type === "color") {
      const fill = new Graphics()
      fill.rect(0, 0, width, height).fill(background.value)
      fill.eventMode = "none"
      this.backgroundHolder.addChild(fill)
    } else {
      const { src, blurRadius } = resolveWallpaper(background)
      if (src) {
        const padding = blurRadius > 0 ? blurredWallpaperPadding(blurRadius) : 0
        const loader =
          blurRadius > 0
            ? loadBlurredWallpaperBitmap(src, blurRadius)
            : loadWallpaperBitmap(src)
        loader
          .then((bitmap) => {
            if (gen !== this.surfaceGen || this.destroyed) return
            const crop = computeCoverCrop(bitmap, this.artboardSize, padding)
            if (!crop) return
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
            sprite.width = this.artboardSize.width
            sprite.height = this.artboardSize.height
            sprite.eventMode = "none"
            this.clearHolder(this.backgroundHolder)
            this.backgroundHolder.addChild(sprite)
            this.requestRender()
          })
          .catch(() => {
            /* wallpaper load failed; the white DOM backdrop shows through */
          })
      }
    }

    const grainAlpha = Math.max(0, Math.min(1, grain / 100))
    if (grainAlpha > 0) {
      const texture = getNoiseTexture()
      if (texture) {
        const tiling = new TilingSprite({ texture, width, height })
        tiling.alpha = grainAlpha
        tiling.blendMode = "overlay"
        tiling.eventMode = "none"
        this.grainHolder.addChild(tiling)
      }
    }

    this.requestRender()
  }

  /** Remove + free a holder's children, keeping shared texture sources alive. */
  private clearHolder(holder: Container) {
    for (const child of holder.removeChildren()) {
      child.destroy({ children: true, texture: false, textureSource: false })
    }
  }

  // ── video nodes ─────────────────────────────────────────────────────────────

  hasNode(id: string): boolean {
    return this.nodeViews.has(id)
  }

  /** Mount a metadata-loaded video element as a cover-cropped sprite node. */
  mountVideoNode(
    id: string,
    videoEl: HTMLVideoElement,
    intrinsic: CanvasSize,
    transform: NodeTransform,
    appearance: NodeAppearance
  ) {
    this.unmountVideoNode(id)

    const source = new VideoSource({
      resource: videoEl,
      autoPlay: false,
      autoLoad: true,
      updateFPS: 0, // upload as fast as the video delivers frames
      loop: false,
      muted: videoEl.muted,
      playsinline: true,
    })
    // `dynamic` + an explicit frame so the cover-crop can be mutated at runtime
    // (the frame Rectangle is read-only to reassign, but its fields are mutable).
    const texture = new Texture({
      source,
      dynamic: true,
      frame: new Rectangle(
        0,
        0,
        Math.max(1, intrinsic.width),
        Math.max(1, intrinsic.height)
      ),
    })
    const sprite = new Sprite(texture)
    sprite.eventMode = "none" // hit-testing is handled by the transform controller
    sprite.renderable = false // until the first frame decodes (WebGPU upload guard)

    const content = new Container({ label: `node-content:${id}` })
    content.addChild(sprite)
    const squircleMask = new Graphics()
    squircleMask.eventMode = "none"
    content.mask = squircleMask
    const borderGfx = new Graphics()
    borderGfx.eventMode = "none"
    const shadowGfx = new Graphics()
    shadowGfx.eventMode = "none"
    const blurFilter = new BlurFilter({ strength: 0 })

    const wrapper = new Container({ label: `node:${id}` })
    // shadow (below) → masked content → mask (in display list, not drawn) → border.
    wrapper.addChild(shadowGfx, content, squircleMask, borderGfx)
    this.nodesLayer.addChild(wrapper)

    const view: VideoNodeView = {
      wrapper,
      content,
      sprite,
      squircleMask,
      borderGfx,
      shadowGfx,
      blurFilter,
      source,
      texture,
      videoEl,
      intrinsic,
      appearance,
      width: transform.width,
      height: transform.height,
      crop: null,
      timelineVisible: true,
    }
    this.nodeViews.set(id, view)
    this.applyNodeTransform(view, transform)
    this.requestRender()
  }

  setNodeTransform(id: string, transform: NodeTransform) {
    const view = this.nodeViews.get(id)
    if (!view) return
    this.applyNodeTransform(view, transform)
    this.requestRender()
  }

  /** Timeline-window visibility (the provider's inactive-clip culling). */
  setNodeRenderable(id: string, visible: boolean) {
    const view = this.nodeViews.get(id)
    if (!view) return
    view.timelineVisible = visible
    this.requestRender()
  }

  /** Upload the node's current video frame + paint immediately (seek lockstep). */
  renderNodeNow(id: string) {
    const view = this.nodeViews.get(id)
    if (!view || this.destroyed) return
    view.source.update()
    this.paint()
  }

  unmountVideoNode(id: string) {
    const view = this.nodeViews.get(id)
    if (!view) return
    this.nodeViews.delete(id)
    this.nodesLayer.removeChild(view.wrapper)
    view.wrapper.destroy({ children: true })
    view.texture.destroy(true)
    this.requestRender()
  }

  private applyNodeTransform(view: VideoNodeView, t: NodeTransform) {
    // Cover-crop the video into the frame (object-fit: cover), like openscreen.
    const crop = getVideoCoverCrop(view.intrinsic, {
      width: t.width,
      height: t.height,
    })
    if (
      !view.crop ||
      view.crop.cropX !== crop.cropX ||
      view.crop.cropY !== crop.cropY ||
      view.crop.cropWidth !== crop.cropWidth ||
      view.crop.cropHeight !== crop.cropHeight
    ) {
      view.crop = crop
      const frame = view.texture.frame
      frame.x = crop.cropX
      frame.y = crop.cropY
      frame.width = crop.cropWidth
      frame.height = crop.cropHeight
      view.texture.updateUvs()
    }

    view.sprite.width = t.width
    view.sprite.height = t.height
    view.sprite.position.set(0, 0)

    // Wrapper carries placement + rotation around the frame center.
    view.wrapper.pivot.set(t.width / 2, t.height / 2)
    view.wrapper.rotation = t.rotation
    view.wrapper.position.set(t.x + t.width / 2, t.y + t.height / 2)

    view.width = t.width
    view.height = t.height
    this.redrawAppearance(view)
  }

  /** Update a node's size-independent appearance (corner/border/shadow) + redraw. */
  setNodeAppearance(id: string, appearance: NodeAppearance) {
    const view = this.nodeViews.get(id)
    if (!view) return
    view.appearance = appearance
    this.redrawAppearance(view)
    this.requestRender()
  }

  private redrawAppearance(view: VideoNodeView) {
    applyVideoAppearance({
      squircleMask: view.squircleMask,
      borderGfx: view.borderGfx,
      shadowGfx: view.shadowGfx,
      shadowBlur: view.blurFilter,
      width: view.width,
      height: view.height,
      appearance: view.appearance,
    })
  }

  /** Schedule a single render on the next frame (no-op while continuously rendering). */
  requestRender() {
    if (this.rafId !== null || this.destroyed || this.playing) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null
      if (!this.destroyed && !this.playing) this.paint()
    })
  }

  /**
   * Render one frame. Wrapped in try/catch as a final guard: uploading a video
   * frame that isn't decoded yet can throw on the WebGPU backend, and a transient
   * GPU upload race must never kill the render loop. (The per-sprite readyState
   * gate lands with video in a later milestone.)
   */
  private paint() {
    if (this.destroyed) return
    // A video sprite is renderable only when its frame is decoded AND its clip is
    // active in the timeline window. Uploading an undecoded frame throws on WebGPU.
    for (const view of this.nodeViews.values()) {
      view.sprite.renderable =
        view.timelineVisible && view.videoEl.readyState >= 2
    }
    try {
      this.app.render()
    } catch {
      /* transient GPU upload race; the next frame recovers */
    }
  }

  /** Begin a continuous render loop so playing video frames reach the screen. */
  beginPlayback() {
    if (this.playing || this.destroyed) return
    this.playing = true
    const pump = () => {
      if (!this.playing || this.destroyed) return
      this.paint()
      this.playbackRaf = requestAnimationFrame(pump)
    }
    this.playbackRaf = requestAnimationFrame(pump)
  }

  endPlayback() {
    this.playing = false
    if (this.playbackRaf !== null) {
      cancelAnimationFrame(this.playbackRaf)
      this.playbackRaf = null
    }
    this.requestRender()
  }

  destroy() {
    this.destroyed = true
    this.endPlayback()
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    for (const view of this.nodeViews.values()) {
      view.texture.destroy(true) // frees the VideoSource (detaches the <video>)
    }
    this.nodeViews.clear()
    this.world.destroy({ children: true })
    // Overlays are stage children, so world.destroy won't reach them.
    this.hoverGfx.destroy()
    this.overlayGfx.destroy()
    this.marqueeGfx.destroy()
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private updateBackdrop() {
    const el = this.backdropEl
    if (!el) return
    const { scale, x, y } = this.lastView
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`
    el.style.opacity = "1"
  }

  private redrawGrid() {
    drawPixelGrid(this.gridGfx, {
      artboard: this.artboardSize,
      viewTransform: this.lastView,
      viewportSize: this.lastViewport,
      color: this.palette.grid,
    })
  }

  private redrawBorder() {
    const { width, height } = this.artboardSize
    const lineWidth = this.lastView.scale > 0 ? 1 / this.lastView.scale : 1
    this.borderGfx
      .clear()
      .rect(0, 0, width, height)
      .stroke({
        width: lineWidth,
        color: ARTBOARD_BORDER_COLOR,
        alpha: ARTBOARD_BORDER_ALPHA,
      })
  }

  private rebuildArtboardGeometry() {
    const { width, height } = this.artboardSize

    this.backgroundMask.clear().rect(0, 0, width, height).fill(0xffffff)
    this.contentMask.clear().rect(0, 0, width, height).fill(0xffffff)
    this.gridMask.clear().rect(0, 0, width, height).fill(0xffffff)
    this.redrawBorder()

    const el = this.backdropEl
    if (el) {
      el.style.width = `${width}px`
      el.style.height = `${height}px`
    }
  }
}
