import type {
  CanvasNode,
  NodeContentTransform,
  NodeTransform,
  NodeTransformUpdate,
  ViewTransform,
} from "@/types/editor-canvas"

/**
 * Pure geometry for editor selection and transforms. No PixiJS, no DOM — just
 * math, so it stays unit-testable and can be shared by the scene, controller,
 * floating toolbar, and inspector.
 *
 * Coordinate spaces:
 *   - screen: CSS pixels relative to the canvas host.
 *   - world:  the PixiJS `world` container's space. The artboard sits at the
 *     world origin, so world coords == artboard coords. `screen = world*scale + {x,y}`.
 *   - node-local: centered on the node, axis-aligned (rotation undone).
 */

export type Vec2 = { x: number; y: number }

export type Rect = {
  x: number
  y: number
  width: number
  height: number
}

/** A resize handle. `hx`/`hy` ∈ {-1,0,1} (not both 0) point from center to the handle. */
export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"
export type ResizeHandle = { id: HandleId; hx: -1 | 0 | 1; hy: -1 | 0 | 1 }
export type FlipAxis = "horizontal" | "vertical"
export type LayerOrderCommand =
  | "bring-forward"
  | "send-backward"
  | "bring-to-front"
  | "send-to-back"

export type DuplicateNodesResult = {
  nodes: CanvasNode[]
  selectedIds: string[]
}

/** The 8 resize handles, in artboard-axis convention (x right, y down). */
export const HANDLE_DESCRIPTORS: ResizeHandle[] = [
  { id: "nw", hx: -1, hy: -1 },
  { id: "n", hx: 0, hy: -1 },
  { id: "ne", hx: 1, hy: -1 },
  { id: "e", hx: 1, hy: 0 },
  { id: "se", hx: 1, hy: 1 },
  { id: "s", hx: 0, hy: 1 },
  { id: "sw", hx: -1, hy: 1 },
  { id: "w", hx: -1, hy: 0 },
]

/** Smallest a node may be resized to, in artboard pixels. */
export const MIN_NODE_SIZE = 32
/** Rotation snaps to this increment while Shift is held. */
export const ROTATION_SNAP_RAD = Math.PI / 4 // 45°
/** Corner anchor diameter, in screen pixels (constant at all zooms). */
export const CORNER_HANDLE_SIZE = 16
/** Side anchor long edge, in screen pixels. */
export const SIDE_HANDLE_LENGTH = 26
/** Side anchor short edge, in screen pixels. */
export const SIDE_HANDLE_THICKNESS = 9
/** Rotation knob diameter, in screen pixels. */
export const ROTATION_HANDLE_SIZE = 32
/** Selection border width, in screen pixels. */
export const SELECTION_BORDER_STROKE_WIDTH = 2
/** Anchor stroke width, in screen pixels. */
export const HANDLE_STROKE_WIDTH = 1.5
/** Pointer must land within this many screen px of a handle center to grab it. */
export const HANDLE_HIT_RADIUS = 14
/** Pointer grab radius for the rotation knob, in screen px. */
export const ROTATION_HIT_RADIUS = 18
/** Distance from the bottom edge to the rotation knob, in screen px. */
export const ROTATION_HANDLE_OFFSET = 56
/** OpenScreen-style offset for duplicated nodes, in artboard px. */
export const DUPLICATED_NODE_OFFSET = 48
/** Small drag before a marquee is considered intentional, in screen px. */
export const MARQUEE_DRAG_THRESHOLD = 3

// ── primitive vector math ────────────────────────────────────────────────────

/** Rotate a vector by `angle` radians (y-down space; same matrix as y-up). */
function rotate(v: Vec2, angle: number): Vec2 {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos }
}

function boolXor(a: boolean | undefined, b: boolean): boolean {
  return !!a !== b
}

function toUpdate(
  node: CanvasNode,
  transform: NodeTransform
): NodeTransformUpdate {
  return { id: node.id, transform }
}

function signedScale(value: number): number {
  return value < 0 ? -1 : 1
}

function minAspectScale(nodes: NodeTransform[]): number {
  return nodes.reduce(
    (scale, node) =>
      Math.max(scale, MIN_NODE_SIZE / node.width, MIN_NODE_SIZE / node.height),
    0
  )
}

