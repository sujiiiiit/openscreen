import "pixi.js/advanced-blend-modes"
import {
  type Application,
  BlurFilter,
  Container,
  Graphics,
  GraphicsPath,
  Rectangle,
  Sprite,
  Texture,
  TilingSprite,
  VideoSource,
} from "pixi.js"

import type { CanvasPalette } from "@/lib/theme-colors"
import {
  CORNER_HANDLE_SIZE,
  getNodeWorldCorners,
  getSelectionHandleScreenPositions,
  HANDLE_STROKE_WIDTH,
  type HandleId,
  ROTATION_HANDLE_SIZE,
  type Rect,
  type ResizeHandle,
  screenFromWorld,
  SELECTION_BORDER_STROKE_WIDTH,
  SIDE_HANDLE_LENGTH,
  SIDE_HANDLE_THICKNESS,
  type Vec2,
} from "@/lib/node-transform"
import type {
  ArtboardBackground,
  CanvasNode,
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
import { applyZoomBlur, createZoomBlurFilter } from "./zoom-blur"

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
  cropTexture: Texture | null
  /**
   * True once Pixi has accepted at least one decoded frame for this video source.
   * During rapid seeks `readyState` may briefly drop, but the last uploaded
   * texture is still valid and should remain visible.
   */
  hasUploadedFrame: boolean
  /** Timeline-window visibility from the provider's inactive-clip culling. */
  timelineVisible: boolean
}

/** The transform control currently being grabbed (a resize handle or rotation). */
export type SelectionOverlayControl = HandleId | "rotation"

type SelectionOverlayListener = (
  nodes: CanvasNode[],
  viewTransform: ViewTransform,
  viewportSize: CanvasSize
) => void

