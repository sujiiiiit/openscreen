"use client"

import { useLayoutEffect, useRef, type RefObject } from "react"
import Konva from "konva"
import { Transformer } from "react-konva"

import {
  MIN_VIDEO_NODE_SIZE,
  VIDEO_ROTATION_SNAPS,
  VIDEO_TRANSFORMER_ANCHORS,
} from "@/components/editor/canvas/canvas-node-constants"

type SelectedVideoTransformerProps = {
  selectedItemId: string | null
  viewScale: number
  nodeVersion: number
  nodeMapRef: RefObject<Map<string, Konva.Image>>
}

export function SelectedVideoTransformer({
  selectedItemId,
  viewScale,
  nodeVersion,
  nodeMapRef,
}: SelectedVideoTransformerProps) {
  const transformerRef = useRef<Konva.Transformer | null>(null)
  const screenScale = 1 / viewScale

  useLayoutEffect(() => {
    const transformer = transformerRef.current
    if (!transformer) return

    const selectedNode = selectedItemId
      ? nodeMapRef.current.get(selectedItemId)
      : null

    transformer.nodes(selectedNode ? [selectedNode] : [])
    transformer.getLayer()?.batchDraw()
  }, [nodeMapRef, nodeVersion, selectedItemId])

  if (!selectedItemId) return null

  return (
    <Transformer
      ref={transformerRef}
      enabledAnchors={VIDEO_TRANSFORMER_ANCHORS}
      keepRatio
      flipEnabled={false}
      rotateEnabled
      rotationSnaps={VIDEO_ROTATION_SNAPS}
      rotationSnapTolerance={5}
      rotateAnchorOffset={28 * screenScale}
      anchorSize={10 * screenScale}
      anchorCornerRadius={3 * screenScale}
      borderStroke="#8b5cf6"
      borderStrokeWidth={1 * screenScale}
      anchorFill="#ffffff"
      anchorStroke="#8b5cf6"
      anchorStrokeWidth={1.25 * screenScale}
      boundBoxFunc={(oldBox, newBox) => {
        if (
          Math.abs(newBox.width) < MIN_VIDEO_NODE_SIZE ||
          Math.abs(newBox.height) < MIN_VIDEO_NODE_SIZE
        ) {
          return oldBox
        }

        return newBox
      }}
    />
  )
}