function hasCropContent(node: CanvasNode): boolean {
  return !!node.contentTransform
}

function isSideHandle(handle: { hx: -1 | 0 | 1; hy: -1 | 0 | 1 }): boolean {
  return (handle.hx === 0) !== (handle.hy === 0)
}

function scaleContentTransform(
  contentTransform: NodeContentTransform | undefined,
  scale: number
): NodeContentTransform | undefined {
  if (!contentTransform) return undefined
  return {
    x: contentTransform.x * scale,
    y: contentTransform.y * scale,
    scale: contentTransform.scale * scale,
    naturalWidth: contentTransform.naturalWidth,
    naturalHeight: contentTransform.naturalHeight,
  }
}

function getScaledContentSize(
  contentTransform: NodeContentTransform | undefined
): { width: number; height: number } | null {
  if (
    !contentTransform ||
    !contentTransform.naturalWidth ||
    !contentTransform.naturalHeight
  ) {
    return null
  }

  return {
    width: contentTransform.naturalWidth * contentTransform.scale,
    height: contentTransform.naturalHeight * contentTransform.scale,
  }
}

function getMaxCropSize(
  start: NodeTransform,
  handle: { hx: -1 | 0 | 1; hy: -1 | 0 | 1 },
  opts: { fromCenter?: boolean } = {}
): { width: number; height: number } {
  const contentSize = getScaledContentSize(start.contentTransform)
  if (!contentSize || !start.contentTransform) {
    return { width: Infinity, height: Infinity }
  }

  const mediaLeft = start.contentTransform.x
  const mediaTop = start.contentTransform.y
  const mediaRight = mediaLeft + contentSize.width
  const mediaBottom = mediaTop + contentSize.height
  const centerX = start.width / 2
  const centerY = start.height / 2

  let width = Infinity
  let height = Infinity
  if (handle.hx !== 0) {
    if (opts.fromCenter) {
      width = Math.max(
        MIN_NODE_SIZE,
        2 * Math.min(centerX - mediaLeft, mediaRight - centerX)
      )
    } else if (handle.hx === 1) {
      width = mediaRight
    } else {
      width = start.width - mediaLeft
    }
  }
  if (handle.hy !== 0) {
    if (opts.fromCenter) {
      height = Math.max(
        MIN_NODE_SIZE,
        2 * Math.min(centerY - mediaTop, mediaBottom - centerY)
      )
    } else if (handle.hy === 1) {
      height = mediaBottom
    } else {
      height = start.height - mediaTop
    }
  }

  return {
    width: Math.max(MIN_NODE_SIZE, width),
    height: Math.max(MIN_NODE_SIZE, height),
  }
}

function getFrameTopLeftWorld(transform: NodeTransform): Vec2 {
  return fromNodeLocal(
    { x: -transform.width / 2, y: -transform.height / 2 },
    getNodeCenter(transform),
    transform.rotation
  )
}

