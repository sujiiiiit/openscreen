"use client"

import { useMemo } from "react"
import { Rect } from "react-konva"

import type { CanvasSize } from "@/types/editor-canvas"

const NOISE_TILE_SIZE = 256
let cachedNoise: HTMLCanvasElement | null = null

function getNoiseTile(): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null
  if (cachedNoise) return cachedNoise

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
  cachedNoise = canvas
  return canvas
}

export function ArtboardGrain({
  artboard,
}: {
  artboard: CanvasSize & { grain: number }
}) {
  const { width, height, grain } = artboard
  const opacity = Math.max(0, Math.min(1, grain / 100))
  const tile = useMemo(() => (opacity > 0 ? getNoiseTile() : null), [opacity])

  if (!tile || opacity <= 0) return null

  return (
    <Rect
      x={0}
      y={0}
      width={width}
      height={height}
      // Konva's runtime fillPatternImage accepts HTMLImageElement |
      // HTMLCanvasElement, but the prop type is narrowed to the former.
      fillPatternImage={tile as unknown as HTMLImageElement}
      fillPatternRepeat="repeat"
      fillPatternOffsetX={0}
      fillPatternOffsetY={0}
      globalCompositeOperation="overlay"
      opacity={opacity}
      listening={false}
      perfectDrawEnabled={false}
      shadowForStrokeEnabled={false}
      transformsEnabled="position"
    />
  )
}
