import Konva from "konva"

import {
  ZOOM_BLUR_MOTION_GAIN,
  ZOOM_RADIAL_BLUR_SHADER,
  clampZoomFocus,
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
  radialBlurCenterX: number
  radialBlurCenterY: number
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
  radialBlurCenterX: 0.5,
  radialBlurCenterY: 0.5,
  radialBlurSettings: ZOOM_RADIAL_BLUR_SHADER,
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

// Magnitude of d(curve)/dt in normalized-t space (central difference). The eased
// progress moves fastest mid-transition and is ~flat at both ends, so this is a
// single smooth bump — exactly the shape a zoom's motion blur should follow.
function curveSlope(curve: CanvasZoomTransitionCurve, value: number) {
  const dt = 1 / 240
  const before = transitionCurveValue(curve, value - dt)
  const after = transitionCurveValue(curve, value + dt)
  return Math.abs(after - before) / (dt * 2)
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

// Returns the eased zoom amount (`progress`, 0..1) and the real-time rate of
// change of that progress (`velocity`, per second, always >= 0). Velocity is 0
// outside the ease ramps (held zoom or identity), which is what gates the motion
// blur to only the moving parts of the effect.
function sampleZoomProgress(
  clip: CanvasZoomClip,
  compositionSeconds: number
): { progress: number; velocity: number } {
  if (!clip.enabled) return { progress: 0, velocity: 0 }
  if (compositionSeconds < clip.start || compositionSeconds >= clip.end) {
    return { progress: 0, velocity: 0 }
  }

  const duration = Math.max(0, clip.end - clip.start)
  if (duration <= 0) return { progress: 0, velocity: 0 }

  const { easeInSeconds, easeOutSeconds } = easeTiming(clip)
  const transition = clampZoomTransitionSettings(clip.transition)
  const easeInEnd = clip.start + easeInSeconds
  const easeOutStart = clip.end - easeOutSeconds

  if (easeInSeconds > 0 && compositionSeconds < easeInEnd) {
    const t = (compositionSeconds - clip.start) / easeInSeconds
    return {
      progress: transitionCurveValue(transition.curve, t),
      velocity: curveSlope(transition.curve, t) / easeInSeconds,
    }
  }

  if (easeOutSeconds > 0 && compositionSeconds > easeOutStart) {
    const t = (compositionSeconds - easeOutStart) / easeOutSeconds
    return {
      progress: 1 - transitionCurveValue(transition.curve, t),
      velocity: curveSlope(transition.curve, t) / easeOutSeconds,
    }
  }

  return { progress: 1, velocity: 0 }
}

export function getZoomCameraCenterForTarget(
  target: CanvasZoomFocus,
  scale: number,
  artboard: ArtboardSize
): CanvasZoomFocus {
  const safeTarget = clampZoomFocus(target)
  const safeScale = clampZoomScale(scale)
  if (
    safeScale <= 1 + ZOOM_IDENTITY_EPSILON ||
    artboard.width <= 0 ||
    artboard.height <= 0
  ) {
    return safeTarget
  }

  const halfWindowX = 1 / (2 * safeScale)
  const halfWindowY = 1 / (2 * safeScale)
  return {
    x: Math.min(1 - halfWindowX, Math.max(halfWindowX, safeTarget.x)),
    y: Math.min(1 - halfWindowY, Math.max(halfWindowY, safeTarget.y)),
  }
}

// Legacy name kept for older call sites/tests. The returned value is the
// clamped camera center, not necessarily the stored target point.
export function clampZoomFocusForScale(
  focus: CanvasZoomFocus,
  scale: number,
  artboard: ArtboardSize
): CanvasZoomFocus {
  return getZoomCameraCenterForTarget(focus, scale, artboard)
}

export function getZoomVisibleWindow(
  target: CanvasZoomFocus,
  scale: number,
  artboard: ArtboardSize
): ZoomVisibleWindow {
  const safeScale = clampZoomScale(scale)
  const cameraCenter = getZoomCameraCenterForTarget(
    target,
    safeScale,
    artboard
  )
  const width = 1 / safeScale
  const height = 1 / safeScale
  return {
    x: cameraCenter.x - width / 2,
    y: cameraCenter.y - height / 2,
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

  const { progress, velocity } = sampleZoomProgress(clip, compositionSeconds)
  const targetScale = clampZoomScale(clip.scale)
  const scale = 1 + (targetScale - 1) * progress
  if (scale <= 1 + ZOOM_IDENTITY_EPSILON) return IDENTITY_ZOOM_CAMERA

  // Motion blur tracks the on-screen zoom velocity: how fast the magnification
  // is changing, relative to the current scale. This is a single smooth bump
  // (~0 at the ease boundaries, so blur ramps on/off seamlessly) and is naturally
  // stronger for faster — snappier or shorter — zooms.
  const scaleVelocity = (targetScale - 1) * velocity
  const motion = clampUnit((scaleVelocity / scale) * ZOOM_BLUR_MOTION_GAIN)

  const cameraCenter = getZoomCameraCenterForTarget(
    clip.focus,
    scale,
    artboard
  )
  const target = clampZoomFocus(clip.focus)
  const centerX = cameraCenter.x * artboard.width
  const centerY = cameraCenter.y * artboard.height
  const offsetX = artboard.width / 2 - scale * centerX
  const offsetY = artboard.height / 2 - scale * centerY
  const targetX = offsetX + scale * target.x * artboard.width
  const targetY = offsetY + scale * target.y * artboard.height
  return {
    scale,
    offsetX,
    offsetY,
    radialBlur: clampUnit(clip.radialBlur * motion),
    radialBlurCenterX: clampUnit(targetX / Math.max(1, artboard.width)),
    radialBlurCenterY: clampUnit(targetY / Math.max(1, artboard.height)),
    radialBlurSettings: ZOOM_RADIAL_BLUR_SHADER,
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
    Math.abs(a.radialBlurCenterX - b.radialBlurCenterX) <
      ZOOM_IDENTITY_EPSILON &&
    Math.abs(a.radialBlurCenterY - b.radialBlurCenterY) <
      ZOOM_IDENTITY_EPSILON &&
    zoomRadialBlurSettingsEqual(a.radialBlurSettings, b.radialBlurSettings) &&
    a.clipId === b.clipId
  )
}
