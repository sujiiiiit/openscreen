import type Konva from "konva"

import type { CanvasSize } from "@/types/editor-canvas"

export type VideoCoverCrop = {
  cropX: number
  cropY: number
  cropWidth: number
  cropHeight: number
}

const MIN_CROP_SIZE = 1

function normalizeSize(size: CanvasSize) {
  return {
    width: Math.max(MIN_CROP_SIZE, size.width),
    height: Math.max(MIN_CROP_SIZE, size.height),
  }
}

export function getVideoCoverCrop(
  sourceSize: CanvasSize,
  frameSize: CanvasSize
): VideoCoverCrop {
  const source = normalizeSize(sourceSize)
  const frame = normalizeSize(frameSize)
  const sourceRatio = source.width / source.height
  const frameRatio = frame.width / frame.height

  if (frameRatio > sourceRatio) {
    const cropHeight = source.width / frameRatio

    return {
      cropX: 0,
      cropY: (source.height - cropHeight) / 2,
      cropWidth: source.width,
      cropHeight,
    }
  }

  const cropWidth = source.height * frameRatio

  return {
    cropX: (source.width - cropWidth) / 2,
    cropY: 0,
    cropWidth,
    cropHeight: source.height,
  }
}

export function applyVideoCoverCrop(
  node: Konva.Image,
  sourceSize: CanvasSize,
  frameSize: CanvasSize
) {
  const crop = getVideoCoverCrop(sourceSize, frameSize)

  node.cropX(crop.cropX)
  node.cropY(crop.cropY)
  node.cropWidth(crop.cropWidth)
  node.cropHeight(crop.cropHeight)
}
