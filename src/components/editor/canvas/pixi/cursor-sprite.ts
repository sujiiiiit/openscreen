import { type Container, Sprite, Texture } from "pixi.js"
import { MotionBlurFilter } from "pixi-filters/motion-blur"

import type { SmoothedCursorTrack } from "@/lib/cursors/cursor-track"
import type { CursorSetId, CursorSmoothingMode } from "@/types/editor-canvas"

import {
  computeCursorBlur,
  placeCursor,
  type CursorVideoGeometry,
} from "../cursor-scene"

const DEG_TO_RAD = Math.PI / 180

// Module-level cursor-SVG cache shared across mounts + the export.
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

/** Decode a set of cursor SVGs up front (used by the export so the loop never waits). */
export async function preloadCursorImages(
  urls: Iterable<string>
): Promise<void> {
  await Promise.all(
    Array.from(urls).map(async (url) => {
      try {
        await loadCursorImage(url).decode()
      } catch {
        // A missing/undecodable SVG just hides the cursor for those frames.
      }
    })
  )
}

/** MotionBlurFilter requires an odd kernel size ≥ 5. */
function toOddKernelSize(kernelSize: number): number {
  const n = Math.max(5, Math.trunc(kernelSize))
  return n % 2 === 0 ? n + 1 : n
}

export type CursorPlaceOptions = {
  sizeMultiplier: number
  clickPressScale: number
  cursorSet: CursorSetId
  alwaysUsePointer: boolean
  motionRotation: number
  smoothingMode: CursorSmoothingMode
  referenceSize: { width: number; height: number }
  /** Fade the cursor out during recorded typing sessions (`typing-track.ts`). */
  hideWhileTyping: boolean
}

/**
 * The cursor as a single Pixi Sprite with a native `MotionBlurFilter`. Shared by
 * the editor preview (CursorController) and the offscreen export. The cursor is
 * drawn directly into the canvas — the motion blur is the Pixi filter on the
 * sprite (GPU), not a pre-rendered canvas. The pure placement + velocity
 * derivation (`placeCursor` / `computeCursorBlur`) is unchanged; zero velocity
 * collapses to a sharp cursor (the filter forces kernelSize 0). The filter
 * auto-pads, so the sprite stays at the placement size and the hotspot anchor is
 * just `offset / size`.
 */
export class CursorSprite {
  readonly sprite = new Sprite()
  private readonly motionBlur = new MotionBlurFilter()
  private readonly sharpTextures = new Map<string, Texture>()
  private filtered = false

  constructor(parent: Container) {
    this.sprite.eventMode = "none"
    this.sprite.visible = false
    parent.addChild(this.sprite)
  }

  /**
   * Place + blur the cursor at an explicit screen-recording source time.
   * `onSvgLoad` (editor only) re-places once a freshly-fetched SVG decodes.
   * `alphaMultiplier` is the per-clip "Hide cursor" fade (`clipCursorAlphaAt`),
   * multiplied onto the hide-while-typing alpha.
   */
  render(
    track: SmoothedCursorTrack,
    video: CursorVideoGeometry,
    sourceSeconds: number,
    options: CursorPlaceOptions,
    motionBlurIntensity: number,
    onSvgLoad?: () => void,
    alphaMultiplier = 1
  ): void {
    const placement = placeCursor(track, video, sourceSeconds, options)
    if (!placement || placement.width <= 0 || placement.height <= 0) {
      this.hide()
      return
    }
    const alpha = placement.alpha * alphaMultiplier
    // Fully faded (hide-while-typing / hidden clip): skip texture/blur work.
    if (alpha <= 0.001) {
      this.hide()
      return
    }

    const svg = loadCursorImage(placement.url)
    if (!svg.complete) {
      if (onSvgLoad) svg.addEventListener("load", onSvgLoad, { once: true })
      this.hide()
      return
    }

    this.sprite.texture = this.sharpTextureFor(placement.url, svg)
    this.sprite.setSize(placement.width, placement.height)
    this.sprite.anchor.set(
      placement.offsetX / placement.width,
      placement.offsetY / placement.height
    )
    this.sprite.position.set(placement.x, placement.y)
    // placeCursor returns degrees (Konva convention); Pixi rotation is radians.
    this.sprite.rotation = placement.rotation * DEG_TO_RAD

    const blur = placement.onScreen
      ? computeCursorBlur(track, video, sourceSeconds, {
          intensity: motionBlurIntensity,
          ...options,
        })
      : null
    const wantBlur = !!blur && (blur.velocityX !== 0 || blur.velocityY !== 0)
    if (wantBlur && blur) {
      this.motionBlur.velocity = { x: blur.velocityX, y: blur.velocityY }
      this.motionBlur.kernelSize = toOddKernelSize(blur.kernelSize)
      this.motionBlur.offset = blur.offset
    }
    if (wantBlur !== this.filtered) {
      this.sprite.filters = wantBlur ? [this.motionBlur] : []
      this.filtered = wantBlur
    }

    this.sprite.alpha = alpha
    this.sprite.visible = placement.onScreen
  }

  hide(): void {
    if (this.sprite.visible) this.sprite.visible = false
  }

  destroy(): void {
    for (const texture of this.sharpTextures.values()) texture.destroy(true)
    this.sharpTextures.clear()
    this.motionBlur.destroy()
    this.sprite.destroy()
  }

  private sharpTextureFor(url: string, svg: HTMLImageElement): Texture {
    const cached = this.sharpTextures.get(url)
    if (cached) return cached
    const texture = Texture.from(svg)
    this.sharpTextures.set(url, texture)
    return texture
  }
}
