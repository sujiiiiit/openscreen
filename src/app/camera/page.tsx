"use client"

import { useEffect, useRef, useState } from "react"
import { Spinner } from "@/components/ui/spinner"
import { DRAG } from "@/lib/window-drag"
import type { CameraPreviewFrame } from "@openscreen/mac-addon"

export default function CameraPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const sizeRef = useRef<{ width: number; height: number } | null>(null)
  const imageDataRef = useRef<ImageData | null>(null)
  const hasFrameRef = useRef(false)
  const [hasFrame, setHasFrame] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [diagnostic, setDiagnostic] = useState<string | null>(null)

  useEffect(() => {
    if (!window.api?.cameraPreview) {
      setErrorMessage("Preview bridge unavailable (preload did not load).")
      return undefined
    }

    const unsubscribeFrame = window.api.cameraPreview.onFrame(
      (frame: CameraPreviewFrame) => {
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

        imageData.data.set(frame.data as unknown as Uint8Array)
        ctx.putImageData(imageData, 0, 0)

        if (!hasFrameRef.current) {
          hasFrameRef.current = true
          setHasFrame(true)
          setErrorMessage(null)
          setDiagnostic(null)
          if (process.env.NODE_ENV !== "production") {
            console.log(
              "[cameraPreview] first frame drawn",
              frame.width,
              frame.height,
            )
          }
        }
      },
    )

    const unsubscribeError = window.api.cameraPreview.onError?.((message) => {
      console.error("[cameraPreview] error from main", message)
      setErrorMessage(message)
    })

    const watchdog = window.setTimeout(() => {
      if (!hasFrameRef.current) {
        const msg =
          "No camera frames received in 3s. Check terminal for [cameraPreview] logs."
        if (process.env.NODE_ENV !== "production") {
          console.warn("[cameraPreview/renderer]", msg)
        }
        setDiagnostic(msg)
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
      className="relative h-full w-full overflow-hidden rounded-2xl select-none bg-transparent"
      style={DRAG}
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full object-cover -scale-x-100"
      />
      {!hasFrame && !errorMessage && !diagnostic && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner size={28} />
        </div>
      )}
      {!hasFrame && diagnostic && !errorMessage && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 px-3 text-center text-[10px] text-yellow-200">
          {diagnostic}
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
