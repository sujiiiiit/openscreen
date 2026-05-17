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

function snapScreenValue(value: number) {
  const pixelRatio =
    typeof window === "undefined"
      ? 1
      : Math.max(1, window.devicePixelRatio || 1)

  return Math.round(value * pixelRatio) / pixelRatio
}

export function snapViewTransformToScreenPixels(
  viewTransform: ViewTransform
): ViewTransform {
  return {
    ...viewTransform,
    x: snapScreenValue(viewTransform.x),
    y: snapScreenValue(viewTransform.y),
  }
}
