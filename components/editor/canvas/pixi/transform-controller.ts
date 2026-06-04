import {
  getSelectionHandleScreenPositions,
  hitTestNodes,
  HANDLE_HIT_RADIUS,
  MARQUEE_DRAG_THRESHOLD,
  moveNodes,
  nodesInMarquee,
  normalizeRect,
  resizeSelection,
  rotateSelection,
  ROTATION_HIT_RADIUS,
  type ResizeHandle,
  type Vec2,
} from "@/lib/node-transform"
import {
  hasAdditiveSelectionModifier,
  isEditableTarget,
} from "../view-transform-utils"
import type {
  CanvasNode,
  NodeTransform,
  NodeTransformUpdate,
  ViewTransform,
} from "@/types/editor-canvas"

import type { CanvasScene, SelectionOverlayControl } from "./scene"

type TransformGestureKind = "move" | "resize" | "rotate"

type TransformGesture = {
  kind: TransformGestureKind
  /** Snapshot of selected nodes at gesture start. */
  nodes: CanvasNode[]
  /** Pointer position (host-local screen px) at gesture start. */
  startScreen: Vec2
  /** The dragged handle, for resize gestures. */
  handle?: ResizeHandle
  /** Latest computed transforms this gesture produced (committed on pointerup). */
  current?: NodeTransformUpdate[]
}

type MarqueeGesture = {
  kind: "marquee"
  startScreen: Vec2
  additive: boolean
  startSelectedIds: string[]
  moved: boolean
  currentIds: string[]
}

type Gesture = TransformGesture | MarqueeGesture

type TransformControllerOptions = {
  scene: CanvasScene
  getViewTransform: () => ViewTransform
  getNodes: () => CanvasNode[]
  getSelectedIds: () => string[]
  getIsSpacePressed: () => boolean
  onSelectionChange: (ids: string[]) => void
  onNodeTransformsCommit: (updates: NodeTransformUpdate[]) => void
  onRemoveNode: (id: string) => void
  onDuplicateSelectedNodes: () => void
  onSetSelectedNodesLocked: (locked: boolean) => void
  onTransformingChange: (isTransforming: boolean) => void
  onRotationPreview?: (rotation: number | null) => void
}

/** Nudge step (artboard px) for arrow keys; Shift uses the larger step. */
const NUDGE_STEP = 1
const NUDGE_STEP_LARGE = 10

/**
 * Owns selection + live transform gestures for canvas nodes. All input is DOM
 * (PixiJS events stay off); hit-testing uses pure math in `lib/node-transform`.
 * Mutates the scene directly each frame for smooth gestures and commits the
 * final transforms back to React once on pointerup.
 */
export class TransformController {
  private readonly scene: CanvasScene
  private readonly getViewTransform: () => ViewTransform
  private readonly getNodes: () => CanvasNode[]
  private readonly getSelectedIds: () => string[]
  private readonly getIsSpacePressed: () => boolean
  private readonly onSelectionChange: (ids: string[]) => void
  private readonly onNodeTransformsCommit: (
    updates: NodeTransformUpdate[]
  ) => void
  private readonly onRemoveNode: (id: string) => void
  private readonly onDuplicateSelectedNodes: () => void
  private readonly onSetSelectedNodesLocked: (locked: boolean) => void
  private readonly onTransformingChange: (isTransforming: boolean) => void
  private readonly onRotationPreview?: (rotation: number | null) => void

  private host: HTMLElement | null = null
  private activePointerId: number | null = null
  private gesture: Gesture | null = null
  private hoveredNodeId: string | null = null

  constructor(options: TransformControllerOptions) {
    this.scene = options.scene
    this.getViewTransform = options.getViewTransform
    this.getNodes = options.getNodes
    this.getSelectedIds = options.getSelectedIds
    this.getIsSpacePressed = options.getIsSpacePressed
    this.onSelectionChange = options.onSelectionChange
    this.onNodeTransformsCommit = options.onNodeTransformsCommit
    this.onRemoveNode = options.onRemoveNode
    this.onDuplicateSelectedNodes = options.onDuplicateSelectedNodes
    this.onSetSelectedNodesLocked = options.onSetSelectedNodesLocked
    this.onTransformingChange = options.onTransformingChange
    this.onRotationPreview = options.onRotationPreview
  }

