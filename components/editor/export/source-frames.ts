import {
  ALL_FORMATS,
  CanvasSink,
  Input,
  UrlSource,
  type WrappedCanvas,
} from "mediabunny"

import type { ProjectTimelineClip } from "@/types/api"

export type DecodedSourceCanvas = HTMLCanvasElement | OffscreenCanvas

/**
 * Streaming source-video decoder for one input file, built on Mediabunny's
 * `CanvasSink.canvasesAtTimestamps` — a WebCodecs `VideoDecoder` pipeline
 * that decodes each packet **at most once** when timestamps are
 * monotonically sorted. Eliminates the per-frame `<video>.currentTime` seek
 * round-trip that dominates wall-clock time in the export loop.
 *
 * Use:
 *   1. Build a `planExportFrames` plan first (computes the timestamp
 *      sequence per source).
 *   2. `await SourceFrameProvider.create({...})` per unique source URL.
 *   3. Call `.next()` once per output frame on which the source is active.
 *   4. `.dispose()` in cleanup.
 *
 * Memory: canvases are reused from a small pool (default 4). For long
 * exports with many sources this stays bounded.
 */
export class SourceFrameProvider {
  private constructor(
    private readonly input: Input,
    private readonly iterator: AsyncGenerator<
      WrappedCanvas | null,
      void,
      unknown
    >,
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
      const sink = new CanvasSink(track, {
        // Decode at native intrinsic dimensions; Konva then handles the
        // cover-crop + artboard scale via its sceneFunc, so the export's
        // pixels match the editor preview exactly. Could be moved to render
        // size with `fit: 'cover'` later if memory pressure shows up.
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
      const timestamps = opts.timestamps
      const iterator = sink.canvasesAtTimestamps(
        (async function* () {
          for (const t of timestamps) yield t
        })(),
      )
      return new SourceFrameProvider(input, iterator)
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
   * Pull the next canvas in the source's monotonic timestamp sequence.
   * Returns `null` only if the iterator is exhausted or the requested
   * timestamp falls before the track's first frame.
   */
  async next(): Promise<DecodedSourceCanvas | null> {
    const result = await this.iterator.next()
    if (result.done || !result.value) return null
    return result.value.canvas
  }

  dispose(): void {
    // Explicitly close the async iterator first. Mediabunny's
    // `canvasesAtTimestamps` pre-decodes a few samples ahead of the
    // consumer; if we just kill the Input without telling the iterator
    // we're done, those pre-fetched VideoSamples never get .close()'d and
    // we trip Mediabunny's "VideoSample was garbage collected without
    // first being closed" warning on the next GC cycle. Calling .return()
    // runs the generator's cleanup path (which closes the buffered
    // samples) synchronously from the consumer's point of view.
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
      const sourceTimeSec = clip.sourceIn + (t - clip.start)
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