function cropContentTransform(
  start: NodeTransform,
  next: NodeTransform
): NodeContentTransform | undefined {
  if (!start.contentTransform) return undefined
  const startTopLeft = getFrameTopLeftWorld(start)
  const nextTopLeft = getFrameTopLeftWorld(next)
  const delta = rotate(
    {
      x: startTopLeft.x - nextTopLeft.x,
      y: startTopLeft.y - nextTopLeft.y,
    },
    -start.rotation
  )

  return {
    ...start.contentTransform,
    x: start.contentTransform.x + delta.x,
    y: start.contentTransform.y + delta.y,
  }
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

/** Normalize an angle to (-π, π]. */
export function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2
  let r = a % twoPi
  if (r <= -Math.PI) r += twoPi
  else if (r > Math.PI) r -= twoPi
  return r
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

export function normalizeRect(a: Vec2, b: Vec2): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

export function getSelectionBounds(nodes: NodeTransform[]): Rect | null {
  if (nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const node of nodes) {
    for (const corner of getNodeWorldCorners(node)) {
      minX = Math.min(minX, corner.x)
      minY = Math.min(minY, corner.y)
      maxX = Math.max(maxX, corner.x)
      maxY = Math.max(maxY, corner.y)
    }
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
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

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  )
}

export function nodesInMarquee(
  nodes: CanvasNode[],
  startScreen: Vec2,
  pointerScreen: Vec2,
  view: ViewTransform
): CanvasNode[] {
  const a = worldFromScreen(startScreen, view)
  const b = worldFromScreen(pointerScreen, view)
  const marquee = normalizeRect(a, b)
  if (marquee.width === 0 && marquee.height === 0) return []

  return nodes.filter((node) => {
    const bounds = getSelectionBounds([node])
    return !!bounds && rectsIntersect(bounds, marquee)
  })
}

// ── overlay geometry (used by scene draw, controller hit-test, React toolbar) ─

export type HandleScreenPosition = ResizeHandle & { screen: Vec2 }

export type OverlayGeometry = {
  /** The 4 box corners in screen space (tl, tr, br, bl) for the selection border. */
  corners: [Vec2, Vec2, Vec2, Vec2]
  /** Screen positions of the 8 resize handles. */
  handles: HandleScreenPosition[]
  /** Rotation knob + the bottom-edge point it anchors from, in screen space. */
  rotation: { knob: Vec2; anchor: Vec2 }
  /** True when this geometry is the axis-aligned group box. */
  isGroup: boolean
}

/**
 * Project a single node's selection geometry into screen space. Single source
 * of truth so drawn handles and hit-test targets cannot drift apart.
 */
export function getHandleScreenPositions(
  node: NodeTransform,
  view: ViewTransform
): OverlayGeometry {
  const center = getNodeCenter(node)
  const hw = node.width / 2
  const hh = node.height / 2
  const rot = node.rotation

  const project = (lx: number, ly: number) =>
    screenFromWorld(fromNodeLocal({ x: lx, y: ly }, center, rot), view)

  const corners: [Vec2, Vec2, Vec2, Vec2] = [
    project(-hw, -hh),
    project(hw, -hh),
    project(hw, hh),
    project(-hw, hh),
  ]

  const handles = HANDLE_DESCRIPTORS.map((h) => ({
    ...h,
    screen: project(h.hx * hw, h.hy * hh),
  }))

  // Match OpenScreen/Konva's rotateAnchorAngle=180: the knob sits below the
  // selection in the node's local bottom direction, with no connector line.
  const anchor = project(0, hh)
  const down = rotate({ x: 0, y: 1 }, rot)
  const knob = {
    x: anchor.x + down.x * ROTATION_HANDLE_OFFSET,
    y: anchor.y + down.y * ROTATION_HANDLE_OFFSET,
  }

  return { corners, handles, rotation: { knob, anchor }, isGroup: false }
}

export function getSelectionHandleScreenPositions(
  nodes: NodeTransform[],
  view: ViewTransform
): OverlayGeometry | null {
  if (nodes.length === 0) return null
  if (nodes.length === 1) return getHandleScreenPositions(nodes[0], view)

  const bounds = getSelectionBounds(nodes)
  if (!bounds) return null
  const { x, y, width, height } = bounds
  const corners: [Vec2, Vec2, Vec2, Vec2] = [
    screenFromWorld({ x, y }, view),
    screenFromWorld({ x: x + width, y }, view),
    screenFromWorld({ x: x + width, y: y + height }, view),
    screenFromWorld({ x, y: y + height }, view),
  ]
  const handles = HANDLE_DESCRIPTORS.map((h) => ({
    ...h,
    screen: screenFromWorld(
      { x: x + ((h.hx + 1) * width) / 2, y: y + ((h.hy + 1) * height) / 2 },
      view
    ),
  }))
  const anchor = screenFromWorld({ x: x + width / 2, y: y + height }, view)
  const knob = { x: anchor.x, y: anchor.y + ROTATION_HANDLE_OFFSET }
  return { corners, handles, rotation: { knob, anchor }, isGroup: true }
}

export function getOverlayScreenBounds(geometry: OverlayGeometry): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of [...geometry.corners, geometry.rotation.knob]) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

// ── gestures (stateless: each takes snapshots from gesture start) ─────────────

/** Translate a node by the world-space delta between two screen points. */
export function moveNode(
  start: NodeTransform,
  startScreen: Vec2,
  pointerScreen: Vec2,
  view: ViewTransform,
  opts: { axisLock?: boolean } = {}
): NodeTransform {
  const a = worldFromScreen(startScreen, view)
  const b = worldFromScreen(pointerScreen, view)
  let dx = b.x - a.x
  let dy = b.y - a.y
  if (opts.axisLock) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0
    else dx = 0
  }
  return { ...start, x: start.x + dx, y: start.y + dy }
}

