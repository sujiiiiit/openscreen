import { hitTestNodes, type Vec2 } from "@/lib/node-transform"
import { ARTBOARD_SELECTION_ID } from "@/types/editor-canvas"
import type { CanvasNode, ViewTransform } from "@/types/editor-canvas"

import type { CanvasScene } from "./scene"

type SelectionControllerOptions = {
  scene: CanvasScene
  getViewTransform: () => ViewTransform
  getNodes: () => CanvasNode[]
  /** The artboard as a synthetic node (id = ARTBOARD_SELECTION_ID) — the hit-test fallback behind every video. */
  getArtboardNode: () => CanvasNode
  getSelectedId: () => string | null
  getIsSpacePressed: () => boolean
  onSelect: (id: string | null) => void
}

/**
 * Hover + click-to-select for canvas nodes — the only node interaction the
 * canvas supports. Placement is fully derived from the artboard settings
 * (`lib/video-placement.ts`); there are no move/resize/rotate gestures, so
 * this controller never mutates node transforms. All input is DOM (PixiJS
 * events stay off); hit-testing uses pure math in `lib/node-transform`.
 *
 * Hit priority: videos (top-most z first), then the artboard itself (clicking
 * the empty artboard / padding margin selects it, routing the sidebar to the
 * Background tab), then the pasteboard (deselect). The artboard participates
 * as a synthetic `CanvasNode` so hover/selection outlines reuse the exact
 * node-overlay path.
 *
 * Scale note: hover hit-testing is O(n) over the node list per pointermove.
 * Fine for today's node counts; if scenes ever approach the 5000+-node stress
 * case, swap `hitTestNodes` for a spatial index without touching this class's
 * surface.
 */
export class SelectionController {
  private readonly scene: CanvasScene
  private readonly getViewTransform: () => ViewTransform
  private readonly getNodes: () => CanvasNode[]
  private readonly getArtboardNode: () => CanvasNode
  private readonly getSelectedId: () => string | null
  private readonly getIsSpacePressed: () => boolean
  private readonly onSelect: (id: string | null) => void

  private host: HTMLElement | null = null
  private hoveredNodeId: string | null = null

  constructor(options: SelectionControllerOptions) {
    this.scene = options.scene
    this.getViewTransform = options.getViewTransform
    this.getNodes = options.getNodes
    this.getArtboardNode = options.getArtboardNode
    this.getSelectedId = options.getSelectedId
    this.getIsSpacePressed = options.getIsSpacePressed
    this.onSelect = options.onSelect
  }

  attach(host: HTMLElement) {
    this.host = host
    host.addEventListener("pointerdown", this.handlePointerDown)
    host.addEventListener("pointermove", this.handlePointerMove)
    host.addEventListener("pointerleave", this.handlePointerLeave)
  }

  detach() {
    const host = this.host
    if (host) {
      host.removeEventListener("pointerdown", this.handlePointerDown)
      host.removeEventListener("pointermove", this.handlePointerMove)
      host.removeEventListener("pointerleave", this.handlePointerLeave)
    }
    this.clearHoverOutline()
    this.host = null
  }

  private handlePointerDown = (event: PointerEvent) => {
    // Plain left-button only; pan (middle / Space+left) is the viewport's,
    // and the viewport owns the cursor while a pan is armed.
    if (event.button !== 0 || this.getIsSpacePressed()) {
      this.clearHoverOutline()
      return
    }
    const node = this.hitTest(event)
    // The clicked node is now selected — the selection outline replaces the
    // hover outline.
    if (node) this.clearHoverOutline()
    this.onSelect(node?.id ?? null)
  }

  private handlePointerMove = (event: PointerEvent) => {
    if (this.getIsSpacePressed()) {
      this.clearHoverOutline()
      return
    }
    const node = this.hitTest(event)
    // Pointer cursor only over videos; the artboard keeps the default arrow —
    // its hover outline is the selectable affordance.
    this.setCursor(
      node && node.id !== ARTBOARD_SELECTION_ID ? "pointer" : "default"
    )
    // The selected node already shows the selection outline; hover chrome on
    // top of it is noise.
    this.setHoverNode(node && node.id !== this.getSelectedId() ? node : null)
  }

  /** Videos first (top-most z wins), then the artboard, then nothing. */
  private hitTest(event: PointerEvent): CanvasNode | null {
    const screen = this.toHostPoint(event)
    const view = this.getViewTransform()
    return (
      hitTestNodes(this.getNodes(), screen, view) ??
      hitTestNodes([this.getArtboardNode()], screen, view)
    )
  }

  private handlePointerLeave = () => {
    this.clearHoverOutline()
    this.setCursor("default")
  }

  private setHoverNode(node: CanvasNode | null) {
    const nextId = node?.id ?? null
    if (nextId === this.hoveredNodeId) return
    this.hoveredNodeId = nextId
    this.scene.drawHoverOverlay(node)
  }

  private clearHoverOutline() {
    if (this.hoveredNodeId === null) return
    this.hoveredNodeId = null
    this.scene.drawHoverOverlay(null)
  }

  private setCursor(cursor: string) {
    if (this.host) this.host.style.cursor = cursor
  }

  private toHostPoint(event: { clientX: number; clientY: number }): Vec2 {
    const rect = this.host?.getBoundingClientRect()
    if (!rect) return { x: event.clientX, y: event.clientY }
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
}
