import type {
  CanvasNode,
  NodeTransform,
  ViewTransform,
} from "@/types/editor-canvas"

/**
 * Pure geometry for canvas-node hit-testing and overlay projection. No PixiJS,
 * no DOM — just math, so it stays unit-testable and can be shared by the scene
 * and the selection controller.
 *
 * Node placement itself is settings-derived (`lib/video-placement.ts`); this
 * module only answers "where is this node on screen" and "is this point inside
 * it" for the hover/selection outlines and click-to-select.
 *
 * Coordinate spaces:
 *   - screen: CSS pixels relative to the canvas host.
 *   - world:  the PixiJS `world` container's space. The artboard sits at the
 *     world origin, so world coords == artboard coords. `screen = world*scale + {x,y}`.
 *   - node-local: centered on the node, axis-aligned (rotation undone).
 */

export type Vec2 = { x: number; y: number }

/** Selection border width, in screen pixels. */
export const SELECTION_BORDER_STROKE_WIDTH = 2

// ── primitive vector math ────────────────────────────────────────────────────

/** Rotate a vector by `angle` radians (y-down space; same matrix as y-up). */
function rotate(v: Vec2, angle: number): Vec2 {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos }
}

// ── space conversions ────────────────────────────────────────────────────────

export function worldFromScreen(s: Vec2, view: ViewTransform): Vec2 {
  return { x: (s.x - view.x) / view.scale, y: (s.y - view.y) / view.scale }
}

export function screenFromWorld(w: Vec2, view: ViewTransform): Vec2 {
  return { x: w.x * view.scale + view.x, y: w.y * view.scale + view.y }
}

export function getNodeCenter(node: NodeTransform): Vec2 {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 }
}

/** World point → node-local (center origin, rotation undone). */
export function toNodeLocal(p: Vec2, center: Vec2, rotation: number): Vec2 {
  return rotate({ x: p.x - center.x, y: p.y - center.y }, -rotation)
}

/** Node-local point → world. */
export function fromNodeLocal(l: Vec2, center: Vec2, rotation: number): Vec2 {
  const r = rotate(l, rotation)
  return { x: center.x + r.x, y: center.y + r.y }
}

// ── bounds and hit testing ───────────────────────────────────────────────────

export function getNodeWorldCorners(
  node: NodeTransform
): [Vec2, Vec2, Vec2, Vec2] {
  const center = getNodeCenter(node)
  const hw = node.width / 2
  const hh = node.height / 2
  return [
    fromNodeLocal({ x: -hw, y: -hh }, center, node.rotation),
    fromNodeLocal({ x: hw, y: -hh }, center, node.rotation),
    fromNodeLocal({ x: hw, y: hh }, center, node.rotation),
    fromNodeLocal({ x: -hw, y: hh }, center, node.rotation),
  ]
}

/** True when a world-space point lies inside the (possibly rotated) node box. */
export function nodeContainsPoint(node: NodeTransform, world: Vec2): boolean {
  const local = toNodeLocal(world, getNodeCenter(node), node.rotation)
  return (
    Math.abs(local.x) <= node.width / 2 && Math.abs(local.y) <= node.height / 2
  )
}

/** Find the topmost node (last in z-order) whose box contains the screen point. */
export function hitTestNodes(
  nodes: CanvasNode[],
  screen: Vec2,
  view: ViewTransform
): CanvasNode | null {
  const world = worldFromScreen(screen, view)
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodeContainsPoint(nodes[i], world)) return nodes[i]
  }
  return null
}