export function moveNodes(
  starts: CanvasNode[],
  startScreen: Vec2,
  pointerScreen: Vec2,
  view: ViewTransform,
  opts: { axisLock?: boolean } = {}
): NodeTransformUpdate[] {
  return starts.map((node) =>
    toUpdate(node, moveNode(node, startScreen, pointerScreen, view, opts))
  )
}

/**
 * Figma-style resize: the handle opposite the dragged one stays fixed in world
 * space. Resize always preserves the gesture-start aspect ratio so media never
 * stretches. Corner drags scale from the opposite corner; edge drags scale from
 * the opposite edge midpoint and grow/shrink the perpendicular axis around its
 * center. With `fromCenter`, the node's center stays fixed. The content flips
 * when the pointer crosses the anchor, while width/height remain positive for
 * stable hit-testing.
 */
export function resizeNode(
  start: NodeTransform,
  handle: { hx: -1 | 0 | 1; hy: -1 | 0 | 1 },
  pointerScreen: Vec2,
  view: ViewTransform,
  opts: { fromCenter?: boolean } = {}
): NodeTransform {
  const { hx, hy } = handle
  const w0 = start.width
  const h0 = start.height
  const center0 = getNodeCenter(start)
  const rot = start.rotation
  const pointerWorld = worldFromScreen(pointerScreen, view)

  const anchorWorld = opts.fromCenter
    ? center0
    : fromNodeLocal({ x: -hx * (w0 / 2), y: -hy * (h0 / 2) }, center0, rot)

  // Pointer measured in the anchor's rotated, axis-aligned frame.
  const pLoc = toNodeLocal(pointerWorld, anchorWorld, rot)

  const rawW = hx !== 0 ? pLoc.x * hx * (opts.fromCenter ? 2 : 1) : w0
  const rawH = hy !== 0 ? pLoc.y * hy * (opts.fromCenter ? 2 : 1) : h0
  const minScale = minAspectScale([start])
  let scale = minScale
  let sgnX = 1
  let sgnY = 1

  if (hx !== 0 && hy !== 0) {
    scale = Math.max(Math.abs(rawW) / w0, Math.abs(rawH) / h0, minScale)
    sgnX = signedScale(rawW)
    sgnY = signedScale(rawH)
  } else if (hx !== 0) {
    scale = Math.max(Math.abs(rawW) / w0, minScale)
    sgnX = signedScale(rawW)
  } else if (hy !== 0) {
    scale = Math.max(Math.abs(rawH) / h0, minScale)
    sgnY = signedScale(rawH)
  }

  const newW = w0 * scale
  const newH = h0 * scale

  const offX = hx !== 0 ? (hx * sgnX * newW) / 2 : 0
  const offY = hy !== 0 ? (hy * sgnY * newH) / 2 : 0
  const newCenter = opts.fromCenter
    ? center0
    : fromNodeLocal({ x: offX, y: offY }, anchorWorld, rot)

  const contentTransform = scaleContentTransform(start.contentTransform, scale)
  return {
    ...start,
    x: newCenter.x - newW / 2,
    y: newCenter.y - newH / 2,
    width: newW,
    height: newH,
    rotation: rot,
    flipX: hx !== 0 ? boolXor(start.flipX, sgnX < 0) : start.flipX,
    flipY: hy !== 0 ? boolXor(start.flipY, sgnY < 0) : start.flipY,
    ...(contentTransform ? { contentTransform } : {}),
  }
}

/**
 * Non-destructive media crop resize. Side handles adjust only the frame's width
 * or height; media pixels keep their current uniform scale and are clipped by
 * the frame mask in the Pixi scene.
 */
