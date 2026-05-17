import type {
  CanvasSize,
  CanvasVideoItem,
  EditorArtboard,
} from "@/types/editor-canvas"

export const SNAP_SCREEN_PX = 6

export type AABB = { x: number; y: number; width: number; height: number }

export type SnapStopKind =
  | "artboard-edge"
  | "artboard-center"
  | "rule-of-thirds"
  | "grid"
  | "node-edge"
  | "node-center"

export type SnapStop = {
  value: number
  kind: SnapStopKind
  nodeId?: string
  // Cross-axis range of the source node, used to span the rendered guide line
  // between the dragged node and the matched source node.
  spanStart?: number
  spanEnd?: number
}

export type GuideLine = {
  axis: "x" | "y"
  value: number
  kind: SnapStopKind
  from: number
  to: number
}

export type DistanceSegment = { from: number; to: number; cross: number }

export type DistanceGuide = {
  axis: "x" | "y"
  gap: number
  segments: DistanceSegment[]
}

export type DraggedEdge = {
  value: number
  offset: number
  edge: "start" | "center" | "end"
}

export type DraggedEdges = {
  vertical: DraggedEdge[]
  horizontal: DraggedEdge[]
}

export type DimensionStop = {
  value: number
  nodeId: string
  aabb: AABB
}

export type SnapCache = {
  artboard: EditorArtboard
  verticalStops: SnapStop[]
  horizontalStops: SnapStop[]
  verticalValues: Float32Array
  horizontalValues: Float32Array
  widthStops: DimensionStop[]
  heightStops: DimensionStop[]
  otherNodes: Array<{ id: string; aabb: AABB }>
  gridStep: number | null
}

const STOP_PRIORITY: Record<SnapStopKind, number> = {
  "artboard-center": 0,
  "artboard-edge": 1,
  "node-center": 2,
  "node-edge": 3,
  "rule-of-thirds": 4,
  grid: 5,
}

