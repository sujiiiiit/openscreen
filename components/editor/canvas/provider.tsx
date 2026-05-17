"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import {
  type ArtboardPresetId,
  clampWorkspaceView,
  DEFAULT_ARTBOARD_PRESET_ID,
  getArtboardPreset,
  getFitViewTransform,
} from "@/lib/editor-canvas"
import type {
  CanvasSize,
  CanvasVideoItem,
  CanvasVideoTransformPatch,
  EditorArtboard,
  ViewTransform,
} from "@/types/editor-canvas"

const DEFAULT_VIEWPORT_SIZE: CanvasSize = { width: 0, height: 0 }
const DEFAULT_ARTBOARD_PRESET = getArtboardPreset(DEFAULT_ARTBOARD_PRESET_ID)
const DEFAULT_ARTBOARD: EditorArtboard = {
  presetId: DEFAULT_ARTBOARD_PRESET.id,
  width: DEFAULT_ARTBOARD_PRESET.width,
  height: DEFAULT_ARTBOARD_PRESET.height,
}
const DEFAULT_VIEW_TRANSFORM = getFitViewTransform(
  DEFAULT_VIEWPORT_SIZE,
  DEFAULT_ARTBOARD
)

type VideoMetadata = {
  width: number
  height: number
}

type EditorCanvasContextValue = {
  videos: CanvasVideoItem[]
  selectedItemId: string | null
  selectedVideo: CanvasVideoItem | null
  viewportSize: CanvasSize
  artboard: EditorArtboard
  viewTransform: ViewTransform
  importError: string | null
  addVideoFile: (file: File) => Promise<void>
  selectItem: (id: string | null) => void
  updateVideoTransform: (id: string, patch: CanvasVideoTransformPatch) => void
  setArtboardPreset: (id: ArtboardPresetId) => void
  setViewportSize: (size: CanvasSize) => void
  setViewTransform: (transform: ViewTransform) => void
  fitArtboardToViewport: () => void
}

type EditorCanvasMediaContextValue = Pick<
  EditorCanvasContextValue,
  "videos" | "selectedItemId" | "selectedVideo" | "importError"
>

type EditorCanvasArtboardContextValue = Pick<
  EditorCanvasContextValue,
  "artboard"
>

type EditorCanvasViewContextValue = Pick<
  EditorCanvasContextValue,
  "viewportSize" | "viewTransform"
>

type EditorCanvasActionsContextValue = Pick<
  EditorCanvasContextValue,
  | "addVideoFile"
  | "selectItem"
  | "updateVideoTransform"
  | "setArtboardPreset"
  | "setViewportSize"
  | "setViewTransform"
  | "fitArtboardToViewport"
>

const EditorCanvasMediaContext =
  createContext<EditorCanvasMediaContextValue | null>(null)
const EditorCanvasArtboardContext =
  createContext<EditorCanvasArtboardContextValue | null>(null)
const EditorCanvasViewContext =
  createContext<EditorCanvasViewContextValue | null>(null)
const EditorCanvasActionsContext =
  createContext<EditorCanvasActionsContextValue | null>(null)

function readVideoMetadata(objectUrl: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video")

    const cleanup = () => {
      video.removeEventListener("loadedmetadata", handleLoadedMetadata)
      video.removeEventListener("error", handleError)
      video.removeAttribute("src")
      video.load()
    }

    const handleLoadedMetadata = () => {
      const width = video.videoWidth
      const height = video.videoHeight
      cleanup()

      if (!width || !height) {
        reject(new Error("The selected video does not expose a valid size."))
        return
      }

      resolve({ width, height })
    }

    const handleError = () => {
      cleanup()
      reject(new Error("The selected video could not be loaded."))
    }

    video.preload = "metadata"
    video.muted = true
    video.playsInline = true
    video.addEventListener("loadedmetadata", handleLoadedMetadata)
    video.addEventListener("error", handleError)
    video.src = objectUrl
    video.load()
  })
}

function getCoverVideoPlacement(
  metadata: VideoMetadata,
  artboardSize: CanvasSize
) {
  const coverScale = Math.max(
    artboardSize.width / metadata.width,
    artboardSize.height / metadata.height
  )
  const width = metadata.width * coverScale
  const height = metadata.height * coverScale

  return {
    x: (artboardSize.width - width) / 2,
    y: (artboardSize.height - height) / 2,
    width,
    height,
  }
}