function cropResizeNode(
  start: NodeTransform,
  handle: { hx: -1 | 0 | 1; hy: -1 | 0 | 1 },
  pointerScreen: Vec2,
  view: ViewTransform,
  opts: { fromCenter?: boolean } = {}
): NodeTransform {
  const { hx, hy } = handle
  const w0 = start.width
  const h0 = start.height
  const center0 = getNodeCenter(start)
  const rot = start.rotation
  const pointerWorld = worldFromScreen(pointerScreen, view)

  const anchorWorld = opts.fromCenter
    ? center0
    : fromNodeLocal({ x: -hx * (w0 / 2), y: -hy * (h0 / 2) }, center0, rot)
  const pLoc = toNodeLocal(pointerWorld, anchorWorld, rot)

  let newW = w0
  let newH = h0
  let sgnX = 1
  let sgnY = 1
  const maxCropSize = getMaxCropSize(start, handle, opts)

  if (hx !== 0) {
    const rawW = pLoc.x * hx * (opts.fromCenter ? 2 : 1)
    sgnX = signedScale(rawW)
    newW = Math.min(Math.max(Math.abs(rawW), MIN_NODE_SIZE), maxCropSize.width)
  }
  if (hy !== 0) {
    const rawH = pLoc.y * hy * (opts.fromCenter ? 2 : 1)
    sgnY = signedScale(rawH)
    newH = Math.min(Math.max(Math.abs(rawH), MIN_NODE_SIZE), maxCropSize.height)
  }

  const newCenter = opts.fromCenter
    ? center0
    : fromNodeLocal(
        {
          x: hx !== 0 ? (hx * sgnX * newW) / 2 : 0,
          y: hy !== 0 ? (hy * sgnY * newH) / 2 : 0,
        },
        anchorWorld,
        rot
      )

  const next: NodeTransform = {
    ...start,
    x: newCenter.x - newW / 2,
    y: newCenter.y - newH / 2,
    width: newW,
    height: newH,
    rotation: rot,
    flipX: hx !== 0 ? boolXor(start.flipX, sgnX < 0) : start.flipX,
    flipY: hy !== 0 ? boolXor(start.flipY, sgnY < 0) : start.flipY,
  }
  const contentTransform = cropContentTransform(start, next)
  return contentTransform ? { ...next, contentTransform } : next
}

/**
 * The fixed anchor coordinate for a group resize along one axis: the opposite
 * edge of the bounds, or the center for edge-only drags and `fromCenter`.
 */
function groupResizeAnchor(
  sign: -1 | 0 | 1,
  low: number,
  high: number,
  center: number,
  fromCenter: boolean | undefined
): number {
  if (fromCenter || sign === 0) return center
  return sign === 1 ? low : high
}

function resizeGroup(
  starts: CanvasNode[],
  handle: ResizeHandle,
  pointerScreen: Vec2,
  view: ViewTransform,
  opts: { fromCenter?: boolean } = {}
): NodeTransformUpdate[] {
  const bounds = getSelectionBounds(starts)
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return starts.map((node) => toUpdate(node, node))
  }

  const { hx, hy } = handle
  const pointer = worldFromScreen(pointerScreen, view)
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const anchorX = groupResizeAnchor(
    hx,
    bounds.x,
    bounds.x + bounds.width,
    centerX,
    opts.fromCenter
  )
  const anchorY = groupResizeAnchor(
    hy,
    bounds.y,
    bounds.y + bounds.height,
    centerY,
    opts.fromCenter
  )

  const rawScaleX =
    hx !== 0
      ? ((pointer.x - anchorX) * hx * (opts.fromCenter ? 2 : 1)) / bounds.width
      : 1
  const rawScaleY =
    hy !== 0
      ? ((pointer.y - anchorY) * hy * (opts.fromCenter ? 2 : 1)) / bounds.height
      : 1
  const minScale = Math.max(
    MIN_NODE_SIZE / bounds.width,
    MIN_NODE_SIZE / bounds.height,
    minAspectScale(starts)
  )

  let sx = 1
  let sy = 1
  if (hx !== 0 && hy !== 0) {
    const scale = Math.max(Math.abs(rawScaleX), Math.abs(rawScaleY), minScale)
    sx = signedScale(rawScaleX) * scale
    sy = signedScale(rawScaleY) * scale
  } else if (hx !== 0) {
    const scale = Math.max(Math.abs(rawScaleX), minScale)
    sx = signedScale(rawScaleX) * scale
    sy = scale
  } else if (hy !== 0) {
    const scale = Math.max(Math.abs(rawScaleY), minScale)
    sx = scale
    sy = signedScale(rawScaleY) * scale
  }

  return starts.map((node) => {
    const center = getNodeCenter(node)
    const nextCenter = {
      x: anchorX + (center.x - anchorX) * sx,
      y: anchorY + (center.y - anchorY) * sy,
    }
    const width = node.width * Math.abs(sx)
    const height = node.height * Math.abs(sy)

    const scale = Math.abs(sx)
    const contentTransform = scaleContentTransform(node.contentTransform, scale)
    return toUpdate(node, {
      ...node,
      x: nextCenter.x - width / 2,
      y: nextCenter.y - height / 2,
      width,
      height,
      flipX: hx !== 0 && sx < 0 ? !node.flipX : node.flipX,
      flipY: hy !== 0 && sy < 0 ? !node.flipY : node.flipY,
      ...(contentTransform ? { contentTransform } : {}),
    })
  })
}

