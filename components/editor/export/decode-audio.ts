import {
  ALL_FORMATS,
  AudioBufferSink,
  type AudioBufferSource,
  Input,
  type InputAudioTrack,
  UrlSource,
  type WrappedAudioBuffer,
} from "mediabunny"

import type { ProjectStateV1, ProjectTimelineClip } from "@/types/api"

/**
 * Window-based streaming timeline audio mixer.
 *
 * **Why this exists (peak-RAM correctness)** — the previous implementation
 * `fetch(file://…) → arrayBuffer() → OfflineAudioContext.decodeAudioData()`
 * loaded the entire source video file into JS heap for every clip *and*
 * allocated a single timeline-sized output `AudioBuffer`. For a 2 GB
 * recording with 1 hour of stereo @ 48 kHz that is ~2 GB transient + ~1.4 GB
 * decoded — easily crashing the export window on commodity hardware.
 *
 * This pipeline keeps peak RAM bounded by the **window size** (default
 * 0.5 s) regardless of timeline duration or source file size:
 *
 *   1. Open one Mediabunny `Input` per unique source URL. Mediabunny's
 *      `UrlSource` issues HTTP Range requests under the hood — the file is
 *      never slurped whole.
 *   2. Build one `AudioBufferSink.buffers(sourceIn, sourceOut)` async
 *      iterator per *timeline clip*. The iterator pre-fetches a few
 *      packets ahead and decodes lazily as we pull.
 *   3. Walk the output timeline in fixed windows. For each window:
 *        - Allocate one window-sized `AudioBuffer` (a few hundred KB).
 *        - For every clip that overlaps the window, pull the slice of
 *          decoded source audio that maps to the window's slice in source
 *          time. Mix-add (sum across channels) into the window buffer so
 *          overlapping clips compose instead of clobbering.
 *        - `await audioSource.add(windowBuffer)` — Mediabunny encodes and
 *          muxes incrementally; backpressure is honoured.
 *      The window buffer is then GC-able.
 *   4. Dispose every `Input` + iterator in `finally`.
 *
 * Peak RAM ≈ window × outSR × channels × 4 bytes (192 KB for the default
 * 0.5 s @ 48 kHz stereo) plus a handful of decoder-prefetch chunks per
 * source. Stays under ~10 MB regardless of timeline length.
 *
 * Sample-rate handling: the output rate is the **max** observed across all
 * sources. Sources whose rate matches the output do a direct frame copy;
 * mismatched sources are linearly resampled inline. Linear interpolation
 * is adequate for the common 44.1 → 48 kHz conversion at screen-recording
 * quality and avoids per-chunk OfflineAudioContext spinups.
 *
 * Returns `true` iff at least one source clip contributed audio (the
 * caller then expects `audioSource` to have been fed). Returns `false`
 * when no source had any audio — caller should mux a video-only file.
 */
export interface StreamTimelineAudioOptions {
  state: ProjectStateV1
  assetUrlsByVideoId: Record<string, string>
  audioSource: AudioBufferSource
  /** Any BaseAudioContext is fine; only `createBuffer` is used. */
  audioContext: BaseAudioContext
  /** Defaults to 0.5 s. */
  windowSeconds?: number
  signal?: AbortSignal
}

const DEFAULT_WINDOW_SECONDS = 0.5
const DEFAULT_OUTPUT_SAMPLE_RATE = 48_000
const DEFAULT_OUTPUT_CHANNELS = 2

interface SourceContext {
  url: string
  input: Input
  track: InputAudioTrack
  sink: AudioBufferSink
  sampleRate: number
  numberOfChannels: number
}

interface ClipIterState {
  clip: ProjectTimelineClip
  src: SourceContext
  iter: AsyncGenerator<WrappedAudioBuffer, void, unknown>
  /**
   * The most recent chunk we pulled. It may extend across multiple output
   * windows, so we keep it around and re-consume on the next pass instead
   * of advancing the iterator before we've read the tail.
   */
  pending: WrappedAudioBuffer | null
  /** Frames already mixed out of `pending`, in pending's own sample rate. */
  pendingConsumedFrames: number
  done: boolean
}

