import { type Graphics } from "pixi.js"

import { tracePathOrRect } from "@/lib/squircle"

import {
  computeBorderParams,
  computeSquircleParams,
  type VideoStyleSource,
} from "../video-scene-draw"

/**
 * Native-Pixi reproduction of the Konva/Canvas2D video appearance stack
 * (`drawCanvasVideoFrame`): squircle clip + stroked border.
 *
 * Geometry parity is exact: Pixi `Graphics` implements the same
 * moveTo/lineTo/bezierCurveTo/arc/rect surface as the Canvas2D `SquircleContext`,
 * so the shared `traceSquirclePath` produces an identical outline. The
 * size-independent appearance params are computed by the SAME shared functions
 * the exporter uses (`computeSquircleParams` / `computeBorderParams` in
 * `video-scene-draw.ts`), keeping preview and export pixel-identical.
 */

/** The size-independent appearance fields of a video node. */
export type NodeAppearance = Omit<VideoStyleSource, "width" | "height">

type AppearanceParts = {
  squircleMask: Graphics
  borderGfx: Graphics
  width: number
  height: number
  appearance: NodeAppearance
}

/** Redraw a node's clip mask and border for its current size + style. */
export function applyVideoAppearance(parts: AppearanceParts): void {
  const { squircleMask, borderGfx } = parts
  const source: VideoStyleSource = {
    width: parts.width,
    height: parts.height,
    ...parts.appearance,
  }

  const squircleParams = computeSquircleParams(source)
  const borderParams = computeBorderParams(source)

  // ── Clip mask (squircle, or full-rect when radius 0) ──
  squircleMask.clear()
  tracePathOrRect(squircleMask, parts.width, parts.height, squircleParams)
  squircleMask.fill(0xffffff)

  // ── Border stroke, centered on the (offset/aligned) squircle path ──
  borderGfx.clear()
  if (borderParams) {
    borderGfx.position.set(borderParams.originX, borderParams.originY)
    tracePathOrRect(
      borderGfx,
      borderParams.width,
      borderParams.height,
      borderParams.params
    )
    borderGfx.stroke({
      width: borderParams.strokeWidth,
      color: borderParams.color,
      join: "round",
    })
  } else {
    borderGfx.position.set(0, 0)
  }
}