export function resizeSelection(
  starts: CanvasNode[],
  handle: ResizeHandle,
  pointerScreen: Vec2,
  view: ViewTransform,
  opts: { fromCenter?: boolean } = {}
): NodeTransformUpdate[] {
  if (starts.length === 1) {
    const start = starts[0]
    const transform =
      isSideHandle(handle) && hasCropContent(start)
        ? cropResizeNode(start, handle, pointerScreen, view, opts)
        : resizeNode(start, handle, pointerScreen, view, opts)
    return [toUpdate(start, transform)]
  }
  return resizeGroup(starts, handle, pointerScreen, view, opts)
}

/** Rotate a node around its center by the angle the pointer swept; Shift snaps to 45°. */
export function rotateNode(
  start: NodeTransform,
  startScreen: Vec2,
  pointerScreen: Vec2,
  view: ViewTransform,
  opts: { snap?: boolean } = {}
): NodeTransform {
  const center = getNodeCenter(start)
  const a = worldFromScreen(startScreen, view)
  const b = worldFromScreen(pointerScreen, view)
  const startAngle = Math.atan2(a.y - center.y, a.x - center.x)
  const liveAngle = Math.atan2(b.y - center.y, b.x - center.x)
  let rotation = start.rotation + (liveAngle - startAngle)
  if (opts.snap) {
    rotation = Math.round(rotation / ROTATION_SNAP_RAD) * ROTATION_SNAP_RAD
  }
  return { ...start, rotation: normalizeAngle(rotation) }
}

export function rotateSelection(
  starts: CanvasNode[],
  startScreen: Vec2,
  pointerScreen: Vec2,
  view: ViewTransform,
  opts: { snap?: boolean } = {}
): NodeTransformUpdate[] {
  if (starts.length === 1) {
    return [
      toUpdate(
        starts[0],
        rotateNode(starts[0], startScreen, pointerScreen, view, opts)
      ),
    ]
  }

  const bounds = getSelectionBounds(starts)
  if (!bounds) return []
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  }
  const a = worldFromScreen(startScreen, view)
  const b = worldFromScreen(pointerScreen, view)
  const startAngle = Math.atan2(a.y - center.y, a.x - center.x)
  const liveAngle = Math.atan2(b.y - center.y, b.x - center.x)
  let delta = liveAngle - startAngle
  if (opts.snap)
    delta = Math.round(delta / ROTATION_SNAP_RAD) * ROTATION_SNAP_RAD

  return starts.map((node) => {
    const nodeCenter = getNodeCenter(node)
    const rotated = rotate(
      { x: nodeCenter.x - center.x, y: nodeCenter.y - center.y },
      delta
    )
    const nextCenter = { x: center.x + rotated.x, y: center.y + rotated.y }
    return toUpdate(node, {
      ...node,
      x: nextCenter.x - node.width / 2,
      y: nextCenter.y - node.height / 2,
      rotation: normalizeAngle(node.rotation + delta),
    })
  })
}

export function flipSelection(
  starts: CanvasNode[],
  axis: FlipAxis
): NodeTransformUpdate[] {
  const bounds = getSelectionBounds(starts)
  if (!bounds) return []
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2

  return starts.map((node) => {
    const center = getNodeCenter(node)
    const nextCenter =
      axis === "horizontal"
        ? { x: cx - (center.x - cx), y: center.y }
        : { x: center.x, y: cy - (center.y - cy) }
    return toUpdate(node, {
      ...node,
      x: nextCenter.x - node.width / 2,
      y: nextCenter.y - node.height / 2,
      flipX: axis === "horizontal" ? !node.flipX : node.flipX,
      flipY: axis === "vertical" ? !node.flipY : node.flipY,
    })
  })
}

