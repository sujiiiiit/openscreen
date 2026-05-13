import { app, type BrowserWindow } from "electron"
import addon, { type CameraPreviewFrame } from "@openscreen/mac-addon"

interface CameraPreviewControllerOptions {
  getCameraWindow: () => BrowserWindow | null
  onStartError?: (message: string) => void
}

let currentDeviceId: string | null = null
let requestId = 0
let didLogFirstFrame = false
const isDev = !app.isPackaged

function devLog(...args: unknown[]): void {
  if (isDev) console.log(...args)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  didLogFirstFrame = false
  devLog("[cameraPreview] start", { deviceId })

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
        if (activeRequestId !== requestId) return

        const win = options.getCameraWindow()
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return

        if (!didLogFirstFrame) {
          didLogFirstFrame = true
          devLog("[cameraPreview] first frame forwarded", {
            width: frame.width,
            height: frame.height,
          })
        }

        win.webContents.send("cameraPreview:frame", {
          width: frame.width,
          height: frame.height,
          rowBytes: frame.rowBytes,
          data: frame.data,
        })
      })
      .then(() => {
        devLog("[cameraPreview] addon ready", { deviceId })
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
  void addon.stopCameraPreview().catch((error: unknown) => {
    console.error("[cameraPreview] failed to stop", error)
  })
}
