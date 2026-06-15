"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Application } from "pixi.js"

import { getPreviewFillTransform } from "@/lib/editor-canvas"
import { resolveCanvasPalette } from "@/lib/theme-colors"
import { ARTBOARD_SELECTION_ID } from "@/types/editor-canvas"
import type {
  CanvasNode,
  CanvasSize,
  ViewTransform,
} from "@/types/editor-canvas"

import { useProject } from "@/components/editor/project/provider"
import {
  useEditorCanvasActions,
  useEditorCanvasArtboard,
  useEditorCanvasMedia,
  useEditorCanvasTimeline,
  useEditorCanvasTimelineActions,
  useEditorCanvasView,
} from "../provider"
import { buildCursorTrack, projectFolderFromObjectUrl } from "../cursor-scene"
import { registerSceneSnapshotProvider } from "../scene-snapshot"
import type { SmoothedCursorTrack } from "@/lib/cursors/cursor-track"
import {
  computeZoomFollowPaths,
  sampleZoomCameraAtTime,
  type ZoomFollowPaths,
} from "../zoom-scene"
import { CursorController, type CursorState } from "./cursor-controller"
import { canvasNodeFromVideo } from "./node-model"
import { preferredRendererBackend } from "./renderer-preference"
import { CanvasScene } from "./scene"
import { SelectionController } from "./selection-controller"
import { VideoController } from "./video-controller"
import { ViewportController } from "./viewport-controller"

function getIsDark() {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  )
}

const RESUME_WARMUP_FRAMES = 6

type WebGpuDeviceLossInfo = {
  reason?: string
  message?: string
}

type MaybeWebGpuRenderer = {
  gpu?: {
    device?: {
      lost?: Promise<WebGpuDeviceLossInfo>
    }
  }
}

function getWebGpuDeviceLostPromise(
  app: Application
): Promise<WebGpuDeviceLossInfo> | null {
  return (
    (app.renderer as unknown as MaybeWebGpuRenderer).gpu?.device?.lost ?? null
  )
}

function destroyPixiApplication(app: Application | null) {
  if (!app) return
  app.destroy(
    { removeView: true, releaseGlobalResources: true },
    { children: true }
  )
}

/**
 * The PixiJS canvas host. Owns the `Application` lifecycle and bridges the
 * imperative scene/controllers to openscreen's `EditorCanvasProvider`:
 *
 *  - React state (artboard, viewTransform, preview) flows IN via effects that
 *    call scene/controller methods.
 *  - Gesture changes flow OUT via the controller's `onChange` → `setViewTransform`.
 *
 * PixiJS's own event system is disabled; all input is handled by the controllers
 * on the host element. Mounted behind {@link isPixiCanvasEnabled} during the
 * migration; replaces the Konva `<Stage>` subtree of `editor-workspace`.
 */
