"use client"

import { Shape } from "react-konva"
import type Konva from "konva"

import { PIXEL_GRID_SETTINGS } from "@/lib/editor-canvas"
import type { CanvasSize } from "@/types/editor-canvas"

type ArtboardPixelGridProps = {
  artboard: CanvasSize
}

export function ArtboardPixelGrid({ artboard }: ArtboardPixelGridProps) {
  return (
    <Shape
      x={0}
      y={0}
      width={artboard.width}
      height={artboard.height}
      listening={false}
      perfectDrawEnabled={false}
      shadowForStrokeEnabled={false}
      transformsEnabled="position"
      sceneFunc={(context, shape) => {
        const stage = shape.getStage()
        if (!stage) return

        const scale = stage.scaleX()
        if (scale < PIXEL_GRID_SETTINGS.visibleFromScale) return

        const stageX = stage.x()
        const stageY = stage.y()
        const stageWidth = stage.width()
        const stageHeight = stage.height()

        const visibleLeft = Math.max(0, -stageX / scale)
        const visibleTop = Math.max(0, -stageY / scale)
        const visibleRight = Math.min(
          artboard.width,
          (stageWidth - stageX) / scale
        )
        const visibleBottom = Math.min(
          artboard.height,
          (stageHeight - stageY) / scale
        )

        if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return

        const { color, majorColor, majorOpacity, majorUnit, opacity, unit } =
          PIXEL_GRID_SETTINGS

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
