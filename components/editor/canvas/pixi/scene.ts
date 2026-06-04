import { type Application, Container, Graphics } from "pixi.js"

import type { CanvasPalette } from "@/lib/theme-colors"
import type { CanvasSize, ViewTransform } from "@/types/editor-canvas"

import { drawPixelGrid } from "./pixel-grid"

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
  /** Artboard background fill / wallpaper / grain (populated later). */
  private readonly surface = new Container({ label: "surface" })
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

  setArtboardSize(size: CanvasSize) {
    this.artboardSize = size
    this.rebuildArtboardGeometry()
    this.redrawGrid()
    this.requestRender()
  }

  setColors(palette: CanvasPalette) {
    this.palette = palette
    this.redrawGrid()
    this.requestRender()
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