export function PixiCanvas() {
  const hostRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const [canvasEpoch, setCanvasEpoch] = useState(0)

  const { artboard } = useEditorCanvasArtboard()
  const { viewTransform, viewportSize, isPreviewMode } = useEditorCanvasView()
  const {
    setViewTransform,
    setViewportSize,
    selectItem,
    reportCursorTrackUnavailable,
  } = useEditorCanvasActions()
  const { project } = useProject()
  const { videos, selectedItemId } = useEditorCanvasMedia()
  const { primaryAudioVideoId, zoomClips, timelineTime, timelineClips } =
    useEditorCanvasTimeline()
  const {
    registerTimelineVideoElement,
    registerTimelineCanvasNode,
    onTimelineVideoSeeked,
    registerTimelineVideoFps,
    subscribeTimelineTicks,
    subscribeHoverTime,
  } = useEditorCanvasTimelineActions()

  const nodes = useMemo<CanvasNode[]>(
    () => videos.map(canvasNodeFromVideo),
    [videos]
  )
  // The artboard as a synthetic node so the selection controller and the
  // scene's hover/selection outlines treat it like any other selectable box.
  // It sits at the world origin, so its rect is simply (0, 0, w, h).
  const artboardNode = useMemo<CanvasNode>(
    () => ({
      id: ARTBOARD_SELECTION_ID,
      type: "shape",
      x: 0,
      y: 0,
      width: artboard.width,
      height: artboard.height,
      rotation: 0,
    }),
    [artboard.width, artboard.height]
  )
  const selectedNode = useMemo(() => {
    if (selectedItemId === ARTBOARD_SELECTION_ID) return artboardNode
    return nodes.find((node) => node.id === selectedItemId) ?? null
  }, [nodes, selectedItemId, artboardNode])

  const screenVideo = useMemo(
    () => videos.find((video) => video.role === "screen") ?? null,
    [videos]
  )
  const screenClips = useMemo(
    () =>
      screenVideo
        ? timelineClips
            .filter((clip) => clip.videoId === screenVideo.id)
            .sort((a, b) => a.start - b.start || a.end - b.end)
        : [],
    [screenVideo, timelineClips]
  )
  const cursorState = useMemo<CursorState>(
    () => ({
      screenVideo: screenVideo
        ? {
            x: screenVideo.x,
            y: screenVideo.y,
            width: screenVideo.width,
            height: screenVideo.height,
            rotation: screenVideo.rotation,
            intrinsicWidth: screenVideo.intrinsicWidth,
            intrinsicHeight: screenVideo.intrinsicHeight,
          }
        : null,
      screenClips: screenClips.map((clip) => ({
        start: clip.start,
        end: clip.end,
        sourceIn: clip.sourceIn,
        sourceOut: clip.sourceOut,
      })),
      referenceSize: { width: artboard.width, height: artboard.height },
      customRenderingEnabled: artboard.cursorCustomRenderingEnabled,
      cursorSetId: artboard.cursorSetId,
      sizeMultiplier: artboard.cursorSizeMultiplier,
      smoothingMode: artboard.cursorSmoothingMode,
      clickPressScale: artboard.cursorClickPressScale,
      alwaysUsePointer: artboard.cursorAlwaysUsePointer,
      motionRotation: artboard.cursorMotionRotation,
      motionBlur: artboard.cursorMotionBlur,
    }),
    [screenVideo, screenClips, artboard]
  )

  const appRef = useRef<Application | null>(null)
  const sceneRef = useRef<CanvasScene | null>(null)
  const controllerRef = useRef<ViewportController | null>(null)
  const videoControllerRef = useRef<VideoController | null>(null)
  const selectionControllerRef = useRef<SelectionController | null>(null)
  const cursorControllerRef = useRef<CursorController | null>(null)
  const cursorStateRef = useRef<CursorState>(cursorState)
  const cursorTrackRef = useRef<SmoothedCursorTrack | null>(null)
  const viewportSizeRef = useRef<CanvasSize>({ width: 0, height: 0 })
  const isPreviewModeRef = useRef(isPreviewMode)

  const nodesRef = useRef<CanvasNode[]>(nodes)
  const artboardNodeRef = useRef<CanvasNode>(artboardNode)
  const selectedItemIdRef = useRef<string | null>(selectedItemId)
  const nodeActionsRef = useRef({ selectItem })

  // Latest values read by the imperative layer without re-running the mount effect.
  const artboardSizeRef = useRef<CanvasSize>({
    width: artboard.width,
    height: artboard.height,
  })
  const viewTransformRef = useRef(viewTransform)
  const setViewTransformRef = useRef(setViewTransform)
  const setViewportSizeRef = useRef(setViewportSize)
  // Effective background/grain for the scene: the Background tab's master
  // switch paints nothing when off (values stay stored in provider state).
  const artboardBgRef = useRef({
    background: artboard.backgroundEnabled ? artboard.background : null,
    grain: artboard.backgroundEnabled ? artboard.grain : 0,
  })
  useEffect(() => {
    artboardSizeRef.current = { width: artboard.width, height: artboard.height }
  }, [artboard.width, artboard.height])
  useEffect(() => {
    viewTransformRef.current = viewTransform
  }, [viewTransform])
  useEffect(() => {
    isPreviewModeRef.current = isPreviewMode
  }, [isPreviewMode])
  useEffect(() => {
    setViewTransformRef.current = setViewTransform
  }, [setViewTransform])
  useEffect(() => {
    setViewportSizeRef.current = setViewportSize
  }, [setViewportSize])
  useEffect(() => {
    artboardBgRef.current = {
      background: artboard.backgroundEnabled ? artboard.background : null,
      grain: artboard.backgroundEnabled ? artboard.grain : 0,
    }
  }, [artboard.background, artboard.grain, artboard.backgroundEnabled])

  const videosRef = useRef(videos)
  const primaryAudioRef = useRef(primaryAudioVideoId)
  const transportRef = useRef({
    registerElement: registerTimelineVideoElement,
    registerNode: registerTimelineCanvasNode,
    onSeeked: onTimelineVideoSeeked,
    onFpsMeasured: registerTimelineVideoFps,
  })
  useEffect(() => {
    videosRef.current = videos
  }, [videos])
  useEffect(() => {
    primaryAudioRef.current = primaryAudioVideoId
  }, [primaryAudioVideoId])
  const zoomClipsRef = useRef(zoomClips)
  const committedTimeRef = useRef(timelineTime)
  // Precomputed cursor-follow paths (hold + reframe-on-exit), one per zoom clip.
  // Rebuilt off the hot path when clips / cursor track / artboard change; the
  // per-frame camera sampling just reads this ref.
  const followPathsRef = useRef<ZoomFollowPaths | null>(null)
  useEffect(() => {
    zoomClipsRef.current = zoomClips
  }, [zoomClips])
  useEffect(() => {
    committedTimeRef.current = timelineTime
  }, [timelineTime])
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  useEffect(() => {
    artboardNodeRef.current = artboardNode
  }, [artboardNode])
  useEffect(() => {
    selectedItemIdRef.current = selectedItemId
  }, [selectedItemId])
  useEffect(() => {
    nodeActionsRef.current = { selectItem }
  }, [selectItem])

  useEffect(() => {
    transportRef.current = {
      registerElement: registerTimelineVideoElement,
      registerNode: registerTimelineCanvasNode,
      onSeeked: onTimelineVideoSeeked,
      onFpsMeasured: registerTimelineVideoFps,
    }
  }, [
    registerTimelineVideoElement,
    registerTimelineCanvasNode,
    onTimelineVideoSeeked,
    registerTimelineVideoFps,
  ])

  // ── PixiJS lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    const app = new Application()

    const getRendererResolution = () =>
      Math.min(window.devicePixelRatio || 1, 2)

    const measure = (): CanvasSize => {
      const rect = host.getBoundingClientRect()
      return {
        width: Math.max(1, Math.ceil(rect.width)),
        height: Math.max(1, Math.ceil(rect.height)),
      }
    }

    const sizeCanvas = (
      targetApp: Application,
      size: CanvasSize,
      resolution: number
    ) => {
      targetApp.renderer.resize(size.width, size.height, resolution)
      const canvas = targetApp.canvas
      canvas.style.display = "block"
      canvas.style.position = "absolute"
      canvas.style.top = "0"
      canvas.style.left = "0"
      canvas.style.width = `${size.width}px`
      canvas.style.height = `${size.height}px`
      canvas.style.maxWidth = "none"
      canvas.style.maxHeight = "none"
    }

    const getImmediateResizeView = (
      size: CanvasSize,
      providerViewTransform: ViewTransform
    ) =>
      isPreviewModeRef.current
        ? getPreviewFillTransform(size, artboardSizeRef.current)
        : providerViewTransform

    let themeObserver: MutationObserver | null = null
    let resizeObserver: ResizeObserver | null = null
    let unregisterSnapshotProvider: (() => void) | null = null
    let resizeRafId: number | null = null
    let resumeWarmupRafId: number | null = null
    let resumeWarmupFrames = 0
    let rendererCanvas: HTMLCanvasElement | null = null
    let handleWebGlContextLost: ((event: Event) => void) | null = null
    let handleWebGlContextRestored: (() => void) | null = null
    let rendererResolution = getRendererResolution()
    let scheduleResize: (() => void) | null = null

    const cancelResumeWarmup = () => {
      if (resumeWarmupRafId !== null) {
        cancelAnimationFrame(resumeWarmupRafId)
        resumeWarmupRafId = null
      }
      resumeWarmupFrames = 0
    }

    const runResumeWarmup = () => {
      resumeWarmupRafId = null
      if (disposed) return
      sceneRef.current?.renderNow()
      resumeWarmupFrames -= 1
      if (resumeWarmupFrames > 0) {
        resumeWarmupRafId = requestAnimationFrame(runResumeWarmup)
      }
    }

    const scheduleResumeWarmup = () => {
      if (disposed || document.visibilityState === "hidden") return
      sceneRef.current?.renderNow()
      resumeWarmupFrames = RESUME_WARMUP_FRAMES
      if (resumeWarmupRafId === null) {
        resumeWarmupRafId = requestAnimationFrame(runResumeWarmup)
      }
    }

    const init = async () => {
      const initialSize = measure()
      await app.init({
        width: initialSize.width,
        height: initialSize.height,
        // Prefer WebGPU for the interactive preview. During layout-driven
        // resizes we paint immediately after resize so old swapchain pixels are
        // not presented in the newly sized canvas. `preferredRendererBackend`
        // downgrades to WebGL2 in environments that expose `navigator.gpu` but
        // not the `GPUTextureUsage` globals PixiJS needs (those throw at the
        // first texture upload, after init has already succeeded).
        preference: preferredRendererBackend(),
        antialias: true,
        resolution: rendererResolution,
        // Keep the backing store and CSS box in the same coordinate system.
        // CSS-stretching a stale Pixi buffer during sidebar animation makes the
        // artboard look elastic, especially on high-DPI displays.
        autoDensity: true,
        backgroundAlpha: 0,
        autoStart: false,
        powerPreference: "high-performance",
        // All input is handled by DOM listeners on the host; PixiJS's own event
        // system stays off (cheaper, and avoids per-node hit graphs).
        eventFeatures: {
          move: false,
          globalMove: false,
          click: false,
          wheel: false,
        },
      })

      // The effect cleanup may have run while init() awaited.
      if (disposed) {
        destroyPixiApplication(app)
        return
      }

      const size = measure()
      rendererResolution = getRendererResolution()
      sizeCanvas(app, size, rendererResolution)
      viewportSizeRef.current = size

      host.appendChild(app.canvas)

      rendererCanvas = app.canvas
      handleWebGlContextLost = (event: Event) => {
        event.preventDefault()
        console.warn("[PixiCanvas] WebGL context lost; waiting for restore")
      }
      handleWebGlContextRestored = () => {
        console.warn("[PixiCanvas] WebGL context restored; repainting scene")
        scheduleResumeWarmup()
      }
      rendererCanvas.addEventListener(
        "webglcontextlost",
        handleWebGlContextLost
      )
      rendererCanvas.addEventListener(
        "webglcontextrestored",
        handleWebGlContextRestored
      )

      const deviceLostPromise = getWebGpuDeviceLostPromise(app)
      if (deviceLostPromise) {
        void deviceLostPromise.then((info) => {
          if (disposed || info.reason === "destroyed") return
          console.warn("[PixiCanvas] WebGPU device lost; remounting renderer", {
            reason: info.reason,
            message: info.message,
          })
          setCanvasEpoch((epoch) => epoch + 1)
        })
      }

      document.addEventListener("visibilitychange", scheduleResumeWarmup)
      document.addEventListener("resume", scheduleResumeWarmup)
      window.addEventListener("focus", scheduleResumeWarmup)
      window.addEventListener("pageshow", scheduleResumeWarmup)

      const scene = new CanvasScene(
        app,
        resolveCanvasPalette(getIsDark()),
        artboardSizeRef.current,
        backdropRef.current
      )

      const controller = new ViewportController({
        scene,
        getViewportSize: () => viewportSizeRef.current,
        onChange: (next) => setViewTransformRef.current(next),
        keyboardEnabled: true,
      })
      controller.attach(host)
      controller.setPreviewMode(isPreviewMode)

      appRef.current = app
      sceneRef.current = scene
      controllerRef.current = controller

      // Expose one-shot artboard rasterization (Zoom tab focus preview).
      unregisterSnapshotProvider = registerSceneSnapshotProvider(
        (targetWidth) =>
          sceneRef.current?.captureCompositeSnapshot(targetWidth) ?? null
      )

      // Push our measured size to the provider (it may re-fit), then apply the
      // provider's current view so the artboard lands correctly on first paint.
      const initialViewTransform = setViewportSizeRef.current(size)
      controller.setExternalViewTransform(
        getImmediateResizeView(size, initialViewTransform)
      )
      scene.setBackground(
        artboardBgRef.current.background,
        artboardBgRef.current.grain
      )

      const videoController = new VideoController({
        scene,
        registerElement: (id, el) =>
          transportRef.current.registerElement(id, el),
        registerNode: (id, node) =>
          transportRef.current.registerNode(
            id,
            node as unknown as Parameters<
              (typeof transportRef.current)["registerNode"]
            >[1]
          ),
        onSeeked: (id, el, redraw) =>
          transportRef.current.onSeeked(id, el, redraw),
        onFpsMeasured: (id, fps) => transportRef.current.onFpsMeasured(id, fps),
      })
      videoControllerRef.current = videoController
      videoController.setPrimaryAudio(primaryAudioRef.current)
      videoController.syncVideos(videosRef.current)

      scene.applyZoomCamera(
        sampleZoomCameraAtTime(
          zoomClipsRef.current,
          artboardSizeRef.current,
          committedTimeRef.current
        )
      )

      const selectionController = new SelectionController({
        scene,
        getViewTransform: () => controller.getViewTransform(),
        getNodes: () => nodesRef.current,
        getArtboardNode: () => artboardNodeRef.current,
        getSelectedId: () => selectedItemIdRef.current,
        getIsSpacePressed: () => controller.isSpaceActive(),
        onSelect: (id) => nodeActionsRef.current.selectItem(id),
      })
      selectionController.attach(host)
      selectionControllerRef.current = selectionController

      const cursorController = new CursorController(scene)
      cursorController.setState(cursorStateRef.current)
      cursorController.setTrack(cursorTrackRef.current)
      cursorController.place(committedTimeRef.current)
      cursorControllerRef.current = cursorController

      themeObserver = new MutationObserver(() => {
        sceneRef.current?.setColors(resolveCanvasPalette(getIsDark()))
      })
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      })

      // Coalesce ResizeObserver bursts (an animated sidebar resizes the host on
      // every spring frame) to one resize per frame, and skip no-op fires —
      // reallocating the GPU drawing buffer is the expensive part.
      const applyResize = () => {
        resizeRafId = null
        const currentApp = appRef.current
        const controller = controllerRef.current
        if (!currentApp || !controller) return
        const next = measure()
        const nextResolution = getRendererResolution()
        if (
          next.width === viewportSizeRef.current.width &&
          next.height === viewportSizeRef.current.height &&
          nextResolution === rendererResolution
        ) {
          return
        }
        rendererResolution = nextResolution
        viewportSizeRef.current = next
        sizeCanvas(currentApp, next, nextResolution)
        const nextViewTransform = setViewportSizeRef.current(next)
        controller.setExternalViewTransform(
          getImmediateResizeView(next, nextViewTransform)
        )
        sceneRef.current?.renderNow()
      }
      scheduleResize = () => {
        if (resizeRafId !== null) return
        resizeRafId = requestAnimationFrame(applyResize)
      }
      resizeObserver = new ResizeObserver(scheduleResize)
      resizeObserver.observe(host)
      window.addEventListener("resize", scheduleResize)
    }

    void init()

    return () => {
      disposed = true
      unregisterSnapshotProvider?.()
      themeObserver?.disconnect()
      resizeObserver?.disconnect()
      if (scheduleResize) window.removeEventListener("resize", scheduleResize)
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId)
      cancelResumeWarmup()
      if (rendererCanvas && handleWebGlContextLost) {
        rendererCanvas.removeEventListener(
          "webglcontextlost",
          handleWebGlContextLost
        )
      }
      if (rendererCanvas && handleWebGlContextRestored) {
        rendererCanvas.removeEventListener(
          "webglcontextrestored",
          handleWebGlContextRestored
        )
      }
      document.removeEventListener("visibilitychange", scheduleResumeWarmup)
      document.removeEventListener("resume", scheduleResumeWarmup)
      window.removeEventListener("focus", scheduleResumeWarmup)
      window.removeEventListener("pageshow", scheduleResumeWarmup)
      controllerRef.current?.detach()
      selectionControllerRef.current?.detach()
      cursorControllerRef.current?.destroy()
      videoControllerRef.current?.destroy()
      sceneRef.current?.destroy()
      destroyPixiApplication(appRef.current)
      appRef.current = null
      sceneRef.current = null
      controllerRef.current = null
      videoControllerRef.current = null
      selectionControllerRef.current = null
      cursorControllerRef.current = null
    }
    // Live values are read through refs above; `canvasEpoch` only bumps after
    // a real GPU-device loss so the Pixi Application can be recreated cleanly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasEpoch])

  // ── React state → scene/controller ─────────────────────────────────────────
  useEffect(() => {
    controllerRef.current?.setExternalViewTransform(viewTransform)
  }, [viewTransform])

  useEffect(() => {
    sceneRef.current?.setArtboardSize({
      width: artboard.width,
      height: artboard.height,
    })
  }, [artboard.width, artboard.height])

  useEffect(() => {
    sceneRef.current?.setBackground(
      artboard.backgroundEnabled ? artboard.background : null,
      artboard.backgroundEnabled ? artboard.grain : 0
    )
  }, [artboard.background, artboard.grain, artboard.backgroundEnabled])

  useEffect(() => {
    const controller = controllerRef.current
    if (!controller) return
    controller.setPreviewMode(isPreviewMode)
    // Restore the saved view on exit; the fill-fit is applied by the effect below.
    if (!isPreviewMode) {
      controller.setExternalViewTransform(viewTransformRef.current)
    }
  }, [isPreviewMode])

  // Fullscreen preview fills the viewport with a zero-padding contain-fit,
  // recomputed on the fullscreen resize + any artboard change.
  useEffect(() => {
    if (!isPreviewMode) return
    controllerRef.current?.setExternalViewTransform(
      getPreviewFillTransform(viewportSize, {
        width: artboard.width,
        height: artboard.height,
      })
    )
  }, [isPreviewMode, viewportSize, artboard.width, artboard.height])

  useEffect(() => {
    videoControllerRef.current?.syncVideos(videos)
  }, [videos])

  useEffect(() => {
    videoControllerRef.current?.setPrimaryAudio(primaryAudioVideoId)
  }, [primaryAudioVideoId])

  // Rebuild the precomputed cursor-follow paths from the current clips + cursor
  // track. Pure + deterministic (samples the fixed recorded cursor at a fixed
  // rate), so the same paths drive preview, hover, and export identically. Cheap
  // (a handful of clips, ~30 Hz over each hold), and kept OFF the per-frame path.
  const recomputeFollowPaths = useCallback(() => {
    const controller = cursorControllerRef.current
    const artboardSize = artboardSizeRef.current
    if (!controller) {
      followPathsRef.current = null
      return
    }
    followPathsRef.current = computeZoomFollowPaths(
      zoomClipsRef.current,
      (time) => controller.getArtboardFocusAt(time, artboardSize)
    )
  }, [])

  // Recompute follow paths whenever the clips, artboard geometry, or cursor
  // inputs change, then re-apply the camera at the current time so the change is
  // visible immediately while paused.
  useEffect(() => {
    recomputeFollowPaths()
    const time = committedTimeRef.current
    sceneRef.current?.applyZoomCamera(
      sampleZoomCameraAtTime(
        zoomClipsRef.current,
        artboardSizeRef.current,
        time,
        followPathsRef.current
      )
    )
  }, [
    zoomClips,
    artboard.width,
    artboard.height,
    cursorState,
    recomputeFollowPaths,
  ])

  // Composition zoom-clip camera: sample at the live playback tick / paused hover
  // / committed time and apply to the scene's content + background cameras.
  useEffect(() => {
    const applyAt = (time: number) => {
      const camera = sampleZoomCameraAtTime(
        zoomClipsRef.current,
        artboardSizeRef.current,
        time,
        // Hold + reframe-on-exit follow paths so the cursor stays in the window.
        followPathsRef.current
      )
      sceneRef.current?.applyZoomCamera(camera)
      cursorControllerRef.current?.place(time)
    }
    const unsubscribeTick = subscribeTimelineTicks((time) => applyAt(time))
    const unsubscribeHover = subscribeHoverTime((time) =>
      applyAt(time ?? committedTimeRef.current)
    )
    return () => {
      unsubscribeTick()
      unsubscribeHover()
    }
  }, [subscribeTimelineTicks, subscribeHoverTime])

  useEffect(() => {
    const artboardSize = { width: artboard.width, height: artboard.height }
    sceneRef.current?.applyZoomCamera(
      sampleZoomCameraAtTime(
        zoomClips,
        artboardSize,
        timelineTime,
        followPathsRef.current
      )
    )
    cursorControllerRef.current?.place(timelineTime)
  }, [zoomClips, timelineTime, artboard.width, artboard.height])

  // Redraw the selection overlay when the selection or node placement changes
  // (covers canvas clicks, timeline/panel selection, and settings-driven
  // relayout — `nodes` rebuilds whenever `videos` changes).
  useEffect(() => {
    sceneRef.current?.drawSelectionOverlay(selectedNode)
  }, [selectedNode])

  // Push cursor state + re-place when paused (settings / geometry changes).
  useEffect(() => {
    cursorStateRef.current = cursorState
    cursorControllerRef.current?.setState(cursorState)
    cursorControllerRef.current?.place(committedTimeRef.current)
    // The auto-follow sampler reads the controller's state (custom-rendering /
    // screenVideo / source mapping), so the follow paths MUST be rebuilt AFTER
    // that state is applied — otherwise the recompute effect above (which runs
    // earlier in the commit) sampled a stale/empty state and baked a static
    // path, so a post-refresh auto clip would hold its seed instead of
    // following. Re-apply the camera so the change is visible immediately.
    recomputeFollowPaths()
    sceneRef.current?.applyZoomCamera(
      sampleZoomCameraAtTime(
        zoomClipsRef.current,
        artboardSizeRef.current,
        committedTimeRef.current,
        followPathsRef.current
      )
    )
  }, [cursorState, recomputeFollowPaths])

  // Load the recorded cursor track when the screen recording / smoothing changes.
  useEffect(() => {
    const controller = cursorControllerRef.current
    if (
      !screenVideo ||
      screenVideo.source.kind !== "recording" ||
      !artboard.cursorCustomRenderingEnabled
    ) {
      cursorTrackRef.current = null
      controller?.setTrack(null)
      // No screen recording / custom rendering off — the notice is
      // inapplicable, not "unavailable".
      reportCursorTrackUnavailable(false)
      return
    }
    // Prefer the project folder (survives any URL-shape changes); fall back
    // to deriving it from the screen video's file URL for sessions hydrated
    // before the project record landed.
    const folder =
      project?.path ?? projectFolderFromObjectUrl(screenVideo.objectUrl)
    if (!folder) {
      cursorTrackRef.current = null
      controller?.setTrack(null)
      reportCursorTrackUnavailable(true)
      return
    }
    let cancelled = false
    void window.api?.projects.getCursorData(folder).then((data) => {
      if (cancelled) return
      const track = buildCursorTrack(data ?? null, {
        smoothingMode: artboard.cursorSmoothingMode,
        stabilizeCursorType: artboard.cursorTypeStabilization,
      })
      cursorTrackRef.current = track
      cursorControllerRef.current?.setTrack(track)
      cursorControllerRef.current?.place(committedTimeRef.current)
      // The follow paths depend on the recorded cursor — rebuild them now that
      // the track has loaded and re-apply the camera at the committed time.
      recomputeFollowPaths()
      sceneRef.current?.applyZoomCamera(
        sampleZoomCameraAtTime(
          zoomClipsRef.current,
          artboardSizeRef.current,
          committedTimeRef.current,
          followPathsRef.current
        )
      )
      // Track === null means the sidecar data was missing/corrupt/unusable
      // (main has already logged the precise reason).
      reportCursorTrackUnavailable(track === null)
    })
    return () => {
      cancelled = true
    }
  }, [
    screenVideo,
    artboard.cursorCustomRenderingEnabled,
    artboard.cursorSmoothingMode,
    artboard.cursorTypeStabilization,
    project?.path,
    reportCursorTrackUnavailable,
    recomputeFollowPaths,
  ])

  return (
    <>
      {/* Artboard "paper" drop shadow — a white div glued to the artboard's
          on-screen rect by the scene (matches openscreen's Konva backdrop). */}
      <div
        ref={backdropRef}
        aria-hidden="true"
        className={`pointer-events-none absolute top-0 left-0 z-0 bg-white shadow-[0_18px_40px_rgba(0,0,0,0.14)] ${
          isPreviewMode ? "hidden" : ""
        }`}
        style={{ transformOrigin: "0 0", willChange: "transform", opacity: 0 }}
      />
      <div ref={hostRef} className="absolute inset-0 z-[1] touch-none" />
    </>
  )
}
