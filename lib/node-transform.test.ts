import { describe, expect, test } from "vitest"

import type { CanvasNode, ViewTransform } from "@/types/editor-canvas"

import {
  fromNodeLocal,
  getNodeCenter,
  getNodeWorldCorners,
  hitTestNodes,
  nodeContainsPoint,
  screenFromWorld,
  toNodeLocal,
  worldFromScreen,
} from "./node-transform"

const view: ViewTransform = { scale: 1, x: 0, y: 0 }

function node(id: string, partial: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    type: "shape",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    ...partial,
  }
}

function closeTo(actual: number, expected: number) {
  expect(actual).toBeCloseTo(expected, 5)
}

describe("space conversions", () => {
  test("worldFromScreen and screenFromWorld round-trip", () => {
    const zoomed: ViewTransform = { scale: 2.5, x: 120, y: -40 }
    const screen = { x: 333, y: 77 }
    const world = worldFromScreen(screen, zoomed)
    const back = screenFromWorld(world, zoomed)

    closeTo(back.x, screen.x)
    closeTo(back.y, screen.y)
  })

  test("screenFromWorld applies scale then offset", () => {
    const zoomed: ViewTransform = { scale: 2, x: 10, y: 20 }
    const screen = screenFromWorld({ x: 5, y: 7 }, zoomed)

    closeTo(screen.x, 20)
    closeTo(screen.y, 34)
  })

  test("node-local round-trip undoes rotation", () => {
    const center = { x: 50, y: 25 }
    const rotation = Math.PI / 3
    const world = { x: 80, y: 60 }
    const local = toNodeLocal(world, center, rotation)
    const back = fromNodeLocal(local, center, rotation)

    closeTo(back.x, world.x)
    closeTo(back.y, world.y)
  })
})

describe("node bounds", () => {
  test("getNodeCenter is the box midpoint", () => {
    const center = getNodeCenter(node("a", { x: 10, y: 20 }))

    closeTo(center.x, 60)
    closeTo(center.y, 45)
  })

  test("axis-aligned corners are tl, tr, br, bl", () => {
    const [tl, tr, br, bl] = getNodeWorldCorners(node("a", { x: 10, y: 20 }))

    expect(tl).toEqual({ x: 10, y: 20 })
    expect(tr).toEqual({ x: 110, y: 20 })
    expect(br).toEqual({ x: 110, y: 70 })
    expect(bl).toEqual({ x: 10, y: 70 })
  })

  test("rotated corners pivot around the box center", () => {
    const [tl, tr, br, bl] = getNodeWorldCorners(
      node("a", { rotation: Math.PI / 2 })
    )

    // 100×50 box centered at (50, 25), rotated 90°: width and height swap.
    closeTo(tl.x, 75)
    closeTo(tl.y, -25)
    closeTo(tr.x, 75)
    closeTo(tr.y, 75)
    closeTo(br.x, 25)
    closeTo(br.y, 75)
    closeTo(bl.x, 25)
    closeTo(bl.y, -25)
  })

  test("nodeContainsPoint respects rotation", () => {
    const rotated = node("a", { rotation: Math.PI / 2 })

    // (90, 25) is inside the unrotated box but outside the rotated one.
    expect(nodeContainsPoint(node("a"), { x: 90, y: 25 })).toBe(true)
    expect(nodeContainsPoint(rotated, { x: 90, y: 25 })).toBe(false)
    // (50, 70) is below the unrotated box but inside the rotated one.
    expect(nodeContainsPoint(node("a"), { x: 50, y: 70 })).toBe(false)
    expect(nodeContainsPoint(rotated, { x: 50, y: 70 })).toBe(true)
  })
})

describe("hitTestNodes", () => {
  test("misses return null", () => {
    expect(hitTestNodes([node("a")], { x: 500, y: 500 }, view)).toBeNull()
  })

  test("topmost node wins where nodes overlap", () => {
    const bottom = node("bottom")
    const top = node("top", { x: 50, y: 0 })

    // Overlap region: x ∈ [50, 100]. Later in the array = higher z.
    expect(hitTestNodes([bottom, top], { x: 75, y: 25 }, view)?.id).toBe("top")
    // Only the bottom node covers x < 50.
    expect(hitTestNodes([bottom, top], { x: 25, y: 25 }, view)?.id).toBe(
      "bottom"
    )
  })

  test("applies the view transform to the screen point", () => {
    const zoomed: ViewTransform = { scale: 2, x: 100, y: 50 }

    // World (50, 25) → screen (200, 100) under the zoomed view.
    expect(hitTestNodes([node("a")], { x: 200, y: 100 }, zoomed)?.id).toBe("a")
    // Screen (50, 25) maps back to world (-25, -12.5) — outside the node.
    expect(hitTestNodes([node("a")], { x: 50, y: 25 }, zoomed)).toBeNull()
  })
})
