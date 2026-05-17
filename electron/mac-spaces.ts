import addon from '@openscreen/mac-addon'

type ActiveSpaceChangeCallback = () => void

const activeSpaceChangeCallbacks = new Set<ActiveSpaceChangeCallback>()
let nativeActiveSpaceChangeRegistered = false
let didLogActiveSpaceChangeError = false

function emitActiveSpaceChanged(): void {
  for (const callback of [...activeSpaceChangeCallbacks]) {
    try {
      callback()
    } catch (error) {
      console.error('[macSpaces] active Space callback failed', error)
    }
  }
}

export function subscribeActiveSpaceChange(
  callback: ActiveSpaceChangeCallback,
): () => void {
  if (process.platform !== 'darwin' || typeof addon.onActiveSpaceChange !== 'function') {
    return () => undefined
  }

  activeSpaceChangeCallbacks.add(callback)

  if (!nativeActiveSpaceChangeRegistered) {
    try {
      addon.onActiveSpaceChange(emitActiveSpaceChanged)
      nativeActiveSpaceChangeRegistered = true
    } catch (error) {
      activeSpaceChangeCallbacks.delete(callback)
      if (!didLogActiveSpaceChangeError) {
        didLogActiveSpaceChangeError = true
        console.warn('[macSpaces] failed to observe active Space changes', error)
      }
      return () => undefined
    }
  }

  return () => {
    activeSpaceChangeCallbacks.delete(callback)
  }
}