export function transformSelectionToBounds(
  starts: CanvasNode[],
  patch: Partial<
    Pick<NodeTransform, "x" | "y" | "width" | "height" | "rotation">
  >
): NodeTransformUpdate[] {
  if (starts.length === 0) return []

  if (starts.length === 1) {
    const node = starts[0]
    return [
      toUpdate(node, {
        ...node,
        x: patch.x ?? node.x,
        y: patch.y ?? node.y,
        width:
          patch.width !== undefined
            ? Math.max(MIN_NODE_SIZE, patch.width)
            : node.width,
        height:
          patch.height !== undefined
            ? Math.max(MIN_NODE_SIZE, patch.height)
            : node.height,
        rotation: patch.rotation ?? node.rotation,
      }),
    ]
  }

  const bounds = getSelectionBounds(starts)
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return []
  const nextX = patch.x ?? bounds.x
  const nextY = patch.y ?? bounds.y
  const nextW =
    patch.width !== undefined
      ? Math.max(MIN_NODE_SIZE, patch.width)
      : bounds.width
  const nextH =
    patch.height !== undefined
      ? Math.max(MIN_NODE_SIZE, patch.height)
      : bounds.height
  const sx = nextW / bounds.width
  const sy = nextH / bounds.height

  return starts.map((node) => {
    const center = getNodeCenter(node)
    const nextCenter = {
      x: nextX + (center.x - bounds.x) * sx,
      y: nextY + (center.y - bounds.y) * sy,
    }
    const width = Math.max(MIN_NODE_SIZE, node.width * sx)
    const height = Math.max(MIN_NODE_SIZE, node.height * sy)
    return toUpdate(node, {
      ...node,
      x: nextCenter.x - width / 2,
      y: nextCenter.y - height / 2,
      width,
      height,
    })
  })
}

export function reorderNodes(
  nodes: CanvasNode[],
  selectedIds: string[],
  command: LayerOrderCommand
): CanvasNode[] {
  const selected = new Set(selectedIds)
  if (selected.size === 0) return nodes

  if (command === "bring-to-front") {
    return [
      ...nodes.filter((node) => !selected.has(node.id)),
      ...nodes.filter((node) => selected.has(node.id)),
    ]
  }
  if (command === "send-to-back") {
    return [
      ...nodes.filter((node) => selected.has(node.id)),
      ...nodes.filter((node) => !selected.has(node.id)),
    ]
  }

  const next = [...nodes]
  if (command === "bring-forward") {
    for (let i = next.length - 2; i >= 0; i--) {
      if (selected.has(next[i].id) && !selected.has(next[i + 1].id)) {
        const item = next[i]
        next[i] = next[i + 1]
        next[i + 1] = item
      }
    }
    return next
  }

  for (let i = 1; i < next.length; i++) {
    if (selected.has(next[i].id) && !selected.has(next[i - 1].id)) {
      const item = next[i]
      next[i] = next[i - 1]
      next[i - 1] = item
    }
  }
  return next
}

export function duplicateNodes(
  nodes: CanvasNode[],
  selectedIds: string[],
  createId: (node: CanvasNode) => string
): DuplicateNodesResult {
  const selected = new Set(selectedIds)
  if (selected.size === 0) return { nodes, selectedIds: [] }

  const next: CanvasNode[] = []
  const nextSelectedIds: string[] = []
  for (const node of nodes) {
    next.push(node)
    if (!selected.has(node.id) || node.locked) continue

    const duplicate: CanvasNode = {
      ...node,
      id: createId(node),
      x: node.x + DUPLICATED_NODE_OFFSET,
      y: node.y + DUPLICATED_NODE_OFFSET,
      locked: false,
    }
    next.push(duplicate)
    nextSelectedIds.push(duplicate.id)
  }

  return {
    nodes: nextSelectedIds.length > 0 ? next : nodes,
    selectedIds: nextSelectedIds,
  }
}
