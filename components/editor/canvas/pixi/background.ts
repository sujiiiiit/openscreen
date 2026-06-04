import { Texture } from "pixi.js"

import {
  getWallpaperFullUrl,
  isWallpaperId,
  type WallpaperId,
} from "@/lib/wallpapers"
import type { ArtboardBackground, CanvasSize } from "@/types/editor-canvas"

/**
 * Framework-agnostic artboard-background helpers, shared by the Pixi preview
 * scene and the offscreen export stage. Ported from the Konva
 * `artboard-background.tsx` / `artboard-grain.tsx` so the cover-crop, wallpaper
 * blur, and noise-tile math stay byte-identical across preview and export.
 *
 * The scene/export build the actual Pixi display objects (Sprite / TilingSprite /
 * Graphics); this module only loads + crops bitmaps and produces the noise
 * texture.
 */

const bitmapCache = new Map<string, ImageBitmap>()
const inFlightBitmaps = new Map<string, Promise<ImageBitmap>>()
const blurredCache = new Map<string, ImageBitmap>()
const inFlightBlurred = new Map<string, Promise<ImageBitmap>>()

export const MAX_BLUR_RADIUS = 200

function blurCacheKey(src: string, radius: number): string {
  return `${src}::blur=${radius}`
}

/** Padding (px) baked around a blurred wallpaper so the crop stays inside opaque content. */
export function blurredWallpaperPadding(radius: number): number {
  return Math.max(1, Math.ceil(radius * 3))
}

export async function loadWallpaperBitmap(src: string): Promise<ImageBitmap> {
  const cached = bitmapCache.get(src)
  if (cached) return cached

  const pending = inFlightBitmaps.get(src)
  if (pending) return pending

  const promise = (async () => {
    const response = await fetch(src)
    if (!response.ok) {
      throw new Error(`Failed to load ${src}: ${response.status}`)
    }
    const blob = await response.blob()
    const bitmap = await createImageBitmap(blob, {
      imageOrientation: "from-image",
      premultiplyAlpha: "default",
      colorSpaceConversion: "default",
    })
    bitmapCache.set(src, bitmap)
    return bitmap
  })()

  inFlightBitmaps.set(src, promise)
  promise.finally(() => {
    inFlightBitmaps.delete(src)
  })

  return promise
}

export async function loadBlurredWallpaperBitmap(
  src: string,
  radius: number
): Promise<ImageBitmap> {
  const key = blurCacheKey(src, radius)
  const cached = blurredCache.get(key)
  if (cached) return cached

  const pending = inFlightBlurred.get(key)
  if (pending) return pending

  const promise = (async () => {
    const source = await loadWallpaperBitmap(src)
    // Pad by ~3× the blur radius so the visible cropped region sits well outside
    // the kernel's reach into the canvas's transparent outer ring. The padded
    // area is filled by stretching the source to cover the whole canvas, so
    // every blur sample inside the visible region lands on real content.
    const padding = blurredWallpaperPadding(radius)
    const canvasWidth = source.width + padding * 2
    const canvasHeight = source.height + padding * 2

    const offscreen =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(canvasWidth, canvasHeight)
        : (() => {
            const c = document.createElement("canvas")
            c.width = canvasWidth
            c.height = canvasHeight
            return c
          })()
    const ctx = offscreen.getContext("2d") as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null
    if (!ctx) throw new Error("2D context unavailable")

    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    ctx.filter = `blur(${radius}px)`
    ctx.drawImage(
      source,
      0,
      0,
      source.width,
      source.height,
      0,
      0,
      canvasWidth,
      canvasHeight
    )

    const blurred =
      "transferToImageBitmap" in offscreen
        ? offscreen.transferToImageBitmap()
        : await createImageBitmap(offscreen)
    blurredCache.set(key, blurred)
    return blurred
  })()

  inFlightBlurred.set(key, promise)
  promise.finally(() => {
    inFlightBlurred.delete(key)
  })

  return promise
}

export type CoverCrop = {
  cropX: number
  cropY: number
  cropWidth: number
  cropHeight: number
}

/** Object-fit cover crop of `source` into the artboard ratio, inside `paddingPx`. */
export function computeCoverCrop(
  source: { width: number; height: number },
  artboard: CanvasSize,
  paddingPx = 0
): CoverCrop | null {
  const iw = source.width - paddingPx * 2
  const ih = source.height - paddingPx * 2
  const aw = artboard.width
  const ah = artboard.height
  if (iw <= 0 || ih <= 0 || aw <= 0 || ah <= 0) return null

  const targetRatio = aw / ah
  const sourceRatio = iw / ih

  if (sourceRatio > targetRatio) {
    const cropHeight = ih
    const cropWidth = ih * targetRatio
    return {
      cropX: paddingPx + (iw - cropWidth) / 2,
      cropY: paddingPx,
      cropWidth,
      cropHeight,
    }
  }

  const cropWidth = iw
  const cropHeight = iw / targetRatio
  return {
    cropX: paddingPx,
    cropY: paddingPx + (ih - cropHeight) / 2,
    cropWidth,
    cropHeight,
  }
}

export function resolveWallpaper(background: ArtboardBackground | null): {
  src: string | null
  wallpaperId: WallpaperId | null
  blurRadius: number
} {
  if (!background || background.type !== "wallpaper") {
    return { src: null, wallpaperId: null, blurRadius: 0 }
  }
  if (!isWallpaperId(background.value)) {
    return { src: null, wallpaperId: null, blurRadius: 0 }
  }
  const requested = background.blurRadius ?? 0
  const blurRadius = Math.max(0, Math.min(MAX_BLUR_RADIUS, Math.round(requested)))
  return {
    src: getWallpaperFullUrl(background.value),
    wallpaperId: background.value,
    blurRadius,
  }
}

const NOISE_TILE_SIZE = 256
let cachedNoiseTexture: Texture | null = null

/** A cached 256×256 repeating grayscale noise texture for the film-grain overlay. */
export function getNoiseTexture(): Texture | null {
  if (cachedNoiseTexture) return cachedNoiseTexture
  if (typeof document === "undefined") return null

  const canvas = document.createElement("canvas")
  canvas.width = NOISE_TILE_SIZE
  canvas.height = NOISE_TILE_SIZE
  const ctx = canvas.getContext("2d")
  if (!ctx) return null

  const imageData = ctx.createImageData(NOISE_TILE_SIZE, NOISE_TILE_SIZE)
  const data = imageData.data
  for (let i = 0; i < data.length; i += 4) {
    const v = (Math.random() * 256) | 0
    data[i] = v
    data[i + 1] = v
    data[i + 2] = v
    data[i + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)

  const texture = Texture.from(canvas)
  texture.source.style.addressMode = "repeat"
  cachedNoiseTexture = texture
  return texture
}