  attach(host: HTMLElement) {
    this.host = host
    host.addEventListener("pointerdown", this.handlePointerDown)
    host.addEventListener("pointermove", this.handlePointerMove)
    host.addEventListener("pointerup", this.handlePointerUp)
    host.addEventListener("pointercancel", this.handlePointerUp)
    host.addEventListener("pointerleave", this.handlePointerLeave)
    window.addEventListener("keydown", this.handleKeyDown)
    window.addEventListener("blur", this.handleWindowBlur)
  }

  detach() {
    const host = this.host
    if (host) {
      host.removeEventListener("pointerdown", this.handlePointerDown)
      host.removeEventListener("pointermove", this.handlePointerMove)
      host.removeEventListener("pointerup", this.handlePointerUp)
      host.removeEventListener("pointercancel", this.handlePointerUp)
      host.removeEventListener("pointerleave", this.handlePointerLeave)
    }
    window.removeEventListener("keydown", this.handleKeyDown)
    window.removeEventListener("blur", this.handleWindowBlur)
    this.endGesture()
    this.clearHover()
    this.host = null
  }

  // ── pointer ────────────────────────────────────────────────────────────────

  private handlePointerDown = (event: PointerEvent) => {
    // Plain left-button only; pan (middle / Space+left) is the viewport's.
    if (event.button !== 0 || this.getIsSpacePressed()) {
      this.clearHover()
      return
    }

    const screen = this.toHostPoint(event)
    const view = this.getViewTransform()
    const nodes = this.getNodes()
    const selectedNodes = this.getSelectedNodes()
    const selectedLocked = isSelectionLocked(selectedNodes)
    const additiveSelection = hasAdditiveSelectionModifier(event)

    if (selectedNodes.length > 0 && !selectedLocked) {
      const hit = this.hitTestHandles(selectedNodes, screen, view)
      if (hit) {
        this.clearHover()
        this.beginTransformGesture(
          hit.kind,
          selectedNodes,
          screen,
          event,
          hit.kind === "resize" ? hit.handle : undefined
        )
        return
      }
    }

    const node = hitTestNodes(nodes, screen, view)
    if (node) {
      if (additiveSelection) {
        this.clearHover()
        this.toggleSelection(node.id)
        event.preventDefault()
        return
      }

      const selectedIds = this.getSelectedIds()
      const isSelected = selectedIds.includes(node.id)
      const nextIds = isSelected ? selectedIds : [node.id]
      this.clearHover()
      if (!isSelected) this.setSelection(nextIds)
      const gestureNodes = this.nodesForIds(nextIds)
      if (!isSelectionLocked(gestureNodes)) {
        this.beginTransformGesture("move", gestureNodes, screen, event)
      } else {
        event.preventDefault()
      }
      return
    }

    this.clearHover()
    this.beginMarqueeGesture(screen, event, additiveSelection)
  }

  private handlePointerMove = (event: PointerEvent) => {
    const gesture = this.gesture
    if (gesture && event.pointerId === this.activePointerId) {
      event.preventDefault()
      const screen = this.toHostPoint(event)
      const view = this.getViewTransform()

      if (gesture.kind === "marquee") {
        this.updateMarqueeGesture(gesture, screen, view)
        return
      }

      let updates: NodeTransformUpdate[]
      if (gesture.kind === "move") {
        updates = moveNodes(gesture.nodes, gesture.startScreen, screen, view, {
          axisLock: event.shiftKey,
        })
      } else if (gesture.kind === "resize") {
        updates = resizeSelection(
          gesture.nodes,
          gesture.handle!,
          screen,
          view,
          {
            fromCenter: event.altKey,
          }
        )
      } else {
        updates = rotateSelection(
          gesture.nodes,
          gesture.startScreen,
          screen,
          view,
          {
            snap: event.shiftKey,
          }
        )
        this.onRotationPreview?.(previewRotation(updates))
      }

      gesture.current = updates
      this.applyLiveUpdates(gesture.nodes, updates)
      return
    }
    if (!gesture) this.updateHoverCursor(event)
  }

