import { describe, expect, test } from "vitest"

import type { CanvasNode, ViewTransform } from "@/types/editor-canvas"

import {
  duplicateNodes,
  DUPLICATED_NODE_OFFSET,
  flipSelection,
  fromNodeLocal,
  getNodeCenter,
  getSelectionBounds,
  getSelectionHandleScreenPositions,
  getNodeWorldCorners,
  MIN_NODE_SIZE,
  moveNodes,
  nodesInMarquee,
  resizeNode,
  resizeSelection,
  rotateSelection,
  ROTATION_HANDLE_OFFSET,
  ROTATION_SNAP_RAD,
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

function cropContent(
  partial: Partial<NonNullable<CanvasNode["contentTransform"]>> = {}
) {
  return {
    x: 0,
    y: 0,
    scale: 1,
    naturalWidth: 100,
    naturalHeight: 50,
    ...partial,
  }
}

function byId(updates: ReturnType<typeof moveNodes>, id: string) {
  const update = updates.find((item) => item.id === id)
  if (!update) throw new Error(`Missing update for ${id}`)
  return update.transform
}

function closeTo(actual: number, expected: number) {
  expect(actual).toBeCloseTo(expected, 5)
}

function mediaTopLeftWorld(transform: CanvasNode) {
  const content = transform.contentTransform
  if (!content) throw new Error("Missing content transform")
  const frameTopLeft = getNodeWorldCorners(transform)[0]
  const cos = Math.cos(transform.rotation)
  const sin = Math.sin(transform.rotation)
  return {
    x: frameTopLeft.x + content.x * cos - content.y * sin,
    y: frameTopLeft.y + content.x * sin + content.y * cos,
  }
}

describe("node transform geometry", () => {
  test("resizes a single node from the opposite anchor", () => {
    const next = resizeNode(
      node("a"),
      { hx: 1, hy: 1 },
      { x: 150, y: 100 },
      view
    )

    closeTo(next.x, 0)
    closeTo(next.y, 0)
    closeTo(next.width, 200)
    closeTo(next.height, 100)
  })

  test("resizes a side handle without stretching the node", () => {
    const next = resizeNode(
      node("a"),
      { hx: 1, hy: 0 },
      { x: 200, y: 25 },
      view
    )

    closeTo(next.x, 0)
    closeTo(next.y, -25)
    closeTo(next.width, 200)
    closeTo(next.height, 100)
    closeTo(next.width / next.height, 2)
  })

  test("center resize keeps the node center fixed", () => {
    const start = node("a")
    const next = resizeNode(start, { hx: 1, hy: 1 }, { x: 125, y: 75 }, view, {
      fromCenter: true,
    })

    closeTo(next.x + next.width / 2, start.x + start.width / 2)
    closeTo(next.y + next.height / 2, start.y + start.height / 2)
    closeTo(next.width, 200)
    closeTo(next.height, 100)
  })

  test("crops a video frame from the right side without scaling content", () => {
    const [update] = resizeSelection(
      [
        node("video", {
          type: "video",
          contentTransform: cropContent(),
        }),
      ],
      { id: "e", hx: 1, hy: 0 },
      { x: 70, y: 25 },
      view
    )
    const next = update.transform

    closeTo(next.x, 0)
    closeTo(next.y, 0)
    closeTo(next.width, 70)
    closeTo(next.height, 50)
    expect(next.contentTransform).toEqual(cropContent())
  })

  test("crops a video frame from the left side and keeps media pinned", () => {
    const [update] = resizeSelection(
      [
        node("video", {
          type: "video",
          contentTransform: cropContent(),
        }),
      ],
      { id: "w", hx: -1, hy: 0 },
      { x: 30, y: 25 },
      view
    )
    const next = update.transform

    closeTo(next.x, 30)
    closeTo(next.y, 0)
    closeTo(next.width, 70)
    closeTo(next.height, 50)
    expect(next.contentTransform).toEqual(cropContent({ x: -30 }))
  })

  test("recovers a left crop only up to the media edge", () => {
    const [update] = resizeSelection(
      [
        node("video", {
          type: "video",
          x: 30,
          width: 70,
          contentTransform: cropContent({ x: -30 }),
        }),
      ],
      { id: "w", hx: -1, hy: 0 },
      { x: -40, y: 25 },
      view
    )
    const next = update.transform

    closeTo(next.x, 0)
    closeTo(next.width, 100)
    expect(next.contentTransform).toEqual(cropContent())
  })

  test("recovers a right crop only up to the media edge", () => {
    const [update] = resizeSelection(
      [
        node("video", {
          type: "video",
          width: 70,
          contentTransform: cropContent(),
        }),
      ],
      { id: "e", hx: 1, hy: 0 },
      { x: 140, y: 25 },
      view
    )
    const next = update.transform

    closeTo(next.x, 0)
    closeTo(next.width, 100)
    expect(next.contentTransform).toEqual(cropContent())
  })

  test("crops a video frame from the top side and keeps media pinned", () => {
    const [update] = resizeSelection(
      [
        node("video", {
          type: "video",
          contentTransform: cropContent(),
        }),
      ],
      { id: "n", hx: 0, hy: -1 },
      { x: 50, y: 10 },
      view
    )
    const next = update.transform

    closeTo(next.x, 0)
    closeTo(next.y, 10)
    closeTo(next.width, 100)
    closeTo(next.height, 40)
    expect(next.contentTransform).toEqual(cropContent({ y: -10 }))
  })

  test("recovers a top crop only up to the media edge", () => {
    const [update] = resizeSelection(
      [
        node("video", {
          type: "video",
          y: 10,
          height: 40,
          contentTransform: cropContent({ y: -10 }),
        }),
      ],
      { id: "n", hx: 0, hy: -1 },
      { x: 50, y: -30 },
      view
    )
    const next = update.transform

    closeTo(next.y, 0)
    closeTo(next.height, 50)
    expect(next.contentTransform).toEqual(cropContent())
  })

  test("recovers a bottom crop only up to the media edge", () => {
    const [update] = resizeSelection(
      [
        node("video", {
          type: "video",
          height: 40,
          contentTransform: cropContent(),
        }),
      ],
      { id: "s", hx: 0, hy: 1 },
      { x: 50, y: 80 },
      view
    )
    const next = update.transform

    closeTo(next.y, 0)
    closeTo(next.height, 50)
    expect(next.contentTransform).toEqual(cropContent())
  })

  test("crops a rotated video frame while keeping media pinned", () => {
    const start = node("video", {
      type: "video",
      rotation: Math.PI / 2,
      contentTransform: cropContent(),
    })
    const anchor = fromNodeLocal(
      { x: start.width / 2, y: 0 },
      getNodeCenter(start),
      start.rotation
    )
    const pointer = fromNodeLocal({ x: -70, y: 0 }, anchor, start.rotation)

    const [update] = resizeSelection(
      [start],
      { id: "w", hx: -1, hy: 0 },
      pointer,
      view
    )
    const next = update.transform as CanvasNode
    const before = mediaTopLeftWorld(start)
    const after = mediaTopLeftWorld({ ...start, ...next })

    closeTo(next.width, 70)
    closeTo(next.height, 50)
    closeTo(after.x, before.x)
    closeTo(after.y, before.y)
    expect(next.contentTransform?.scale).toBe(1)
  })

  test("crops a video frame from center with Alt without scaling content", () => {
    const [update] = resizeSelection(
      [
        node("video", {
          type: "video",
          contentTransform: cropContent(),
        }),
      ],
      { id: "e", hx: 1, hy: 0 },
      { x: 80, y: 25 },
      view,
      { fromCenter: true }
    )
    const next = update.transform

    closeTo(next.x, 20)
    closeTo(next.y, 0)
    closeTo(next.width, 60)
    closeTo(next.height, 50)
    expect(next.contentTransform).toEqual(cropContent({ x: -20 }))
  })

  test("scales video content uniformly during corner resize", () => {
    const [update] = resizeSelection(
      [
        node("video", {
          type: "video",
          contentTransform: cropContent({ x: -10, y: -5 }),
        }),
      ],
      { id: "se", hx: 1, hy: 1 },
      { x: 150, y: 100 },
      view
    )
    const next = update.transform

    closeTo(next.width, 200)
    closeTo(next.height, 100)
    expect(next.contentTransform).toEqual(
      cropContent({ x: -20, y: -10, scale: 2 })
    )
  })

  test("keeps dimensions positive and toggles flip when a handle crosses the anchor", () => {
    const next = resizeNode(
      node("a"),
      { hx: 1, hy: 0 },
      { x: -40, y: 25 },
      view
    )

    closeTo(next.x, -64)
    closeTo(next.y, 9)
    closeTo(next.width, 64)
    closeTo(next.height, 32)
    closeTo(next.width / next.height, 2)
    expect(next.flipX).toBe(true)
  })

  test("clamps single-node resize to minimum size", () => {
    const next = resizeNode(node("a"), { hx: 1, hy: 1 }, { x: 1, y: 1 }, view)

    expect(next.width).toBe(MIN_NODE_SIZE * 2)
    expect(next.height).toBe(MIN_NODE_SIZE)
  })

  test("moves a multi-selection with Shift axis lock", () => {
    const updates = moveNodes(
      [node("a"), node("b", { x: 200 })],
      { x: 0, y: 0 },
      { x: 30, y: 10 },
      view,
      { axisLock: true }
    )

    closeTo(byId(updates, "a").x, 30)
    closeTo(byId(updates, "a").y, 0)
    closeTo(byId(updates, "b").x, 230)
    closeTo(byId(updates, "b").y, 0)
  })

  test("resizes a multi-selection around the group bounds", () => {
    const start = [node("a"), node("b", { x: 100, width: 100 })]
    const updates = resizeSelection(
      start,
      { id: "e", hx: 1, hy: 0 },
      { x: 400, y: 25 },
      view
    )
    const nextBounds = getSelectionBounds(
      updates.map((update) => update.transform)
    )

    expect(nextBounds).not.toBeNull()
    closeTo(nextBounds!.x, 0)
    closeTo(nextBounds!.y, -25)
    closeTo(nextBounds!.width, 400)
    closeTo(nextBounds!.height, 100)
    closeTo(byId(updates, "b").width, 200)
    closeTo(byId(updates, "b").height, 100)
    closeTo(byId(updates, "b").width / byId(updates, "b").height, 2)
  })

  test("scales cropped media content uniformly during multi-selection resize", () => {
    const updates = resizeSelection(
      [
        node("a", {
          type: "video",
          contentTransform: cropContent({ x: -12, y: -6 }),
        }),
        node("b", { x: 100, width: 100 }),
      ],
      { id: "e", hx: 1, hy: 0 },
      { x: 400, y: 25 },
      view
    )

    expect(byId(updates, "a").contentTransform).toEqual(
      cropContent({ x: -24, y: -12, scale: 2 })
    )
  })

  test("rotates a multi-selection around its bounds center", () => {
    const updates = rotateSelection(
      [node("a"), node("b", { x: 200 })],
      { x: 150, y: -50 },
      { x: 200, y: 25 },
      view,
      { snap: true }
    )

    closeTo(byId(updates, "a").rotation, ROTATION_SNAP_RAD * 2)
    closeTo(byId(updates, "b").rotation, ROTATION_SNAP_RAD * 2)
  })

  test("places the rotation handle below the selected bounds", () => {
    const single = getSelectionHandleScreenPositions([node("a")], view)
    const group = getSelectionHandleScreenPositions(
      [node("a"), node("b", { x: 200 })],
      view
    )

    expect(single).not.toBeNull()
    expect(group).not.toBeNull()
    closeTo(single!.rotation.anchor.x, 50)
    closeTo(single!.rotation.anchor.y, 50)
    closeTo(single!.rotation.knob.x, 50)
    closeTo(single!.rotation.knob.y, 50 + ROTATION_HANDLE_OFFSET)
    closeTo(group!.rotation.anchor.x, 150)
    closeTo(group!.rotation.anchor.y, 50)
    closeTo(group!.rotation.knob.x, 150)
    closeTo(group!.rotation.knob.y, 50 + ROTATION_HANDLE_OFFSET)
  })

  test("flips a multi-selection horizontally around group center", () => {
    const updates = flipSelection(
      [node("a", { x: 0, width: 50 }), node("b", { x: 150, width: 50 })],
      "horizontal"
    )

    closeTo(byId(updates, "a").x, 150)
    closeTo(byId(updates, "b").x, 0)
    expect(byId(updates, "a").flipX).toBe(true)
    expect(byId(updates, "b").flipX).toBe(true)
  })

  test("duplicates selected editable nodes after their originals", () => {
    const result = duplicateNodes(
      [
        node("a", { x: 10, y: 20 }),
        node("b", { x: 100, y: 120, locked: true }),
      ],
      ["a", "b"],
      (source) => `${source.id}-copy`
    )

    expect(result.nodes.map((item) => item.id)).toEqual(["a", "a-copy", "b"])
    expect(result.selectedIds).toEqual(["a-copy"])
    expect(result.nodes[1].x).toBe(10 + DUPLICATED_NODE_OFFSET)
    expect(result.nodes[1].y).toBe(20 + DUPLICATED_NODE_OFFSET)
    expect(result.nodes[1].locked).toBe(false)
  })

  test("marquee selects nodes whose bounds intersect the drag rectangle", () => {
    const hits = nodesInMarquee(
      [node("a", { x: 10, y: 10 }), node("b", { x: 300, y: 300 })],
      { x: 0, y: 0 },
      { x: 120, y: 80 },
      view
    )

    expect(hits.map((hit) => hit.id)).toEqual(["a"])
  })
})
