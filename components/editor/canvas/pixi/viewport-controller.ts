import {
  clampWorkspaceView,
  getFitViewTransform,
  getZoomedViewTransform,
  WORKSPACE_PINCH_ZOOM_DELTA,
  WORKSPACE_WHEEL_ZOOM_DELTA,
  WORKSPACE_ZOOM_STEP,
} from "@/lib/editor-canvas"
import type { CanvasSize, ViewTransform } from "@/types/editor-canvas"

import {
  hasZoomModifier,
  isEditableTarget,
  snapViewTransformToScreenPixels,
} from "../view-transform-utils"
import type { CanvasScene } from "./scene"

type Point = { x: number; y: number }

type ViewportControllerOptions = {
  scene: CanvasScene
  /** Current viewport (canvas host) size in CSS pixels. */
  getViewportSize: () => CanvasSize
  /** Notified (rAF-throttled) whenever a gesture changes the transform, for UI + session state. */
  onChange: (viewTransform: ViewTransform) => void
  /**
   * Keyboard zoom/pan shortcuts. Disabled during the migration coexistence
   * phase so they don't double-fire with editor-workspace's existing window
   * handler; enabled once Konva (and its handler) is removed.
   */
  keyboardEnabled?: boolean
}

/** Wheel line/page deltas normalized to pixels so mouse wheels feel like trackpads. */
const LINE_HEIGHT = 16

function viewEquals(a: ViewTransform, b: ViewTransform): boolean {
  return a.scale === b.scale && a.x === b.x && a.y === b.y
}

/**
 * Owns the live viewport transform and the input that drives it — wheel/pinch
 * zoom, trackpad and drag panning, and (optionally) keyboard shortcuts. Gesture
 * mutations funnel through {@link setViewTransform}, which clamps, pixel-snaps,
 * pushes the result to the scene imperatively (no React in the hot path), and
 * notifies the provider for UI + session state.
 *
 * External transform changes (footer zoom menu, fit, artboard preset, preview
 * fill-fit) flow back the other way via {@link setExternalViewTransform}, which
 * applies to the scene WITHOUT re-notifying — so there is no feedback loop with
 * the provider that owns the persisted view state.
 */
export class ViewportController {
  private readonly scene: CanvasScene
  private readonly getViewportSize: () => CanvasSize
  private readonly onChange: (viewTransform: ViewTransform) => void
  private readonly keyboardEnabled: boolean

  private host: HTMLElement | null = null
  private viewTransform: ViewTransform = { scale: 1, x: 0, y: 0 }

  private previewMode = false
  private isSpacePressed = false
  private isPanning = false
  private activePointerId: number | null = null
  private lastPanPoint: Point | null = null

  private notifyRaf: number | null = null
  private pendingNotify: ViewTransform | null = null
  /** Whether a transform has been applied to the scene at least once. */
  private appliedOnce = false

  constructor(options: ViewportControllerOptions) {
    this.scene = options.scene
    this.getViewportSize = options.getViewportSize
    this.onChange = options.onChange
    this.keyboardEnabled = options.keyboardEnabled ?? false
  }

  attach(host: HTMLElement) {
    this.host = host
    host.addEventListener("wheel", this.handleWheel, { passive: false })
    host.addEventListener("pointerdown", this.handlePointerDown)
    host.addEventListener("pointermove", this.handlePointerMove)
    host.addEventListener("pointerup", this.handlePointerUp)
    host.addEventListener("pointercancel", this.handlePointerUp)
    host.addEventListener("contextmenu", this.handleContextMenu)
    window.addEventListener("keydown", this.handleKeyDown)
    window.addEventListener("keyup", this.handleKeyUp)
    window.addEventListener("blur", this.handleWindowBlur)
    this.updateCursor()
  }

