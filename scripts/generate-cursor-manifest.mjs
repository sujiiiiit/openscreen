// Scans public/assets/cursors/sets/** and emits lib/cursors/cursor-manifest.ts —
// a typed index of every cursor SVG with its hotspot (parsed from the
// `<asset>-<variant>__<hotXpct>-<hotYpct>.svg` filename), intrinsic size, and
// optical scale. Optical scale is derived from rendered alpha bounds so cursor
// sets with larger SVG canvases do not jump in perceived size when selected.
//
// Re-run after adding/replacing cursor assets:
//   node scripts/generate-cursor-manifest.mjs
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { inflateSync } from "node:zlib"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const setsDir = join(root, "public/assets/cursors/sets")
const outFile = join(root, "lib/cursors/cursor-manifest.ts")
const opticalBaselineSet = "macos"
const opticalFallbackAsset = "pointer"
const alphaBoundsThreshold = 8

// `<asset>-<variant>__<hotXpct>-<hotYpct>.svg` (halloween doubles the .svg).
const FILENAME = /^([a-z]+)-(\d+)__([\d.]+)-([\d.]+)\.svg(?:\.svg)?$/

function readSvgSize(filePath) {
  const text = readFileSync(filePath, "utf8")
  const wh = text.match(/\bwidth="([\d.]+)"\s+height="([\d.]+)"/)
  if (wh) return [Number(wh[1]), Number(wh[2])]
  const vb = text.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/)
  if (vb) return [Number(vb[1]), Number(vb[2])]
  return [0, 0]
}

function canMeasureAlphaBounds() {
  try {
    execFileSync("sips", ["--help"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function paethPredictor(left, up, upLeft) {
  const p = left + up - upLeft
  const pa = Math.abs(p - left)
  const pb = Math.abs(p - up)
  const pc = Math.abs(p - upLeft)
  if (pa <= pb && pa <= pc) return left
  return pb <= pc ? up : upLeft
}

function readPngAlphaBounds(filePath, threshold) {
  const buf = readFileSync(filePath)
  let p = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idats = []

  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    p += 4
    const type = buf.toString("ascii", p, p + 4)
    p += 4
    const data = buf.subarray(p, p + len)
    p += len + 4 // data + crc
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === "IDAT") {
      idats.push(data)
    } else if (type === "IEND") {
      break
    }
  }

  // `sips` currently emits 8-bit RGBA for these SVG conversions. If that ever
  // changes, fall back to the full intrinsic box instead of writing bad bounds.
  if (bitDepth !== 8 || colorType !== 6 || width <= 0 || height <= 0) {
    return { x: 0, y: 0, width, height }
  }

  const raw = inflateSync(Buffer.concat(idats))
  const bpp = 4
  const stride = width * bpp
  let src = 0
  let prev = Buffer.alloc(stride)
  let cur = Buffer.alloc(stride)
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y += 1) {
    const filter = raw[src]
    src += 1
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src]
      src += 1
      const left = x >= bpp ? cur[x - bpp] : 0
      const up = prev[x]
      const upLeft = x >= bpp ? prev[x - bpp] : 0
      if (filter === 0) cur[x] = value
      else if (filter === 1) cur[x] = (value + left) & 255
      else if (filter === 2) cur[x] = (value + up) & 255
      else if (filter === 3)
        cur[x] = (value + Math.floor((left + up) / 2)) & 255
      else if (filter === 4)
        cur[x] = (value + paethPredictor(left, up, upLeft)) & 255
      else return { x: 0, y: 0, width, height }
    }

    for (let x = 0; x < width; x += 1) {
      if (cur[x * bpp + 3] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    ;[prev, cur] = [cur, prev]
  }

  if (maxX < 0) return { x: 0, y: 0, width, height }
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  }
}

function measureSvgVisualBounds(filePath, size, measureAlpha, tmpDir) {
  const [width, height] = size
  if (!measureAlpha || width <= 0 || height <= 0) {
    return { x: 0, y: 0, width, height }
  }

  const pngPath = join(
    tmpDir,
    filePath
      .slice(root.length + 1)
      .replaceAll("/", "__")
      .replace(/\.svg(?:\.svg)?$/, ".png")
  )
  try {
    execFileSync("sips", ["-s", "format", "png", filePath, "--out", pngPath], {
      stdio: "ignore",
    })
    return readPngAlphaBounds(pngPath, alphaBoundsThreshold)
  } catch {
    return { x: 0, y: 0, width, height }
  }
}

