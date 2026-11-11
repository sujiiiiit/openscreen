import {
  ALL_FORMATS,
  CanvasSink,
  Input,
  UrlSource,
  VideoSample,
  VideoSampleSink,
  type WrappedCanvas,
} from "mediabunny"

import { timelineToSourceSeconds } from "@/lib/timeline-edits"
import type { ProjectTimelineClip } from "@/types/api"

export type DecodedSourceCanvas = HTMLCanvasElement | OffscreenCanvas
/**
 * What `.next()` hands the render loop: a decoded `VideoFrame` on the fast
 * path (caller MUST `close()` it once it has been uploaded/rendered), or a
 * pooled canvas on the fallback path (owned by the sink — do not close).
 */
export type DecodedSourceFrame = DecodedSourceCanvas | VideoFrame

/**
 * Fast-path gate: the export can hand decoded `VideoFrame`s straight to the
 * PixiJS texture (skipping Mediabunny's canvas blit AND the per-node 2D
 * staging blit) only when no canvas-side preprocessing is needed — i.e. the
 * track has no rotation metadata to bake in and its coded size equals the
 * intrinsic size the stage's cover-crop math was built around. Pure +
 * exported for tests.
 */
export function canUseDirectVideoFrames(opts: {
  rotation: number
  codedWidth: number
  codedHeight: number
  intrinsicWidth: number
  intrinsicHeight: number
}): boolean {
  return (
    opts.rotation === 0 &&
    opts.codedWidth === opts.intrinsicWidth &&
    opts.codedHeight === opts.intrinsicHeight
  )
}

/**
 * Streaming source-video decoder for one input file, built on Mediabunny's
 * WebCodecs `VideoDecoder` pipeline — decodes each packet **at most once**
 * when timestamps are monotonically sorted. Eliminates the per-frame
 * `<video>.currentTime` seek round-trip that dominated wall-clock time in
 * the export loop.
 *
 * Two modes, chosen at create() time:
 *
 * - **Direct `VideoFrame` mode** (`VideoSampleSink.samplesAtTimestamps`) —
 *   the default for our own recordings (rotation 0, coded size ==
 *   intrinsic size). Each `.next()` yields a `VideoFrame` that the caller
 *   uploads to the GPU texture directly and then closes. This skips two
 *   full-resolution canvas blits per frame (Mediabunny's sample→canvas
 *   draw and the export node's canvas→canvas staging draw); for a
 *   hardware-decoded source the texture upload is a GPU→GPU transfer.
 *   `toVideoFrame()` on a decoder-backed sample is a refcounted wrapper,
 *   not a pixel copy, and Mediabunny clones samples that satisfy duplicate
 *   timestamps, so every yielded frame is independently closable.
 *
 * - **Canvas fallback mode** (`CanvasSink.canvasesAtTimestamps`) — used
 *   when rotation metadata or a coded/intrinsic size mismatch means the
 *   canvas preprocessing step is actually needed. Canvases are reused from
 *   a small pool (default 4), so memory stays bounded.
 *
 * Use:
 *   1. Build a `planExportFrames` plan first (computes the timestamp
 *      sequence per source).
 *   2. `await SourceFrameProvider.create({...})` per unique source URL.
 *   3. Call `.next()` once per output frame on which the source is active.
 *      If it returns a `VideoFrame`, close it after the stage has rendered.
 *   4. `.dispose()` in cleanup.
 */
export class SourceFrameProvider {
  private constructor(
    private readonly input: Input,
    private readonly iterator: AsyncGenerator<
      WrappedCanvas | VideoSample | null,
      void,
      unknown
    >,
    /** True when this source runs the direct-`VideoFrame` fast path. */
    readonly usesVideoFrames: boolean,
  ) {}

