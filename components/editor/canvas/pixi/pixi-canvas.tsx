"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Application } from "pixi.js"

import { getPreviewFillTransform } from "@/lib/editor-canvas"
import { normalizeAngle } from "@/lib/node-transform"
import { resolveCanvasPalette } from "@/lib/theme-colors"
import type {
  CanvasNode,
  CanvasSize,
  NodeTransformUpdate,
} from "@/types/editor-canvas"

import {
  useEditorCanvasActions,
  useEditorCanvasArtboard,
  useEditorCanvasMedia,
  useEditorCanvasTimeline,
  useEditorCanvasTimelineActions,
  useEditorCanvasView,
} from "../provider"
import { buildCursorTrack, projectFolderFromObjectUrl } from "../cursor-scene"
import { sampleZoomCameraAtTime } from "../zoom-scene"
import { CursorController, type CursorState } from "./cursor-controller"
import { canvasNodeFromVideo } from "./node-model"
import { CanvasScene } from "./scene"
import { TransformController } from "./transform-controller"
import { VideoController } from "./video-controller"
import { ViewportController } from "./viewport-controller"

function getIsDark() {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
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

  const { artboard } = useEditorCanvasArtboard()
  const { viewTransform, viewportSize, isPreviewMode } = useEditorCanvasView()
  const {
    setViewTransform,
    setViewportSize,
    selectItem,
    updateVideoTransform,
    deleteVideo,
    duplicateVideo,
    setVideoLocked,
  } = useEditorCanvasActions()
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

  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([])
  const nodes = useMemo<CanvasNode[]>(
    () => videos.map(canvasNodeFromVideo),
    [videos]
  )
  const selectedNodes = useMemo(
    () => nodes.filter((node) => selectedNodeIds.includes(node.id)),
    [nodes, selectedNodeIds]
  )

  const screenVideo = useMemo(
    () => videos.find((video) => video.role === "screen") ?? null,
    [videos]
  )
  const screenClip = useMemo(
    () =>
      screenVideo
        ? (timelineClips.find((clip) => clip.videoId === screenVideo.id) ??
          null)
        : null,
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
      screenClip: screenClip
        ? { start: screenClip.start, sourceIn: screenClip.sourceIn }
        : null,
      referenceSize: { width: artboard.width, height: artboard.height },
      customRenderingEnabled: artboard.cursorCustomRenderingEnabled,
      cursorSetId: artboard.cursorSetId,
      sizeMultiplier: artboard.cursorSizeMultiplier,
      smoothingMode: artboard.cursorSmoothingMode,
      clickPressScale: artboard.cursorClickPressScale,
      alwaysUsePointer: artboard.cursorAlwaysUsePointer,
      motionRotation: artboard.cursorMotionRotation,
      motionRotationMode: artboard.cursorMotionRotationMode,
      motionBlur: artboard.cursorMotionBlur,
    }),
    [screenVideo, screenClip, artboard]
  )

  const appRef = useRef<Application | null>(null)
  const sceneRef = useRef<CanvasScene | null>(null)
  const controllerRef = useRef<ViewportController | null>(null)
  const videoControllerRef = useRef<VideoController | null>(null)
  const transformControllerRef = useRef<TransformController | null>(null)
  const cursorControllerRef = useRef<CursorController | null>(null)
  const cursorStateRef = useRef<CursorState>(cursorState)
  const rotationReadoutRef = useRef<HTMLDivElement>(null)
  const viewportSizeRef = useRef<CanvasSize>({ width: 0, height: 0 })

  const nodesRef = useRef<CanvasNode[]>(nodes)
  const selectedIdsRef = useRef<string[]>(selectedNodeIds)
  const nodeActionsRef = useRef({
    selectItem,
    updateVideoTransform,
    deleteVideo,
    duplicateVideo,
    setVideoLocked,
  })

  // Latest values read by the imperative layer without re-running the mount effect.
  const artboardSizeRef = useRef<CanvasSize>({
    width: artboard.width,
    height: artboard.height,
  })
  const viewTransformRef = useRef(viewTransform)
  const setViewTransformRef = useRef(setViewTransform)
  const setViewportSizeRef = useRef(setViewportSize)
  const artboardBgRef = useRef({
    background: artboard.background,
    grain: artboard.grain,
  })
  useEffect(() => {
    artboardSizeRef.current = { width: artboard.width, height: artboard.height }
  }, [artboard.width, artboard.height])
  useEffect(() => {
    viewTransformRef.current = viewTransform
  }, [viewTransform])
  useEffect(() => {
    setViewTransformRef.current = setViewTransform
  }, [setViewTransform])
  useEffect(() => {
    setViewportSizeRef.current = setViewportSize
  }, [setViewportSize])
  useEffect(() => {
    artboardBgRef.current = {
      background: artboard.background,
      grain: artboard.grain,
    }
  }, [artboard.background, artboard.grain])

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
    selectedIdsRef.current = selectedNodeIds
  }, [selectedNodeIds])
  useEffect(() => {
    nodeActionsRef.current = {
      selectItem,
      updateVideoTransform,
      deleteVideo,
      duplicateVideo,
      setVideoLocked,
    }
  }, [
    selectItem,
    updateVideoTransform,
    deleteVideo,
    duplicateVideo,
    setVideoLocked,
  ])

  const updateRotationReadout = useCallback((rotation: number | null) => {
    const readout = rotationReadoutRef.current
    if (!readout) return
    if (rotation === null) {
      readout.style.visibility = "hidden"
      readout.textContent = ""
      return
    }
    const normalized = normalizeAngle(rotation)
    const positive = normalized < 0 ? normalized + Math.PI * 2 : normalized
    readout.textContent = `${Math.round((positive * 180) / Math.PI)}°`
    readout.style.visibility = "visible"
  }, [])

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

  // ── PixiJS lifecycle (mount once) ──────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    const app = new Application()

    const measure = (): CanvasSize => {
      const rect = host.getBoundingClientRect()
      return {
        width: Math.max(1, Math.floor(rect.width)),
        height: Math.max(1, Math.floor(rect.height)),
      }
    }

    let themeObserver: MutationObserver | null = null
    let resizeObserver: ResizeObserver | null = null

    const init = async () => {
      await app.init({
        preference: "webgpu", // WebGL2 fallback is automatic when WebGPU is absent.
        antialias: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
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
        app.destroy(true)
        return
      }

      const size = measure()
      app.renderer.resize(size.width, size.height)
      viewportSizeRef.current = size

      app.canvas.style.display = "block"
      host.appendChild(app.canvas)

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

      // Push our measured size to the provider (it may re-fit), then apply the
      // provider's current view so the artboard lands correctly on first paint.
      setViewportSizeRef.current(size)
      controller.setExternalViewTransform(viewTransformRef.current)
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
        onFpsMeasured: (id, fps) =>
          transportRef.current.onFpsMeasured(id, fps),
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

      const transformController = new TransformController({
        scene,
        getViewTransform: () => controller.getViewTransform(),
        getNodes: () => nodesRef.current,
        getSelectedIds: () => selectedIdsRef.current,
        getIsSpacePressed: () => controller.isSpaceActive(),
        onSelectionChange: (ids) => {
          setSelectedNodeIds(ids)
          nodeActionsRef.current.selectItem(ids.at(-1) ?? null)
        },
        onNodeTransformsCommit: (updates: NodeTransformUpdate[]) => {
          for (const update of updates) {
            nodeActionsRef.current.updateVideoTransform(update.id, {
              x: update.transform.x,
              y: update.transform.y,
              width: update.transform.width,
              height: update.transform.height,
              rotation: update.transform.rotation,
            })
          }
        },
        onRemoveNode: (id) => nodeActionsRef.current.deleteVideo(id),
        onDuplicateSelectedNodes: () => {
          for (const id of selectedIdsRef.current) {
            nodeActionsRef.current.duplicateVideo(id)
          }
        },
        onSetSelectedNodesLocked: (locked) => {
          for (const id of selectedIdsRef.current) {
            nodeActionsRef.current.setVideoLocked(id, locked)
          }
        },
        onTransformingChange: () => {},
        onRotationPreview: updateRotationReadout,
      })
      transformController.attach(host)
      transformControllerRef.current = transformController

      const cursorController = new CursorController(scene)
      cursorController.setState(cursorStateRef.current)
      cursorControllerRef.current = cursorController

      themeObserver = new MutationObserver(() => {
        sceneRef.current?.setColors(resolveCanvasPalette(getIsDark()))
      })
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      })

      resizeObserver = new ResizeObserver(() => {
        if (!appRef.current || !controllerRef.current) return
        const next = measure()
        viewportSizeRef.current = next
        appRef.current.renderer.resize(next.width, next.height)
        setViewportSizeRef.current(next)
        controllerRef.current.handleResize()
      })
      resizeObserver.observe(host)
    }

    void init()

    return () => {
      disposed = true
      themeObserver?.disconnect()
      resizeObserver?.disconnect()
      controllerRef.current?.detach()
      transformControllerRef.current?.detach()
      cursorControllerRef.current?.destroy()
      videoControllerRef.current?.destroy()
      sceneRef.current?.destroy()
      appRef.current?.destroy({ removeView: true }, { children: true })
      appRef.current = null
      sceneRef.current = null
      controllerRef.current = null
      videoControllerRef.current = null
      transformControllerRef.current = null
      cursorControllerRef.current = null
    }
    // Mount once. Live values are read through refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    sceneRef.current?.setBackground(artboard.background, artboard.grain)
  }, [artboard.background, artboard.grain])

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

  // Composition zoom-clip camera: sample at the live playback tick / paused hover
  // / committed time and apply to the scene's content + background cameras.
  useEffect(() => {
    const applyAt = (time: number) => {
      const camera = sampleZoomCameraAtTime(
        zoomClipsRef.current,
        artboardSizeRef.current,
        time
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
    sceneRef.current?.applyZoomCamera(
      sampleZoomCameraAtTime(
        zoomClips,
        { width: artboard.width, height: artboard.height },
        timelineTime
      )
    )
    cursorControllerRef.current?.place(timelineTime)
  }, [zoomClips, timelineTime, artboard.width, artboard.height])

  // Bridge the provider's single-selection (sidebar Video-tab "Select" /
  // deselect / artboard) into the canvas's multi-selection. The provider only
  // holds one id, so we override our local selection ONLY when its id diverges
  // from our current set — never when it merely echoes the primary we just
  // pushed via selectItem() (that would collapse a marquee/Shift group to one).
  // Deliberate cross-store sync with an equality guard (no cascading renders).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedNodeIds((prev) => {
      if (selectedItemId && prev.includes(selectedItemId)) return prev
      const nextIds =
        selectedItemId && videos.some((video) => video.id === selectedItemId)
          ? [selectedItemId]
          : []
      return prev.length === nextIds.length &&
        prev.every((id, i) => id === nextIds[i])
        ? prev
        : nextIds
    })
  }, [selectedItemId, videos])

  // Redraw the selection overlay when the selection or node transforms change
  // (covers programmatic selection + panel edits; live gestures draw directly).
  useEffect(() => {
    sceneRef.current?.drawSelectionOverlay(selectedNodes)
  }, [selectedNodes])

  // Push cursor state + re-place when paused (settings / geometry changes).
  useEffect(() => {
    cursorStateRef.current = cursorState
    cursorControllerRef.current?.setState(cursorState)
    cursorControllerRef.current?.place(committedTimeRef.current)
  }, [cursorState])

  // Load the recorded cursor track when the screen recording / smoothing changes.
  useEffect(() => {
    const controller = cursorControllerRef.current
    if (
      !screenVideo ||
      screenVideo.source.kind !== "recording" ||
      !artboard.cursorCustomRenderingEnabled
    ) {
      controller?.setTrack(null)
      return
    }
    const folder = projectFolderFromObjectUrl(screenVideo.objectUrl)
    if (!folder) return
    let cancelled = false
    void window.api?.projects.getCursorData(folder).then((data) => {
      if (cancelled) return
      const track = buildCursorTrack(data ?? null, {
        smoothingMode: artboard.cursorSmoothingMode,
      })
      cursorControllerRef.current?.setTrack(track)
      cursorControllerRef.current?.place(committedTimeRef.current)
    })
    return () => {
      cancelled = true
    }
  }, [
    screenVideo,
    artboard.cursorCustomRenderingEnabled,
    artboard.cursorSmoothingMode,
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
      <div
        ref={rotationReadoutRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute bottom-4 left-1/2 z-[4] min-w-16 -translate-x-1/2 rounded-full border border-border/70 bg-popover px-3 py-1.5 text-center text-xs font-semibold text-foreground tabular-nums shadow-xl ring-1 ring-border/40"
      />
      <div ref={hostRef} className="absolute inset-0 z-[1] touch-none" />
    </>
  )
}
