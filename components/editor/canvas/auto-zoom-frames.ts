// Offline frame-analysis for auto-zoom content bounds.
//
// Around each click (where a menu/popover/flyout may open) we grab a frame just
// BEFORE and just AFTER the click and diff them; the bounding box of what
// appeared is the engaged content's extent (see `lib/auto-zoom/content-bounds`).
// The result lets the predictive follow planner zoom OUT to reveal a menu that
// opens past the zoomed frame, then return — the Screen-Studio submenu beat.
//
// Decode strategy: a bounded number of seeks on a hidden <video>. The export
// path uses a streaming Mediabunny decoder for throughput, but this is a
// one-shot, offline, ~N-interactions × 2-frames pass where reliability with the
// editor's object URLs matters more than decode-once speed — and a <video> seek
// works with any source the editor can already play. Best-effort throughout: any
// failure simply omits that interaction's rect, and the planner falls back to
// pure cursor geometry. Returns FRAME-normalized rects; the caller maps them to
// artboard space with the cover-crop chain the cursor overlay uses.

import {
  detectChangedRect,
  type FrameLuma,
} from "@/lib/auto-zoom/content-bounds/frame-diff"
import type { NormRect } from "@/lib/auto-zoom/types"

export type ClickFrameQuery = {
  /** Caller's key for this interaction (we use the click `processTimeMs`). */
  key: number
  /** The click time in the video's own (source) seconds. */
  sourceSec: number
}

export type DetectClickRectsOptions = {
  /** The screen recording's playable URL (object URL or file URL). */
  url: string
  intrinsicWidth: number
  intrinsicHeight: number
  durationSec: number
  clicks: readonly ClickFrameQuery[]
  /** Cap the offline work (defaults to 60 interactions). */
  maxInteractions?: number
  /** Frame offsets around the click (defaults pre 120 ms / post 220 ms). */
  preMs?: number
  postMs?: number
  /** Longest side of the downscaled working frame (defaults to 256 px). */
  workSize?: number
  signal?: AbortSignal
}

type Canvas2D = OffscreenCanvas | HTMLCanvasElement
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/**
 * Frame-normalized content rects keyed by interaction key. Best-effort: keys
 * with no detected change (or a decode failure) are simply absent. Returns an
 * empty map outside a DOM environment.
 */
export async function detectClickRects(
  opts: DetectClickRectsOptions
): Promise<Map<number, NormRect>> {
  const result = new Map<number, NormRect>()
  if (typeof document === "undefined") return result

  const clicks = opts.clicks
    .filter((c) => Number.isFinite(c.sourceSec) && c.sourceSec >= 0)
    .slice(0, opts.maxInteractions ?? 60)
  if (clicks.length === 0) return result

  const preMs = opts.preMs ?? 120
  const postMs = opts.postMs ?? 220
  const longest = opts.workSize ?? 256
  const aspect =
    opts.intrinsicWidth > 0 && opts.intrinsicHeight > 0
      ? opts.intrinsicWidth / opts.intrinsicHeight
      : 16 / 9
  const workW = aspect >= 1 ? longest : Math.max(1, Math.round(longest * aspect))
  const workH = aspect >= 1 ? Math.max(1, Math.round(longest / aspect)) : longest

  const video = document.createElement("video")
  video.muted = true
  video.preload = "auto"
  video.src = opts.url

  const canvas = makeCanvas(workW, workH)
  const ctx = canvas.getContext("2d", {
    willReadFrequently: true,
  }) as Ctx2D | null
  if (!ctx) return result

  try {
    await waitVideoReady(video)
    for (const c of clicks) {
      if (opts.signal?.aborted) break
      const tBefore = Math.max(0, c.sourceSec - preMs / 1000)
      const tAfter = Math.min(
        Math.max(0, opts.durationSec - 1e-3),
        c.sourceSec + postMs / 1000
      )
      if (!(tAfter > tBefore)) continue
      const before = await grabLuma(video, ctx, tBefore, workW, workH)
      if (!before || opts.signal?.aborted) continue
      const after = await grabLuma(video, ctx, tAfter, workW, workH)
      if (!after) continue
      const rect = detectChangedRect(before, after)
      if (rect) result.set(c.key, rect)
    }
  } catch {
    // Best-effort: whatever we collected before the failure still stands.
  } finally {
    video.removeAttribute("src")
    video.load()
  }
  return result
}

function makeCanvas(w: number, h: number): Canvas2D {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h)
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  return c
}

function waitVideoReady(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2 /* HAVE_CURRENT_DATA */) {
      resolve()
      return
    }
    const cleanup = () => {
      video.removeEventListener("loadeddata", onReady)
      video.removeEventListener("error", onError)
    }
    const onReady = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error("auto-zoom frame video failed to load"))
    }
    video.addEventListener("loadeddata", onReady)
    video.addEventListener("error", onError)
  })
}

/** Seek to `t`, draw the frame downscaled, and read it back as a luma buffer. */
async function grabLuma(
  video: HTMLVideoElement,
  ctx: Ctx2D,
  t: number,
  w: number,
  h: number
): Promise<FrameLuma | null> {
  const ok = await seek(video, t)
  if (!ok) return null
  try {
    ctx.drawImage(video as CanvasImageSource, 0, 0, w, h)
    const img = ctx.getImageData(0, 0, w, h)
    const src = img.data
    const luma = new Uint8ClampedArray(w * h)
    for (let p = 0, i = 0; p < luma.length; p++, i += 4) {
      // Rec. 601 luma; integer-floored.
      luma[p] = (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) | 0
    }
    return { data: luma, width: w, height: h }
  } catch {
    return null
  }
}

function seek(video: HTMLVideoElement, t: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(ok)
    }
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked)
      video.removeEventListener("error", onError)
      clearTimeout(timer)
    }
    const onSeeked = () => settle(true)
    const onError = () => settle(false)
    // A seek that never fires (e.g. a bad timestamp) must not hang generation.
    const timer = setTimeout(() => settle(false), 1500)
    video.addEventListener("seeked", onSeeked)
    video.addEventListener("error", onError)
    try {
      video.currentTime = t
    } catch {
      settle(false)
    }
  })
}