function createCanvasId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }

  return `canvas-item-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function EditorCanvasProvider({ children }: { children: ReactNode }) {
  const [videos, setVideos] = useState<CanvasVideoItem[]>([])
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [artboard, setArtboard] = useState<EditorArtboard>(DEFAULT_ARTBOARD)
  const [viewportSize, setViewportSizeState] = useState<CanvasSize>(
    DEFAULT_VIEWPORT_SIZE
  )
  const [viewTransform, setViewTransformState] = useState<ViewTransform>(
    DEFAULT_VIEW_TRANSFORM
  )
  const [importError, setImportError] = useState<string | null>(null)

  const objectUrlsRef = useRef(new Set<string>())
  const viewportSizeRef = useRef(viewportSize)
  const artboardRef = useRef(artboard)
  const viewTransformRef = useRef(viewTransform)
  const hasCustomViewRef = useRef(false)

  useEffect(() => {
    viewportSizeRef.current = viewportSize
  }, [viewportSize])

  useEffect(() => {
    artboardRef.current = artboard
  }, [artboard])

  useEffect(() => {
    viewTransformRef.current = viewTransform
  }, [viewTransform])

  useEffect(() => {
    const objectUrls = objectUrlsRef.current

    return () => {
      objectUrls.forEach((objectUrl) => {
        URL.revokeObjectURL(objectUrl)
      })
      objectUrls.clear()
    }
  }, [])

  const setViewportSize = useCallback((size: CanvasSize) => {
    const nextSize = {
      width: Math.max(0, Math.floor(size.width)),
      height: Math.max(0, Math.floor(size.height)),
    }

    if (
      viewportSizeRef.current.width === nextSize.width &&
      viewportSizeRef.current.height === nextSize.height
    ) {
      return
    }

    setViewportSizeState((current) =>
      current.width === nextSize.width && current.height === nextSize.height
        ? current
        : nextSize
    )

    viewportSizeRef.current = nextSize
    if (!hasCustomViewRef.current) {
      const fitTransform = getFitViewTransform(nextSize, artboardRef.current)
      viewTransformRef.current = fitTransform
      setViewTransformState(fitTransform)
      return
    }

    const clampedTransform = clampWorkspaceView(
      viewTransformRef.current,
      nextSize,
      artboardRef.current
    )
    viewTransformRef.current = clampedTransform
    setViewTransformState(clampedTransform)
  }, [])

  const setViewTransform = useCallback((transform: ViewTransform) => {
    hasCustomViewRef.current = true
    const clampedTransform = clampWorkspaceView(
      transform,
      viewportSizeRef.current,
      artboardRef.current
    )
    viewTransformRef.current = clampedTransform
    setViewTransformState((current) =>
      current.scale === clampedTransform.scale &&
      current.x === clampedTransform.x &&
      current.y === clampedTransform.y
        ? current
        : clampedTransform
    )
  }, [])

  const fitArtboardToViewport = useCallback(() => {
    hasCustomViewRef.current = false
    const fitTransform = getFitViewTransform(
      viewportSizeRef.current,
      artboardRef.current
    )
    viewTransformRef.current = fitTransform
    setViewTransformState(fitTransform)
  }, [])

  const setArtboardPreset = useCallback((id: ArtboardPresetId) => {
    const preset = getArtboardPreset(id)
    const nextArtboard: EditorArtboard = {
      presetId: preset.id,
      width: preset.width,
      height: preset.height,
    }

    artboardRef.current = nextArtboard
    hasCustomViewRef.current = false
    setArtboard(nextArtboard)
    const fitTransform = getFitViewTransform(
      viewportSizeRef.current,
      nextArtboard
    )
    viewTransformRef.current = fitTransform
    setViewTransformState(fitTransform)
  }, [])

  const addVideoFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("video/")) {
      setImportError("Choose a video file to add it to the canvas.")
      return
    }

    const objectUrl = URL.createObjectURL(file)
    objectUrlsRef.current.add(objectUrl)

    try {
      const metadata = await readVideoMetadata(objectUrl)
      const placement = getCoverVideoPlacement(metadata, artboardRef.current)
      const id = createCanvasId()
      const item: CanvasVideoItem = {
        id,
        fileName: file.name,
        objectUrl,
        intrinsicWidth: metadata.width,
        intrinsicHeight: metadata.height,
        rotation: 0,
        ...placement,
      }

      setVideos((current) => [...current, item])
      setSelectedItemId(id)
      setImportError(null)
    } catch (error) {
      objectUrlsRef.current.delete(objectUrl)
      URL.revokeObjectURL(objectUrl)
      setImportError(
        error instanceof Error
          ? error.message
          : "The selected video could not be loaded."
      )
    }
  }, [])

  const selectItem = useCallback((id: string | null) => {
    setSelectedItemId((current) => (current === id ? current : id))
  }, [])

  const updateVideoTransform = useCallback(
    (id: string, patch: CanvasVideoTransformPatch) => {
      setVideos((current) => {
        let didChange = false
        const nextVideos = current.map((video) => {
          if (video.id !== id) return video

          const nextVideo = { ...video, ...patch }
          didChange =
            nextVideo.x !== video.x ||
            nextVideo.y !== video.y ||
            nextVideo.width !== video.width ||
            nextVideo.height !== video.height ||
            nextVideo.rotation !== video.rotation

          return didChange ? nextVideo : video
        })

        return didChange ? nextVideos : current
      })
    },
    []
  )

  const selectedVideo = useMemo(
    () => videos.find((video) => video.id === selectedItemId) ?? null,
    [selectedItemId, videos]
  )

  const mediaValue = useMemo<EditorCanvasMediaContextValue>(
    () => ({
      videos,
      selectedItemId,
      selectedVideo,
      importError,
    }),
    [importError, selectedItemId, selectedVideo, videos]
  )

  const artboardValue = useMemo<EditorCanvasArtboardContextValue>(
    () => ({
      artboard,
    }),
    [artboard]
  )

  const viewValue = useMemo<EditorCanvasViewContextValue>(
    () => ({
      viewportSize,
      viewTransform,
    }),
    [viewTransform, viewportSize]
  )

  const actionsValue = useMemo<EditorCanvasActionsContextValue>(
    () => ({
      addVideoFile,
      selectItem,
      updateVideoTransform,
      setArtboardPreset,
      setViewportSize,
      setViewTransform,
      fitArtboardToViewport,
    }),
    [
      addVideoFile,
      selectItem,
      updateVideoTransform,
      setArtboardPreset,
      setViewportSize,
      setViewTransform,
      fitArtboardToViewport,
    ]
  )

  return (
    <EditorCanvasActionsContext.Provider value={actionsValue}>
      <EditorCanvasMediaContext.Provider value={mediaValue}>
        <EditorCanvasArtboardContext.Provider value={artboardValue}>
          <EditorCanvasViewContext.Provider value={viewValue}>
            {children}
          </EditorCanvasViewContext.Provider>
        </EditorCanvasArtboardContext.Provider>
      </EditorCanvasMediaContext.Provider>
    </EditorCanvasActionsContext.Provider>
  )
}

function useRequiredEditorCanvasContext<T>(
  context: T | null,
  contextName: string
) {
  if (!context) {
    throw new Error(`${contextName} must be used within EditorCanvasProvider.`)
  }

  return context
}

export function useEditorCanvasMedia() {
  return useRequiredEditorCanvasContext(
    useContext(EditorCanvasMediaContext),
    "useEditorCanvasMedia"
  )
}

export function useEditorCanvasArtboard() {
  return useRequiredEditorCanvasContext(
    useContext(EditorCanvasArtboardContext),
    "useEditorCanvasArtboard"
  )
}

export function useEditorCanvasView() {
  return useRequiredEditorCanvasContext(
    useContext(EditorCanvasViewContext),
    "useEditorCanvasView"
  )
}

export function useEditorCanvasActions() {
  return useRequiredEditorCanvasContext(
    useContext(EditorCanvasActionsContext),
    "useEditorCanvasActions"
  )
}

export function useEditorCanvas(): EditorCanvasContextValue {
  return {
    ...useEditorCanvasMedia(),
    ...useEditorCanvasArtboard(),
    ...useEditorCanvasView(),
    ...useEditorCanvasActions(),
  }
}
