// Visual change-detection for auto-zoom content bounds.
//
// Around an interaction (a click that may open a menu/popover/flyout), we diff a
// frame just BEFORE the interaction against one just AFTER. The bounding box of
// the region that *appeared* is the engaged content's extent — exactly what the
// predictive cursor-follow planner needs to decide PAN vs ZOOM-OUT-to-fit.
//
// This is a deliberately lightweight, dependency-free technique (a luma frame
// difference + a coarse grid-cell vote), NOT a heavy ML/OpenCV pass: the target
// is the bounding box of an appeared rectangular UI region, which a per-pixel
// delta resolves robustly. It runs offline at generation, is pure (so it is
// unit-testable with synthetic frames), and sits behind {@link ContentBoundsProvider}
// so an Accessibility-backed provider can replace it later without touching the
// pipeline. It returns FRAME-normalized bounds; the caller maps them to artboard
// space with the same cover-crop chain the cursor overlay uses.

import type { NormRect } from "../types"

/** A single-channel (luma) frame: one byte per pixel, row-major. */
export type FrameLuma = {
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

export type ChangeDetectOptions = {
  /** Per-pixel luma delta (0..255) above which a pixel counts as changed. */
  threshold: number
  /** The frame is divided into `cellGrid` × `cellGrid` cells for the vote. */
  cellGrid: number
  /** A cell counts as changed when at least this fraction of its pixels changed. */
  minCellFraction: number
  /**
   * Ignore the result when more than this fraction of cells changed: a
   * whole-frame change is a scroll / page-nav / video, not a popover, and should
   * fall back to pure cursor geometry rather than zoom the camera way out.
   */
  maxChangedCellFraction: number
  /**
   * Minimum density of changed cells WITHIN the detected bounding box. A real
   * popover densely fills its box (≈1.0); scattered AA/compression/cursor noise
   * spreads a few cells across a large box (low density) and is rejected. This is
   * what makes the cheap grid vote robust without connected-component analysis.
   */
  minBoxDensity: number
}

export const CHANGE_DETECT_DEFAULTS: ChangeDetectOptions = {
  threshold: 18,
  cellGrid: 48,
  minCellFraction: 0.06,
  maxChangedCellFraction: 0.6,
  minBoxDensity: 0.35,
}

/**
 * Detect the bounding box of content that changed between two equal-size luma
 * frames, in FRAME-normalized [0,1] coordinates (top-left origin). Returns
 * `null` when there is no change, when the change spans most of the frame
 * (full-frame → not a popover), or when the inputs are unusable.
 */
export function detectChangedRect(
  before: FrameLuma,
  after: FrameLuma,
  opts: ChangeDetectOptions = CHANGE_DETECT_DEFAULTS
): NormRect | null {
  const w = before.width
  const h = before.height
  if (w <= 0 || h <= 0) return null
  if (after.width !== w || after.height !== h) return null
  if (before.data.length < w * h || after.data.length < w * h) return null

  const grid = Math.max(1, Math.trunc(opts.cellGrid))
  // Per-cell changed-pixel counts (grid × grid).
  const changed = new Int32Array(grid * grid)
  for (let y = 0; y < h; y++) {
    const cy = Math.min(grid - 1, Math.floor((y * grid) / h))
    const rowBase = y * w
    const cellRow = cy * grid
    for (let x = 0; x < w; x++) {
      const i = rowBase + x
      const delta = Math.abs(after.data[i] - before.data[i])
      if (delta > opts.threshold) {
        const cx = Math.min(grid - 1, Math.floor((x * grid) / w))
        changed[cellRow + cx] += 1
      }
    }
  }

  // Cell is "changed" when enough of its pixels moved. Cells along the right/
  // bottom edge may be a pixel larger; using the nominal cell area is close
  // enough for a vote and keeps the threshold uniform.
  const cellPixels = Math.max(1, Math.floor(w / grid) * Math.floor(h / grid))
  const minChangedPixels = opts.minCellFraction * cellPixels

  let minCx = grid
  let minCy = grid
  let maxCx = -1
  let maxCy = -1
  let changedCells = 0
  for (let cy = 0; cy < grid; cy++) {
    for (let cx = 0; cx < grid; cx++) {
      if (changed[cy * grid + cx] < minChangedPixels) continue
      changedCells += 1
      if (cx < minCx) minCx = cx
      if (cy < minCy) minCy = cy
      if (cx > maxCx) maxCx = cx
      if (cy > maxCy) maxCy = cy
    }
  }

  if (changedCells === 0) return null
  if (changedCells > opts.maxChangedCellFraction * grid * grid) return null

  // Reject a sparse, scattered change (noise) whose box is mostly empty.
  const boxCells = (maxCx - minCx + 1) * (maxCy - minCy + 1)
  if (changedCells < opts.minBoxDensity * boxCells) return null

  // Cell bounds → frame-normalized rect. The box spans [minC, maxC+1) cells.
  const x = minCx / grid
  const y = minCy / grid
  const width = (maxCx + 1) / grid - x
  const height = (maxCy + 1) / grid - y
  return { x, y, width, height }
}

/**
 * Source of a content rect for an interaction at a given timeline time. The
 * frame-diff implementation is one provider; an Accessibility-backed provider
 * (real element/menu bounds) is the planned drop-in. The planner depends only on
 * the resulting {@link NormRect}, never on how it was produced.
 */
export interface ContentBoundsProvider {
  /** Artboard-normalized content bounds at `timelineSeconds`, or `null` if none. */
  rectFor(timelineSeconds: number): Promise<NormRect | null>
}
