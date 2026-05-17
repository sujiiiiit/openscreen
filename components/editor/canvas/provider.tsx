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
  AUTO_ARTBOARD_PRESET_ID,
  clampWorkspaceView,
  DEFAULT_ARTBOARD_PRESET_ID,
  getArtboardPreset,
  getFitViewTransform,
  resolveAutoArtboard,
} from "@/lib/editor-canvas"
import { useProject } from "@/components/editor/project/provider"
import type {
  CanvasSize,
  CanvasVideoCropShape,
  CanvasVideoItem,
  CanvasVideoRole,
  CanvasVideoTransformPatch,
  EditorArtboard,
  ViewTransform,
} from "@/types/editor-canvas"
import type { ProjectAsset } from "@/types/api"

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
const DUPLICATED_VIDEO_OFFSET = 48
const CAMERA_DEFAULT_DIAMETER = 240
const CAMERA_DEFAULT_MARGIN = 32

type AddRemoteVideoInput = {
  id?: string
  url: string
  fileName: string
  intrinsicWidth: number
  intrinsicHeight: number
  role: "screen" | "camera"
  cropShape?: CanvasVideoCropShape
  placement?: Partial<Pick<CanvasVideoItem, "x" | "y" | "width" | "height">>
}

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
  addRemoteVideo: (input: AddRemoteVideoInput) => string | null
  selectItem: (id: string | null) => void
  updateVideoTransform: (id: string, patch: CanvasVideoTransformPatch) => void
  setVideoLocked: (id: string, locked: boolean) => void
  duplicateVideo: (id: string) => void
  deleteVideo: (id: string) => void
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
  | "addRemoteVideo"
  | "selectItem"
  | "updateVideoTransform"
  | "setVideoLocked"
  | "duplicateVideo"
  | "deleteVideo"
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