export async function streamTimelineAudio(
  options: StreamTimelineAudioOptions,
): Promise<boolean> {
  const {
    state,
    assetUrlsByVideoId,
    audioSource,
    audioContext,
    windowSeconds = DEFAULT_WINDOW_SECONDS,
    signal,
  } = options

  const timelineDuration = computeTimelineDuration(state.timelineClips)
  if (timelineDuration <= 0) return false

  // Open Inputs / sinks for every source URL that owns an audio track. A
  // single source may be referenced by multiple timeline clips — share its
  // Input so we don't open the same file twice.
  const sourcesByVideoId = new Map<string, SourceContext>()
  try {
    for (const video of state.videos) {
      throwIfAborted(signal)
      const url = assetUrlsByVideoId[video.id]
      if (!url) continue
      if (sourcesByVideoId.has(video.id)) continue
      const ctx = await openAudioSource(url)
      if (ctx) sourcesByVideoId.set(video.id, ctx)
    }

    if (sourcesByVideoId.size === 0) return false

    // Output format = max(SR), max(channels) across all sources. Falls back
    // to industry defaults if every source somehow reports zero.
    let outputSR = 0
    let outputCh = 0
    for (const ctx of sourcesByVideoId.values()) {
      if (ctx.sampleRate > outputSR) outputSR = ctx.sampleRate
      if (ctx.numberOfChannels > outputCh) outputCh = ctx.numberOfChannels
    }
    if (outputSR <= 0) outputSR = DEFAULT_OUTPUT_SAMPLE_RATE
    if (outputCh <= 0) outputCh = DEFAULT_OUTPUT_CHANNELS

    // One iterator per clip — a clip is a slice of source, so we open the
    // sink with the clip's source-time range and pull lazily as the
    // window-walk advances. Order matches state.timelineClips so the
    // sink iterator's internal optimisations (monotonic timestamps) hold.
    const clipIters: (ClipIterState | null)[] = state.timelineClips.map(
      (clip) => {
        const src = sourcesByVideoId.get(clip.videoId)
        if (!src) return null
        const iter = src.sink.buffers(clip.sourceIn, clip.sourceOut)
        return {
          clip,
          src,
          iter,
          pending: null,
          pendingConsumedFrames: 0,
          done: false,
        }
      },
    )

    try {
      const totalOutputFrames = Math.ceil(timelineDuration * outputSR)
      const windowFrames = Math.max(
        1,
        Math.round(windowSeconds * outputSR),
      )

      let outputFrameOffset = 0
      let mixedAnyAudio = false
      while (outputFrameOffset < totalOutputFrames) {
        throwIfAborted(signal)
        const framesInWindow = Math.min(
          windowFrames,
          totalOutputFrames - outputFrameOffset,
        )
        const windowStartSec = outputFrameOffset / outputSR
        const windowEndSec =
          (outputFrameOffset + framesInWindow) / outputSR
        const windowBuffer = audioContext.createBuffer(
          outputCh,
          framesInWindow,
          outputSR,
        )

        for (const it of clipIters) {
          if (!it || it.done) continue
          // Skip clips that don't overlap the current window.
          if (it.clip.end <= windowStartSec) continue
          if (it.clip.start >= windowEndSec) continue

          const overlapStartSec = Math.max(windowStartSec, it.clip.start)
          const overlapEndSec = Math.min(windowEndSec, it.clip.end)
          const srcStartSec =
            it.clip.sourceIn + (overlapStartSec - it.clip.start)
          const srcEndSec =
            it.clip.sourceIn + (overlapEndSec - it.clip.start)
          const writeOffsetFrames = Math.round(
            (overlapStartSec - windowStartSec) * outputSR,
          )
          const mixed = await mixClipSliceIntoWindow(
            it,
            srcStartSec,
            srcEndSec,
            writeOffsetFrames,
            windowBuffer,
          )
          if (mixed) mixedAnyAudio = true
        }

        // Backpressure-respecting submit. Mediabunny encodes + muxes
        // incrementally; awaiting here keeps memory in the encoder
        // pipeline bounded.
        await audioSource.add(windowBuffer)

        outputFrameOffset += framesInWindow
      }

      return mixedAnyAudio
    } finally {
      // Explicitly return() each iterator so Mediabunny releases any
      // pre-decoded packets it had buffered. Without this, the
      // "AudioSample garbage-collected without being closed" warning
      // fires on the next GC.
      for (const it of clipIters) {
        if (!it) continue
        try {
          void it.iter.return?.()
        } catch {
          // best-effort
        }
      }
    }
  } finally {
    for (const ctx of sourcesByVideoId.values()) {
      try {
        ctx.input.dispose()
      } catch {
        // best-effort — Input dispose is the GC handle for HTTP Range
        // requests and the WebCodecs AudioDecoder.
      }
    }
  }
}

async function openAudioSource(url: string): Promise<SourceContext | null> {
  // try/catch covers BOTH the synchronous Input construction AND the async
  // track probe — without this, a source whose primary-track lookup
  // rejects leaks the Input forever (no consumer to dispose it).
  let input: Input | null = null
  try {
    input = new Input({
      formats: ALL_FORMATS,
      source: new UrlSource(url),
    })
    const track = await input.getPrimaryAudioTrack()
    if (!track) {
      input.dispose()
      return null
    }
    const [sampleRate, numberOfChannels] = await Promise.all([
      track.getSampleRate(),
      track.getNumberOfChannels(),
    ])
    if (sampleRate <= 0 || numberOfChannels <= 0) {
      input.dispose()
      return null
    }
    const sink = new AudioBufferSink(track)
    return { url, input, track, sink, sampleRate, numberOfChannels }
  } catch {
    if (input) {
      try {
        input.dispose()
      } catch {
        // best-effort
      }
    }
    return null
  }
}