export function getRotatedAABB(item: {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}): AABB {
  if (!item.rotation) {
    return {
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    }
  }

  const angle = (item.rotation * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const corner of [
    { x: 0, y: 0 },
    { x: item.width, y: 0 },
    { x: item.width, y: item.height },
    { x: 0, y: item.height },
  ]) {
    const px = item.x + corner.x * cos - corner.y * sin
    const py = item.y + corner.x * sin + corner.y * cos
    if (px < minX) minX = px
    if (py < minY) minY = py
    if (px > maxX) maxX = px
    if (py > maxY) maxY = py
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function buildSnapCache(args: {
  artboard: EditorArtboard
  otherVideos: CanvasVideoItem[]
  includeRuleOfThirds: boolean
  gridStep?: number | null
  // Optional inflated viewport AABB in artboard coords. Nodes whose AABB does
  // not overlap are dropped from the cache.
  viewportAABB?: AABB | null
}): SnapCache {
  const {
    artboard,
    otherVideos,
    includeRuleOfThirds,
    gridStep = null,
    viewportAABB = null,
  } = args

  const verticalStops: SnapStop[] = [
    { value: 0, kind: "artboard-edge" },
    { value: artboard.width, kind: "artboard-edge" },
    { value: artboard.width / 2, kind: "artboard-center" },
  ]
  const horizontalStops: SnapStop[] = [
    { value: 0, kind: "artboard-edge" },
    { value: artboard.height, kind: "artboard-edge" },
    { value: artboard.height / 2, kind: "artboard-center" },
  ]

  if (includeRuleOfThirds) {
    verticalStops.push(
      { value: artboard.width / 3, kind: "rule-of-thirds" },
      { value: (2 * artboard.width) / 3, kind: "rule-of-thirds" }
    )
    horizontalStops.push(
      { value: artboard.height / 3, kind: "rule-of-thirds" },
      { value: (2 * artboard.height) / 3, kind: "rule-of-thirds" }
    )
  }

  const otherNodes: SnapCache["otherNodes"] = []
  const widthStops: DimensionStop[] = []
  const heightStops: DimensionStop[] = []
  for (const video of otherVideos) {
    const aabb = getRotatedAABB(video)
    if (
      viewportAABB &&
      !rangesOverlap(
        aabb.x,
        aabb.x + aabb.width,
        viewportAABB.x,
        viewportAABB.x + viewportAABB.width
      )
    ) {
      continue
    }
    if (
      viewportAABB &&
      !rangesOverlap(
        aabb.y,
        aabb.y + aabb.height,
        viewportAABB.y,
        viewportAABB.y + viewportAABB.height
      )
    ) {
      continue
    }
    otherNodes.push({ id: video.id, aabb })
    widthStops.push({ value: aabb.width, nodeId: video.id, aabb })
    heightStops.push({ value: aabb.height, nodeId: video.id, aabb })

    const top = aabb.y
    const bottom = aabb.y + aabb.height
    const left = aabb.x
    const right = aabb.x + aabb.width

    verticalStops.push(
      {
        value: left,
        kind: "node-edge",
        nodeId: video.id,
        spanStart: top,
        spanEnd: bottom,
      },
      {
        value: right,
        kind: "node-edge",
        nodeId: video.id,
        spanStart: top,
        spanEnd: bottom,
      },
      {
        value: left + aabb.width / 2,
        kind: "node-center",
        nodeId: video.id,
        spanStart: top,
        spanEnd: bottom,
      }
    )
    horizontalStops.push(
      {
        value: top,
        kind: "node-edge",
        nodeId: video.id,
        spanStart: left,
        spanEnd: right,
      },
      {
        value: bottom,
        kind: "node-edge",
        nodeId: video.id,
        spanStart: left,
        spanEnd: right,
      },
      {
        value: top + aabb.height / 2,
        kind: "node-center",
        nodeId: video.id,
        spanStart: left,
        spanEnd: right,
      }
    )
  }

  const compare = (a: SnapStop, b: SnapStop) =>
    a.value === b.value
      ? STOP_PRIORITY[a.kind] - STOP_PRIORITY[b.kind]
      : a.value - b.value
  verticalStops.sort(compare)
  horizontalStops.sort(compare)

  const verticalValues = new Float32Array(verticalStops.length)
  for (let i = 0; i < verticalStops.length; i++) {
    verticalValues[i] = verticalStops[i].value
  }
  const horizontalValues = new Float32Array(horizontalStops.length)
  for (let i = 0; i < horizontalStops.length; i++) {
    horizontalValues[i] = horizontalStops[i].value
  }

  const artboardAabb: AABB = {
    x: 0,
    y: 0,
    width: artboard.width,
    height: artboard.height,
  }
  widthStops.push({
    value: artboard.width,
    nodeId: "__artboard__",
    aabb: artboardAabb,
  })
  heightStops.push({
    value: artboard.height,
    nodeId: "__artboard__",
    aabb: artboardAabb,
  })

  return {
    artboard,
    verticalStops,
    horizontalStops,
    verticalValues,
    horizontalValues,
    widthStops,
    heightStops,
    otherNodes,
    gridStep: gridStep ?? null,
  }
}

export type DimensionGuide = {
  axis: "width" | "height"
  value: number
  draggedRect: AABB
  matchedRect: AABB
}

type DimensionMatch = {
  delta: number
  stop: DimensionStop
}

function findDimensionSnap(
  currentValue: number,
  stops: DimensionStop[],
  threshold: number
): DimensionMatch | null {
  let best: DimensionMatch | null = null
  for (const stop of stops) {
    const diff = stop.value - currentValue
    const distance = Math.abs(diff)
    if (distance > threshold) continue
    if (!best || distance < Math.abs(best.delta)) {
      best = { delta: diff, stop }
    }
  }
  return best
}

function lowerBound(values: Float32Array, target: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (values[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function computeDraggedEdges(aabb: AABB): DraggedEdges {
  return {
    vertical: [
      { value: aabb.x, offset: 0, edge: "start" },
      {
        value: aabb.x + aabb.width / 2,
        offset: aabb.width / 2,
        edge: "center",
      },
      {
        value: aabb.x + aabb.width,
        offset: aabb.width,
        edge: "end",
      },
    ],
    horizontal: [
      { value: aabb.y, offset: 0, edge: "start" },
      {
        value: aabb.y + aabb.height / 2,
        offset: aabb.height / 2,
        edge: "center",
      },
      {
        value: aabb.y + aabb.height,
        offset: aabb.height,
        edge: "end",
      },
    ],
  }
}

type AxisSnap = {
  delta: number
  stop: SnapStop
  edge: DraggedEdge
}

function findAxisSnap(
  edges: DraggedEdge[],
  stops: SnapStop[],
  values: Float32Array,
  threshold: number,
  // Optional subset of edges that are allowed to snap (resize anchors).
  allowedEdges?: ReadonlySet<DraggedEdge["edge"]>
): AxisSnap | null {
  let best: AxisSnap | null = null

  for (const edge of edges) {
    if (allowedEdges && !allowedEdges.has(edge.edge)) continue

    const start = lowerBound(values, edge.value - threshold)
    for (let i = start; i < values.length; i++) {
      const value = values[i]
      if (value > edge.value + threshold) break

      const stop = stops[i]
      const diff = value - edge.value
      const distance = Math.abs(diff)

      if (!best) {
        best = { delta: diff, stop, edge }
        continue
      }

      const bestDistance = Math.abs(best.delta)
      if (distance < bestDistance) {
        best = { delta: diff, stop, edge }
      } else if (
        distance === bestDistance &&
        STOP_PRIORITY[stop.kind] < STOP_PRIORITY[best.stop.kind]
      ) {
        best = { delta: diff, stop, edge }
      }
    }
  }

  return best
}

function findGridAxisSnap(
  edges: DraggedEdge[],
  gridStep: number,
  threshold: number,
  allowedEdges?: ReadonlySet<DraggedEdge["edge"]>
): AxisSnap | null {
  let best: AxisSnap | null = null

  for (const edge of edges) {
    if (allowedEdges && !allowedEdges.has(edge.edge)) continue

    const target = Math.round(edge.value / gridStep) * gridStep
    const diff = target - edge.value
    const distance = Math.abs(diff)
    if (distance > threshold) continue

    if (!best || distance < Math.abs(best.delta)) {
      best = {
        delta: diff,
        stop: { value: target, kind: "grid" },
        edge,
      }
    }
  }

  return best
}

function spanForStop(
  stop: SnapStop,
  draggedFrom: number,
  draggedTo: number,
  artboardCrossLength: number
): [number, number] {
  if (
    (stop.kind === "node-edge" || stop.kind === "node-center") &&
    stop.spanStart !== undefined &&
    stop.spanEnd !== undefined
  ) {
    return [
      Math.min(stop.spanStart, draggedFrom),
      Math.max(stop.spanEnd, draggedTo),
    ]
  }
  return [0, artboardCrossLength]
}

function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
) {
  return aStart < bEnd && bStart < aEnd
}

function computeEqualSpacing(
  aabb: AABB,
  axis: "x" | "y",
  otherNodes: SnapCache["otherNodes"],
  threshold: number
): { delta: number; guide: DistanceGuide } | null {
  // For axis "x": looking at horizontal gaps between siblings whose vertical
  // ranges overlap the dragged AABB. The reverse for "y".
  const isX = axis === "x"
  const draggedStart = isX ? aabb.x : aabb.y
  const draggedEnd = isX ? aabb.x + aabb.width : aabb.y + aabb.height
  const draggedCrossStart = isX ? aabb.y : aabb.x
  const draggedCrossEnd = isX
    ? aabb.y + aabb.height
    : aabb.x + aabb.width

  const left: Array<{ start: number; end: number; cross: [number, number] }> =
    []
  const right: Array<{ start: number; end: number; cross: [number, number] }> =
    []

  for (const node of otherNodes) {
    const nStart = isX ? node.aabb.x : node.aabb.y
    const nEnd = isX
      ? node.aabb.x + node.aabb.width
      : node.aabb.y + node.aabb.height
    const nCrossStart = isX ? node.aabb.y : node.aabb.x
    const nCrossEnd = isX
      ? node.aabb.y + node.aabb.height
      : node.aabb.x + node.aabb.width

    if (
      !rangesOverlap(
        draggedCrossStart,
        draggedCrossEnd,
        nCrossStart,
        nCrossEnd
      )
    ) {
      continue
    }

    if (nEnd <= draggedStart + threshold) {
      left.push({
        start: nStart,
        end: nEnd,
        cross: [nCrossStart, nCrossEnd],
      })
    } else if (nStart >= draggedEnd - threshold) {
      right.push({
        start: nStart,
        end: nEnd,
        cross: [nCrossStart, nCrossEnd],
      })
    }
  }

  if (!left.length || !right.length) return null

  // Closest neighbor on each side.
  const nearestLeft = left.reduce((a, b) => (a.end > b.end ? a : b))
  const nearestRight = right.reduce((a, b) => (a.start < b.start ? a : b))

  const gapLeft = draggedStart - nearestLeft.end
  const gapRight = nearestRight.start - draggedEnd
  if (gapLeft < 0 || gapRight < 0) return null

  const diff = gapRight - gapLeft
  if (Math.abs(diff) > threshold) return null

  const delta = diff / 2
  const gap = (gapLeft + gapRight) / 2

  // Cross-axis level for the rendered segments: midline of the union range.
  const crossUnion: [number, number] = [
    Math.min(
      draggedCrossStart,
      nearestLeft.cross[0],
      nearestRight.cross[0]
    ),
    Math.max(
      draggedCrossEnd,
      nearestLeft.cross[1],
      nearestRight.cross[1]
    ),
  ]
  const cross = (crossUnion[0] + crossUnion[1]) / 2

  const segments: DistanceSegment[] = [
    {
      from: nearestLeft.end,
      to: draggedStart + delta,
      cross,
    },
    {
      from: draggedEnd + delta,
      to: nearestRight.start,
      cross,
    },
  ]

  return { delta, guide: { axis, gap, segments } }
}

export type SnapResult = {
  deltaX: number
  deltaY: number
  guides: GuideLine[]
  distances: DistanceGuide[]
}

const EMPTY_RESULT: SnapResult = {
  deltaX: 0,
  deltaY: 0,
  guides: [],
  distances: [],
}

export function findDragSnaps(
  aabb: AABB,
  cache: SnapCache,
  thresholdArtboard: number
): SnapResult {
  if (thresholdArtboard <= 0) return EMPTY_RESULT

  const edges = computeDraggedEdges(aabb)
  let x = findAxisSnap(
    edges.vertical,
    cache.verticalStops,
    cache.verticalValues,
    thresholdArtboard
  )
  let y = findAxisSnap(
    edges.horizontal,
    cache.horizontalStops,
    cache.horizontalValues,
    thresholdArtboard
  )

  if (!x && cache.gridStep) {
    x = findGridAxisSnap(edges.vertical, cache.gridStep, thresholdArtboard)
  }
  if (!y && cache.gridStep) {
    y = findGridAxisSnap(edges.horizontal, cache.gridStep, thresholdArtboard)
  }

  const deltaX = x?.delta ?? 0
  const deltaY = y?.delta ?? 0

  const guides: GuideLine[] = []

  if (x) {
    const draggedFrom = aabb.y + deltaY
    const draggedTo = aabb.y + aabb.height + deltaY
    const [from, to] = spanForStop(
      x.stop,
      draggedFrom,
      draggedTo,
      cache.artboard.height
    )
    guides.push({
      axis: "x",
      value: x.stop.value,
      kind: x.stop.kind,
      from,
      to,
    })
  }

  if (y) {
    const draggedFrom = aabb.x + deltaX
    const draggedTo = aabb.x + aabb.width + deltaX
    const [from, to] = spanForStop(
      y.stop,
      draggedFrom,
      draggedTo,
      cache.artboard.width
    )
    guides.push({
      axis: "y",
      value: y.stop.value,
      kind: y.stop.kind,
      from,
      to,
    })
  }

  const distances: DistanceGuide[] = []
  let resolvedDeltaX = deltaX
  let resolvedDeltaY = deltaY

  if (!x) {
    const spacing = computeEqualSpacing(
      aabb,
      "x",
      cache.otherNodes,
      thresholdArtboard
    )
    if (spacing) {
      resolvedDeltaX = spacing.delta
      distances.push(spacing.guide)
    }
  }
  if (!y) {
    const spacing = computeEqualSpacing(
      aabb,
      "y",
      cache.otherNodes,
      thresholdArtboard
    )
    if (spacing) {
      resolvedDeltaY = spacing.delta
      distances.push(spacing.guide)
    }
  }

  return {
    deltaX: resolvedDeltaX,
    deltaY: resolvedDeltaY,
    guides,
    distances,
  }
}

export type ResizeAnchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"
  | null

type ActiveEdgeSet = {
  vertical: Set<DraggedEdge["edge"]>
  horizontal: Set<DraggedEdge["edge"]>
}

function activeEdgesForAnchor(anchor: ResizeAnchor): ActiveEdgeSet {
  const vertical = new Set<DraggedEdge["edge"]>()
  const horizontal = new Set<DraggedEdge["edge"]>()
  if (!anchor) return { vertical, horizontal }

  switch (anchor) {
    case "top-left":
      vertical.add("start")
      horizontal.add("start")
      break
    case "top-center":
      horizontal.add("start")
      break
    case "top-right":
      vertical.add("end")
      horizontal.add("start")
      break
    case "middle-left":
      vertical.add("start")
      break
    case "middle-right":
      vertical.add("end")
      break
    case "bottom-left":
      vertical.add("start")
      horizontal.add("end")
      break
    case "bottom-center":
      horizontal.add("end")
      break
    case "bottom-right":
      vertical.add("end")
      horizontal.add("end")
      break
  }

  return { vertical, horizontal }
}

export type ResizeBox = {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

export type ResizeSnapResult = {
  box: ResizeBox
  guides: GuideLine[]
  dimensions: DimensionGuide[]
}

export function findResizeSnap(
  oldBox: ResizeBox,
  newBox: ResizeBox,
  anchor: ResizeAnchor,
  cache: SnapCache,
  thresholdArtboard: number,
  keepRatio: boolean
): ResizeSnapResult {
  if (!anchor || newBox.rotation !== 0 || thresholdArtboard <= 0) {
    return { box: newBox, guides: [], dimensions: [] }
  }

  const active = activeEdgesForAnchor(anchor)
  const aabb: AABB = {
    x: newBox.x,
    y: newBox.y,
    width: newBox.width,
    height: newBox.height,
  }
  const edges = computeDraggedEdges(aabb)

  let x = active.vertical.size
    ? findAxisSnap(
        edges.vertical,
        cache.verticalStops,
        cache.verticalValues,
        thresholdArtboard,
        active.vertical
      )
    : null
  let y = active.horizontal.size
    ? findAxisSnap(
        edges.horizontal,
        cache.horizontalStops,
        cache.horizontalValues,
        thresholdArtboard,
        active.horizontal
      )
    : null

  if (!x && cache.gridStep && active.vertical.size) {
    x = findGridAxisSnap(
      edges.vertical,
      cache.gridStep,
      thresholdArtboard,
      active.vertical
    )
  }
  if (!y && cache.gridStep && active.horizontal.size) {
    y = findGridAxisSnap(
      edges.horizontal,
      cache.gridStep,
      thresholdArtboard,
      active.horizontal
    )
  }

  const widthMatch = active.vertical.size
    ? findDimensionSnap(newBox.width, cache.widthStops, thresholdArtboard)
    : null
  const heightMatch = active.horizontal.size
    ? findDimensionSnap(newBox.height, cache.heightStops, thresholdArtboard)
    : null

  let resultBox: ResizeBox = newBox
  const guides: GuideLine[] = []
  const dimensions: DimensionGuide[] = []

  const isCorner =
    anchor === "top-left" ||
    anchor === "top-right" ||
    anchor === "bottom-left" ||
    anchor === "bottom-right"

  if (isCorner && keepRatio) {
    type Candidate =
      | { kind: "edge-x"; magnitude: number }
      | { kind: "edge-y"; magnitude: number }
      | { kind: "dim-w"; magnitude: number }
      | { kind: "dim-h"; magnitude: number }
    const candidates: Candidate[] = []
    if (x) candidates.push({ kind: "edge-x", magnitude: Math.abs(x.delta) })
    if (y) candidates.push({ kind: "edge-y", magnitude: Math.abs(y.delta) })
    if (widthMatch)
      candidates.push({ kind: "dim-w", magnitude: Math.abs(widthMatch.delta) })
    if (heightMatch)
      candidates.push({ kind: "dim-h", magnitude: Math.abs(heightMatch.delta) })

    candidates.sort((a, b) => a.magnitude - b.magnitude)
    const winner = candidates[0]

    if (winner) {
      if (winner.kind === "edge-x" && x) {
        resultBox = applyCornerSnap(
          oldBox,
          newBox,
          anchor,
          "x",
          x.edge.edge,
          x.delta
        )
        pushGuide(guides, x.stop, resultBox, "x", cache)
      } else if (winner.kind === "edge-y" && y) {
        resultBox = applyCornerSnap(
          oldBox,
          newBox,
          anchor,
          "y",
          y.edge.edge,
          y.delta
        )
        pushGuide(guides, y.stop, resultBox, "y", cache)
      } else if (winner.kind === "dim-w" && widthMatch) {
        resultBox = applyDimensionSnap(
          oldBox,
          newBox,
          anchor,
          "width",
          widthMatch.stop.value,
          true
        )
        dimensions.push(
          buildDimensionGuide("width", widthMatch.stop, resultBox)
        )
      } else if (winner.kind === "dim-h" && heightMatch) {
        resultBox = applyDimensionSnap(
          oldBox,
          newBox,
          anchor,
          "height",
          heightMatch.stop.value,
          true
        )
        dimensions.push(
          buildDimensionGuide("height", heightMatch.stop, resultBox)
        )
      }
    }
  } else {
    // Side anchors and corners without keepRatio: snap each active axis
    // independently, picking edge-snap over dimension-snap when both fit.
    if (active.vertical.size) {
      const xMag = x ? Math.abs(x.delta) : Infinity
      const wMag = widthMatch ? Math.abs(widthMatch.delta) : Infinity
      if (x && xMag <= wMag) {
        resultBox = applyEdgeSnap(resultBox, "x", x.edge.edge, x.delta)
        pushGuide(guides, x.stop, resultBox, "x", cache)
      } else if (widthMatch) {
        resultBox = applyDimensionSnap(
          oldBox,
          resultBox,
          anchor,
          "width",
          widthMatch.stop.value,
          false
        )
        dimensions.push(
          buildDimensionGuide("width", widthMatch.stop, resultBox)
        )
      }
    }
    if (active.horizontal.size) {
      const yMag = y ? Math.abs(y.delta) : Infinity
      const hMag = heightMatch ? Math.abs(heightMatch.delta) : Infinity
      if (y && yMag <= hMag) {
        resultBox = applyEdgeSnap(resultBox, "y", y.edge.edge, y.delta)
        pushGuide(guides, y.stop, resultBox, "y", cache)
      } else if (heightMatch) {
        resultBox = applyDimensionSnap(
          oldBox,
          resultBox,
          anchor,
          "height",
          heightMatch.stop.value,
          false
        )
        dimensions.push(
          buildDimensionGuide("height", heightMatch.stop, resultBox)
        )
      }
    }
  }

  return { box: resultBox, guides, dimensions }
}

function applyDimensionSnap(
  oldBox: ResizeBox,
  newBox: ResizeBox,
  anchor: Exclude<ResizeAnchor, null>,
  axis: "width" | "height",
  targetValue: number,
  preserveRatio: boolean
): ResizeBox {
  let width = newBox.width
  let height = newBox.height

  if (axis === "width") {
    width = Math.max(0, targetValue)
    if (preserveRatio) {
      const ratio = oldBox.width / Math.max(1, oldBox.height)
      height = width / ratio
    }
  } else {
    height = Math.max(0, targetValue)
    if (preserveRatio) {
      const ratio = oldBox.width / Math.max(1, oldBox.height)
      width = height * ratio
    }
  }

  // The pivot is the corner / midpoint opposite to the active anchor. Keep it
  // fixed at its current position from `newBox`.
  const pivot = anchorPivot(anchor, newBox)
  const x = pivot.fx === 0 ? pivot.px : pivot.px - width * pivot.fx
  const y = pivot.fy === 0 ? pivot.py : pivot.py - height * pivot.fy

  return { ...newBox, x, y, width, height }
}

function anchorPivot(
  anchor: Exclude<ResizeAnchor, null>,
  box: ResizeBox
): { px: number; py: number; fx: 0 | 0.5 | 1; fy: 0 | 0.5 | 1 } {
  // (fx, fy) is the fractional position of the pivot relative to the new box:
  //   x = pivotX - width * fx
  //   y = pivotY - height * fy
  // and (px, py) is the pivot's absolute position taken from the current box.
  switch (anchor) {
    case "top-left":
      return {
        px: box.x + box.width,
        py: box.y + box.height,
        fx: 1,
        fy: 1,
      }
    case "top-center":
      return {
        px: box.x + box.width / 2,
        py: box.y + box.height,
        fx: 0.5,
        fy: 1,
      }
    case "top-right":
      return { px: box.x, py: box.y + box.height, fx: 0, fy: 1 }
    case "middle-left":
      return {
        px: box.x + box.width,
        py: box.y + box.height / 2,
        fx: 1,
        fy: 0.5,
      }
    case "middle-right":
      return { px: box.x, py: box.y + box.height / 2, fx: 0, fy: 0.5 }
    case "bottom-left":
      return { px: box.x + box.width, py: box.y, fx: 1, fy: 0 }
    case "bottom-center":
      return { px: box.x + box.width / 2, py: box.y, fx: 0.5, fy: 0 }
    case "bottom-right":
      return { px: box.x, py: box.y, fx: 0, fy: 0 }
  }
}

function buildDimensionGuide(
  axis: "width" | "height",
  stop: DimensionStop,
  resultBox: ResizeBox
): DimensionGuide {
  return {
    axis,
    value: stop.value,
    draggedRect: {
      x: resultBox.x,
      y: resultBox.y,
      width: resultBox.width,
      height: resultBox.height,
    },
    matchedRect: stop.aabb,
  }
}

function applyCornerSnap(
  oldBox: ResizeBox,
  newBox: ResizeBox,
  anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right",
  axis: "x" | "y",
  edge: DraggedEdge["edge"],
  delta: number
): ResizeBox {
  const ratio = oldBox.width / Math.max(1, oldBox.height)
  let width = newBox.width
  let height = newBox.height

  if (axis === "x") {
    width = Math.max(0, edge === "start" ? width - delta : width + delta)
    height = width / ratio
  } else {
    height = Math.max(0, edge === "start" ? height - delta : height + delta)
    width = height * ratio
  }

  // Anchor at the opposite corner so resize grows away from the active handle.
  const anchorRight = anchor === "top-right" || anchor === "bottom-right"
  const anchorBottom = anchor === "bottom-left" || anchor === "bottom-right"
  const stationaryX = anchorRight ? newBox.x : newBox.x + newBox.width
  const stationaryY = anchorBottom ? newBox.y : newBox.y + newBox.height
  const x = anchorRight ? stationaryX : stationaryX - width
  const y = anchorBottom ? stationaryY : stationaryY - height

  return { ...newBox, x, y, width, height }
}

function applyEdgeSnap(
  box: ResizeBox,
  axis: "x" | "y",
  edge: DraggedEdge["edge"],
  delta: number
): ResizeBox {
  if (axis === "x") {
    if (edge === "start") return { ...box, x: box.x + delta, width: box.width - delta }
    if (edge === "end") return { ...box, width: box.width + delta }
    return { ...box, x: box.x + delta }
  }
  if (edge === "start") return { ...box, y: box.y + delta, height: box.height - delta }
  if (edge === "end") return { ...box, height: box.height + delta }
  return { ...box, y: box.y + delta }
}

function pushGuide(
  guides: GuideLine[],
  stop: SnapStop,
  box: ResizeBox,
  axis: "x" | "y",
  cache: SnapCache
) {
  if (axis === "x") {
    const [from, to] = spanForStop(
      stop,
      box.y,
      box.y + box.height,
      cache.artboard.height
    )
    guides.push({ axis: "x", value: stop.value, kind: stop.kind, from, to })
  } else {
    const [from, to] = spanForStop(
      stop,
      box.x,
      box.x + box.width,
      cache.artboard.width
    )
    guides.push({ axis: "y", value: stop.value, kind: stop.kind, from, to })
  }
}

export function snapToIntegerArtboardPixels(value: number): number {
  return Math.round(value)
}

export function gridSnapActive(
  scale: number,
  pixelGridVisibleFromScale: number
): boolean {
  return scale >= pixelGridVisibleFromScale
}

export type GridAxis = {
  start: number
  end: number
  step: number
}

export function snapToGrid(
  value: number,
  step: number,
  min: number,
  max: number
): number {
  const snapped = Math.round(value / step) * step
  if (snapped < min) return min
  if (snapped > max) return max
  return snapped
}

// Convenience: viewport AABB in artboard coords, used by callers that want to
// prune off-screen nodes from the snap cache.
export function viewportArtboardAABB(
  viewportSize: CanvasSize,
  viewTransform: { scale: number; x: number; y: number }
): AABB {
  if (viewTransform.scale <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  return {
    x: -viewTransform.x / viewTransform.scale,
    y: -viewTransform.y / viewTransform.scale,
    width: viewportSize.width / viewTransform.scale,
    height: viewportSize.height / viewTransform.scale,
  }
}
