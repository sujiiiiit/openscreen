import { CanvasSource, Sprite, Texture } from "pixi.js"

import {
  createSpriteMotionBlurRendererForBackend,
  type SpriteMotionBlurRenderer,
} from "@/lib/motion-blur/sprite-motion-blur"
import type { SmoothedCursorTrack } from "@/lib/cursors/cursor-track"
import type {
  CursorMotionBlurBackend,
  CursorMotionRotationMode,
  CursorSetId,
  CursorSmoothingMode,
} from "@/types/editor-canvas"

import { computeCursorBlur, placeCursor } from "../cursor-scene"
import type { CanvasScene } from "./scene"

const DEG_TO_RAD = Math.PI / 180

// Module-level image cache shared across mounts — cursor SVGs are tiny and
// reused across recordings (mirrors the Konva overlay's cache).
const imageCache = new Map<string, HTMLImageElement>()
function loadCursorImage(url: string): HTMLImageElement {
  const cached = imageCache.get(url)
  if (cached) return cached
  const img = new window.Image()
  img.decoding = "async"
  img.src = url
  imageCache.set(url, img)
  return img
}

/** The live inputs the cursor placement reads, pushed from the provider bridge. */
export type CursorState = {
  screenVideo: {
    x: number
    y: number
    width: number
    height: number
    rotation: number
    intrinsicWidth: number
    intrinsicHeight: number
  } | null
  /** Maps timeline time → screen source time (`t - start + sourceIn`). */
  screenClip: { start: number; sourceIn: number } | null
  referenceSize: { width: number; height: number }
  customRenderingEnabled: boolean
  cursorSetId: CursorSetId
  sizeMultiplier: number
  smoothingMode: CursorSmoothingMode
  clickPressScale: number
  alwaysUsePointer: boolean
  motionRotation: number
  motionRotationMode: CursorMotionRotationMode
  motionBlur: number
  motionBlurBackend: CursorMotionBlurBackend
}

/**
 * Pixi port of `CanvasCursorOverlay`. Owns one cursor Sprite in the scene's
 * content cursor layer (above the video nodes, clipped to the artboard) and
 * places it imperatively per playback tick / hover, reusing the shared
 * `cursor-scene` placement + the `sprite-motion-blur` renderer. Sharp SVGs use a
 * per-URL texture cache; the (size-varying) blurred canvas is wrapped in a
 * CanvasSource texture that's rebuilt only when the canvas instance or size
 * changes, and re-uploaded otherwise.
 */
export class CursorController {
  private readonly scene: CanvasScene
  private readonly sprite: Sprite
  private track: SmoothedCursorTrack | null = null
  private state: CursorState | null = null
  private lastTimelineSeconds = 0

  private renderer: SpriteMotionBlurRenderer | null = null
  private rendererBackend: CursorMotionBlurBackend | null = null
  private rendererEnabled = false

  private readonly sharpTextures = new Map<string, Texture>()
  private blurTexture: Texture | null = null
  private blurCanvas: HTMLCanvasElement | OffscreenCanvas | null = null

  constructor(scene: CanvasScene) {
    this.scene = scene
    this.sprite = new Sprite()
    this.sprite.eventMode = "none"
    this.sprite.visible = false
    scene.getCursorLayer().addChild(this.sprite)
  }

  setTrack(track: SmoothedCursorTrack | null) {
    this.track = track
  }

  setState(state: CursorState) {
    this.state = state
    this.ensureRenderer(state)
  }