  private handlePointerLeave = () => {
    this.clearHover()
    if (this.host) this.host.style.cursor = "default"
  }

  private handlePointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.activePointerId) return
    const gesture = this.gesture
    this.clearHover()
    this.endGesture()

    if (gesture?.kind === "marquee") {
      this.scene.drawMarqueeOverlay(null)
      if (gesture.moved) this.setSelection(gesture.currentIds)
      else if (!gesture.additive) this.setSelection([])
      else
        this.scene.drawSelectionOverlay(
          this.nodesForIds(gesture.startSelectedIds)
        )
      return
    }

    if (gesture?.current) this.onNodeTransformsCommit(gesture.current)
  }

  private handleWindowBlur = () => {
    const gesture = this.gesture
    this.clearHover()
    this.endGesture()
    this.scene.drawMarqueeOverlay(null)
    if (gesture?.kind === "marquee") {
      this.scene.drawSelectionOverlay(
        this.nodesForIds(gesture.startSelectedIds)
      )
      return
    }
    if (gesture?.current) this.onNodeTransformsCommit(gesture.current)
  }

  // ── keyboard ─────────────────────────────────────────────────────────────

  private handleKeyDown = (event: KeyboardEvent) => {
    if (isEditableTarget(event.target)) return

    const selectedIds = this.getSelectedIds()
    const selectedNodes = selectedIds.length > 0 ? this.getSelectedNodes() : []

    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      event.code === "KeyD" &&
      selectedNodes.length > 0
    ) {
      event.preventDefault()
      this.onDuplicateSelectedNodes()
      return
    }

    if (
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      event.code === "KeyL" &&
      selectedNodes.length > 0
    ) {
      event.preventDefault()
      const allLocked = selectedNodes.every((node) => node.locked)
      this.onSetSelectedNodesLocked(!allLocked)
      return
    }

    if (event.metaKey || event.ctrlKey || event.altKey) return

    if (event.key === "Escape") {
      event.preventDefault()
      if (this.gesture) {
        this.abortGesture()
      } else if (this.getSelectedIds().length > 0) {
        this.setSelection([])
      }
      return
    }

    if (selectedIds.length === 0) return
    if (selectedNodes.length === 0) return
    const editableNodes = selectedNodes.filter((node) => !node.locked)

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault()
      for (const node of editableNodes) this.onRemoveNode(node.id)
      if (editableNodes.length > 0) {
        const removed = new Set(editableNodes.map((node) => node.id))
        this.setSelection(selectedIds.filter((id) => !removed.has(id)))
      }
      return
    }

    const step = event.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP
    let dx = 0
    let dy = 0
    switch (event.key) {
      case "ArrowLeft":
        dx = -step
        break
      case "ArrowRight":
        dx = step
        break
      case "ArrowUp":
        dy = -step
        break
      case "ArrowDown":
        dy = step
        break
      default:
        return
    }
    event.preventDefault()
    if (editableNodes.length === 0) return
    const updates = editableNodes.map((node) => ({
      id: node.id,
      transform: { ...node, x: node.x + dx, y: node.y + dy },
    }))
    this.applyLiveUpdates(editableNodes, updates)
    this.onNodeTransformsCommit(updates)
  }

  // ── gesture lifecycle ──────────────────────────────────────────────────────

  private beginTransformGesture(
    kind: TransformGestureKind,
    nodes: CanvasNode[],
    startScreen: Vec2,
    event: PointerEvent,
    handle?: ResizeHandle
  ) {
    if (nodes.length === 0 || isSelectionLocked(nodes)) return
    this.gesture = {
      kind,
      nodes: nodes.map((node) => ({ ...node })),
      startScreen,
      handle,
    }
    this.activePointerId = event.pointerId
    this.host?.setPointerCapture(event.pointerId)
    this.scene.setActiveSelectionControl(activeControlForGesture(kind, handle))
    this.scene.setActiveDragIds(nodes.map((node) => node.id))
    this.onTransformingChange(true)
    if (kind === "rotate")
      this.onRotationPreview?.(previewRotationFromNodes(nodes))
    event.preventDefault()
  }

  private beginMarqueeGesture(
    startScreen: Vec2,
    event: PointerEvent,
    additive: boolean
  ) {
    const selectedIds = this.getSelectedIds()
    this.gesture = {
      kind: "marquee",
      startScreen,
      additive,
      startSelectedIds: selectedIds,
      moved: false,
      currentIds: selectedIds,
    }
    this.activePointerId = event.pointerId
    this.host?.setPointerCapture(event.pointerId)
    this.onTransformingChange(true)
    event.preventDefault()
  }

  private endGesture() {
    const wasRotating = this.gesture?.kind === "rotate"
    if (this.activePointerId !== null) {
      this.host?.releasePointerCapture?.(this.activePointerId)
    }
    this.activePointerId = null
    this.scene.setActiveDragIds([])
    this.scene.setActiveSelectionControl(null)
    this.onTransformingChange(false)
    this.gesture = null
    if (wasRotating) this.onRotationPreview?.(null)
  }

  /** Cancel the active gesture and restore nodes to their pre-gesture state. */
  private abortGesture() {
    const gesture = this.gesture
    this.endGesture()
    this.scene.drawMarqueeOverlay(null)
    if (!gesture) return
    if (gesture.kind === "marquee") {
      this.scene.drawSelectionOverlay(
        this.nodesForIds(gesture.startSelectedIds)
      )
      return
    }
    const updates = gesture.nodes.map((node) => ({
      id: node.id,
      transform: node,
    }))
    this.applyLiveUpdates(gesture.nodes, updates)
  }

  private updateMarqueeGesture(
    gesture: MarqueeGesture,
    screen: Vec2,
    view: ViewTransform
  ) {
    const dx = screen.x - gesture.startScreen.x
    const dy = screen.y - gesture.startScreen.y
    gesture.moved =
      gesture.moved || Math.hypot(dx, dy) >= MARQUEE_DRAG_THRESHOLD

    if (!gesture.moved) return

    const rect = normalizeRect(gesture.startScreen, screen)
    this.scene.drawMarqueeOverlay(rect)

    const hitIds = nodesInMarquee(
      this.getNodes(),
      gesture.startScreen,
      screen,
      view
    ).map((node) => node.id)
    gesture.currentIds = gesture.additive
      ? uniqueIds([...gesture.startSelectedIds, ...hitIds])
      : hitIds
    this.scene.drawSelectionOverlay(this.nodesForIds(gesture.currentIds))
  }

  // ── hit testing & helpers ──────────────────────────────────────────────────

  private hitTestHandles(
    nodes: CanvasNode[],
    screen: Vec2,
    view: ViewTransform
  ): { kind: "rotate" } | { kind: "resize"; handle: ResizeHandle } | null {
    const geo = getSelectionHandleScreenPositions(nodes, view)
    if (!geo) return null
    if (distance(screen, geo.rotation.knob) <= ROTATION_HIT_RADIUS) {
      return { kind: "rotate" }
    }
    for (const handle of geo.handles) {
      if (distance(screen, handle.screen) <= HANDLE_HIT_RADIUS) {
        return { kind: "resize", handle }
      }
    }
    return null
  }

  private updateHoverCursor(event: PointerEvent) {
    const host = this.host
    if (!host) return
    if (this.getIsSpacePressed()) {
      this.clearHover()
      return
    }

    const screen = this.toHostPoint(event)
    const view = this.getViewTransform()
    const selected = this.getSelectedNodes()
    const selectedIds = new Set(this.getSelectedIds())
    const selectedLocked = isSelectionLocked(selected)
    const hoveredNode = hitTestNodes(this.getNodes(), screen, view)
    const hoverOutlineNode =
      hoveredNode && !selectedIds.has(hoveredNode.id) ? hoveredNode : null

    let cursor = "default"
    if (selected.length > 0 && !selectedLocked) {
      const hit = this.hitTestHandles(selected, screen, view)
      if (hit?.kind === "rotate") cursor = "grab"
      else if (hit?.kind === "resize") {
        const rotation = selected.length === 1 ? selected[0].rotation : 0
        cursor = resizeCursor(hit.handle, rotation)
      }
    }
    if (cursor === "default" && hoveredNode && !hoveredNode.locked) {
      cursor = "move"
    }
    this.setHoverNode(hoverOutlineNode)
    host.style.cursor = cursor
  }

  private getSelectedNodes(): CanvasNode[] {
    return this.nodesForIds(this.getSelectedIds())
  }

  private nodesForIds(ids: string[]): CanvasNode[] {
    const selected = new Set(ids)
    return this.getNodes().filter((node) => selected.has(node.id))
  }

  private setSelection(ids: string[]) {
    const nextIds = uniqueIds(ids)
    this.onSelectionChange(nextIds)
    this.scene.drawSelectionOverlay(this.nodesForIds(nextIds))
  }

  private setHoverNode(node: CanvasNode | null) {
    const nextId = node?.id ?? null
    if (nextId === this.hoveredNodeId) return
    this.hoveredNodeId = nextId
    this.scene.drawHoverOverlay(node)
  }

  private clearHover() {
    if (!this.hoveredNodeId) return
    this.hoveredNodeId = null
    this.scene.drawHoverOverlay(null)
  }

  private toggleSelection(id: string) {
    const selected = this.getSelectedIds()
    const next = selected.includes(id)
      ? selected.filter((selectedId) => selectedId !== id)
      : [...selected, id]
    this.setSelection(next)
  }

  private applyLiveUpdates(
    startNodes: CanvasNode[],
    updates: NodeTransformUpdate[]
  ) {
    const byId = new Map<string, NodeTransform>()
    for (const update of updates) {
      byId.set(update.id, update.transform)
      this.scene.setNodeTransform(update.id, update.transform)
    }

    const nextNodes = startNodes.map((node) => ({
      ...node,
      ...(byId.get(node.id) ?? node),
    }))
    this.scene.drawSelectionOverlay(nextNodes)
  }

  private toHostPoint(event: { clientX: number; clientY: number }): Vec2 {
    const rect = this.host?.getBoundingClientRect()
    if (!rect) return { x: event.clientX, y: event.clientY }
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)]
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function isSelectionLocked(nodes: CanvasNode[]): boolean {
  return nodes.some((node) => node.locked)
}

function previewRotation(updates: NodeTransformUpdate[]): number | null {
  return updates[0]?.transform.rotation ?? null
}

function previewRotationFromNodes(nodes: CanvasNode[]): number | null {
  return nodes[0]?.rotation ?? null
}

function activeControlForGesture(
  kind: TransformGestureKind,
  handle?: ResizeHandle
): SelectionOverlayControl | null {
  if (kind === "resize") return handle?.id ?? null
  if (kind === "rotate") return "rotation"
  return null
}

/**
 * Pick the nearest of the 4 resize cursors for a handle, accounting for the
 * selection rotation (approximate — snapped to the 4 standard directions).
 */
function resizeCursor(handle: ResizeHandle, rotation: number): string {
  const angle = Math.atan2(handle.hy, handle.hx) + rotation
  const deg = ((((angle * 180) / Math.PI) % 180) + 180) % 180 // [0, 180)
  if (deg < 22.5 || deg >= 157.5) return "ew-resize"
  if (deg < 67.5) return "nwse-resize"
  if (deg < 112.5) return "ns-resize"
  return "nesw-resize"
}