function relayoutVideoForArtboard(
  video: CanvasVideoItem,
  prev: CanvasSize,
  next: CanvasSize
): CanvasVideoItem {
  if (prev.width <= 0 || prev.height <= 0) return video

  if (video.role === "screen") {
    const cover = getCoverVideoPlacement(
      { width: video.intrinsicWidth, height: video.intrinsicHeight },
      next
    )
    return { ...video, ...cover }
  }

  const scaleX = next.width / prev.width
  const scaleY = next.height / prev.height
  const uniformScale = Math.min(scaleX, scaleY)

  if (video.role === "camera") {
    const nextWidth = video.width
    const nextHeight = video.height
    const targetX = video.x * scaleX
    const targetY = video.y * scaleY
    const clampedX = Math.max(0, Math.min(next.width - nextWidth, targetX))
    const clampedY = Math.max(0, Math.min(next.height - nextHeight, targetY))
    return {
      ...video,
      x: clampedX,
      y: clampedY,
      width: nextWidth,
      height: nextHeight,
    }
  }

  const nextWidth = video.width * uniformScale
  const nextHeight = video.height * uniformScale
  const targetX = video.x * uniformScale
  const targetY = video.y * uniformScale
  const clampedX = Math.max(0, Math.min(next.width - nextWidth, targetX))
  const clampedY = Math.max(0, Math.min(next.height - nextHeight, targetY))
  return {
    ...video,
    x: clampedX,
    y: clampedY,
    width: nextWidth,
    height: nextHeight,
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
  const videosRef = useRef(videos)
  const selectedItemIdRef = useRef(selectedItemId)
  const viewportSizeRef = useRef(viewportSize)
  const artboardRef = useRef(artboard)
  const viewTransformRef = useRef(viewTransform)
  const hasCustomViewRef = useRef(false)
  const sourceVideoDimsRef = useRef<{ width: number; height: number } | null>(
    null
  )
  const hydratedProjectIdRef = useRef<string | null>(null)

  useEffect(() => {
    videosRef.current = videos
  }, [videos])

  useEffect(() => {
    selectedItemIdRef.current = selectedItemId
  }, [selectedItemId])

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
    let nextArtboard: EditorArtboard
    if (id === AUTO_ARTBOARD_PRESET_ID) {
      const auto = resolveAutoArtboard(sourceVideoDimsRef.current)
      nextArtboard = {
        presetId: AUTO_ARTBOARD_PRESET_ID,
        width: auto.width,
        height: auto.height,
      }
    } else {
      const preset = getArtboardPreset(id)
      nextArtboard = {
        presetId: preset.id,
        width: preset.width,
        height: preset.height,
      }
    }

    const prevArtboard = artboardRef.current
    artboardRef.current = nextArtboard
    hasCustomViewRef.current = false
    setArtboard(nextArtboard)
    const fitTransform = getFitViewTransform(
      viewportSizeRef.current,
      nextArtboard
    )
    viewTransformRef.current = fitTransform
    setViewTransformState(fitTransform)

    if (
      prevArtboard.width === nextArtboard.width &&
      prevArtboard.height === nextArtboard.height
    ) {
      return
    }

    setVideos((current) => {
      let didChange = false
      const nextVideos = current.map((video) => {
        const adjusted = relayoutVideoForArtboard(
          video,
          prevArtboard,
          nextArtboard
        )
        if (adjusted !== video) didChange = true
        return adjusted
      })
      if (!didChange) return current
      videosRef.current = nextVideos
      return nextVideos
    })
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
        locked: false,
        cropShape: "rect",
        role: "media",
        ...placement,
      }

      setVideos((current) => {
        const nextVideos = [...current, item]
        videosRef.current = nextVideos
        return nextVideos
      })
      selectedItemIdRef.current = id
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

  const addRemoteVideo = useCallback(
    (input: AddRemoteVideoInput): string | null => {
      if (
        !input.url ||
        !Number.isFinite(input.intrinsicWidth) ||
        !Number.isFinite(input.intrinsicHeight) ||
        input.intrinsicWidth <= 0 ||
        input.intrinsicHeight <= 0
      ) {
        return null
      }

      const desiredId = input.id ?? createCanvasId()
      if (videosRef.current.some((video) => video.id === desiredId)) {
        return desiredId
      }

      const artboardSize = artboardRef.current
      const cropShape: CanvasVideoCropShape =
        input.cropShape ?? (input.role === "camera" ? "circle" : "rect")

      let placement: { x: number; y: number; width: number; height: number }
      if (input.role === "camera") {
        const width = input.placement?.width ?? CAMERA_DEFAULT_DIAMETER
        const height = input.placement?.height ?? CAMERA_DEFAULT_DIAMETER
        const x =
          input.placement?.x ??
          artboardSize.width - width - CAMERA_DEFAULT_MARGIN
        const y =
          input.placement?.y ??
          artboardSize.height - height - CAMERA_DEFAULT_MARGIN
        placement = { x, y, width, height }
      } else {
        const cover = getCoverVideoPlacement(
          { width: input.intrinsicWidth, height: input.intrinsicHeight },
          artboardSize
        )
        placement = {
          x: input.placement?.x ?? cover.x,
          y: input.placement?.y ?? cover.y,
          width: input.placement?.width ?? cover.width,
          height: input.placement?.height ?? cover.height,
        }
      }

      const role: CanvasVideoRole =
        input.role === "screen" || input.role === "camera"
          ? input.role
          : "media"

      const item: CanvasVideoItem = {
        id: desiredId,
        fileName: input.fileName,
        objectUrl: input.url,
        intrinsicWidth: input.intrinsicWidth,
        intrinsicHeight: input.intrinsicHeight,
        rotation: 0,
        locked: false,
        cropShape,
        role,
        ...placement,
      }

      setVideos((current) => {
        if (current.some((video) => video.id === desiredId)) return current
        const nextVideos = [...current, item]
        videosRef.current = nextVideos
        return nextVideos
      })
      return desiredId
    },
    []
  )

  const selectItem = useCallback((id: string | null) => {
    selectedItemIdRef.current = id
    setSelectedItemId((current) => (current === id ? current : id))
  }, [])

  const updateVideoTransform = useCallback(
    (id: string, patch: CanvasVideoTransformPatch) => {
      setVideos((current) => {
        let didChange = false
        const nextVideos = current.map((video) => {
          if (video.id !== id) return video
          if (video.locked) return video

          const nextVideo = { ...video, ...patch }
          didChange =
            nextVideo.x !== video.x ||
            nextVideo.y !== video.y ||
            nextVideo.width !== video.width ||
            nextVideo.height !== video.height ||
            nextVideo.rotation !== video.rotation

          return didChange ? nextVideo : video
        })

        if (!didChange) return current

        videosRef.current = nextVideos
        return nextVideos
      })
    },
    []
  )

  const setVideoLocked = useCallback((id: string, locked: boolean) => {
    setVideos((current) => {
      let didChange = false
      const nextVideos = current.map((video) => {
        if (video.id !== id || video.locked === locked) return video

        didChange = true
        return {
          ...video,
          locked,
        }
      })

      if (!didChange) return current

      videosRef.current = nextVideos
      return nextVideos
    })
  }, [])

  const duplicateVideo = useCallback((id: string) => {
    const currentVideos = videosRef.current
    const selectedIndex = currentVideos.findIndex((video) => video.id === id)
    const selectedVideo = currentVideos[selectedIndex]
    if (!selectedVideo) return

    const duplicate: CanvasVideoItem = {
      ...selectedVideo,
      id: createCanvasId(),
      x: selectedVideo.x + DUPLICATED_VIDEO_OFFSET,
      y: selectedVideo.y + DUPLICATED_VIDEO_OFFSET,
    }
    const nextVideos = [
      ...currentVideos.slice(0, selectedIndex + 1),
      duplicate,
      ...currentVideos.slice(selectedIndex + 1),
    ]

    videosRef.current = nextVideos
    selectedItemIdRef.current = duplicate.id
    setVideos(nextVideos)
    setSelectedItemId(duplicate.id)
  }, [])

  const deleteVideo = useCallback((id: string) => {
    const currentVideos = videosRef.current
    const deletedVideo = currentVideos.find((video) => video.id === id)
    if (!deletedVideo) return

    const nextVideos = currentVideos.filter((video) => video.id !== id)
    const objectUrlStillUsed = nextVideos.some(
      (video) => video.objectUrl === deletedVideo.objectUrl
    )

    if (!objectUrlStillUsed) {
      objectUrlsRef.current.delete(deletedVideo.objectUrl)
      URL.revokeObjectURL(deletedVideo.objectUrl)
    }

    videosRef.current = nextVideos
    setVideos(nextVideos)

    if (selectedItemIdRef.current === id) {
      selectedItemIdRef.current = null
      setSelectedItemId(null)
    }
  }, [])

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
      addRemoteVideo,
      selectItem,
      updateVideoTransform,
      setVideoLocked,
      duplicateVideo,
      deleteVideo,
      setArtboardPreset,
      setViewportSize,
      setViewTransform,
      fitArtboardToViewport,
    }),
    [
      addVideoFile,
      addRemoteVideo,
      selectItem,
      updateVideoTransform,
      setVideoLocked,
      duplicateVideo,
      deleteVideo,
      setArtboardPreset,
      setViewportSize,
      setViewTransform,
      fitArtboardToViewport,
    ]
  )

  const { project } = useProject()

  useEffect(() => {
    if (!project) return
    if (hydratedProjectIdRef.current === project.id) return

    const findAsset = (role: ProjectAsset["role"]) =>
      project.assets.find((asset) => asset.role === role) ?? null

    const screenAsset = findAsset("screen")
    const cameraAsset = findAsset("camera")

    if (!screenAsset && !cameraAsset) return

    if (
      hydratedProjectIdRef.current !== null &&
      hydratedProjectIdRef.current !== project.id
    ) {
      const previousBlobs = Array.from(objectUrlsRef.current)
      objectUrlsRef.current.clear()
      for (const url of previousBlobs) URL.revokeObjectURL(url)
      videosRef.current = []
      selectedItemIdRef.current = null
      setVideos([])
      setSelectedItemId(null)
    }

    if (
      screenAsset &&
      typeof screenAsset.width === "number" &&
      typeof screenAsset.height === "number" &&
      screenAsset.width > 0 &&
      screenAsset.height > 0
    ) {
      sourceVideoDimsRef.current = {
        width: screenAsset.width,
        height: screenAsset.height,
      }

      // Display captures inherit the source's aspect via the Auto preset so
      // the recording fills the artboard with no letterboxing. Window /
      // region / application captures fall back to the Wide 16:9 preset —
      // those source shapes are arbitrary and would otherwise produce an
      // odd-shaped artboard.
      const useAuto = project.recordingType === "display"
      const nextArtboard: EditorArtboard = useAuto
        ? (() => {
            const auto = resolveAutoArtboard(sourceVideoDimsRef.current)
            return {
              presetId: AUTO_ARTBOARD_PRESET_ID,
              width: auto.width,
              height: auto.height,
            }
          })()
        : (() => {
            const preset = getArtboardPreset(DEFAULT_ARTBOARD_PRESET_ID)
            return {
              presetId: preset.id,
              width: preset.width,
              height: preset.height,
            }
          })()
      artboardRef.current = nextArtboard
      hasCustomViewRef.current = false
      setArtboard(nextArtboard)
      const fit = getFitViewTransform(viewportSizeRef.current, nextArtboard)
      viewTransformRef.current = fit
      setViewTransformState(fit)
    }

    if (
      screenAsset &&
      typeof screenAsset.width === "number" &&
      typeof screenAsset.height === "number" &&
      screenAsset.width > 0 &&
      screenAsset.height > 0
    ) {
      addRemoteVideo({
        id: `${project.id}:screen`,
        url: screenAsset.fileUrl,
        fileName: screenAsset.fileName,
        intrinsicWidth: screenAsset.width,
        intrinsicHeight: screenAsset.height,
        role: "screen",
      })
    }

    if (
      cameraAsset &&
      typeof cameraAsset.width === "number" &&
      typeof cameraAsset.height === "number" &&
      cameraAsset.width > 0 &&
      cameraAsset.height > 0
    ) {
      addRemoteVideo({
        id: `${project.id}:camera`,
        url: cameraAsset.fileUrl,
        fileName: cameraAsset.fileName,
        intrinsicWidth: cameraAsset.width,
        intrinsicHeight: cameraAsset.height,
        role: "camera",
      })
    }

    hydratedProjectIdRef.current = project.id
  }, [addRemoteVideo, project])

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
