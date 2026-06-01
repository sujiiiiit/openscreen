import Konva from "konva"

import {
  ZOOM_RADIAL_BLUR_SETTINGS_DEFAULT,
  clampZoomFocus,
  clampZoomRadialBlurSettings,
  clampZoomScale,
  clampZoomTransitionSettings,
  withZoomClipDefaults,
  zoomRadialBlurSettingsEqual,
  type CanvasZoomClipInput,
} from "@/lib/zoom-clips"
import type {
  CanvasZoomClip,
  CanvasZoomFocus,
  CanvasZoomRadialBlurSettings,
  CanvasZoomTransitionCurve,
} from "@/types/editor-canvas"

const ZOOM_IDENTITY_EPSILON = 1e-4

type ArtboardSize = { width: number; height: number }

export type ZoomCamera = {
  scale: number
  offsetX: number
  offsetY: number
  radialBlur: number
  radialBlurSettings: CanvasZoomRadialBlurSettings
  clipId: string | null
}

export type ZoomVisibleWindow = {
  x: number
  y: number
  width: number
  height: number
}

export const IDENTITY_ZOOM_CAMERA: ZoomCamera = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  radialBlur: 0,
  radialBlurSettings: ZOOM_RADIAL_BLUR_SETTINGS_DEFAULT,
  clipId: null,
}

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value))
}

function smoothstep(value: number) {
  const t = clampUnit(value)
  return t * t * (3 - 2 * t)
}

