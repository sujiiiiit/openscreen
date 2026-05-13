import { BrowserWindow } from 'electron'
import addon, { type RecordingEvent } from '@openscreen/mac-addon'

interface RegisterMacAddonHandlersOptions {
  // Only the recorder bar surfaces recording events. Every other window we
  // own (camera, permission) ignores them, so broadcasting wakes context
  // isolation up for nothing on each frameDropped/error tick.
  getRecorderWindow: () => BrowserWindow | null
}

let unsubscribeNativeEvents: (() => void) | null = null
let getRecorderWindowRef: (() => BrowserWindow | null) | null = null
let didLogRecordingEventDeliveryError = false

function sendRecordingEvent(event: RecordingEvent): void {
  const target = getRecorderWindowRef?.()
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return

  try {
    target.webContents.send('recorder:event', event)
  } catch (error) {
    if (didLogRecordingEventDeliveryError) return
    didLogRecordingEventDeliveryError = true
    console.error('[macAddon] failed to deliver recording event', error)
  }
}

// The addon's API surface is intentionally NOT exposed to the renderer via
// ipcMain.handle. Anything the renderer can drive must go through the
// `recorder:*` / `permissions:*` channels so main owns paths, device choices,
// and lifecycle. Direct addon access would let a compromised renderer pick its
// own outputDir or start a recording that bypasses our state machine.
export function registerMacAddonHandlers(options: RegisterMacAddonHandlersOptions): void {
  getRecorderWindowRef = options.getRecorderWindow

  if (!unsubscribeNativeEvents) {
    unsubscribeNativeEvents = addon.onRecordingEvent(sendRecordingEvent)
  }
}

// Release the native ThreadSafeFunction so its underlying worker thread exits
// cleanly. Without this, on macOS the process can sit for a beat at shutdown
// waiting for libuv to drain the TSFN.
export function disposeMacAddon(): void {
  if (unsubscribeNativeEvents) {
    unsubscribeNativeEvents()
    unsubscribeNativeEvents = null
  }
  getRecorderWindowRef = null
}
