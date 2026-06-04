"use client"

import { useEffect, useRef } from "react"
import { Application } from "pixi.js"

import { resolveCanvasPalette } from "@/lib/theme-colors"
import type { CanvasSize } from "@/types/editor-canvas"

import {
  useEditorCanvasActions,
  useEditorCanvasArtboard,
  useEditorCanvasMedia,
  useEditorCanvasTimeline,
  useEditorCanvasTimelineActions,
  useEditorCanvasView,
} from "../provider"
import { CanvasScene } from "./scene"
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
  const { viewTransform, isPreviewMode } = useEditorCanvasView()
  const { setViewTransform, setViewportSize } = useEditorCanvasActions()
  const { videos } = useEditorCanvasMedia()
  const { primaryAudioVideoId } = useEditorCanvasTimeline()
  const {
    registerTimelineVideoElement,
    registerTimelineCanvasNode,
    onTimelineVideoSeeked,
    registerTimelineVideoFps,
  } = useEditorCanvasTimelineActions()

  const appRef = useRef<Application | null>(null)
  const sceneRef = useRef<CanvasScene | null>(null)
  const controllerRef = useRef<ViewportController | null>(null)
  const videoControllerRef = useRef<VideoController | null>(null)
  const viewportSizeRef = useRef<CanvasSize>({ width: 0, height: 0 })

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
      videoControllerRef.current?.destroy()
      sceneRef.current?.destroy()
      appRef.current?.destroy({ removeView: true }, { children: true })
      appRef.current = null
      sceneRef.current = null
      controllerRef.current = null
      videoControllerRef.current = null
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
    controllerRef.current?.setPreviewMode(isPreviewMode)
  }, [isPreviewMode])

  useEffect(() => {
    videoControllerRef.current?.syncVideos(videos)
  }, [videos])

  useEffect(() => {
    videoControllerRef.current?.setPrimaryAudio(primaryAudioVideoId)
  }, [primaryAudioVideoId])

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
