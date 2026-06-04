import type { SmoothedCursorTrack } from "@/lib/cursors/cursor-track"
import type {
  CursorMotionRotationMode,
  CursorSetId,
  CursorSmoothingMode,
} from "@/types/editor-canvas"

import { CursorSprite } from "./cursor-sprite"
import type { CanvasScene } from "./scene"

/** The live inputs the cursor placement reads, pushed from the provider bridge. */
export type CursorState = {
  screenVideo: {
    x: number
    y: number
    width: number
    height: number
    rotation: number
    intrinsicWidth: number
    intrinsicHeight: number
  } | null
  /** Maps timeline time → screen source time (`t - start + sourceIn`). */
  screenClip: { start: number; sourceIn: number } | null
  referenceSize: { width: number; height: number }
  customRenderingEnabled: boolean
  cursorSetId: CursorSetId
  sizeMultiplier: number
  smoothingMode: CursorSmoothingMode
  clickPressScale: number
  alwaysUsePointer: boolean
  motionRotation: number
  motionRotationMode: CursorMotionRotationMode
  motionBlur: number
}

/**
 * Editor-preview cursor: owns a {@link CursorSprite} in the scene's content
 * cursor layer and places it imperatively per playback tick / hover, mapping the
 * timeline time through the screen clip to the recording's source time. The
 * sprite + native MotionBlurFilter live in CursorSprite (shared with the export);
 * this class only holds the live state + track and drives the per-frame call.
 */
export class CursorController {
  private readonly scene: CanvasScene
  private readonly cursorSprite: CursorSprite
  private track: SmoothedCursorTrack | null = null
  private state: CursorState | null = null
  private lastTimelineSeconds = 0

  constructor(scene: CanvasScene) {
    this.scene = scene
    this.cursorSprite = new CursorSprite(scene.getCursorLayer())
  }

  setTrack(track: SmoothedCursorTrack | null) {
    this.track = track
  }

  setState(state: CursorState) {
    this.state = state
  }

  place(timelineSeconds: number) {
    this.lastTimelineSeconds = timelineSeconds
    const { state, track } = this
    if (
      !state ||
      !state.customRenderingEnabled ||
      !state.screenVideo ||
      !track
    ) {
      this.cursorSprite.hide()
      this.scene.requestRender()
      return
    }

    const sourceSeconds = state.screenClip
      ? timelineSeconds - state.screenClip.start + state.screenClip.sourceIn
      : timelineSeconds

    this.cursorSprite.render(
      track,
      state.screenVideo,
      sourceSeconds,
      {
        sizeMultiplier: state.sizeMultiplier,
        clickPressScale: state.clickPressScale,
        cursorSet: state.cursorSetId,
        alwaysUsePointer: state.alwaysUsePointer,
        motionRotation: state.motionRotation,
        motionRotationMode: state.motionRotationMode,
        smoothingMode: state.smoothingMode,
        referenceSize: state.referenceSize,
      },
      state.motionBlur,
      () => this.place(this.lastTimelineSeconds)
    )
    this.scene.requestRender()
  }

  destroy() {
    this.cursorSprite.destroy()
  }
}