const HOVER_OUTLINE_STROKE_WIDTH = 1.5
const ROTATE_ICON_VIEWBOX_SIZE = 24
const ROTATE_ICON_SIZE = 18
const ROTATE_ICON_SCALE = ROTATE_ICON_SIZE / ROTATE_ICON_VIEWBOX_SIZE
const ROTATE_ICON_STROKE_WIDTH = 2
const ROTATE_ICON_PATHS = [
  new GraphicsPath(
    "M3.05493 13C3.01863 12.6717 3 12.338 3 12C3 7.02944 7.02944 3 12 3C14.8273 3 17.35 4.30367 19 6.34267M20.9451 11C20.9814 11.3283 21 11.662 21 12C21 16.9706 16.9706 21 12 21C9.17273 21 6.64996 19.6963 5 17.6573"
  ),
  new GraphicsPath(
    "M16 7H17C18.4142 7 19.1213 7 19.5607 6.56066C20 6.12132 20 5.41421 20 4V3"
  ),
  new GraphicsPath(
    "M8 17H7C5.58579 17 4.87868 17 4.43934 17.4393C4 17.8787 4 18.5858 4 20V21"
  ),
] as const

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
  /** Cursor overlay parent — above the video nodes, inside the artboard clip. */
  private readonly cursorLayer = new Container({ label: "cursor" })
  /** Wraps the zoomed composition (bg + grid + content) for the radial zoom blur. */
  private readonly composite = new Container({ label: "composite" })

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
  private readonly zoomBlur = createZoomBlurFilter()
  private zoomBlurOn = false

  // Selection / hover / marquee overlay state (drawn in screen space on the stage).
  private hoveredNode: CanvasNode | null = null
  private selectedNodes: CanvasNode[] = []
  private activeSelectionControl: SelectionOverlayControl | null = null
  /** Ids under a live gesture (controller-owned); reserved for future sync guards. */
  private activeDragIds = new Set<string>()
  private selectionOverlayListener: SelectionOverlayListener | null = null

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
    this.cursorLayer.eventMode = "none"
    this.contentCamera.addChild(this.nodesLayer, this.cursorLayer)

    this.borderGfx.eventMode = "none"

    // Paint order (first child = bottom): bg fill → grid → content → border.
    // The composite holds everything the composition zoom + radial blur act on
    // (bg fill/grain, grid, video nodes, cursor). The artboard border stays
    // outside it so the 1px edge never blurs.
    this.composite.addChild(
      this.backgroundCamera,
      this.backgroundMask,
      this.gridGfx,
      this.gridMask,
      this.contentCamera,
      this.contentMask
    )
    this.artboard.addChild(this.composite, this.borderGfx)
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

  /** The cursor overlay parent (content-clipped, above video nodes). */
  getCursorLayer(): Container {
    return this.cursorLayer
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
    // Pan/zoom moves the projected handle positions; re-project the overlays.
    this.redrawOverlays()
    // The zoom-blur center is in filter-input px (artboard × viewport scale), so
    // a viewport change during an active blur must re-derive it.
    this.applyZoomBlurFilter(this.lastZoomCamera)
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
    this.applyZoomBlurFilter(camera)
    this.requestRender()
  }

  /** Attach/update the radial zoom-blur filter on the composite (during ease). */
  private applyZoomBlurFilter(camera: ZoomCamera) {
    const scale = this.lastView.scale || 1
    const on = applyZoomBlur(
      this.zoomBlur,
      camera,
      this.artboardSize.width * scale,
      this.artboardSize.height * scale
    )
    if (on !== this.zoomBlurOn) {
      this.composite.filters = on ? [this.zoomBlur] : []
      this.zoomBlurOn = on
    }
  }

  // ── selection / hover / marquee overlays (screen space) ─────────────────────

  /** Notified whenever the selection overlay changes, for the DOM toolbar. */
  setSelectionOverlayListener(listener: SelectionOverlayListener | null) {
    this.selectionOverlayListener = listener
    this.selectionOverlayListener?.(
      [...this.selectedNodes],
      this.lastView,
      this.lastViewport
    )
  }

  /** While a gesture is live, show only the grabbed handle (less visual noise). */
  setActiveSelectionControl(control: SelectionOverlayControl | null) {
    if (this.activeSelectionControl === control) return
    this.activeSelectionControl = control
    if (this.selectedNodes.length > 0) {
      this.drawSelectionOverlay(this.selectedNodes)
    }
  }

  setActiveDragIds(ids: string[]) {
    this.activeDragIds = new Set(ids)
  }

  private redrawOverlays() {
    if (this.hoveredNode) this.drawHoverOverlay(this.hoveredNode)
    if (this.selectedNodes.length > 0) {
      this.drawSelectionOverlay(this.selectedNodes)
    }
  }

  drawHoverOverlay(node: CanvasNode | null) {
    this.hoveredNode = node
    const g = this.hoverGfx
    g.clear()
    if (!node) {
      this.requestRender()
      return
    }
    const corners = getNodeWorldCorners(node).map((corner) =>
      screenFromWorld(corner, this.lastView)
    )
    g.poly(flattenPoints(corners), true).stroke({
      width: HOVER_OUTLINE_STROKE_WIDTH,
      color: this.palette.hover,
    })
    this.requestRender()
  }

  drawSelectionOverlay(nodes: CanvasNode[] | CanvasNode | null) {
    const selected = Array.isArray(nodes) ? nodes : nodes ? [nodes] : []
    this.selectedNodes = selected
    const g = this.overlayGfx
    g.clear()
    if (selected.length === 0) {
      this.selectionOverlayListener?.([], this.lastView, this.lastViewport)
      this.requestRender()
      return
    }

    const { selection } = this.palette
    const geometry = getSelectionHandleScreenPositions(selected, this.lastView)
    if (!geometry) {
      this.selectionOverlayListener?.([], this.lastView, this.lastViewport)
      return
    }
    const { corners, handles, rotation } = geometry
    const locked = selected.some((node) => node.locked)

    // Faint per-node outlines inside a multi-selection bounds box.
    if (selected.length > 1) {
      for (const node of selected) {
        const nodeCorners = getNodeWorldCorners(node).map((corner) =>
          screenFromWorld(corner, this.lastView)
        )
        g.poly(flattenPoints(nodeCorners), true).stroke({
          width: 1,
          color: selection,
          alpha: 0.42,
        })
      }
    }

    g.poly(flattenPoints(corners), true).stroke({
      width: SELECTION_BORDER_STROKE_WIDTH,
      color: selection,
    })

    if (!locked) {
      const activeControl = this.activeSelectionControl
      if (!activeControl || activeControl === "rotation") {
        drawRotationHandle(g, rotation.knob, this.palette)
      }
      for (const handle of handles) {
        if (activeControl && activeControl !== handle.id) continue
        drawResizeHandle(g, handle, this.palette)
      }
    }

    this.selectionOverlayListener?.(
      [...selected],
      this.lastView,
      this.lastViewport
    )
    this.requestRender()
  }

  drawMarqueeOverlay(rect: Rect | null) {
    const g = this.marqueeGfx
    g.clear()
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      this.requestRender()
      return
    }
    const { selection } = this.palette
    g.rect(rect.x, rect.y, rect.width, rect.height)
      .fill({ color: selection, alpha: 0.08 })
      .stroke({ width: 1, color: selection, alpha: 0.85 })
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
    this.redrawOverlays()
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
      cropTexture: null,
      hasUploadedFrame: false,
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

  /** Paint immediately so a freshly seeked video frame reaches the canvas. */
  renderNodeNow(id: string) {
    const view = this.nodeViews.get(id)
    if (!view || this.destroyed) return
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
    view.sprite.width = t.width
    view.sprite.height = t.height
    view.sprite.position.set(0, 0)

    // Wrapper carries placement + rotation around the frame center.
    view.wrapper.pivot.set(t.width / 2, t.height / 2)
    view.wrapper.rotation = t.rotation
    view.wrapper.position.set(t.x + t.width / 2, t.y + t.height / 2)

    view.width = t.width
    view.height = t.height
    this.applySpriteCrop(view)
    this.redrawAppearance(view)
  }

  private applySpriteCrop(view: VideoNodeView) {
    // Cover-crop the live video texture into the frame (object-fit: cover),
    // like the old Konva.Image crop path.
    const texture = view.sprite.texture
    const crop = getVideoCoverCrop(view.intrinsic, {
      width: view.width,
      height: view.height,
    })
    if (
      view.cropTexture === texture &&
      view.crop &&
      view.crop.cropX === crop.cropX &&
      view.crop.cropY === crop.cropY &&
      view.crop.cropWidth === crop.cropWidth &&
      view.crop.cropHeight === crop.cropHeight
    ) {
      return
    }

    view.crop = crop
    view.cropTexture = texture
    const frame = texture.frame
    frame.x = crop.cropX
    frame.y = crop.cropY
    frame.width = crop.cropWidth
    frame.height = crop.cropHeight
    texture.update()
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
   * Paint immediately after the drawing buffer changes size. Deferring this to
   * the next rAF can let the browser present old pixels in the new canvas box
   * for a frame, which reads as artboard/content stretch during layout animation.
   */
  renderNow() {
    if (this.destroyed) return
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.paint()
  }

  /**
   * Render one frame. Wrapped in try/catch as a final guard: uploading a video
   * frame that isn't decoded yet can throw on the WebGPU backend, and a transient
   * GPU upload race must never kill the render loop.
   */
  private paint() {
    if (this.destroyed) return
    // Keep the last successfully uploaded video texture visible during seeks.
    // Konva behaved this way naturally when drawing an HTMLVideoElement; gating
    // renderability on transient readyState dips causes visible blank flicker.
    for (const view of this.nodeViews.values()) {
      if (view.timelineVisible) this.uploadVideoFrame(view)
      view.sprite.renderable = view.timelineVisible && view.hasUploadedFrame
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
    this.zoomBlur.destroy()
  }

  // ── internal ───────────────────────────────────────────────────────────────

  /**
   * Upload the current HTMLVideoElement frame when the browser has one ready.
   * A failed upload leaves the previous texture intact so fast hover seeking
   * never blanks the node while the decoder is catching up.
   */
  private uploadVideoFrame(view: VideoNodeView): boolean {
    if (view.videoEl.readyState < 2) return false
    try {
      view.source.update()
      view.hasUploadedFrame = true
      return true
    } catch {
      return false
    }
  }

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
    this.borderGfx.clear().rect(0, 0, width, height).stroke({
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

/** Flatten points into the [x0, y0, x1, y1, …] array Graphics.poly expects. */
function flattenPoints(points: Vec2[]): number[] {
  return points.flatMap((point) => [point.x, point.y])
}

function drawResizeHandle(
  g: Graphics,
  handle: ResizeHandle & { screen: Vec2 },
  palette: CanvasPalette
) {
  const { x, y } = handle.screen
  if (handle.hx !== 0 && handle.hy !== 0) {
    const radius = CORNER_HANDLE_SIZE / 2
    g.circle(x, y, radius)
      .fill({ color: palette.handleFill })
      .stroke({ width: HANDLE_STROKE_WIDTH, color: palette.handleStroke })
    return
  }

  const isHorizontal = handle.hy !== 0
  const width = isHorizontal ? SIDE_HANDLE_LENGTH : SIDE_HANDLE_THICKNESS
  const height = isHorizontal ? SIDE_HANDLE_THICKNESS : SIDE_HANDLE_LENGTH
  g.roundRect(x - width / 2, y - height / 2, width, height, height / 2)
    .fill({ color: palette.handleFill })
    .stroke({ width: HANDLE_STROKE_WIDTH, color: palette.handleStroke })
}

function drawRotationHandle(g: Graphics, point: Vec2, palette: CanvasPalette) {
  const radius = ROTATION_HANDLE_SIZE / 2
  g.circle(point.x, point.y, radius)
    .fill({ color: palette.handleFill })
    .stroke({ width: HANDLE_STROKE_WIDTH, color: palette.handleStroke })
  drawRotateIcon(g, point, palette)
}

function drawRotateIcon(g: Graphics, point: Vec2, palette: CanvasPalette) {
  const tx = point.x - (ROTATE_ICON_VIEWBOX_SIZE * ROTATE_ICON_SCALE) / 2
  const ty = point.y - (ROTATE_ICON_VIEWBOX_SIZE * ROTATE_ICON_SCALE) / 2

  g.save().setTransform(ROTATE_ICON_SCALE, 0, 0, ROTATE_ICON_SCALE, tx, ty)
  for (const path of ROTATE_ICON_PATHS) {
    g.beginPath().path(path).stroke({
      width: ROTATE_ICON_STROKE_WIDTH,
      color: palette.handleIcon,
      cap: "round",
      join: "round",
    })
  }
  g.restore()
}
