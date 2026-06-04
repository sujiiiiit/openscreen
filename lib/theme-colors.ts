/**
 * Colors the PixiJS scene draws with. PixiJS does not read CSS variables, and
 * this project's theme tokens are authored in `oklch(...)` — a format PixiJS's
 * color parser does not accept. So we resolve each `var(--token)` through a
 * detached probe element (to apply the cascade, including the `.dark` class)
 * and then rasterize it to a single sRGB pixel via a 2D canvas — yielding a
 * plain `rgba(...)` string PixiJS understands.
 *
 * The artboard surface and its shadow are not theme-derived (the surface is
 * black; the shadow is a fixed CSS box-shadow). We resolve the pixel grid color;
 * transformer chrome uses fixed OpenScreen accent colors so CSS theme changes
 * cannot accidentally make it white.
 */
type PixiColor = string | number

export type CanvasPalette = {
  /** Base color for grid lines (alpha is applied per-line at draw time). */
  grid: string
  /** Hover outline color for unselected nodes. */
  hover: PixiColor
  /** Selection border + handle outline color. */
  selection: PixiColor
  /** Resize/rotation handle fill color. */
  handleFill: PixiColor
  /** Resize/rotation handle outline color. */
  handleStroke: PixiColor
  /** Rotation glyph color. */
  handleIcon: PixiColor
}

const TRANSFORMER_ACCENT = 0x8b5cf6
const TRANSFORMER_ICON_STROKE = 0xffffff

/** Fixed transformer chrome colors, shared across every palette variant. */
const TRANSFORMER_COLORS = {
  hover: TRANSFORMER_ACCENT,
  selection: TRANSFORMER_ACCENT,
  handleFill: TRANSFORMER_ACCENT,
  handleStroke: TRANSFORMER_ACCENT,
  handleIcon: TRANSFORMER_ICON_STROKE,
} as const

const FALLBACK_LIGHT: CanvasPalette = { grid: "#78716c", ...TRANSFORMER_COLORS }
const FALLBACK_DARK: CanvasPalette = { grid: "#a8a29e", ...TRANSFORMER_COLORS }

export function resolveCanvasPalette(isDark: boolean): CanvasPalette {
  if (typeof document === "undefined")
    return isDark ? FALLBACK_DARK : FALLBACK_LIGHT

  const fallback = isDark ? FALLBACK_DARK : FALLBACK_LIGHT

  const probe = document.createElement("span")
  probe.style.cssText =
    "position:absolute;left:-9999px;top:-9999px;width:0;height:0;pointer-events:none"
  document.body.appendChild(probe)

  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })

  const resolve = (cssExpr: string, fallbackColor: string) => {
    if (!ctx) return fallbackColor
    probe.style.color = ""
    probe.style.color = cssExpr
    const computed = getComputedStyle(probe).color
    if (!computed) return fallbackColor
    // The computed value may be in a space PixiJS can't parse (oklch/lab/color()
    // in modern browsers), and the `fillStyle` getter now preserves that space.
    // Rasterizing to a single pixel and reading it back always yields sRGB
    // bytes. Seed with the fallback so an invalid `computed` degrades gracefully.
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = fallbackColor
    ctx.fillStyle = computed
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
  }

  const palette: CanvasPalette = {
    grid: resolve("var(--muted-foreground)", fallback.grid),
    ...TRANSFORMER_COLORS,
  }

  document.body.removeChild(probe)
  return palette
}