  static async create(opts: {
    url: string
    intrinsicWidth: number
    intrinsicHeight: number
    timestamps: readonly number[]
  }): Promise<SourceFrameProvider> {
    // UrlSource issues HTTP Range requests under the hood — so a 200 MB
    // recording isn't slurped into JS heap before decoding can start.
    // Mediabunny streams what it needs.
    //
    // The try/catch covers BOTH the sync Input construction AND every
    // async step before we hand off ownership to the returned provider.
    // Without it, a rejected `getPrimaryVideoTrack()` or a `CanvasSink`
    // constructor throw would leak the Input — no consumer would ever
    // call `.dispose()` on it. The decoder + Range requests stay open
    // until the page unloads.
    let input: Input | null = null
    try {
      input = new Input({
        formats: ALL_FORMATS,
        source: new UrlSource(opts.url),
      })
      const track = await input.getPrimaryVideoTrack()
      if (!track) {
        throw new Error(`No video track in source: ${opts.url}`)
      }
      const timestamps = opts.timestamps
      const timestampIterator = (async function* () {
        for (const t of timestamps) yield t
      })()

      const direct = canUseDirectVideoFrames({
        rotation: await track.getRotation(),
        codedWidth: track.codedWidth,
        codedHeight: track.codedHeight,
        intrinsicWidth: opts.intrinsicWidth,
        intrinsicHeight: opts.intrinsicHeight,
      })
      if (direct) {
        // Fast path: raw decoder output, no canvas staging. The render loop
        // uploads each VideoFrame straight into the node's texture.
        const sink = new VideoSampleSink(track)
        return new SourceFrameProvider(
          input,
          sink.samplesAtTimestamps(timestampIterator),
          true,
        )
      }

      const sink = new CanvasSink(track, {
        // Decode at native intrinsic dimensions; PixiJS then handles the
        // cover-crop (texture frame) + artboard scale, so the export's pixels
        // match the editor preview exactly. Could be moved to render size with
        // `fit: 'cover'` later if memory pressure shows up.
        width: opts.intrinsicWidth,
        height: opts.intrinsicHeight,
        // `fit` is required by Mediabunny when both width and height are
        // set. `'fill'` is the right choice here because both dimensions
        // equal the source's native frame size — no resize / aspect change
        // happens regardless. If we ever decode at the render size we'd
        // switch to `'cover'` to match the editor's cover-crop semantics.
        fit: "fill",
        // Pool of recycled canvases — keeps VRAM bounded across long exports
        // and avoids alloc churn. The decoder pre-fetches ~poolSize-1 frames
        // ahead of the consumer, which is exactly what we want for a
        // pull-driven render loop.
        poolSize: 4,
      })
      const iterator = sink.canvasesAtTimestamps(timestampIterator)
      return new SourceFrameProvider(input, iterator, false)
    } catch (error) {
      if (input) {
        try {
          input.dispose()
        } catch {
          // best-effort
        }
      }
      throw error
    }
  }

  /**
   * Pull the next decoded frame in the source's monotonic timestamp
   * sequence. Returns `null` only if the iterator is exhausted or the
   * requested timestamp falls before the track's first frame.
   *
   * Ownership: a returned `VideoFrame` belongs to the caller, who must
   * `close()` it after the GPU upload (leaks stall the decoder); a returned
   * canvas stays owned by the sink's pool.
   */
  async next(): Promise<DecodedSourceFrame | null> {
    const result = await this.iterator.next()
    if (result.done || !result.value) return null
    const value = result.value
    if (value instanceof VideoSample) {
      // Refcounted wrapper around the decoder's VideoFrame — closing the
      // sample here just drops our reference; the returned frame stays live
      // until the caller closes it.
      const frame = value.toVideoFrame()
      value.close()
      return frame
    }
    return value.canvas
  }

  dispose(): void {
    // Explicitly close the async iterator first. Both Mediabunny sinks
    // (`samplesAtTimestamps` / `canvasesAtTimestamps`) pre-decode a few
    // samples ahead of the consumer; if we just kill the Input without
    // telling the iterator we're done, those pre-fetched VideoSamples never
    // get .close()'d and we trip Mediabunny's "VideoSample was garbage
    // collected without first being closed" warning on the next GC cycle.
    // Calling .return() runs the generator's cleanup path (which closes the
    // buffered samples) synchronously from the consumer's point of view.
    void this.iterator.return?.()
    // Then dispose the Input: cancels any in-flight Range requests, closes
    // the WebCodecs decoder, returns pooled canvases to the GC.
    this.input.dispose()
  }
}

export interface ExportFramePlanEntry {
  videoId: string
  sourceTimeSec: number
}

export interface ExportFramePlan {
  /** For every output frame, the list of clips active at that frame. */
  framePlan: ExportFramePlanEntry[][]
  /**
   * For every source video referenced by at least one clip, the list of
   * source timestamps the export will request — in the order they'll be
   * requested. Monotonically sorted iff the clips referencing that source
   * are placed in timeline order without source-time inversions; otherwise
   * Mediabunny still works but loses the per-packet decode optimisation.
   */
  sourceTimelinesByVideoId: Map<string, number[]>
}

/**
 * Walk the timeline once and produce a complete export plan. Used both to
 * build per-source timestamp streams (fed to `SourceFrameProvider`) and to
 * drive the render loop's per-frame "which clips are active" check —
 * computing this once removes the O(frames × clips) check from the hot path.
 */
export function planExportFrames(opts: {
  clips: readonly ProjectTimelineClip[]
  totalFrames: number
  fps: number
}): ExportFramePlan {
  const { clips, totalFrames, fps } = opts
  const framePlan: ExportFramePlanEntry[][] = []
  const sourceTimelinesByVideoId = new Map<string, number[]>()

  for (let i = 0; i < totalFrames; i++) {
    const t = i / fps
    const active: ExportFramePlanEntry[] = []
    for (const clip of clips) {
      if (t < clip.start || t >= clip.end) continue
      const sourceTimeSec = timelineToSourceSeconds(clip, t)
      active.push({ videoId: clip.videoId, sourceTimeSec })
      let bucket = sourceTimelinesByVideoId.get(clip.videoId)
      if (!bucket) {
        bucket = []
        sourceTimelinesByVideoId.set(clip.videoId, bucket)
      }
      bucket.push(sourceTimeSec)
    }
    framePlan.push(active)
  }

  return { framePlan, sourceTimelinesByVideoId }
}