  detach() {
    const host = this.host
    if (host) {
      host.removeEventListener("wheel", this.handleWheel)
      host.removeEventListener("pointerdown", this.handlePointerDown)
      host.removeEventListener("pointermove", this.handlePointerMove)
      host.removeEventListener("pointerup", this.handlePointerUp)
      host.removeEventListener("pointercancel", this.handlePointerUp)
      host.removeEventListener("contextmenu", this.handleContextMenu)
    }
    window.removeEventListener("keydown", this.handleKeyDown)
    window.removeEventListener("keyup", this.handleKeyUp)
    window.removeEventListener("blur", this.handleWindowBlur)
    if (this.notifyRaf !== null) {
      cancelAnimationFrame(this.notifyRaf)
      this.notifyRaf = null
    }
    this.host = null
  }

  getViewTransform(): ViewTransform {
    return this.viewTransform
  }

  /** Single source of truth for Space-to-pan, shared with the TransformController. */
  isSpaceActive(): boolean {
    return this.isSpacePressed
  }

  setPreviewMode(previewMode: boolean) {
    this.previewMode = previewMode
    if (previewMode) {
      this.endPan()
      this.isSpacePressed = false
      this.updateCursor()
    }
  }

  /** Re-apply the current transform against the current viewport (clamps to it). */
  handleResize() {
    this.setViewTransform(this.viewTransform)
  }

  fit() {
    this.setViewTransform(
      getFitViewTransform(this.getViewportSize(), this.scene.getArtboardSize())
    )
  }

  zoomToScale(scale: number, anchor?: Point) {
    const viewport = this.getViewportSize()
    const point = anchor ?? { x: viewport.width / 2, y: viewport.height / 2 }
    this.setViewTransform(
      getZoomedViewTransform(this.viewTransform, point, scale)
    )
  }

  zoomBy(factor: number, anchor?: Point) {
    this.zoomToScale(this.viewTransform.scale * factor, anchor)
  }

  /** A gesture-driven change: clamp, snap, apply to the scene, and notify the provider. */
  setViewTransform(next: ViewTransform) {
    const viewport = this.getViewportSize()
    const clamped = snapViewTransformToScreenPixels(
      clampWorkspaceView(next, viewport, this.scene.getArtboardSize())
    )
    this.viewTransform = clamped
    this.appliedOnce = true
    this.scene.applyView(clamped, viewport)
    this.scheduleNotify(clamped)
  }

  /**
   * An external change (provider-owned: fit, footer zoom, preset, preview). Apply
   * to the scene without notifying back, so the provider stays the source of
   * truth without a feedback loop. Already-equal values are ignored.
   */
  setExternalViewTransform(next: ViewTransform) {
    if (this.appliedOnce && viewEquals(next, this.viewTransform)) return
    this.appliedOnce = true
    this.viewTransform = next
    this.scene.applyView(next, this.getViewportSize())
  }

  // ── input handlers ───────────────────────────────────────────────────────

  private handleWheel = (event: WheelEvent) => {
    if (this.previewMode) return
    event.preventDefault()
    const point = this.toLocalPoint(event)

    const scale =
      event.deltaMode === 1
        ? LINE_HEIGHT
        : event.deltaMode === 2
          ? this.getViewportSize().height || LINE_HEIGHT
          : 1
    let dx = event.deltaX * scale
    let dy = event.deltaY * scale

    if (hasZoomModifier(event)) {
      // Trackpad pinch arrives as ctrl+wheel (without meta) and is much finer.
      const step =
        event.ctrlKey && !event.metaKey
          ? WORKSPACE_PINCH_ZOOM_DELTA
          : WORKSPACE_WHEEL_ZOOM_DELTA
      const nextScale =
        this.viewTransform.scale * Math.pow(WORKSPACE_ZOOM_STEP, -dy / step)
      this.setViewTransform(
        getZoomedViewTransform(this.viewTransform, point, nextScale)
      )
      return
    }

    // Shift turns a vertical mouse wheel into horizontal panning.
    if (event.shiftKey && dx === 0) {
      dx = dy
      dy = 0
    }

    this.setViewTransform({
      scale: this.viewTransform.scale,
      x: this.viewTransform.x - dx,
      y: this.viewTransform.y - dy,
    })
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (this.previewMode) return
    const panButton =
      event.button === 1 || (event.button === 0 && this.isSpacePressed)
    if (!panButton) return

    event.preventDefault()
    this.isPanning = true
    this.activePointerId = event.pointerId
    this.lastPanPoint = this.toLocalPoint(event)
    this.host?.setPointerCapture(event.pointerId)
    this.updateCursor()
  }