function visualRatio(entry) {
  const [, intrinsicHeight] = entry.size
  if (!Number.isFinite(intrinsicHeight) || intrinsicHeight <= 0) return 1
  const [, , visualWidth, visualHeight] = entry.visualBounds
  const visualMax = Math.max(visualWidth, visualHeight)
  if (!Number.isFinite(visualMax) || visualMax <= 0) return 1
  return visualMax / intrinsicHeight
}

function roundScale(value) {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Number(value.toFixed(6))
}

const manifest = {}
const measureAlpha = canMeasureAlphaBounds()
const tmpDir = mkdtempSync(join(tmpdir(), "openscreen-cursor-manifest-"))
try {
  for (const setId of readdirSync(setsDir)) {
    const setPath = join(setsDir, setId)
    if (!statSync(setPath).isDirectory()) continue

    const assets = {}
    for (const file of readdirSync(setPath)) {
      const m = file.match(FILENAME)
      if (!m) continue
      const [, asset, variantStr, hx, hy] = m
      const variant = Number(variantStr)
      const [w, h] = readSvgSize(join(setPath, file))
      // Lowest variant number wins as the default for an asset.
      if (assets[asset] && assets[asset].variant <= variant) continue
      const svgPath = join(setPath, file)
      const bounds = measureSvgVisualBounds(
        svgPath,
        [w, h],
        measureAlpha,
        tmpDir
      )
      assets[asset] = {
        url: `/assets/cursors/sets/${setId}/${file}`,
        // Hotspot as a 0..1 fraction of the SVG's intrinsic box.
        hotspot: [Number(hx) / 100, Number(hy) / 100],
        size: [w, h],
        visualBounds: [bounds.x, bounds.y, bounds.width, bounds.height],
        variant,
      }
    }
    manifest[setId] = assets
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}

const baseline = manifest[opticalBaselineSet] ?? {}
const baselineRatios = new Map(
  Object.entries(baseline).map(([asset, entry]) => [asset, visualRatio(entry)])
)
const fallbackRatio =
  baselineRatios.get(opticalFallbackAsset) ??
  visualRatio(
    baseline[opticalFallbackAsset] ?? {
      size: [1, 1],
      visualBounds: [0, 0, 1, 1],
    }
  )

for (const assets of Object.values(manifest)) {
  for (const [asset, entry] of Object.entries(assets)) {
    if (!measureAlpha) {
      entry.opticalScale = 1
      continue
    }
    const ownRatio = visualRatio(entry)
    const baselineRatio = baselineRatios.get(asset) ?? fallbackRatio
    entry.opticalScale = roundScale(baselineRatio / ownRatio)
  }
}

const banner = `// AUTO-GENERATED by scripts/generate-cursor-manifest.mjs — do not edit by hand.
// Cursor SVGs extracted from Screen Studio; hotspots parsed from filenames.
// opticalScale is derived from rendered alpha bounds against the macOS set.
`
const body = `export interface CursorAssetEntry {
  /** Public URL of the SVG, served from /public. */
  url: string;
  /** Hotspot (click point) as a [x, y] fraction of the SVG's box, 0..1. */
  hotspot: [number, number];
  /** Intrinsic [width, height] of the SVG in its own px. */
  size: [number, number];
  /** Rendered alpha bounds [x, y, width, height] inside the SVG box. */
  visualBounds: [number, number, number, number];
  /** Per-asset optical size multiplier relative to the macOS style. */
  opticalScale: number;
  /** Variant index from the filename (lowest is the default). */
  variant: number;
}

export type CursorSetId = keyof typeof cursorManifest;

export const cursorManifest = ${JSON.stringify(manifest, null, 2)} as const satisfies Record<
  string,
  Record<string, CursorAssetEntry>
>;
`
writeFileSync(outFile, banner + "\n" + body)

const sets = Object.keys(manifest).length
const total = Object.values(manifest).reduce(
  (n, a) => n + Object.keys(a).length,
  0
)
console.log(`Wrote ${outFile}: ${sets} sets, ${total} cursor assets indexed.`)
