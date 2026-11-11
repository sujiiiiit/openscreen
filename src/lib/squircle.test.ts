import { describe, expect, it } from "vitest"

import {
  clampSquircleRadius,
  computeSquircleCornerParams,
  tracePathOrRect,
  traceSquirclePath,
} from "./squircle"
import {
  computeBorderParams,
  computeSquircleParams,
} from "@/components/editor/canvas/video-scene-draw"

const EPS = 1e-9

/** Records every path command with its coordinates for geometric assertions. */
type PathCommand =
  | { op: "moveTo"; x: number; y: number }
  | { op: "lineTo"; x: number; y: number }
  | {
      op: "bezierCurveTo"
      cp1x: number
      cp1y: number
      cp2x: number
      cp2y: number
      x: number
      y: number
    }
  | { op: "rect"; x: number; y: number; w: number; h: number }

function recordTrace(
  width: number,
  height: number,
  radius: number,
  smoothing: number
): PathCommand[] {
  const commands: PathCommand[] = []
  const ctx = {
    moveTo: (x: number, y: number) => commands.push({ op: "moveTo", x, y }),
    lineTo: (x: number, y: number) => commands.push({ op: "lineTo", x, y }),
    bezierCurveTo: (
      cp1x: number,
      cp1y: number,
      cp2x: number,
      cp2y: number,
      x: number,
      y: number
    ) => commands.push({ op: "bezierCurveTo", cp1x, cp1y, cp2x, cp2y, x, y }),
    rect: (x: number, y: number, w: number, h: number) =>
      commands.push({ op: "rect", x, y, w, h }),
  }
  const safeRadius = clampSquircleRadius(width, height, radius)
  const params = computeSquircleCornerParams(
    safeRadius,
    smoothing,
    Math.min(width, height) / 2
  )
  traceSquirclePath(ctx, width, height, params)
  return commands
}

/** Cubic bézier point at t for the recorded command, given its start point. */
function bezierPoint(
  start: { x: number; y: number },
  cmd: Extract<PathCommand, { op: "bezierCurveTo" }>,
  t: number
) {
  const u = 1 - t
  const x =
    u * u * u * start.x +
    3 * u * u * t * cmd.cp1x +
    3 * u * t * t * cmd.cp2x +
    t * t * t * cmd.x
  const y =
    u * u * u * start.y +
    3 * u * u * t * cmd.cp1y +
    3 * u * t * t * cmd.cp2y +
    t * t * t * cmd.y
  return { x, y }
}

// ── Reference implementation (figma-squircle, preserveSmoothing branch) ──
// https://github.com/phamfoo/figma-squircle/blob/main/src/draw.ts
function referenceParams(
  cornerRadius: number,
  cornerSmoothing: number,
  budget: number
) {
  const toRadians = (deg: number) => (deg * Math.PI) / 180
  let p = (1 + cornerSmoothing) * cornerRadius
  const arcMeasure = 90 * (1 - cornerSmoothing)
  const arcSectionLength =
    Math.sin(toRadians(arcMeasure / 2)) * cornerRadius * Math.sqrt(2)
  const angleAlpha = (90 - arcMeasure) / 2
  const p3ToP4Distance = cornerRadius * Math.tan(toRadians(angleAlpha / 2))
  const angleBeta = 45 * cornerSmoothing
  const c = p3ToP4Distance * Math.cos(toRadians(angleBeta))
  const d = c * Math.tan(toRadians(angleBeta))
  let b = (p - arcSectionLength - c - d) / 3
  let a = 2 * b
  if (p > budget) {
    const p1ToP3MaxDistance = budget - d - arcSectionLength - c
    const minA = p1ToP3MaxDistance / 6
    const maxB = p1ToP3MaxDistance - minA
    b = Math.min(b, maxB)
    a = p1ToP3MaxDistance - b
    p = Math.min(p, budget)
  }
  return { a, b, c, d, p }
}

