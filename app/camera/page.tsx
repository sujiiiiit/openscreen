"use client"

import { useEffect, useRef, useState } from "react"
import { Spinner } from "@/components/ui/spinner"
import { DRAG } from "@/lib/window-drag"
import type { CameraPreviewFrame } from "@openscreen/mac-addon"

export default function CameraPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const sizeRef = useRef<{ width: number; height: number } | null>(null)
  // ImageData with a stable backing buffer; reused while the frame dimensions
  // don't change. Each native frame arrives as a fresh Uint8Array (a new
  // ArrayBuffer per structured-clone hop), so we memcpy into the stable
  // buffer rather than allocating a new ImageData every tick.
  const imageDataRef = useRef<ImageData | null>(null)
  const hasFrameRef = useRef(false)
  const [hasFrame, setHasFrame] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    console.log("[cameraPreview/renderer] mount; api present?", {
      hasApi: typeof window.api !== "undefined",
      hasCameraPreview: typeof window.api?.cameraPreview !== "undefined",
    })
    if (!window.api?.cameraPreview) {
      setErrorMessage("Preview bridge unavailable (preload did not load).")
      return undefined
    }

    let didLogFirstCallback = false

    const unsubscribeFrame = window.api.cameraPreview.onFrame((frame: CameraPreviewFrame) => {
      if (!didLogFirstCallback) {
        didLogFirstCallback = true
        const data = frame.data as unknown as { byteLength?: number; length?: number } | undefined
        console.log("[cameraPreview/renderer] first frame in component callback", {
          width: frame.width,
          height: frame.height,
          dataKind: data?.constructor?.name ?? typeof data,
          byteLength: data?.byteLength ?? data?.length,
          canvasRefAttached: canvasRef.current != null,
        })
      }

      const canvas = canvasRef.current
      if (!canvas) return

      if (
        !sizeRef.current ||
        sizeRef.current.width !== frame.width ||
        sizeRef.current.height !== frame.height
      ) {
        canvas.width = frame.width
        canvas.height = frame.height
        ctxRef.current = canvas.getContext("2d")
        sizeRef.current = { width: frame.width, height: frame.height }
        imageDataRef.current = new ImageData(frame.width, frame.height)
      }

      const ctx = ctxRef.current
      const imageData = imageDataRef.current
      if (!ctx || !imageData) return

      const source = frame.data as Uint8Array
      imageData.data.set(source)
      ctx.putImageData(imageData, 0, 0)
      if (!hasFrameRef.current) {
        hasFrameRef.current = true
        setHasFrame(true)
        setErrorMessage(null)
        console.log("[cameraPreview] first frame drawn", frame.width, frame.height)
      }
    })

    const unsubscribeError = window.api.cameraPreview.onError?.((message) => {
      console.error("[cameraPreview] start error", message)
      setErrorMessage(message)
    })

    // Tell main we're subscribed so it can start the native preview without
    // dropping the first frames.
    void window.api.cameraPreview
      .signalReady?.()
      .then((accepted: boolean) => {
        console.log("[cameraPreview/renderer] signalReady acknowledged", { accepted })
      })
      .catch((error: unknown) => {
        console.error("[cameraPreview/renderer] signalReady failed", error)
      })

    const watchdog = window.setTimeout(() => {
      if (!hasFrameRef.current) {
        console.warn(
          "[cameraPreview/renderer] no frames received within 3s — check main process logs for [cameraPreview] entries",
        )
      }
    }, 3000)

    return () => {
      window.clearTimeout(watchdog)
      unsubscribeFrame()
      unsubscribeError?.()
    }
  }, [])

  return (
    <div
      data-window="camera"
      className="relative h-full w-full overflow-hidden rounded-2xl select-none"
      style={DRAG}
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full object-cover transform-[scaleX(-1)]"
      />
      {!hasFrame && !errorMessage && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner size={28} />
        </div>
      )}
      {errorMessage && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 px-3 text-center text-xs text-red-300">
          {errorMessage}
        </div>
      )}
    </div>
  )
}
