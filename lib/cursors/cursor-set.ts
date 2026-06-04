// Maps a captured cursor id (the macOS NSCursor name our mac-addon records in
// the recording's input sidecars, e.g. "arrow", "iBeam", "windowResizeEast")
// to a themed SVG cursor asset + hotspot, using the generated manifest.
//
// The NsCursorName → asset-name lookup mirrors Screen Studio's
// assets/cursors/macos mapping (preserved verbatim in
// public/assets/cursors/macos/screen-studio-index.reference.txt). Our addon's
// `cursorId` values are exactly these NsCursorNames — see CursorTrack.mm.

import { cursorManifest, type CursorAssetEntry, type CursorSetId } from "./cursor-manifest";

// Captured cursor ids (NSCursor names) → themed asset names in the SVG sets.
const NS_NAME_TO_ASSET: Record<string, string> = {
  arrow: "pointer",
  iBeam: "ibeamstroke",
  crosshair: "cross",
  closedHand: "closedhand",
  openHand: "openhand",
  pointingHand: "pointinghand",
  resizeLeft: "resizeleft",
  resizeRight: "resizeright",
  resizeLeftRight: "resizeleftright",
  resizeUp: "resizeup",
  resizeDown: "resizedown",
  resizeUpDown: "resizeupdown",
  disappearingItem: "poof",
  iBeamCursorForVerticalLayout: "ibeamvertical",
  operationNotAllowed: "notallowed",
  dragLink: "makealias",
  dragCopy: "copy",
  contextualMenu: "contextualmenu",
  windowResizeNorthEast: "resizenortheast",
  windowResizeNorthWestSouthEast: "resizenorthwestsoutheast",
  zoomIn: "zoomin",
  windowResizeNorthWest: "resizenorthwest",
  windowResizeSouthEast: "resizesoutheast",
  windowResizeEastWest: "resizeeastwest",
  windowResizeNorth: "resizenorth",
  windowResizeEast: "resizeeast",
  windowResizeNorthSouth: "resizenorthsouth",
  windowResizeNorthEastSouthWest: "resizenortheastsouthwest",
  windowResizeWest: "resizewest",
  windowResizeSouth: "resizesouth",
  windowResizeSouthWest: "resizesouthwest",
  bottomRightResize: "resizesoutheast",
  bottomLeftResize: "resizesouthwest",
  topRightResize: "resizenortheast",
  topLeftResize: "resizenorthwest",
  help: "help",
  zoomOut: "zoomout",
  busyButClickable: "busybutclickable",
};

export const DEFAULT_CURSOR_SET: CursorSetId = "macos-tahoe";
export const CURSOR_FALLBACK_ASSET = "pointer";

export const cursorSetIds = Object.keys(cursorManifest) as CursorSetId[];

export function isCursorSetId(id: string): id is CursorSetId {
  return id in cursorManifest;
}

/** The themed asset name for a captured cursor id (falls back to the pointer). */
export function assetNameForCursorId(cursorId: string): string {
  return NS_NAME_TO_ASSET[cursorId] ?? CURSOR_FALLBACK_ASSET;
}

/**
 * Resolve a captured `cursorId` to a concrete SVG asset within `setId`.
 *
 * Resolution order: requested set → fallback set (default macOS Tahoe) for the
 * same asset → fallback set's pointer. Custom sets that only theme the
 * pointer/pointinghand therefore borrow every other shape from the base set,
 * exactly like Screen Studio.
 */
export function resolveCursorAsset(
  cursorId: string,
  setId: CursorSetId = DEFAULT_CURSOR_SET,
  fallbackSetId: CursorSetId = DEFAULT_CURSOR_SET,
): CursorAssetEntry | null {
  const asset = assetNameForCursorId(cursorId);
  const requested = cursorManifest[setId] as Record<string, CursorAssetEntry> | undefined;
  const fallback = cursorManifest[fallbackSetId] as Record<string, CursorAssetEntry> | undefined;
  return (
    requested?.[asset] ??
    fallback?.[asset] ??
    fallback?.[CURSOR_FALLBACK_ASSET] ??
    requested?.[CURSOR_FALLBACK_ASSET] ??
    null
  );
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Top-left position to draw the cursor SVG so its hotspot lands on `point`,
 * given the rendered [width, height] of the cursor box. `renderWidth/Height`
 * are in the same coordinate space as `point` (e.g. artboard pixels).
 */
export function cursorDrawOrigin(
  point: Point,
  entry: CursorAssetEntry,
  renderWidth: number,
  renderHeight: number,
): Point {
  return {
    x: point.x - entry.hotspot[0] * renderWidth,
    y: point.y - entry.hotspot[1] * renderHeight,
  };
}

/**
 * Rendered cursor box for a target height, preserving the SVG aspect ratio.
 * `targetHeight` is in the destination coordinate space (e.g. artboard px).
 */
export function cursorRenderSize(
  entry: CursorAssetEntry,
  targetHeight: number,
): { width: number; height: number } {
  const [w, h] = entry.size;
  const aspect = h > 0 ? w / h : 1;
  return { width: targetHeight * aspect, height: targetHeight };
}