describe("computeSquircleCornerParams", () => {
  it("matches the figma-squircle reference across radius/smoothing grid", () => {
    const budget = 100
    for (const radius of [1, 10, 40, 80, 100]) {
      for (const smoothing of [0, 0.25, 0.6, 0.8, 1]) {
        const got = computeSquircleCornerParams(radius, smoothing, budget)
        const want = referenceParams(radius, smoothing, budget)
        expect(got.p, `p r=${radius} s=${smoothing}`).toBeCloseTo(want.p, 9)
        expect(got.a, `a r=${radius} s=${smoothing}`).toBeCloseTo(want.a, 9)
        expect(got.b, `b r=${radius} s=${smoothing}`).toBeCloseTo(want.b, 9)
        expect(got.c, `c r=${radius} s=${smoothing}`).toBeCloseTo(want.c, 9)
        expect(got.d, `d r=${radius} s=${smoothing}`).toBeCloseTo(want.d, 9)
      }
    }
  })

  it("never lets the smoothing extension overrun the per-corner budget", () => {
    for (const budget of [10, 50, 160, 450]) {
      for (const radius of [budget * 0.3, budget * 0.7, budget]) {
        for (const smoothing of [0, 0.3, 0.6, 0.9, 1]) {
          const params = computeSquircleCornerParams(radius, smoothing, budget)
          expect(
            params.p,
            `p ≤ budget for r=${radius} s=${smoothing} budget=${budget}`
          ).toBeLessThanOrEqual(budget + EPS)
          // The straight-edge + perpendicular handles must fit the budget too,
          // or the traced outline self-intersects.
          expect(params.a).toBeGreaterThanOrEqual(-EPS)
          expect(params.b).toBeGreaterThanOrEqual(-EPS)
          expect(params.c).toBeGreaterThanOrEqual(-EPS)
          expect(params.d).toBeGreaterThanOrEqual(-EPS)
        }
      }
    }
  })

  it("keeps the exact figma geometry when the budget is not exceeded", () => {
    // p = (1 + s)·r fits → identical to the pre-clamp output (no regression
    // for every small/moderate radius the editor renders today).
    const params = computeSquircleCornerParams(40, 0.6, 100)
    expect(params.p).toBeCloseTo(64, 12)
    expect(params.radius).toBe(40)
  })

  it("degenerates to a plain quarter-arc fillet at smoothing 0", () => {
    const params = computeSquircleCornerParams(32, 0, 100)
    expect(params.p).toBeCloseTo(32, 12)
    expect(params.a).toBeCloseTo(0, 12)
    expect(params.b).toBeCloseTo(0, 12)
    expect(params.c).toBeCloseTo(0, 12)
    expect(params.d).toBeCloseTo(0, 12)
    expect(params.arcSweep).toBeCloseTo(Math.PI / 2, 12)
  })

  it("clamps radius to the budget defensively", () => {
    const params = computeSquircleCornerParams(500, 0.6, 100)
    expect(params.radius).toBe(100)
    expect(params.p).toBeLessThanOrEqual(100 + EPS)
  })
})

