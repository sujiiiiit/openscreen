import Konva from "konva"

import type { ProjectStateV1, ProjectVideo } from "@/types/api"
import {
  computeBorderParams,
  computeShadowParams,
  computeSquircleParams,
  drawCanvasVideoFrame,
} from "@/components/editor/canvas/video-scene-draw"
import { getVideoCoverCrop } from "@/components/editor/canvas/video-cover-crop"
import {
  getWallpaperFullUrl,
  isWallpaperId,
} from "@/lib/wallpapers"

export interface ExportStageHandles {
  stage: Konva.Stage
  backgroundLayer: Konva.Layer
  contentLayer: Konva.Layer
  /**
   * Per-video Konva.Image nodes, keyed by `ProjectVideo.id`. The render
   * loop swaps `node.image(...)` to whichever decoded source canvas is
   * current for each output frame.
   */
  nodesByVideoId: Map<string, Konva.Image>
  /** Output dimensions of the stage in pixels. */
  outputSize: { width: number; height: number }
  dispose: () => void
}

export interface BuildStageOptions {
  state: ProjectStateV1
  assetUrlsByVideoId: Record<string, string>
  outputSize: { width: number; height: number }
  /** Off-DOM container the stage attaches to. Hidden via CSS display:none. */
  container: HTMLDivElement
}

/**
 * Build a vanilla-Konva stage that mirrors the editor's render path for a
 * single artboard composition, sized to the export's output pixel
 * dimensions. Each video clip becomes a `Konva.Image` node with a
 * placeholder canvas — the render loop in `run-export.ts` swaps in the
 * real per-frame canvas pulled from a Mediabunny `CanvasSink`.
 *
 * The stage is not drawn yet — callers should draw the background layer
 * once after construction, then redraw the content layer per output frame.
 */
export async function buildExportStage(
  options: BuildStageOptions,
): Promise<ExportStageHandles> {
  const { state, assetUrlsByVideoId, outputSize, container } = options
  const { artboard } = state

  // Stage in output pixel space. Apply a uniform scale so every node still
  // uses artboard coordinates internally — keeps the math identical to the
  // editor's render path.
  const stage = new Konva.Stage({
    container,
    width: outputSize.width,
    height: outputSize.height,
  })
  const scale = outputSize.width / artboard.width
  stage.scale({ x: scale, y: scale })

  const backgroundLayer = new Konva.Layer({ listening: false })
  const contentLayer = new Konva.Layer({ listening: false })
  stage.add(backgroundLayer)
  stage.add(contentLayer)
  // Konva defaults the layer's backing <canvas> to `width × devicePixelRatio`
  // — on a Retina display that's 2× the output resolution per layer, which
  // costs ~4× memory and forces an extra downsample when we blit into the
  // composite. For export the stage is already at the user's chosen output
  // pixel size, so pixelRatio=1 is the right setting. Avoids OOM on 4K.
  backgroundLayer.getCanvas().setPixelRatio(1)
  contentLayer.getCanvas().setPixelRatio(1)

  // ─── background ────────────────────────────────────────────────────────
  if (artboard.background?.type === "color") {
    backgroundLayer.add(
      new Konva.Rect({
        x: 0,
        y: 0,
        width: artboard.width,
        height: artboard.height,
        fill: artboard.background.value,
        listening: false,
        perfectDrawEnabled: false,
        shadowForStrokeEnabled: false,
      }),
    )
  } else if (
    artboard.background?.type === "wallpaper" &&
    isWallpaperId(artboard.background.value)
  ) {
    const url = getWallpaperFullUrl(artboard.background.value)
    try {
      const bitmap = await loadImageBitmap(url)
      const crop = getVideoCoverCrop(
        { width: bitmap.width, height: bitmap.height },
        { width: artboard.width, height: artboard.height },
      )
      backgroundLayer.add(
        new Konva.Image({
          x: 0,
          y: 0,
          width: artboard.width,
          height: artboard.height,
          image: bitmap as unknown as HTMLImageElement,
          cropX: crop.cropX,
          cropY: crop.cropY,
          cropWidth: crop.cropWidth,
          cropHeight: crop.cropHeight,
          listening: false,
          perfectDrawEnabled: false,
          shadowForStrokeEnabled: false,
          transformsEnabled: "position",
        }),
      )
    } catch {
      // Wallpaper missing — drop the background rather than failing the
      // entire export. Black-fill is acceptable.
    }
  }

  // Grain pass: same noise overlay the editor uses, applied at artboard
  // resolution. Skip in v1 if it adds measurable cost on slow exports —
  // it's a cheap pattern fill so we leave it on.
  if (artboard.grain > 0) {
    const tile = makeNoiseTile()
    if (tile) {
      backgroundLayer.add(
        new Konva.Rect({
          x: 0,
          y: 0,
          width: artboard.width,
          height: artboard.height,
          fillPatternImage: tile as unknown as HTMLImageElement,
          fillPatternRepeat: "repeat",
          globalCompositeOperation: "overlay",
          opacity: Math.max(0, Math.min(1, artboard.grain / 100)),
          listening: false,
          perfectDrawEnabled: false,
          shadowForStrokeEnabled: false,
          transformsEnabled: "position",
        }),
      )
    }
  }

  // ─── videos ────────────────────────────────────────────────────────────
  // Build one Konva.Image per video. The image source starts as a
  // placeholder canvas; the render loop swaps it to a real decoded canvas
  // from the Mediabunny CanvasSink each frame. Nodes start `visible(false)`
  // so a frame where the clip isn't active doesn't show the prior frame.
  const nodesByVideoId = new Map<string, Konva.Image>()
  const placeholderCanvas = makePlaceholderCanvas()

  for (const video of state.videos) {
    if (!assetUrlsByVideoId[video.id]) {
      // Missing asset — skip this clip. Export proceeds with whatever
      // videos we could resolve.
      continue
    }
    const node = buildVideoNode(video, placeholderCanvas)
    contentLayer.add(node)
    nodesByVideoId.set(video.id, node)
  }

  const dispose = () => {
    stage.destroy()
    nodesByVideoId.clear()
  }

  return {
    stage,
    backgroundLayer,
    contentLayer,
    nodesByVideoId,
    outputSize,
    dispose,
  }
}