  private handlePointerMove = (event: PointerEvent) => {
    if (!this.isPanning || event.pointerId !== this.activePointerId) return
    const point = this.toLocalPoint(event)
    const last = this.lastPanPoint
    if (!last) return

    this.setViewTransform({
      scale: this.viewTransform.scale,
      x: this.viewTransform.x + (point.x - last.x),
      y: this.viewTransform.y + (point.y - last.y),
    })
    this.lastPanPoint = point
  }

  private handlePointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.activePointerId) return
    this.endPan()
  }

  private handleContextMenu = (event: MouseEvent) => {
    // Don't pop the OS menu out of a middle-button / space pan gesture.
    if (this.isPanning) event.preventDefault()
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (this.previewMode) return
    if (isEditableTarget(event.target)) return

    // Space-to-pan is tracked even when the keyboard shortcuts are otherwise
    // delegated to editor-workspace, so the pointer pan gesture knows the mode.
    if (event.code === "Space") {
      const noMods =
        !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
      if (noMods) {
        event.preventDefault()
        if (!this.isSpacePressed) {
          this.isSpacePressed = true
          this.updateCursor()
        }
      }
    }

    if (!this.keyboardEnabled) return

    if (hasZoomModifier(event)) {
      switch (event.code) {
        case "Equal":
        case "NumpadAdd":
          event.preventDefault()
          this.zoomBy(WORKSPACE_ZOOM_STEP)
          return
        case "Minus":
        case "NumpadSubtract":
          event.preventDefault()
          this.zoomBy(1 / WORKSPACE_ZOOM_STEP)
          return
        case "Digit0":
        case "Numpad0":
          event.preventDefault()
          this.zoomToScale(1)
          return
      }
      return
    }

    if (event.shiftKey && !event.altKey) {
      if (event.code === "KeyF") {
        event.preventDefault()
        this.fit()
        return
      }
      if (event.code === "Digit2" || event.code === "Numpad2") {
        event.preventDefault()
        this.zoomToScale(2)
        return
      }
    }
  }

  private handleKeyUp = (event: KeyboardEvent) => {
    if (event.code !== "Space") return
    this.isSpacePressed = false
    if (!this.isPanning) this.updateCursor()
  }

  private handleWindowBlur = () => {
    this.isSpacePressed = false
    this.endPan()
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private endPan() {
    if (this.activePointerId !== null) {
      this.host?.releasePointerCapture?.(this.activePointerId)
    }
    this.isPanning = false
    this.activePointerId = null
    this.lastPanPoint = null
    this.updateCursor()
  }

  private updateCursor() {
    if (!this.host) return
    this.host.style.cursor = this.isPanning
      ? "grabbing"
      : this.isSpacePressed
        ? "grab"
        : "default"
  }

  private toLocalPoint(event: { clientX: number; clientY: number }): Point {
    const rect = this.host?.getBoundingClientRect()
    if (!rect) return { x: event.clientX, y: event.clientY }
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private scheduleNotify(viewTransform: ViewTransform) {
    this.pendingNotify = viewTransform
    if (this.notifyRaf !== null) return
    this.notifyRaf = requestAnimationFrame(() => {
      this.notifyRaf = null
      const next = this.pendingNotify
      this.pendingNotify = null
      if (next) this.onChange(next)
    })
  }
}