describe("traceSquirclePath", () => {
  it("never traces a backwards edge (regression: circle preset r=min/2 s=1)", () => {
    // Before the budget clamp this produced p = 200 on a 200×200 box: the top
    // edge ran from x=200 back to x=0 and the outline self-intersected.
    const commands = recordTrace(200, 200, 100, 1)
    const move = commands[0]
    const line = commands[1]
    if (move.op !== "moveTo" || line.op !== "lineTo") {
      throw new Error("unexpected command order")
    }
    expect(line.x).toBeGreaterThanOrEqual(move.x - EPS)
  })

  it("keeps every point and control point inside the box for stressed combos", () => {
    const cases: Array<[number, number, number, number]> = [
      [200, 200, 100, 1], // circle preset
      [1600, 900, 450, 0.6], // 16:9 at max radius, macOS smoothing
      [320, 320, 120, 0.6], // camera bubble
      [1600, 900, 350, 1],
      [500, 120, 60, 0.8], // extreme aspect
    ]
    for (const [w, h, r, s] of cases) {
      const commands = recordTrace(w, h, r, s)
      for (const cmd of commands) {
        const points =
          cmd.op === "bezierCurveTo"
            ? [
                [cmd.cp1x, cmd.cp1y],
                [cmd.cp2x, cmd.cp2y],
                [cmd.x, cmd.y],
              ]
            : cmd.op === "rect"
              ? []
              : [[cmd.x, cmd.y]]
        for (const [x, y] of points) {
          expect(x, `x in [0,${w}] for ${w}×${h} r=${r} s=${s}`).toBeGreaterThanOrEqual(-1e-6)
          expect(x).toBeLessThanOrEqual(w + 1e-6)
          expect(y, `y in [0,${h}] for ${w}×${h} r=${r} s=${s}`).toBeGreaterThanOrEqual(-1e-6)
          expect(y).toBeLessThanOrEqual(h + 1e-6)
        }
      }
    }
  })

  it("emits the corner arc as cubic béziers that stay on the circle", () => {
    // smoothing 0 → the whole corner is the 90° arc → two ≤45° cubics whose
    // sampled points must sit on the corner circle (radius 50 at (150, 50)).
    const commands = recordTrace(200, 200, 50, 0)
    expect(commands.some((c) => c.op === "rect")).toBe(false)

    // Top-right corner: moveTo, lineTo, ramp bezier (degenerate at s=0), then
    // the two arc cubics. Walk the commands tracking the running point.
    let current = { x: 0, y: 0 }
    const arcSamples: Array<{ x: number; y: number }> = []
    let beziersSeen = 0
    for (const cmd of commands) {
      if (cmd.op === "moveTo" || cmd.op === "lineTo") {
        current = { x: cmd.x, y: cmd.y }
        continue
      }
      if (cmd.op === "bezierCurveTo") {
        beziersSeen += 1
        // Commands 2 and 3 of each corner are the arc cubics (the ramp cubics
        // are degenerate at smoothing 0). Sample the first corner's pair.
        if (beziersSeen === 2 || beziersSeen === 3) {
          for (let i = 0; i <= 8; i++) {
            arcSamples.push(bezierPoint(current, cmd, i / 8))
          }
        }
        current = { x: cmd.x, y: cmd.y }
      }
    }
    expect(arcSamples.length).toBeGreaterThan(0)
    for (const pt of arcSamples) {
      const dist = Math.hypot(pt.x - 150, pt.y - 50)
      // Standard 45° cubic arc approximation error is ~0.0002 % of radius.
      expect(dist).toBeGreaterThan(50 - 0.001)
      expect(dist).toBeLessThan(50 + 0.001)
    }
  })

  it("collapses to rect() for radius 0 via tracePathOrRect", () => {
    const commands: PathCommand[] = []
    tracePathOrRect(
      {
        moveTo: () => {
          throw new Error("unexpected moveTo")
        },
        lineTo: () => {
          throw new Error("unexpected lineTo")
        },
        bezierCurveTo: () => {
          throw new Error("unexpected bezierCurveTo")
        },
        rect: (x: number, y: number, w: number, h: number) =>
          commands.push({ op: "rect", x, y, w, h }),
      },
      640,
      360,
      null
    )
    expect(commands).toEqual([{ op: "rect", x: 0, y: 0, w: 640, h: 360 }])
  })
})

describe("video-scene-draw budget wiring", () => {
  const baseStyle = {
    width: 200,
    height: 200,
    cornerRadius: 100,
    cornerSmoothing: 1,
    borderWidth: 0,
    borderColor: "#ffffff",
    borderOffset: 0,
    borderAlignment: "inside" as const,
  }

  it("computeSquircleParams caps p at the node's own budget", () => {
    const params = computeSquircleParams(baseStyle)
    expect(params).not.toBeNull()
    expect(params!.p).toBeLessThanOrEqual(100 + EPS)
  })

  it("computeBorderParams caps p at the border box's budget", () => {
    const border = computeBorderParams({
      ...baseStyle,
      borderWidth: 8,
      borderAlignment: "outside",
      borderOffset: 10,
    })
    expect(border).not.toBeNull()
    const budget = Math.min(border!.width, border!.height) / 2
    expect(border!.params).not.toBeNull()
    expect(border!.params!.p).toBeLessThanOrEqual(budget + EPS)
  })
})
