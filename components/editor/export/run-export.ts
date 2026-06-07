import {
  ALL_FORMATS,
  AudioBufferSource,
  canEncodeVideo,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  WebMOutputFormat,
  type OutputFormat,
  type StreamTargetChunk,
} from "mediabunny"

import type {
  ExportProgress,
  ExportSettings,
  ProjectStateV1,
  ProjectTimelineClip,
} from "@/types/api"
import { exportResolutionPixels } from "@/lib/editor-project/export-settings"
import { sampleZoomCameraAtTime } from "@/components/editor/canvas/zoom-scene"
import { formatToVideoCodec } from "./codec-probe"
import { buildExportStage } from "./build-stage"
import { streamTimelineAudio } from "./decode-audio"
import { planExportFrames, SourceFrameProvider } from "./source-frames"
import {
  findMissingActiveSourceVideoIds,
  formatExportSourceList,
} from "./source-validation"

export type ExportStage =
  | "preparing"
  | "decoding-audio"
  | "encoding"
  | "muxing-audio"
  | "finalizing"

export interface RunExportOptions {
  state: ProjectStateV1
  settings: ExportSettings
  assetUrlsByVideoId: Record<string, string>
  container: HTMLDivElement
  // Absolute project folder used to load cursor sidecars; when absent the
  // stage falls back to deriving the folder from the screen video's URL.
  projectPath?: string
  onProgress?: (progress: ExportProgress) => void
  onStage?: (stage: ExportStage) => void
  signal?: AbortSignal
}

const PROGRESS_INTERVAL_MS = 100

// Hard ceiling on how long a single export can be. Above this we refuse to
// start rather than discover the OOM 90 minutes in. Roughly:
//   - 4 h @ 60 fps = 864 000 video frames — Mediabunny / WebCodecs handle
//     this fine but the user experience of a multi-hour blocking encode is
//     poor and a real Mediabunny failure mid-way is unrecoverable.
//   - 4 h is large enough that legitimate long-form screen content stays
//     in-scope (lectures, multi-app demos). Beyond this users want to
//     trim first.
const MAX_TIMELINE_SECONDS = 4 * 60 * 60

// Maximum output pixel count. `exportResolutionPixels` already caps at
// each preset's nominal pixel budget, so the only way to land above 4K
// here is a custom artboard with `resolution: 'artboard'`. Mediabunny /
// hardware encoders reject above this, and renderer RAM for the layer
// canvases scales linearly — refusing early saves a slow OOM.
const MAX_OUTPUT_PIXELS = 3840 * 2160

const AUDIO_OUTPUT_BITRATE = 128_000
const AUDIO_PROBE_SAMPLE_RATE = 48_000

/**
 * End-to-end export driver. Renders every frame of the timeline through an
 * offscreen PixiJS stage (`app.canvas`), then hands each frame to Mediabunny's
 * WebCodecs-backed encoder. The encoded container bytes stream straight to a
 * temp file on disk through the `export:stream*` IPC (16 MiB chunks,
 * positional writes), so peak renderer memory stays bounded regardless of
 * output size; `export:reportDone` renames the temp file into place. Audio is
 * mixed by a windowed streaming mixer (`streamTimelineAudio`) running
 * CONCURRENTLY with the video frame loop — the muxer interleaves the two
 * tracks with per-track backpressure — so audio adds no wall-clock time of
 * its own.
 *
 * The driver is designed to live in any context that has DOM + WebCodecs
 * (currently the export window's renderer thread). Source pixels come from
 * WebCodecs decoders (`SourceFrameProvider`), so lifting the whole driver
 * into a Web Worker is possible if main-thread contention ever shows up —
 * note WebCodecs codecs already run off-thread, so a worker buys
 * responsiveness, not encode throughput.
 */
