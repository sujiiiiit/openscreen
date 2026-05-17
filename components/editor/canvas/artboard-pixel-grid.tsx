"use client"

import { Shape } from "react-konva"
import type Konva from "konva"

import { PIXEL_GRID_SETTINGS } from "@/lib/editor-canvas"
import type { CanvasSize, ViewTransform } from "@/types/editor-canvas"

type ArtboardPixelGridProps = {
  artboard: CanvasSize
  viewportSize: CanvasSize
  viewTransform: ViewTransform
}

export function ArtboardPixelGrid({
  artboard,
  viewportSize,
  viewTransform,
}: ArtboardPixelGridProps) {
  const {
    color,
    enabled,
    majorColor,
    majorOpacity,
    majorUnit,
    opacity,
    unit,
    visibleFromScale,
  } = PIXEL_GRID_SETTINGS
  const isVisible = enabled && viewTransform.scale >= visibleFromScale

  if (!isVisible) return null

  return (
    <Shape
      x={0}
      y={0}
      width={artboard.width}
      height={artboard.height}
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(context) => {
        const scale = viewTransform.scale
        const visibleLeft = Math.max(0, -viewTransform.x / scale)
        const visibleTop = Math.max(0, -viewTransform.y / scale)
        const visibleRight = Math.min(
          artboard.width,
          (viewportSize.width - viewTransform.x) / scale
        )
        const visibleBottom = Math.min(
          artboard.height,
          (viewportSize.height - viewTransform.y) / scale
        )

        if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return

        context.save()
        context.beginPath()
        context.rect(0, 0, artboard.width, artboard.height)
        context.clip()

        drawGridLines(context, {
          visibleLeft,
          visibleTop,
          visibleRight,
          visibleBottom,
          unit,
          color,
          opacity,
          lineWidth: 1 / scale,
        })

        drawGridLines(context, {
          visibleLeft,
          visibleTop,
          visibleRight,
          visibleBottom,
          unit: majorUnit,
          color: majorColor,
          opacity: majorOpacity,
          lineWidth: 1.25 / scale,
        })

        context.restore()
      }}
    />
  )
}

function drawGridLines(
  context: Konva.Context,
  {
    visibleLeft,
    visibleTop,
    visibleRight,
    visibleBottom,
    unit,
    color,
    opacity,
    lineWidth,
  }: {
    visibleLeft: number
    visibleTop: number
    visibleRight: number
    visibleBottom: number
    unit: number
    color: string
    opacity: number
    lineWidth: number
  }
) {
  const startX = Math.floor(visibleLeft / unit) * unit
  const endX = Math.ceil(visibleRight / unit) * unit
  const startY = Math.floor(visibleTop / unit) * unit
  const endY = Math.ceil(visibleBottom / unit) * unit

  context.beginPath()
  context.strokeStyle = color
  context.lineWidth = lineWidth
  context.globalAlpha = opacity

  for (let x = startX; x <= endX; x += unit) {
    context.moveTo(x, visibleTop)
    context.lineTo(x, visibleBottom)
  }

  for (let y = startY; y <= endY; y += unit) {
    context.moveTo(visibleLeft, y)
    context.lineTo(visibleRight, y)
  }

  context.stroke()
}