  /** Place the cursor for a timeline time (committed tick or paused/hover). */
  place(timelineSeconds: number) {
    this.lastTimelineSeconds = timelineSeconds
    const { sprite, state, track } = this
    if (!state || !state.customRenderingEnabled || !state.screenVideo || !track) {
      this.hide()
      return
    }

    const video = state.screenVideo
    const sourceSeconds = state.screenClip
      ? timelineSeconds - state.screenClip.start + state.screenClip.sourceIn
      : timelineSeconds

    const options = {
      sizeMultiplier: state.sizeMultiplier,
      clickPressScale: state.clickPressScale,
      cursorSet: state.cursorSetId,
      alwaysUsePointer: state.alwaysUsePointer,
      motionRotation: state.motionRotation,
      motionRotationMode: state.motionRotationMode,
      smoothingMode: state.smoothingMode,
      referenceSize: state.referenceSize,
    }
    const placement = placeCursor(track, video, sourceSeconds, options)
    if (!placement || placement.width <= 0 || placement.height <= 0) {
      this.hide()
      return
    }

    const svg = loadCursorImage(placement.url)
    if (!svg.complete) {
      // Re-place once the SVG decodes so it (and any blur) appears immediately.
      svg.addEventListener(
        "load",
        () => this.place(this.lastTimelineSeconds),
        { once: true }
      )
    }

    const blur = placement.onScreen
      ? computeCursorBlur(track, video, sourceSeconds, {
          intensity: state.motionBlur,
          ...options,
        })
      : null

    if (blur && this.renderer && svg.complete) {
      const { canvas, padding } = this.renderer.render(
        svg,
        placement.width,
        placement.height,
        blur
      )
      sprite.texture = this.blurTextureFor(canvas)
      const displayW = placement.width + 2 * padding
      const displayH = placement.height + 2 * padding
      sprite.width = displayW
      sprite.height = displayH
      sprite.anchor.set(
        (placement.offsetX + padding) / displayW,
        (placement.offsetY + padding) / displayH
      )
    } else {
      const texture = svg.complete ? this.sharpTextureFor(placement.url, svg) : null
      if (!texture) {
        this.hide()
        return
      }
      sprite.texture = texture
      sprite.width = placement.width
      sprite.height = placement.height
      sprite.anchor.set(
        placement.offsetX / placement.width,
        placement.offsetY / placement.height
      )
    }

    sprite.position.set(placement.x, placement.y)
    // placeCursor returns degrees (Konva convention); Pixi rotation is radians.
    sprite.rotation = placement.rotation * DEG_TO_RAD
    sprite.visible = placement.onScreen
    this.scene.requestRender()
  }

  destroy() {
    this.renderer?.destroy()
    this.renderer = null
    for (const texture of this.sharpTextures.values()) texture.destroy(true)
    this.sharpTextures.clear()
    this.blurTexture?.destroy(true)
    this.blurTexture = null
    this.sprite.destroy()
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private hide() {
    if (this.sprite.visible) {
      this.sprite.visible = false
      this.scene.requestRender()
    }
  }

  private ensureRenderer(state: CursorState) {
    if (
      this.rendererEnabled === state.customRenderingEnabled &&
      this.rendererBackend === state.motionBlurBackend &&
      (this.renderer !== null || !state.customRenderingEnabled)
    ) {
      return
    }
    this.renderer?.destroy()
    this.renderer = state.customRenderingEnabled
      ? (createSpriteMotionBlurRendererForBackend(state.motionBlurBackend) ??
        createSpriteMotionBlurRendererForBackend("cpu"))
      : null
    this.rendererEnabled = state.customRenderingEnabled
    this.rendererBackend = state.motionBlurBackend
  }

  private sharpTextureFor(url: string, svg: HTMLImageElement): Texture {
    const cached = this.sharpTextures.get(url)
    if (cached) return cached
    const texture = Texture.from(svg)
    this.sharpTextures.set(url, texture)
    return texture
  }

  private blurTextureFor(canvas: HTMLCanvasElement | OffscreenCanvas): Texture {
    const existing = this.blurTexture
    if (
      existing &&
      this.blurCanvas === canvas &&
      existing.source.width === canvas.width &&
      existing.source.height === canvas.height
    ) {
      existing.source.update()
      return existing
    }
    existing?.destroy(true)
    const source = new CanvasSource({ resource: canvas })
    this.blurTexture = new Texture({ source })
    this.blurCanvas = canvas
    return this.blurTexture
  }
}
