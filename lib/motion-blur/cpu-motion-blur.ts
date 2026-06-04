import { effectiveKernelSize, type MotionBlurOptions } from "./types"

/**
 * Pure-CPU port of PixiJS's `MotionBlurFilter`, operating on `ImageData`.
 *
 * It is a faithful re-implementation of Pixi's shader math: for every output
 * pixel it samples `kernelSize` taps along the velocity vector and averages
 * them, with bilinear sampling.
 *
 * Like Pixi, the averaging happens in **premultiplied alpha**
 * (`FilterSystem` tags the filter output `premultiplied-alpha`). That matters at
 * the sprite edges: when a tap reaches into the transparent margin around the
 * sprite, premultiplied averaging feathers the smear out to transparent cleanly
 * instead of dragging colours toward black. Combined with a transparent margin
 * (Konva's `node.cache({ offset })`, sized by `motionBlurPadding`), the smear
 * spills beyond the sprite exactly like Pixi rather than being boxed inside it.
 *
 * This is the idiomatic-Konva integration path: `konvaMotionBlurFilter` wraps it
 * as a `Konva.Filters`-compatible function usable via `node.cache({ offset });
 * node.filters([fn])`. It is CPU-bound — fine for stills and small sprites, slow
 * for large/video frames (cost is O(width * height * kernelSize)).
 */

/** Bilinear sample of a premultiplied buffer at UV `(u, v)`, clamp-to-edge, into `out`. */
function samplePremul(
  pre: Float64Array,
  w: number,
  h: number,
  u: number,
  v: number,
  out: Float64Array,
): void {
  // UV -> continuous texel coordinate (GL convention: texel centers at +0.5).
  const tx = u * w - 0.5
  const ty = v * h - 0.5
  const x0 = Math.floor(tx)
  const y0 = Math.floor(ty)
  const fx = tx - x0
  const fy = ty - y0

  const cx0 = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0
  const cy0 = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0
  const cx1 = x0 + 1 < 0 ? 0 : x0 + 1 >= w ? w - 1 : x0 + 1
  const cy1 = y0 + 1 < 0 ? 0 : y0 + 1 >= h ? h - 1 : y0 + 1

  const i00 = (cy0 * w + cx0) * 4
  const i10 = (cy0 * w + cx1) * 4
  const i01 = (cy1 * w + cx0) * 4
  const i11 = (cy1 * w + cx1) * 4

  const w00 = (1 - fx) * (1 - fy)
  const w10 = fx * (1 - fy)
  const w01 = (1 - fx) * fy
  const w11 = fx * fy

  for (let c = 0; c < 4; c++) {
    out[c] = pre[i00 + c] * w00 + pre[i10 + c] * w10 + pre[i01 + c] * w01 + pre[i11 + c] * w11
  }
}

/**
 * Apply the motion blur to `src`, returning a new `ImageData`. Pure function;
 * does not mutate the input.
 */
export function applyMotionBlur(src: ImageData, options: MotionBlurOptions): ImageData {
  const { width: w, height: h } = src
  const out = new ImageData(w, h)
  const kernelSize = effectiveKernelSize(options)

  if (kernelSize === 0) {
    out.data.set(src.data)
    return out
  }

  // Premultiply the source once (rgb scaled by alpha). Averaging in this space
  // makes the transparent margin feather correctly — Pixi's `premultiplied-alpha`.
  const sd = src.data
  const pre = new Float64Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    const a = sd[o + 3]
    const af = a / 255
    pre[o] = sd[o] * af
    pre[o + 1] = sd[o + 1] * af
    pre[o + 2] = sd[o + 2] * af
    pre[o + 3] = a
  }

  const { velocityX, velocityY, offset } = options
  // Velocity normalized to UV space (matches `uVelocity / uTexSize` in the shader).
  const velUX = velocityX / w
  const velUY = velocityY / h
  const len = Math.hypot(velocityX, velocityY)
  const windowOffset = -offset / len - 0.5
  const k = kernelSize - 1

  const tap = new Float64Array(4)
  const acc = new Float64Array(4)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w
      const v = (y + 0.5) / h

      samplePremul(pre, w, h, u, v, acc)

      for (let i = 0; i < k; i++) {
        const factor = i / k + windowOffset
        samplePremul(pre, w, h, u + velUX * factor, v + velUY * factor, tap)
        acc[0] += tap[0]
        acc[1] += tap[1]
        acc[2] += tap[2]
        acc[3] += tap[3]
      }

      // Average in premultiplied space, then un-premultiply for straight-alpha output.
      const aAvg = acc[3] / kernelSize
      const o = (y * w + x) * 4
      out.data[o + 3] = aAvg
      if (aAvg > 0) {
        const inv = 255 / (aAvg * kernelSize)
        out.data[o] = acc[0] * inv
        out.data[o + 1] = acc[1] * inv
        out.data[o + 2] = acc[2] * inv
      }
    }
  }

  return out
}

/**
 * Build a `Konva.Filters`-compatible filter. Konva calls the function with the
 * node's cached `ImageData` and expects it to be mutated in place. Options are
 * read from custom attrs on the node (`motionBlur` attr), falling back to a
 * passthrough when absent.
 *
 * Usage:
 *   image.setAttr("motionBlur", { velocityX, velocityY, kernelSize, offset })
 *   image.cache()
 *   image.filters([konvaMotionBlurFilter])
 */
export function konvaMotionBlurFilter(this: { getAttr(name: string): unknown }, imageData: ImageData): void {
  const options = this.getAttr("motionBlur") as MotionBlurOptions | undefined
  if (!options) return
  const result = applyMotionBlur(imageData, options)
  imageData.data.set(result.data)
}
