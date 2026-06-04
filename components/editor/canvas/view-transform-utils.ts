import type { ViewTransform } from "@/types/editor-canvas"

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false

  return Boolean(
    target.closest("input, textarea, select, button, [contenteditable='true']")
  )
}

export function hasZoomModifier(event: WheelEvent | KeyboardEvent) {
  return event.metaKey || event.ctrlKey
}

/** The modifier that adds/removes nodes instead of replacing the selection. */
export function hasAdditiveSelectionModifier(
  event: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">
) {
  return event.shiftKey || event.metaKey || event.ctrlKey
}

function snapScreenValue(value: number) {
  const pixelRatio =
    typeof window === "undefined"
      ? 1
      : Math.max(1, window.devicePixelRatio || 1)

  return Math.round(value * pixelRatio) / pixelRatio
}

const SCALE_QUANTUM = 1e-4

function snapScale(scale: number) {
  return Math.round(scale / SCALE_QUANTUM) * SCALE_QUANTUM
}

export function snapViewTransformToScreenPixels(
  viewTransform: ViewTransform
): ViewTransform {
  return {
    scale: snapScale(viewTransform.scale),
    x: snapScreenValue(viewTransform.x),
    y: snapScreenValue(viewTransform.y),
  }
}