function buildVideoNode(
  video: ProjectVideo,
  placeholder: HTMLCanvasElement,
): Konva.Image {
  const squircleParams = computeSquircleParams(video)
  const borderParams = computeBorderParams(video)
  const shadowParams = computeShadowParams(video)
  const cover = getVideoCoverCrop(
    { width: video.intrinsicWidth, height: video.intrinsicHeight },
    { width: video.width, height: video.height },
  )

  const node = new Konva.Image({
    x: video.x,
    y: video.y,
    width: video.width,
    height: video.height,
    rotation: video.rotation,
    image: placeholder,
    cropX: cover.cropX,
    cropY: cover.cropY,
    cropWidth: cover.cropWidth,
    cropHeight: cover.cropHeight,
    listening: false,
    perfectDrawEnabled: false,
    shadowForStrokeEnabled: false,
    visible: false,
  })
  node.sceneFunc((context, shape) => {
    const w = shape.width()
    const h = shape.height()
    const img = (shape as Konva.Image).image()
    if (!img || w <= 0 || h <= 0) return
    const ki = shape as Konva.Image
    const cw = ki.cropWidth()
    const ch = ki.cropHeight()
    drawCanvasVideoFrame(
      context,
      img,
      w,
      h,
      cw && ch
        ? { x: ki.cropX(), y: ki.cropY(), width: cw, height: ch }
        : null,
      squircleParams,
      borderParams,
      shadowParams,
    )
  })
  return node
}

function makePlaceholderCanvas(): HTMLCanvasElement {
  // Tiny transparent canvas — Konva needs an image() to construct the node,
  // but the sceneFunc bails when the underlying image hasn't been swapped
  // in yet (the `node.visible(false)` guard already prevents drawing).
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  return canvas
}

async function loadImageBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }
  const blob = await response.blob()
  return createImageBitmap(blob, {
    imageOrientation: "from-image",
    premultiplyAlpha: "default",
    colorSpaceConversion: "default",
  })
}

const NOISE_TILE_SIZE = 256
let cachedNoiseTile: HTMLCanvasElement | null = null

function makeNoiseTile(): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null
  if (cachedNoiseTile) return cachedNoiseTile
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
  cachedNoiseTile = canvas
  return canvas
}

export type { ProjectVideo }