export async function runExport(options: RunExportOptions): Promise<void> {
  const {
    state,
    settings,
    assetUrlsByVideoId,
    container,
    projectPath,
    onProgress,
    onStage,
    signal,
  } = options

  const timelineDurationSec = computeTimelineDuration(state.timelineClips)
  if (timelineDurationSec <= 0) {
    throw new Error("Timeline is empty — nothing to export.")
  }
  if (timelineDurationSec > MAX_TIMELINE_SECONDS) {
    throw new Error(
      `Timeline is longer than the export cap of ${MAX_TIMELINE_SECONDS / 3600} hours. Trim the timeline and try again.`
    )
  }
  const missingSourceVideoIds = findMissingActiveSourceVideoIds(
    state,
    assetUrlsByVideoId
  )
  if (missingSourceVideoIds.length > 0) {
    throw new Error(
      `Export is missing source media for active clip(s): ${formatExportSourceList(state, missingSourceVideoIds)}. Reopen the project or restore the source file and try again.`
    )
  }

  const totalFrames = Math.max(
    1,
    Math.round(timelineDurationSec * settings.fps)
  )
  const outputSize = exportResolutionPixels(settings.resolution, {
    width: state.artboard.width,
    height: state.artboard.height,
  })
  if (
    outputSize.width <= 0 ||
    outputSize.height <= 0 ||
    outputSize.width * outputSize.height > MAX_OUTPUT_PIXELS
  ) {
    throw new Error(
      `Output resolution ${outputSize.width}×${outputSize.height} exceeds the encoder's per-frame pixel budget. Pick a lower preset.`
    )
  }

  // Streamed-output bridge — fail fast before any heavy setup.
  const api = window.api?.export
  if (!api) {
    throw new Error("Export bridge is unavailable.")
  }

  onStage?.("preparing")
  const handles = await buildExportStage({
    state,
    assetUrlsByVideoId,
    outputSize,
    container,
    projectPath,
  })

  // From here on, `handles` owns an offscreen Pixi application; every exit path
  // (success, abort, error) must call handles.dispose(). Once the disk stream
  // opens, every failure path must also discard the temp file (streamAbort).
  let streamNeedsAbort = false
  try {
    throwIfAborted(signal)

    const videoCodec = formatToVideoCodec(settings.format)
    const bitrate = computeScreenContentBitrate(
      videoCodec,
      outputSize.width,
      outputSize.height,
      settings.fps
    )
    // Ask WebCodecs up front whether a hardware encoder exists for this
    // exact codec/size/bitrate. Chromium's 'no-preference' hardware/software
    // policy is undocumented and resolution-dependent — a silent software
    // fallback at 4K is a multi-× slowdown. Probing first means we only pin
    // 'prefer-hardware' when it is actually supported, and otherwise leave
    // Chromium's default in place (pinning blindly rejects the config on
    // machines without a hardware encoder).
    const hardwareAcceleration = await probePreferHardwareEncode(
      videoCodec,
      outputSize,
      bitrate
    )
    throwIfAborted(signal)

    // The encoded container streams straight to a temp file in the exports
    // folder (positional writes over IPC). BufferTarget would hold the whole
    // output in renderer memory AND make the MP4 muxer default to fastStart
    // 'in-memory' (whole-file assembly at finalize); StreamTarget keeps peak
    // memory at ~chunk size and finalize cheap. `export:reportDone` renames
    // the temp file into place after this function resolves.
    await api.streamBegin(settings.format)
    streamNeedsAbort = true

    const format = makeOutputFormat(settings.format)
    const output = new Output({
      format,
      target: new StreamTarget(
        new WritableStream<StreamTargetChunk>({
          // Returning the IPC promise propagates disk backpressure up
          // through Mediabunny's writer into `videoSource.add()`.
          write: (chunk) => api.streamWrite(chunk.position, chunk.data),
        }),
        // Gather output into 16 MiB chunks — one IPC hop per chunk instead
        // of one per muxer write.
        { chunked: true }
      ),
    })

    // Captured from Mediabunny's encoder init via onEncoderConfig and
    // surfaced in the end-of-export perf log, so a silent software-encode
    // fallback is diagnosable from the console.
    let resolvedEncoderConfig: VideoEncoderConfig | null = null

    // PixiJS composites the whole scene into one canvas (`app.canvas`), so we
    // hand that straight to Mediabunny — no per-layer composite blit needed.
    const videoSource = new CanvasSource(handles.app.canvas, {
      codec: videoCodec,
      // Custom screen-recording-tuned bitrate ladder. Mediabunny's QUALITY_*
      // constants resolve to bitrates calibrated for *general* video
      // (motion, natural scenes). Screen recordings are dominated by
      // high-frequency text edges that compress poorly — the same nominal
      // bitrate that looks great on a movie clip turns terminal output into
      // mush. computeScreenContentBitrate roughly doubles Mediabunny's
      // numbers at every quality tier.
      bitrate,
      // Tells the underlying VideoEncoder to optimise rate allocation for
      // text legibility (vs `'motion'` for action video). Browsers that
      // honour the hint pour more bits into edge detail, which is exactly
      // what screen recordings need.
      contentHint: "text",
      // Quality > realtime: this is an offline export, we never want the
      // encoder to drop frames or trade quality for latency.
      latencyMode: "quality",
      // 1 s GOP instead of 2 s: keyframes encode the full picture (great
      // for static text), delta frames only encode motion. More keyframes =
      // sharper static content on average for the same total bits.
      keyFrameInterval: 1,
      // 'prefer-hardware' iff the probe above confirmed it; undefined
      // otherwise (Chromium's 'no-preference' default).
      hardwareAcceleration,
      onEncoderConfig: (config) => {
        resolvedEncoderConfig = config
      },
    })
    output.addVideoTrack(videoSource, { frameRate: settings.fps })

    // Probe — do we need an audio track at all? Mediabunny doesn't allow
    // removing a track after `output.start()`, so we have to decide here.
    // The probe opens each source briefly to check for an audio track and
    // disposes immediately; cost is roughly one HTTP HEAD-equivalent per
    // unique source.
    onStage?.("decoding-audio")
    const hasAudio = await probeHasAnyAudio({
      state,
      assetUrlsByVideoId,
      signal,
    })
    throwIfAborted(signal)

    let audioSource: AudioBufferSource | null = null
    if (hasAudio) {
      // WebM containers want Opus; MP4 containers want AAC. Picking the
      // wrong pair throws at output.start() time.
      const audioCodec = settings.format === "webm-vp9" ? "opus" : "aac"
      audioSource = new AudioBufferSource({
        codec: audioCodec,
        bitrate: AUDIO_OUTPUT_BITRATE,
      })
      output.addAudioTrack(audioSource)
    }

    // ─── plan + spin up per-source decoders ────────────────────────────
    const plan = planExportFrames({
      clips: state.timelineClips,
      totalFrames,
      fps: settings.fps,
    })
    // Map every video id to its intrinsic dimensions so the CanvasSink
    // decodes at native resolution (matching the editor preview pipeline
    // pixel-for-pixel).
    const videoMeta = new Map<
      string,
      { url: string; intrinsicWidth: number; intrinsicHeight: number }
    >()
    for (const video of state.videos) {
      const url = assetUrlsByVideoId[video.id]
      if (!url) continue
      videoMeta.set(video.id, {
        url,
        intrinsicWidth: video.intrinsicWidth,
        intrinsicHeight: video.intrinsicHeight,
      })
    }

    const providers = new Map<string, SourceFrameProvider>()
    try {
      const sourceTimelineEntries = Array.from(
        plan.sourceTimelinesByVideoId.entries()
      ).filter(([, timestamps]) => timestamps.length > 0)
      const missingMetadataVideoIds = sourceTimelineEntries
        .filter(([videoId]) => !videoMeta.has(videoId))
        .map(([videoId]) => videoId)
      if (missingMetadataVideoIds.length > 0) {
        throw new Error(
          `Export is missing source metadata for active clip(s): ${formatExportSourceList(state, missingMetadataVideoIds)}.`
        )
      }

      // Spin up all decoders in parallel — each does a metadata read
      // (lightweight HTTP Range request) before the loop starts so frame 0
      // doesn't pay for N sequential init round-trips.
      const initResults = await Promise.allSettled(
        sourceTimelineEntries.map(async ([videoId, timestamps]) => {
          const meta = videoMeta.get(videoId)
          if (!meta) return
          const provider = await SourceFrameProvider.create({
            url: meta.url,
            intrinsicWidth: meta.intrinsicWidth,
            intrinsicHeight: meta.intrinsicHeight,
            timestamps,
          })
          providers.set(videoId, provider)
        })
      )
      throwIfAborted(signal)
      const failedDecoderVideoIds = initResults.flatMap((result, index) =>
        result.status === "rejected" ? [sourceTimelineEntries[index][0]] : []
      )
      if (failedDecoderVideoIds.length > 0) {
        throw new Error(
          `Export could not decode source video(s): ${formatExportSourceList(state, failedDecoderVideoIds)}. Try recording in H.264 or restore the source media and try again.`
        )
      }

      await output.start()

      // Audio mixes CONCURRENTLY with the video frame loop — the sources
      // are independent and the muxer interleaves them with per-track
      // backpressure — so the old serial "muxing-audio" stage no longer
      // adds wall-clock time. AbortError must propagate (it IS the cancel
      // path); any other audio failure degrades to silence after the video
      // loop, matching the previous serial behavior.
      let audioWork: Promise<boolean> | null = null
      let audioCtx: OfflineAudioContext | null = null
      if (audioSource) {
        const src = audioSource
        // OfflineAudioContext is just a host for `createBuffer` calls; we
        // never actually run it. One frame is enough for the constructor.
        audioCtx = new OfflineAudioContext(2, 1, AUDIO_PROBE_SAMPLE_RATE)
        const ctx = audioCtx
        audioWork = (async () => {
          try {
            return await streamTimelineAudio({
              state,
              assetUrlsByVideoId,
              audioSource: src,
              audioContext: ctx,
              signal,
            })
          } catch (audioError) {
            if (isAbortError(audioError)) throw audioError
            // Audio failure must not kill the video export — the caller
            // muxes a silent track instead.
            if (process.env.NODE_ENV !== "production") {
              console.warn(
                "[export] audio mix failed; muxing silence",
                audioError
              )
            }
            return false
          }
        })()
        // The video loop may throw first (e.g. cancel) and never await this
        // promise — pre-attach a noop catch so the rejection isn't unhandled.
        audioWork.catch(() => {})
      }

      onStage?.("encoding")

      let lastProgressAt = 0
      const startWall = performance.now()
      const frameDuration = 1 / settings.fps
      // Per-leg wall-clock accumulators, logged once at the end — the first
      // thing to read when an export is slower than expected. decodeWait =
      // stalls on the source decoders; render = PixiJS scene render +
      // texture uploads; encodeWait = backpressure from the WebCodecs
      // encoder/muxer/disk (the encoder itself runs in parallel).
      let decodeWaitMs = 0
      let renderMs = 0
      let encodeWaitMs = 0
      // Catch the "silently black export" case (a source that opens but never
      // decodes a single frame — corrupt or undecodable media) by tracking,
      // per source, whether it ever produced a frame across the whole render.
      // We deliberately do NOT penalize transient or trailing gaps: a clip
      // whose audio track outlasts its video track yields `null` for the tail
      // frames, which is expected and should still export the frames it has.
      const expectedSourceIds = new Set(
        sourceTimelineEntries.map(([videoId]) => videoId)
      )
      const decodedSourceIds = new Set<string>()

      for (let frame = 0; frame < totalFrames; frame++) {
        throwIfAborted(signal)

        const t = frame * frameDuration
        const active = plan.framePlan[frame]
        handles.applyZoomCamera(
          sampleZoomCameraAtTime(state.zoomClips ?? [], state.artboard, t)
        )

        // Decoded VideoFrames handed out this iteration. They must stay
        // open until app.render() has uploaded them (the upload happens
        // inside render), then be closed promptly — open frames pin decoder
        // memory and can stall WebCodecs.
        const framesToClose: VideoFrame[] = []
        try {
          // Hide every node first so a clip that ended on the previous frame
          // doesn't ghost a stale image into this one. setFrame() re-activates
          // the ones that should render now.
          for (const node of handles.nodesByVideoId.values()) {
            node.hide()
          }

          // Pull the next decoded frame from each active source's iterator
          // in parallel. The decoders pre-fetch a few frames ahead, so this
          // resolves almost instantly once the pipeline is warm.
          const decodeStart = performance.now()
          await Promise.all(
            active.map(async (entry) => {
              const provider = providers.get(entry.videoId)
              if (!provider) return
              const decoded = await provider.next()
              if (!decoded) return
              if (
                typeof VideoFrame !== "undefined" &&
                decoded instanceof VideoFrame
              ) {
                framesToClose.push(decoded)
              }
              const node = handles.nodesByVideoId.get(entry.videoId)
              if (!node) return
              node.setFrame(decoded)
              decodedSourceIds.add(entry.videoId)
            })
          )
          decodeWaitMs += performance.now() - decodeStart

          // Place the recorded cursor using the screen clip's source time straight
          // from the plan (honors trims/splits). Same CursorSprite the preview uses.
          const cursor = handles.cursor
          if (cursor) {
            const screenEntry = active.find(
              (entry) => entry.videoId === cursor.screenVideoId
            )
            if (screenEntry) {
              cursor.cursorSprite.render(
                cursor.track,
                cursor.video,
                screenEntry.sourceTimeSec,
                cursor.options,
                cursor.motionBlur
              )
            } else {
              cursor.cursorSprite.hide()
            }
          }

          // Render the whole scene into app.canvas (the export composite Mediabunny reads).
          const renderStart = performance.now()
          handles.app.render()
          renderMs += performance.now() - renderStart
        } finally {
          for (const decodedFrame of framesToClose) decodedFrame.close()
        }

        const encodeStart = performance.now()
        await videoSource.add(t, frameDuration)
        encodeWaitMs += performance.now() - encodeStart

        const now = performance.now()
        if (
          now - lastProgressAt >= PROGRESS_INTERVAL_MS ||
          frame === totalFrames - 1
        ) {
          lastProgressAt = now
          const elapsed = (now - startWall) / 1000
          const framesDone = frame + 1
          const fps = framesDone / Math.max(0.001, elapsed)
          const eta =
            framesDone < totalFrames && fps > 0
              ? (totalFrames - framesDone) / fps
              : 0
          onProgress?.({
            framesDone,
            framesTotal: totalFrames,
            etaSeconds: framesDone >= 30 ? eta : null,
          })
        }
      }

      // A source that had active frames but never decoded a single one means
      // its clips would be silently black in the output — fail loudly with the
      // offending file name(s) rather than handing back a broken export.
      const undecodedSourceIds = Array.from(expectedSourceIds).filter(
        (videoId) => !decodedSourceIds.has(videoId)
      )
      if (undecodedSourceIds.length > 0) {
        throw new Error(
          `Export could not decode any frames for source video(s): ${formatExportSourceList(state, undecodedSourceIds)}. Try recording in H.264 or restore the source media and try again.`
        )
      }

      // No more video frames — close the source so the muxer can plan ahead
      // (Mediabunny's recommended optimization when tracks finish at different
      // times; the audio track is still being written below).
      videoSource.close()

      if (audioSource) {
        // Usually the concurrent mixer finished long before the last video
        // frame; this await is only visible when audio decode is the
        // bottleneck (or surfaces a deferred AbortError from cancel).
        onStage?.("muxing-audio")
        const wroteAudio = audioWork ? await audioWork : false
        if (!wroteAudio) {
          // Edge case: probe said audio exists but mixer produced nothing
          // (every source's audio decode failed, every clip is outside its
          // source's audio range, etc.). Mediabunny requires at least one
          // packet per declared track before finalize; push a single tiny
          // silent buffer so the muxer is happy.
          const ctx =
            audioCtx ?? new OfflineAudioContext(2, 1, AUDIO_PROBE_SAMPLE_RATE)
          const silent = ctx.createBuffer(2, 1, AUDIO_PROBE_SAMPLE_RATE)
          await audioSource.add(silent)
        }
        audioSource.close()
      }

      onStage?.("finalizing")
      await output.finalize()
      streamNeedsAbort = false

      if (process.env.NODE_ENV !== "production") {
        const seconds = (performance.now() - startWall) / 1000
        const providerList = Array.from(providers.values())
        console.info("[export] perf", {
          frames: totalFrames,
          seconds: Math.round(seconds * 10) / 10,
          fps: Math.round((totalFrames / Math.max(0.001, seconds)) * 10) / 10,
          decodeWaitMs: Math.round(decodeWaitMs),
          renderMs: Math.round(renderMs),
          encodeWaitMs: Math.round(encodeWaitMs),
          renderer: handles.app.renderer.name,
          hardwareAcceleration: hardwareAcceleration ?? "no-preference",
          directVideoFrameSources: `${providerList.filter((p) => p.usesVideoFrames).length}/${providerList.length}`,
          encoderConfig: resolvedEncoderConfig,
        })
      }
    } finally {
      for (const provider of providers.values()) {
        try {
          provider.dispose()
        } catch {
          // best-effort
        }
      }
    }
  } catch (error) {
    if (streamNeedsAbort) {
      // Discard the temp output file — nothing references it after a failed
      // or cancelled export. Best-effort: main also cleans up on cancel,
      // reportError, and window close.
      try {
        await api.streamAbort()
      } catch {
        // best-effort
      }
    }
    throw error
  } finally {
    try {
      handles.dispose()
    } catch {
      // best-effort
    }
  }
}

