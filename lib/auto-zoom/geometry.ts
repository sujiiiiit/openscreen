// Small, pure geometry helpers shared across the auto-zoom stages.

import type { CanvasZoomFocus } from "@/types/editor-canvas"
import type { NormRect } from "./types"

export function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function focusDistance(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** A zero-size rect at a single point. */
export function pointRect(p: { x: number; y: number }): NormRect {
  return { x: clampUnit(p.x), y: clampUnit(p.y), width: 0, height: 0 }
}

/** The axis-aligned bounding rect of a set of points (clamped to [0,1]). */
export function rectFromPoints(points: readonly { x: number; y: number }[]): NormRect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    const x = clampUnit(p.x)
    const y = clampUnit(p.y)
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function rectCenter(rect: NormRect): CanvasZoomFocus {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/** Smallest rect covering both inputs. */
export function rectUnion(a: NormRect, b: NormRect): NormRect {
  const minX = Math.min(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxX = Math.max(a.x + a.width, b.x + b.width)
  const maxY = Math.max(a.y + a.height, b.y + b.height)
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * The smallest rect CENTERED on `center` that still contains `rect`. Used by the
 * hybrid detector to frame a cluster on its stable anchor: the framed rect's
 * center is exactly `center` (so `solveFraming` focuses there), while it still
 * covers the whole union so every subject stays in frame. May extend outside
 * [0,1] when the anchor sits near an edge — `solveFraming` clamps the focus and
 * shrinks the scale to fit, so that is safe.
 */
export function growRectAroundCenter(
  rect: NormRect,
  center: { x: number; y: number }
): NormRect {
  const halfW = Math.max(center.x - rect.x, rect.x + rect.width - center.x, 0)
  const halfH = Math.max(center.y - rect.y, rect.y + rect.height - center.y, 0)
  return {
    x: center.x - halfW,
    y: center.y - halfH,
    width: halfW * 2,
    height: halfH * 2,
  }
}

/** Weighted-average merge of two rect centers, preserving the union extent. */
export function rectMergeWeighted(
  a: NormRect,
  aWeight: number,
  b: NormRect,
  bWeight: number
): NormRect {
  // The framed subject is the union (so both stay visible); the union already
  // covers both centers, so a separate weighted center is unnecessary.
  void aWeight
  void bWeight
  return rectUnion(a, b)
}
