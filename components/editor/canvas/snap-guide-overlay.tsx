"use client"

import { forwardRef, useImperativeHandle, useMemo, useRef } from "react"
import type Konva from "konva"
import { Group, Line, Text } from "react-konva"

import {
  SNAP_GUIDE_DASH,
  SNAP_GUIDE_STROKE,
  SNAP_GUIDE_STROKE_WIDTH_SCREEN_PX,
} from "@/components/editor/canvas/canvas-node-constants"
import type {
  DimensionGuide,
  DistanceGuide,
  GuideLine,
} from "@/lib/editor-canvas-snap"

const MAX_GUIDE_LINES = 4
const MAX_DISTANCE_SEGMENTS = 4
const MAX_DISTANCE_LABELS = 2
const MAX_DIMENSION_LINES = 4
const MAX_DIMENSION_LABELS = 2
const DISTANCE_LABEL_FONT_SIZE_PX = 11
const DISTANCE_LABEL_OFFSET_PX = 6

export type SnapGuideOverlayHandle = {
  setGuides: (
    guides: GuideLine[],
    distances: DistanceGuide[],
    dimensions?: DimensionGuide[]
  ) => void
  clear: () => void
}

export const SnapGuideOverlay = forwardRef<SnapGuideOverlayHandle>(
  function SnapGuideOverlay(_, ref) {
    const guideRefs = useRef<Array<Konva.Line | null>>([])
    const distanceRefs = useRef<Array<Konva.Line | null>>([])
    const labelRefs = useRef<Array<Konva.Text | null>>([])
    const dimensionLineRefs = useRef<Array<Konva.Line | null>>([])
    const dimensionLabelRefs = useRef<Array<Konva.Text | null>>([])

    const guideIndexes = useMemo(
      () => Array.from({ length: MAX_GUIDE_LINES }, (_, i) => i),
      []
    )
    const distanceIndexes = useMemo(
      () => Array.from({ length: MAX_DISTANCE_SEGMENTS }, (_, i) => i),
      []
    )
    const labelIndexes = useMemo(
      () => Array.from({ length: MAX_DISTANCE_LABELS }, (_, i) => i),
      []
    )
    const dimensionLineIndexes = useMemo(
      () => Array.from({ length: MAX_DIMENSION_LINES }, (_, i) => i),
      []
    )
    const dimensionLabelIndexes = useMemo(
      () => Array.from({ length: MAX_DIMENSION_LABELS }, (_, i) => i),
      []
    )

    useImperativeHandle(
      ref,
      () => ({
        setGuides: (guides, distances, dimensions = []) => {
          for (let i = 0; i < MAX_GUIDE_LINES; i++) {
            const node = guideRefs.current[i]
            if (!node) continue

            const guide = guides[i]
            if (!guide) {
              if (node.visible()) node.visible(false)
              continue
            }

            const points =
              guide.axis === "x"
                ? [guide.value, guide.from, guide.value, guide.to]
                : [guide.from, guide.value, guide.to, guide.value]
            node.points(points)
            node.visible(true)
          }

          const flatSegments: Array<{
            axis: "x" | "y"
            from: number
            to: number
            cross: number
          }> = []
          for (const distance of distances) {
            for (const segment of distance.segments) {
              flatSegments.push({ ...segment, axis: distance.axis })
              if (flatSegments.length >= MAX_DISTANCE_SEGMENTS) break
            }
            if (flatSegments.length >= MAX_DISTANCE_SEGMENTS) break
          }

          for (let i = 0; i < MAX_DISTANCE_SEGMENTS; i++) {
            const node = distanceRefs.current[i]
            if (!node) continue

            const segment = flatSegments[i]
            if (!segment) {
              if (node.visible()) node.visible(false)
              continue
            }

            const points =
              segment.axis === "x"
                ? [segment.from, segment.cross, segment.to, segment.cross]
                : [segment.cross, segment.from, segment.cross, segment.to]
            node.points(points)
            node.visible(true)
          }

          const currentScale = (guideRefs.current[0]?.getStage()?.scaleX() ||
            1) as number
          for (let i = 0; i < MAX_DISTANCE_LABELS; i++) {
            const node = labelRefs.current[i]
            if (!node) continue

            const distance = distances[i]
            if (
              !distance ||
              distance.segments.length === 0 ||
              currentScale <= 0
            ) {
              if (node.visible()) node.visible(false)
              continue
            }

            const segment = distance.segments[0]
            const labelOffset = DISTANCE_LABEL_OFFSET_PX / currentScale
            node.text(Math.round(Math.abs(distance.gap)).toString())
            if (distance.axis === "x") {
              node.x((segment.from + segment.to) / 2)
              node.y(segment.cross - labelOffset)
            } else {
              node.x(segment.cross + labelOffset)
              node.y((segment.from + segment.to) / 2)
            }
            node.fontSize(DISTANCE_LABEL_FONT_SIZE_PX / currentScale)
            node.offsetX(node.width() / 2)
            node.offsetY(node.height() / 2)
            node.visible(true)
          }

          const currentScaleForDims = (guideRefs.current[0]
            ?.getStage()
            ?.scaleX() || 1) as number
          const dimLines: Array<{
            x1: number
            y1: number
            x2: number
            y2: number
          }> = []
          const dimLabels: Array<{
            x: number
            y: number
            text: string
            anchor: "x" | "y"
          }> = []
          for (const dim of dimensions) {
            const dragged = dim.draggedRect
            const matched = dim.matchedRect
            if (dim.axis === "width") {
              const labelOffset = DISTANCE_LABEL_OFFSET_PX / currentScaleForDims
              dimLines.push({
                x1: dragged.x,
                y1: dragged.y - labelOffset,
                x2: dragged.x + dragged.width,
                y2: dragged.y - labelOffset,
              })
              dimLines.push({
                x1: matched.x,
                y1: matched.y - labelOffset,
                x2: matched.x + matched.width,
                y2: matched.y - labelOffset,
              })
              dimLabels.push({
                x: dragged.x + dragged.width / 2,
                y: dragged.y - labelOffset * 2,
                text: `W ${Math.round(dim.value)}`,
                anchor: "x",
              })
            } else {
              const labelOffset = DISTANCE_LABEL_OFFSET_PX / currentScaleForDims
              dimLines.push({
                x1: dragged.x - labelOffset,
                y1: dragged.y,
                x2: dragged.x - labelOffset,
                y2: dragged.y + dragged.height,
              })
              dimLines.push({
                x1: matched.x - labelOffset,
                y1: matched.y,
                x2: matched.x - labelOffset,
                y2: matched.y + matched.height,
              })
              dimLabels.push({
                x: dragged.x - labelOffset * 2,
                y: dragged.y + dragged.height / 2,
                text: `H ${Math.round(dim.value)}`,
                anchor: "y",
              })
            }
            if (dimLines.length >= MAX_DIMENSION_LINES) break
          }

          for (let i = 0; i < MAX_DIMENSION_LINES; i++) {
            const node = dimensionLineRefs.current[i]
            if (!node) continue
            const seg = dimLines[i]
            if (!seg) {
              if (node.visible()) node.visible(false)
              continue
            }
            node.points([seg.x1, seg.y1, seg.x2, seg.y2])
            node.visible(true)
          }

          for (let i = 0; i < MAX_DIMENSION_LABELS; i++) {
            const node = dimensionLabelRefs.current[i]
            if (!node) continue
            const label = dimLabels[i]
            if (!label || currentScaleForDims <= 0) {
              if (node.visible()) node.visible(false)
              continue
            }
            node.text(label.text)
            node.fontSize(DISTANCE_LABEL_FONT_SIZE_PX / currentScaleForDims)
            node.x(label.x)
            node.y(label.y)
            node.offsetX(node.width() / 2)
            node.offsetY(node.height() / 2)
            node.visible(true)
          }

          const layer = guideRefs.current[0]?.getLayer()
          layer?.batchDraw()
        },
        clear: () => {
          let touched = false
          const allRefs = [
            guideRefs,
            distanceRefs,
            labelRefs,
            dimensionLineRefs,
            dimensionLabelRefs,
          ]
          for (const bag of allRefs) {
            for (const node of bag.current) {
              if (node?.visible()) {
                node.visible(false)
                touched = true
              }
            }
          }
          if (touched) {
            const layer = guideRefs.current[0]?.getLayer()
            layer?.batchDraw()
          }
        },
      }),
      []
    )

    return (
      <Group listening={false}>
        {guideIndexes.map((index) => (
          <Line
            key={`guide-${index}`}
            ref={(node) => {
              guideRefs.current[index] = node
            }}
            visible={false}
            stroke={SNAP_GUIDE_STROKE}
            strokeWidth={SNAP_GUIDE_STROKE_WIDTH_SCREEN_PX}
            strokeScaleEnabled={false}
            dash={[...SNAP_GUIDE_DASH]}
            listening={false}
            perfectDrawEnabled={false}
            shadowForStrokeEnabled={false}
          />
        ))}
        {distanceIndexes.map((index) => (
          <Line
            key={`distance-${index}`}
            ref={(node) => {
              distanceRefs.current[index] = node
            }}
            visible={false}
            stroke={SNAP_GUIDE_STROKE}
            strokeWidth={SNAP_GUIDE_STROKE_WIDTH_SCREEN_PX}
            strokeScaleEnabled={false}
            dash={[...SNAP_GUIDE_DASH]}
            listening={false}
            perfectDrawEnabled={false}
            shadowForStrokeEnabled={false}
          />
        ))}
        {labelIndexes.map((index) => (
          <Text
            key={`label-${index}`}
            ref={(node) => {
              labelRefs.current[index] = node
            }}
            visible={false}
            fill={SNAP_GUIDE_STROKE}
            fontSize={DISTANCE_LABEL_FONT_SIZE_PX}
            fontStyle="600"
            text=""
            listening={false}
            perfectDrawEnabled={false}
            shadowForStrokeEnabled={false}
          />
        ))}
        {dimensionLineIndexes.map((index) => (
          <Line
            key={`dim-line-${index}`}
            ref={(node) => {
              dimensionLineRefs.current[index] = node
            }}
            visible={false}
            stroke={SNAP_GUIDE_STROKE}
            strokeWidth={SNAP_GUIDE_STROKE_WIDTH_SCREEN_PX}
            strokeScaleEnabled={false}
            dash={[...SNAP_GUIDE_DASH]}
            listening={false}
            perfectDrawEnabled={false}
            shadowForStrokeEnabled={false}
          />
        ))}
        {dimensionLabelIndexes.map((index) => (
          <Text
            key={`dim-label-${index}`}
            ref={(node) => {
              dimensionLabelRefs.current[index] = node
            }}
            visible={false}
            fill={SNAP_GUIDE_STROKE}
            fontSize={DISTANCE_LABEL_FONT_SIZE_PX}
            fontStyle="600"
            text=""
            listening={false}
            perfectDrawEnabled={false}
            shadowForStrokeEnabled={false}
          />
        ))}
      </Group>
    )
  }
)
