// Minimal rgba parser / formatter shared by the canvas renderer and the color
// picker UI. Accepts CSS strings the user is likely to land on — `#rgb`,
// `#rrggbb`, `#rrggbbaa`, named `transparent`, and `rgba(...)` / `rgb(...)`
// with comma or space separators — and emits a normalised
// `rgba(R, G, B, A)` string for storage.

export type Rgba = { r: number; g: number; b: number; a: number }

const HEX_3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i
const HEX_6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const HEX_8 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const RGB_FN = /^rgba?\(([^)]+)\)$/i

function clampByte(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(255, Math.round(value)))
}

function clampUnit(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function parseRgba(input: string): Rgba | null {
  const trimmed = input.trim()
  if (trimmed === "" || trimmed.toLowerCase() === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0 }
  }

  const m3 = trimmed.match(HEX_3)
  if (m3) {
    return {
      r: parseInt(m3[1] + m3[1], 16),
      g: parseInt(m3[2] + m3[2], 16),
      b: parseInt(m3[3] + m3[3], 16),
      a: 1,
    }
  }

  const m6 = trimmed.match(HEX_6)
  if (m6) {
    return {
      r: parseInt(m6[1], 16),
      g: parseInt(m6[2], 16),
      b: parseInt(m6[3], 16),
      a: 1,
    }
  }

  const m8 = trimmed.match(HEX_8)
  if (m8) {
    return {
      r: parseInt(m8[1], 16),
      g: parseInt(m8[2], 16),
      b: parseInt(m8[3], 16),
      a: clampUnit(parseInt(m8[4], 16) / 255),
    }
  }

  const fn = trimmed.match(RGB_FN)
  if (fn) {
    const parts = fn[1].split(/[,\s/]+/).filter(Boolean)
    if (parts.length === 3 || parts.length === 4) {
      const r = clampByte(parseFloat(parts[0]))
      const g = clampByte(parseFloat(parts[1]))
      const b = clampByte(parseFloat(parts[2]))
      const a =
        parts.length === 4
          ? parts[3].endsWith("%")
            ? clampUnit(parseFloat(parts[3]) / 100)
            : clampUnit(parseFloat(parts[3]))
          : 1
      return { r, g, b, a }
    }
  }

  return null
}

export function formatRgba(color: Rgba): string {
  const r = clampByte(color.r)
  const g = clampByte(color.g)
  const b = clampByte(color.b)
  // Three decimals is enough resolution for 0–100% alpha steps without
  // dragging trailing-zero noise into the stored string.
  const alpha = Math.round(clampUnit(color.a) * 1000) / 1000
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function rgbaToHex(color: Rgba): string {
  const toHex = (n: number) => clampByte(n).toString(16).padStart(2, "0")
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`
}

export function getRgbaAlpha(input: string): number {
  const parsed = parseRgba(input)
  return parsed ? parsed.a : 0
}
