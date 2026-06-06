import type { CanvasSize, CanvasVideoItem, EditorArtboard } from "@/types/editor-canvas"

/**
 * Derived video placement — the single source of layout truth for canvas
 * videos. Placement (`x/y/width/height`) is a pure function of the video's
 * intrinsic size and the artboard's size + padding; it is never edited by
 * gestures. The provider recomputes it at every mutation site (import,
 * hydration, re-attach, preset change, padding change) and persists the
 * result so the export pipeline and old `project.json` readers keep working
 * unchanged.
 */

/** Minimal artboard shape placement depends on — keeps this module pure. */
export type PlacementArtboard = Pick<EditorArtboard, "width" | "height" | "padding">

export const ARTBOARD_PADDING_MAX = 500

// Padding is stored in artboard pixels for direct, one-to-one control. We
// still clamp against the artboard's shorter edge so the inner rect can never
// collapse to zero — leaving a 2px floor keeps `computeVideoPlacement`'s
// `Math.max(1, ...)` from masking a too-aggressive value.
export function getPaddingInsetPx(artboard: PlacementArtboard) {
  const raw = Math.max(0, Math.min(ARTBOARD_PADDING_MAX, artboard.padding ?? 0))
  if (raw <= 0) return 0
  const maxInset = Math.max(
    0,
    Math.floor(Math.min(artboard.width, artboard.height) / 2) - 1
  )
  return Math.min(raw, maxInset)
}

export type VideoPlacement = {
  x: number
  y: number
  width: number
  height: number
}

function getCoverPlacement(
  intrinsic: CanvasSize,
  artboard: PlacementArtboard
): VideoPlacement {
  const coverScale = Math.max(
    artboard.width / intrinsic.width,
    artboard.height / intrinsic.height
  )
  const width = intrinsic.width * coverScale
  const height = intrinsic.height * coverScale

  return {
    x: (artboard.width - width) / 2,
    y: (artboard.height - height) / 2,
    width,
    height,
  }
}

/**
 * The one placement rule for every canvas video, regardless of role:
 * - padding 0 → cover-fit: the video fills the artboard edge-to-edge with
 *   whatever crop is needed, centered.
 * - padding > 0 → contain-fit inside the padded inner rect so the *entire*
 *   video is visible with breathing room on all four sides. Aspect ratio is
 *   always preserved by using the smaller of the two scales.
 */
export function computeVideoPlacement(
  intrinsic: CanvasSize,
  artboard: PlacementArtboard
): VideoPlacement {
  // Defensive: intrinsics are validated upstream (metadata probe / schema),
  // but a zero/negative size must not produce NaN placement.
  if (intrinsic.width <= 0 || intrinsic.height <= 0) {
    return { x: 0, y: 0, width: artboard.width, height: artboard.height }
  }

  const inset = getPaddingInsetPx(artboard)
  if (inset <= 0) return getCoverPlacement(intrinsic, artboard)

  const innerWidth = Math.max(1, artboard.width - inset * 2)
  const innerHeight = Math.max(1, artboard.height - inset * 2)
  const containScale = Math.min(
    innerWidth / intrinsic.width,
    innerHeight / intrinsic.height
  )
  const width = intrinsic.width * containScale
  const height = intrinsic.height * containScale
  return {
    x: (artboard.width - width) / 2,
    y: (artboard.height - height) / 2,
    width,
    height,
  }
}

/**
 * Recompute the derived placement for every video (all roles — screen,
 * camera, media; `locked` is ignored) and force `rotation` to 0.
 *
 * Identity-preserving: items whose values already match are returned as-is,
 * and when nothing changed the *same array reference* comes back. Callers can
 * therefore feed the result straight into React state setters / the autosave
 * fingerprint without triggering redundant renders or writes.
 */
export function applyAutoLayout(
  videos: CanvasVideoItem[],
  artboard: PlacementArtboard
): CanvasVideoItem[] {
  let changed = false
  const next = videos.map((video) => {
    const placement = computeVideoPlacement(
      { width: video.intrinsicWidth, height: video.intrinsicHeight },
      artboard
    )
    if (
      video.x === placement.x &&
      video.y === placement.y &&
      video.width === placement.width &&
      video.height === placement.height &&
      video.rotation === 0
    ) {
      return video
    }
    changed = true
    return { ...video, ...placement, rotation: 0 }
  })
  return changed ? next : videos
}
