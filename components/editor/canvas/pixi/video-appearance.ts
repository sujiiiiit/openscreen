import { BlurFilter, type Graphics } from "pixi.js"

import { tracePathOrRect } from "@/lib/squircle"

import {
  computeBorderParams,
  computeShadowParams,
  computeSquircleParams,
  type VideoStyleSource,
} from "../video-scene-draw"

/**
 * Native-Pixi reproduction of the Konva/Canvas2D video appearance stack
 * (`drawCanvasVideoFrame`): squircle clip + stroked border + drop shadow.
 *
 * Geometry parity is exact: Pixi `Graphics` implements the same
 * moveTo/lineTo/bezierCurveTo/arc/rect surface as the Canvas2D `SquircleContext`,
 * so the shared `traceSquirclePath` produces an identical outline. The
 * size-independent appearance params are computed by the SAME shared functions
 * the exporter uses (`computeSquircleParams` / `computeBorderParams` /
 * `computeShadowParams` in `video-scene-draw.ts`), keeping preview and export
 * pixel-identical.
 *
 * Shadow: the Canvas2D path casts a blurred, offset silhouette via a scratch
 * black fill + `destination-out` carve. In Pixi we fill the (spread-grown)
 * squircle caster directly in the shadow color at the offset and blur it — the
 * same net result, below the content, without the carve hack (a parity
 * improvement noted in the migration plan).
 */

/** The size-independent appearance fields of a video node. */
export type NodeAppearance = Omit<VideoStyleSource, "width" | "height">

/**
 * Maps a Canvas2D `shadowBlur` radius to a Pixi `BlurFilter` strength. The two
 * gaussians are not 1:1; this is the single knob to calibrate against a captured
 * Konva reference frame (M6 parity risk in the plan).
 */
export const SHADOW_BLUR_SCALE = 1

type AppearanceParts = {
  squircleMask: Graphics
  borderGfx: Graphics
  shadowGfx: Graphics
  shadowBlur: BlurFilter
  width: number
  height: number
  appearance: NodeAppearance
}

/** Redraw a node's clip mask, border, and drop shadow for its current size + style. */
export function applyVideoAppearance(parts: AppearanceParts): void {
  const { squircleMask, borderGfx, shadowGfx, shadowBlur } = parts
  const source: VideoStyleSource = {
    width: parts.width,
    height: parts.height,
    ...parts.appearance,
  }

  const squircleParams = computeSquircleParams(source)
  const borderParams = computeBorderParams(source)
  const shadowParams = computeShadowParams(source)

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

  // ── Drop shadow: blurred squircle caster placed below the content ──
  shadowGfx.clear()
  if (shadowParams) {
    shadowGfx.position.set(
      shadowParams.originX + shadowParams.offsetX,
      shadowParams.originY + shadowParams.offsetY
    )
    tracePathOrRect(
      shadowGfx,
      shadowParams.width,
      shadowParams.height,
      shadowParams.params
    )
    // The rgba shadow color carries its own alpha; Pixi's Color parses it.
    shadowGfx.fill(shadowParams.color)
    if (shadowParams.blur > 0) {
      shadowBlur.strength = shadowParams.blur * SHADOW_BLUR_SCALE
      shadowGfx.filters = [shadowBlur]
    } else {
      shadowGfx.filters = []
    }
    shadowGfx.visible = true
  } else {
    shadowGfx.filters = []
    shadowGfx.visible = false
  }
}