/**
 * Returns `'prefer-hardware'` when WebCodecs confirms a hardware encoder
 * exists for this exact codec/size/bitrate, undefined otherwise. Mediabunny
 * recommends leaving the hint unset because pinning 'prefer-hardware'
 * blindly makes the encoder config rejection-prone on machines without one —
 * probing first gives hardware speed when available with no such risk.
 */
async function probePreferHardwareEncode(
  codec: "avc" | "hevc" | "vp9" | "vp8" | "av1",
  size: { width: number; height: number },
  bitrate: number
): Promise<"prefer-hardware" | undefined> {
  try {
    const supported = await canEncodeVideo(codec, {
      width: size.width,
      height: size.height,
      bitrate,
      hardwareAcceleration: "prefer-hardware",
    })
    return supported ? "prefer-hardware" : undefined
  } catch {
    return undefined
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function makeOutputFormat(formatId: ExportSettings["format"]): OutputFormat {
  if (formatId === "webm-vp9") return new WebMOutputFormat()
  return new Mp4OutputFormat()
}

/**
 * Bitrate tuned for *screen-recording* content rather than the general-video
 * defaults Mediabunny's QUALITY_* constants assume. Anchored at 14 Mbps for
 * 1080p H.264 — about 2× what Mediabunny's QUALITY_HIGH would give.
 * Text-heavy content (terminals, code, design tools) compresses far worse
 * than natural video, and pinching the bitrate is the #1 cause of visible
 * blur around small text edges.
 *
 * Scales sub-linearly with pixel count (4× pixels ≈ 3.5× bitrate — spatial
 * redundancy grows with image size). Applies a codec-efficiency discount
 * for HEVC / VP9 (~40% smaller files at the same perceptual quality), and
 * a 35% bump above 30 fps because the encoder has more frames to feed.
 */
function computeScreenContentBitrate(
  codec: "avc" | "hevc" | "vp9" | "vp8" | "av1",
  width: number,
  height: number,
  fps: number
): number {
  const REFERENCE_PIXELS = 1920 * 1080
  const REFERENCE_BITRATE = 14_000_000
  const pixels = Math.max(1, width * height)
  const pixelFactor = Math.pow(pixels / REFERENCE_PIXELS, 0.9)
  const fpsFactor = fps > 30 ? 1.35 : 1.0
  const { factor, cap } = codecBitrateProfile(codec)
  const raw = REFERENCE_BITRATE * factor * pixelFactor * fpsFactor
  const capped = Math.min(raw, cap)
  return Math.max(500_000, Math.round(capped / 1000) * 1000)
}

/**
 * Per-codec bitrate factor + practical cap. Caps are well below each
 * codec's spec maximum but comfortably above the headroom most hardware
 * encoders advertise. The raw formula on 4K@60 lands above ~75 Mbps for
 * AVC, which trips Chromium's encoder feasibility check on a lot of
 * machines even when resolution fits Level 5.2. Capping here keeps the
 * export viable without a visible quality loss — text is already at
 * near-transparent bitrates by 40 Mbps on AVC.
 *
 * Exhaustive switch (instead of a `Record<typeof codec, …>`) so adding a
 * codec to the union is a type error rather than silently falling back to
 * an arbitrary default.
 */
function codecBitrateProfile(codec: "avc" | "hevc" | "vp9" | "vp8" | "av1"): {
  factor: number
  cap: number
} {
  switch (codec) {
    case "avc":
      return { factor: 1.0, cap: 50_000_000 }
    case "hevc":
      return { factor: 0.6, cap: 35_000_000 }
    case "vp9":
      return { factor: 0.6, cap: 30_000_000 }
    case "vp8":
      return { factor: 1.2, cap: 40_000_000 }
    case "av1":
      return { factor: 0.5, cap: 25_000_000 }
  }
}

function computeTimelineDuration(clips: ProjectTimelineClip[]): number {
  let max = 0
  for (const clip of clips) {
    if (clip.end > max) max = clip.end
  }
  return max
}

/**
 * Cheap audio-presence probe. Mediabunny doesn't allow removing a track
 * after `output.start()`, so we have to decide whether to call
 * `addAudioTrack` upfront. Opens each unique source URL just long enough
 * to ask `getPrimaryAudioTrack()`, then disposes — all sources probed in
 * parallel (each is one lightweight metadata read). Returns true if any
 * source has at least one audio track.
 */
async function probeHasAnyAudio(options: {
  state: ProjectStateV1
  assetUrlsByVideoId: Record<string, string>
  signal?: AbortSignal
}): Promise<boolean> {
  const { state, assetUrlsByVideoId, signal } = options
  const uniqueUrls = new Set<string>()
  for (const video of state.videos) {
    const url = assetUrlsByVideoId[video.id]
    if (url) uniqueUrls.add(url)
  }
  throwIfAborted(signal)
  const results = await Promise.all(
    Array.from(uniqueUrls, async (url) => {
      let input: Input | null = null
      try {
        input = new Input({
          formats: ALL_FORMATS,
          source: new UrlSource(url),
        })
        return (await input.getPrimaryAudioTrack()) !== null
      } catch {
        // Source unreadable — treat as no audio for this URL.
        return false
      } finally {
        if (input) {
          try {
            input.dispose()
          } catch {
            // best-effort
          }
        }
      }
    })
  )
  throwIfAborted(signal)
  return results.some(Boolean)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Export cancelled by user.", "AbortError")
  }
}

export type { ExportProgress }
