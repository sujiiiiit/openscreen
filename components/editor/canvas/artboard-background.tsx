"use client"

import { useEffect, useMemo, useState } from "react"
import { Image as KonvaImage, Rect } from "react-konva"

import {
  getWallpaperFullUrl,
  isWallpaperId,
  type WallpaperId,
} from "@/lib/wallpapers"
import type { ArtboardBackground, CanvasSize } from "@/types/editor-canvas"

const bitmapCache = new Map<string, ImageBitmap>()
const inFlightBitmaps = new Map<string, Promise<ImageBitmap>>()
const blurredCache = new Map<string, ImageBitmap>()
const inFlightBlurred = new Map<string, Promise<ImageBitmap>>()

const MAX_BLUR_RADIUS = 200

function bitmapCacheKey(src: string): string {
  return src
}

function blurCacheKey(src: string, radius: number): string {
  return `${src}::blur=${radius}`
}

async function loadBitmap(src: string): Promise<ImageBitmap> {
  const cached = bitmapCache.get(bitmapCacheKey(src))
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
    bitmapCache.set(bitmapCacheKey(src), bitmap)
    return bitmap
  })()

  inFlightBitmaps.set(src, promise)
  promise.finally(() => {
    inFlightBitmaps.delete(src)
  })

  return promise
}

async function loadBlurredBitmap(
  src: string,
  radius: number
): Promise<ImageBitmap> {
  const key = blurCacheKey(src, radius)
  const cached = blurredCache.get(key)
  if (cached) return cached

  const pending = inFlightBlurred.get(key)
  if (pending) return pending

  const promise = (async () => {
    const source = await loadBitmap(src)
    // Pad by ~3× the blur radius so the visible cropped region is well outside
    // the kernel's reach into the canvas's transparent outer ring. The padded
    // area is filled by stretching the source to cover the whole canvas — that
    // way every blur sample inside the visible region lands on real content
    // (no alpha fade, nothing for the white artboard underneath to show
    // through). The visible region we crop back out is offset by `padding`,
    // which corresponds to ~`padding / canvasWidth` ≈ 1–3% of the source's
    // edge content being trimmed — imperceptible for a cover-fit background.
    const padding = Math.max(1, Math.ceil(radius * 3))
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
    // Single drawImage that stretches the source to fill the entire padded
    // canvas. The blur kernel inside the visible window samples only real
    // (stretched) source pixels — no transparent neighbours, no edge fade.
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

function useImageBitmap(src: string | null): ImageBitmap | null {
  const [loaded, setLoaded] = useState<{
    src: string
    bitmap: ImageBitmap
  } | null>(() => {
    if (!src) return null
    const cached = bitmapCache.get(bitmapCacheKey(src))
    return cached ? { src, bitmap: cached } : null
  })

  useEffect(() => {
    if (!src) return
    if (bitmapCache.has(bitmapCacheKey(src))) return

    let cancelled = false
    loadBitmap(src)
      .then((bitmap) => {
        if (cancelled) return
        setLoaded({ src, bitmap })
      })
      .catch((error) => {
        if (cancelled) return
        console.warn("[artboard-background]", error)
      })

    return () => {
      cancelled = true
    }
  }, [src])

  if (!src) return null
  const cached = bitmapCache.get(bitmapCacheKey(src))
  if (cached) return cached
  return loaded && loaded.src === src ? loaded.bitmap : null
}

function useBlurredBitmap(
  src: string | null,
  radius: number
): ImageBitmap | null {
  const key = src ? blurCacheKey(src, radius) : null
  const [loaded, setLoaded] = useState<{
    key: string
    bitmap: ImageBitmap
  } | null>(() => {
    if (!key) return null
    const cached = blurredCache.get(key)
    return cached ? { key, bitmap: cached } : null
  })

  useEffect(() => {
    if (!src || radius <= 0 || !key) return
    if (blurredCache.has(key)) return

    let cancelled = false
    loadBlurredBitmap(src, radius)
      .then((bitmap) => {
        if (cancelled) return
        setLoaded({ key, bitmap })
      })
      .catch((error) => {
        if (cancelled) return
        console.warn("[artboard-background] blur failed", error)
      })

    return () => {
      cancelled = true
    }
  }, [src, radius, key])

  if (!key || radius <= 0) return null
  const cached = blurredCache.get(key)
  if (cached) return cached
  return loaded && loaded.key === key ? loaded.bitmap : null
}

type CoverCrop = {
  cropX: number
  cropY: number
  cropWidth: number
  cropHeight: number
}

function computeCoverCrop(
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

function resolveWallpaper(background: ArtboardBackground | null): {
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
  const blurRadius = Math.max(
    0,
    Math.min(MAX_BLUR_RADIUS, Math.round(requested))
  )
  return {
    src: getWallpaperFullUrl(background.value),
    wallpaperId: background.value,
    blurRadius,
  }
}

export function ArtboardBackground({
  artboard,
}: {
  artboard: CanvasSize & { background: ArtboardBackground | null }
}) {
  const { background, width, height } = artboard

  const colorFill = background?.type === "color" ? background.value : null

  const { src, blurRadius } = useMemo(
    () => resolveWallpaper(background),
    [background]
  )
  const baseBitmap = useImageBitmap(src)
  const blurredBitmap = useBlurredBitmap(src, blurRadius)

  const useBlurred = blurRadius > 0 && blurredBitmap !== null
  const displayBitmap = useBlurred ? blurredBitmap : baseBitmap
  // Must match the padding used in loadBlurredBitmap so the cover-crop falls
  // inside the safe (fully-opaque, fully-source-derived) region.
  const sourcePadding = useBlurred ? Math.max(1, Math.ceil(blurRadius * 3)) : 0

  const crop = useMemo(() => {
    if (!displayBitmap) return null
    return computeCoverCrop(
      displayBitmap,
      { width, height },
      sourcePadding
    )
  }, [displayBitmap, width, height, sourcePadding])

  if (colorFill) {
    return (
      <Rect
        x={0}
        y={0}
        width={width}
        height={height}
        fill={colorFill}
        listening={false}
        perfectDrawEnabled={false}
        shadowForStrokeEnabled={false}
      />
    )
  }

  if (displayBitmap && crop) {
    return (
      <KonvaImage
        x={0}
        y={0}
        width={width}
        height={height}
        image={displayBitmap}
        cropX={crop.cropX}
        cropY={crop.cropY}
        cropWidth={crop.cropWidth}
        cropHeight={crop.cropHeight}
        listening={false}
        perfectDrawEnabled={false}
        shadowForStrokeEnabled={false}
        transformsEnabled="position"
      />
    )
  }

  return null
}