function smootherstep(value: number) {
  const t = clampUnit(value)
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function easeOutCubic(value: number) {
  const t = clampUnit(value)
  return 1 - Math.pow(1 - t, 3)
}

function transitionCurveValue(curve: CanvasZoomTransitionCurve, value: number) {
  switch (curve) {
    case "linear":
      return clampUnit(value)
    case "smootherstep":
      return smootherstep(value)
    case "ease-out-cubic":
      return easeOutCubic(value)
    case "smoothstep":
    default:
      return smoothstep(value)
  }
}

function transitionMotion(curve: CanvasZoomTransitionCurve, value: number) {
  const t = Math.min(1, Math.max(0, value))
  const dt = 1 / 240
  const before = transitionCurveValue(curve, t - dt)
  const after = transitionCurveValue(curve, t + dt)
  const speed = Math.abs(after - before) / (dt * 2)
  return Math.min(1, Math.sin(Math.PI * t) * Math.max(0.35, speed / 1.5))
}

function easeTiming(clip: CanvasZoomClip): {
  easeInSeconds: number
  easeOutSeconds: number
} {
  const duration = Math.max(0, clip.end - clip.start)
  const transition = clampZoomTransitionSettings(clip.transition)
  const easeInSeconds = duration * transition.easeIn
  const easeOutSeconds = duration * transition.easeOut
  const total = easeInSeconds + easeOutSeconds
  if (total <= duration) return { easeInSeconds, easeOutSeconds }
  const scale = duration / Math.max(total, 1e-6)
  return {
    easeInSeconds: easeInSeconds * scale,
    easeOutSeconds: easeOutSeconds * scale,
  }
}

function sampleZoomProgress(
  clip: CanvasZoomClip,
  compositionSeconds: number
): { progress: number; motion: number } {
  if (!clip.enabled) return { progress: 0, motion: 0 }
  if (compositionSeconds < clip.start || compositionSeconds >= clip.end) {
    return { progress: 0, motion: 0 }
  }

  const duration = Math.max(0, clip.end - clip.start)
  if (duration <= 0) return { progress: 0, motion: 0 }

  const { easeInSeconds, easeOutSeconds } = easeTiming(clip)
  const transition = clampZoomTransitionSettings(clip.transition)
  const easeInEnd = clip.start + easeInSeconds
  const easeOutStart = clip.end - easeOutSeconds

  if (easeInSeconds > 0 && compositionSeconds < easeInEnd) {
    const t = (compositionSeconds - clip.start) / easeInSeconds
    return {
      progress: transitionCurveValue(transition.curve, t),
      motion: transitionMotion(transition.curve, t),
    }
  }

  if (easeOutSeconds > 0 && compositionSeconds > easeOutStart) {
    const t = (compositionSeconds - easeOutStart) / easeOutSeconds
    return {
      progress: 1 - transitionCurveValue(transition.curve, t),
      motion: transitionMotion(transition.curve, t),
    }
  }

  return { progress: 1, motion: 0 }
}

export function clampZoomFocusForScale(
  focus: CanvasZoomFocus,
  scale: number,
  artboard: ArtboardSize
): CanvasZoomFocus {
  const safeFocus = clampZoomFocus(focus)
  const safeScale = clampZoomScale(scale)
  if (
    safeScale <= 1 + ZOOM_IDENTITY_EPSILON ||
    artboard.width <= 0 ||
    artboard.height <= 0
  ) {
    return safeFocus
  }

  const halfWindowX = 1 / (2 * safeScale)
  const halfWindowY = 1 / (2 * safeScale)
  return {
    x: Math.min(1 - halfWindowX, Math.max(halfWindowX, safeFocus.x)),
    y: Math.min(1 - halfWindowY, Math.max(halfWindowY, safeFocus.y)),
  }
}

export function getZoomVisibleWindow(
  focus: CanvasZoomFocus,
  scale: number,
  artboard: ArtboardSize
): ZoomVisibleWindow {
  const safeScale = clampZoomScale(scale)
  const clampedFocus = clampZoomFocusForScale(focus, safeScale, artboard)
  const width = 1 / safeScale
  const height = 1 / safeScale
  return {
    x: clampedFocus.x - width / 2,
    y: clampedFocus.y - height / 2,
    width,
    height,
  }
}

export function sampleZoomCameraAtTime(
  clips: readonly CanvasZoomClipInput[],
  artboard: ArtboardSize,
  compositionSeconds: number
): ZoomCamera {
  let clip: CanvasZoomClip | null = null
  for (const candidate of clips) {
    if (candidate.enabled === false) continue
    if (
      compositionSeconds >= candidate.start &&
      compositionSeconds < candidate.end
    ) {
      clip = withZoomClipDefaults(candidate)
      break
    }
  }
  if (!clip) return IDENTITY_ZOOM_CAMERA

  const { progress, motion } = sampleZoomProgress(clip, compositionSeconds)
  const targetScale = clampZoomScale(clip.scale)
  const scale = 1 + (targetScale - 1) * progress
  if (scale <= 1 + ZOOM_IDENTITY_EPSILON) return IDENTITY_ZOOM_CAMERA

  const focus = clampZoomFocusForScale(clip.focus, scale, artboard)
  const focusX = focus.x * artboard.width
  const focusY = focus.y * artboard.height
  const offsetX = artboard.width / 2 - scale * focusX
  const offsetY = artboard.height / 2 - scale * focusY
  return {
    scale,
    offsetX,
    offsetY,
    radialBlur: Math.max(0, Math.min(1, clip.radialBlur * motion)),
    radialBlurSettings: clampZoomRadialBlurSettings(clip.radialBlurSettings),
    clipId: clip.id,
  }
}

export function applyZoomCamera(node: Konva.Node | null, camera: ZoomCamera) {
  if (!node) return
  if (camera.scale <= 1 + ZOOM_IDENTITY_EPSILON) {
    node.scale({ x: 1, y: 1 })
    node.position({ x: 0, y: 0 })
    return
  }
  node.scale({ x: camera.scale, y: camera.scale })
  node.position({ x: camera.offsetX, y: camera.offsetY })
}

export function zoomCamerasEqual(a: ZoomCamera, b: ZoomCamera) {
  return (
    Math.abs(a.scale - b.scale) < ZOOM_IDENTITY_EPSILON &&
    Math.abs(a.offsetX - b.offsetX) < ZOOM_IDENTITY_EPSILON &&
    Math.abs(a.offsetY - b.offsetY) < ZOOM_IDENTITY_EPSILON &&
    Math.abs(a.radialBlur - b.radialBlur) < ZOOM_IDENTITY_EPSILON &&
    zoomRadialBlurSettingsEqual(a.radialBlurSettings, b.radialBlurSettings) &&
    a.clipId === b.clipId
  )
}
