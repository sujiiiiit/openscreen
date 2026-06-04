/**
 * Draws a high-contrast procedural test pattern into a fresh canvas. Crisp
 * edges in every orientation (checkerboard, diagonals, rings, text, colour
 * bars) make a *directional* blur immediately obvious — far better than a photo.
 * The pattern is fully opaque, so the only transparency in play is the margin
 * the blur feathers into.
 */
export function drawMotionBlurTestPattern(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("2D context unavailable")

  // Opaque dark background.
  ctx.fillStyle = "#0b1020"
  ctx.fillRect(0, 0, width, height)

  // Checkerboard (top-left quadrant) — orthogonal crisp edges.
  const cell = 24
  for (let y = 0; y < height / 2; y += cell) {
    for (let x = 0; x < width / 2; x += cell) {
      const on = ((x / cell) ^ (y / cell)) & 1
      ctx.fillStyle = on ? "#e7ecff" : "#1b2547"
      ctx.fillRect(x, y, cell, cell)
    }
  }

  // Diagonal stripes (top-right quadrant) — 45° edges.
  ctx.save()
  ctx.beginPath()
  ctx.rect(width / 2, 0, width / 2, height / 2)
  ctx.clip()
  ctx.lineWidth = 8
  ctx.strokeStyle = "#ff5d73"
  for (let i = -height; i < width; i += 22) {
    ctx.beginPath()
    ctx.moveTo(width / 2 + i, 0)
    ctx.lineTo(width / 2 + i + height / 2, height / 2)
    ctx.stroke()
  }
  ctx.restore()

  // Concentric rings (bottom-left quadrant) — curved edges in all directions.
  const cx = width / 4
  const cy = (height * 3) / 4
  ctx.lineWidth = 6
  for (let r = 10; r < height / 2; r += 18) {
    ctx.beginPath()
    ctx.strokeStyle = (r / 18) & 1 ? "#4ade80" : "#fde047"
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
  }

  // Colour bars (bottom-right quadrant) — vertical hard edges.
  const colors = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#6366f1"]
  const barW = width / 2 / colors.length
  colors.forEach((c, i) => {
    ctx.fillStyle = c
    ctx.fillRect(width / 2 + i * barW, height / 2, barW, height / 2)
  })

  // Centered label — fine high-contrast detail.
  ctx.fillStyle = "#ffffff"
  ctx.strokeStyle = "#000000"
  ctx.lineWidth = 4
  ctx.font = "bold 40px sans-serif"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.strokeText("MOTION", width / 2, height / 2 - 4)
  ctx.fillText("MOTION", width / 2, height / 2 - 4)

  return canvas
}
