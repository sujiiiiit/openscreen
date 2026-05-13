import { type BrowserWindow } from "electron"
import addon, { type CameraPreviewFrame } from "@openscreen/mac-addon"

interface CameraPreviewControllerOptions {
  getCameraWindow: () => BrowserWindow | null
  onStartError?: (message: string) => void
}

let currentDeviceId: string | null = null
let requestId = 0
let didLogFrameDeliveryError = false
let didLogFirstFrame = false

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function frameWindow(
  options: CameraPreviewControllerOptions
): BrowserWindow | null {
  const win = options.getCameraWindow()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null
  return win
}

function logFrameDeliveryError(error: unknown): void {
  if (didLogFrameDeliveryError) return
  didLogFrameDeliveryError = true
  console.error("[cameraPreview] failed to deliver frame", error)
}

export function startCameraPreview(
  deviceId: string,
  options: CameraPreviewControllerOptions
): void {
  if (process.platform !== "darwin") return
  if (currentDeviceId === deviceId) return
  stopCameraPreview()

  const activeRequestId = ++requestId
  currentDeviceId = deviceId
  didLogFrameDeliveryError = false
  didLogFirstFrame = false
  console.log("[cameraPreview] start", { deviceId })

  const handleStartError = (error: unknown): void => {
    if (activeRequestId !== requestId) return
    const message = errorMessage(error)
    currentDeviceId = null
    console.error("[cameraPreview] failed to start", message)
    options.onStartError?.(message)
  }

  try {
    void addon
      .startCameraPreview({ deviceId }, (frame: CameraPreviewFrame) => {
        console.log("[cameraPreview] JS callback invoked", {
          width: frame.width,
          height: frame.height,
          activeRequestId,
          requestId,
          currentDeviceId,
          deviceId,
        })
        if (activeRequestId !== requestId || currentDeviceId !== deviceId)
          return

        try {
          const win = frameWindow(options)
          if (!win) return

          if (!didLogFirstFrame) {
            didLogFirstFrame = true
            console.log("[cameraPreview] first frame sent", {
              width: frame.width,
              height: frame.height,
              bytes: (frame.data as { length?: number } | undefined)?.length,
            })
          }

          win.webContents.send("cameraPreview:frame", {
            width: frame.width,
            height: frame.height,
            rowBytes: frame.rowBytes,
            data: Buffer.from(frame.data),
          })
        } catch (error) {
          logFrameDeliveryError(error)
        }
      })
      .then(() => {
        console.log("[cameraPreview] addon ready", { deviceId })
      })
      .catch(handleStartError)
  } catch (error) {
    handleStartError(error)
  }
}

export function stopCameraPreview(): void {
  if (process.platform !== "darwin") return
  if (currentDeviceId === null) return
  requestId++
  currentDeviceId = null
  try {
    void addon.stopCameraPreview().catch((error: unknown) => {
      console.error("[cameraPreview] failed to stop", error)
    })
  } catch (error) {
    console.error("[cameraPreview] failed to stop", error)
  }
}

export function getCurrentCameraPreviewDevice(): string | null {
  return currentDeviceId
}