/**
 * Drain the clip's iterator up to `srcEndSec`, mixing every overlapping
 * sample into `windowBuffer` starting at `writeOffsetFrames`. The
 * iterator's `pending` chunk persists across calls so a single source
 * packet that spans multiple windows is decoded once and consumed in
 * pieces. Returns true iff any samples were written.
 */
async function mixClipSliceIntoWindow(
  it: ClipIterState,
  srcStartSec: number,
  srcEndSec: number,
  writeOffsetFrames: number,
  windowBuffer: AudioBuffer,
): Promise<boolean> {
  const outSR = windowBuffer.sampleRate
  const outCh = windowBuffer.numberOfChannels
  let wrote = false

  let srcCursor = srcStartSec
  let writeHead = writeOffsetFrames

  while (
    srcCursor < srcEndSec - 1e-9 &&
    !it.done &&
    writeHead < windowBuffer.length
  ) {
    if (!it.pending) {
      const next = await it.iter.next()
      if (next.done) {
        it.done = true
        break
      }
      // The iterator yields `null` when the source has no buffer for the
      // exact timestamp; skip and pull again.
      if (!next.value) continue
      it.pending = next.value
      it.pendingConsumedFrames = 0
    }

    const chunk = it.pending
    const chunkSR = chunk.buffer.sampleRate
    const chunkChannels = chunk.buffer.numberOfChannels
    const chunkStartSec =
      chunk.timestamp + it.pendingConsumedFrames / chunkSR
    const chunkEndSec = chunk.timestamp + chunk.duration

    // Chunk lies entirely before the cursor — drop and pull next.
    if (chunkEndSec <= srcCursor + 1e-9) {
      it.pending = null
      it.pendingConsumedFrames = 0
      continue
    }
    // Chunk starts after the slice's end — done with this slice; keep
    // pending so the next window can still consume it.
    if (chunkStartSec >= srcEndSec - 1e-9) break

    const useStartSec = Math.max(chunkStartSec, srcCursor)
    const useEndSec = Math.min(chunkEndSec, srcEndSec)
    const chunkStartFrame = Math.max(
      0,
      Math.round((useStartSec - chunk.timestamp) * chunkSR),
    )
    const chunkEndFrame = Math.min(
      chunk.buffer.length,
      Math.round((useEndSec - chunk.timestamp) * chunkSR),
    )
    const framesFromChunk = chunkEndFrame - chunkStartFrame
    if (framesFromChunk <= 0) {
      // Numerically too small to copy — advance past it.
      it.pendingConsumedFrames = chunkEndFrame
      if (useEndSec >= chunkEndSec - 1e-9) {
        it.pending = null
        it.pendingConsumedFrames = 0
      }
      srcCursor = useEndSec
      continue
    }

    if (chunkSR === outSR) {
      const framesToWrite = Math.min(
        framesFromChunk,
        windowBuffer.length - writeHead,
      )
      for (let c = 0; c < outCh; c++) {
        // Dup mono into every output channel; otherwise stride by source
        // channel index when source has at least that many channels.
        const srcChannelIdx = Math.min(c, chunkChannels - 1)
        const src = chunk.buffer.getChannelData(srcChannelIdx)
        const dst = windowBuffer.getChannelData(c)
        for (let i = 0; i < framesToWrite; i++) {
          dst[writeHead + i] += src[chunkStartFrame + i]
        }
      }
      writeHead += framesToWrite
      wrote = wrote || framesToWrite > 0
    } else {
      // Linear-resample inline. Output frame i samples source at
      // (chunkStartFrame + i * srcSR/outSR) and lerps between neighbours.
      const ratio = chunkSR / outSR
      const maxOutFrames = Math.min(
        Math.floor(framesFromChunk / ratio),
        windowBuffer.length - writeHead,
      )
      for (let c = 0; c < outCh; c++) {
        const srcChannelIdx = Math.min(c, chunkChannels - 1)
        const src = chunk.buffer.getChannelData(srcChannelIdx)
        const dst = windowBuffer.getChannelData(c)
        for (let i = 0; i < maxOutFrames; i++) {
          const srcPos = chunkStartFrame + i * ratio
          const lo = Math.floor(srcPos)
          const hi = Math.min(chunkEndFrame - 1, lo + 1)
          const t = srcPos - lo
          dst[writeHead + i] += src[lo] * (1 - t) + src[hi] * t
        }
      }
      writeHead += maxOutFrames
      wrote = wrote || maxOutFrames > 0
    }

    srcCursor = useEndSec
    if (useEndSec >= chunkEndSec - 1e-9) {
      it.pending = null
      it.pendingConsumedFrames = 0
    } else {
      it.pendingConsumedFrames = chunkEndFrame
    }
  }

  return wrote
}

function computeTimelineDuration(clips: ProjectTimelineClip[]): number {
  let max = 0
  for (const clip of clips) {
    if (clip.end > max) max = clip.end
  }
  return max
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Export cancelled by user.", "AbortError")
  }
}
