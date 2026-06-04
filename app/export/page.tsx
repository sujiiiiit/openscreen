"use client"

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DRAG, NO_DRAG } from "@/lib/window-drag"
import { cn } from "@/lib/utils"
import {
  defaultExportSettings,
  exportResolutionPixels,
} from "@/lib/editor-project/export-settings"
import {
  probeExportFormats,
} from "@/components/editor/export/codec-probe"
import {
  runExport,
  type ExportStage,
} from "@/components/editor/export/run-export"
import type {
  ExportCodecSupport,
  ExportFormatId,
  ExportFrameRate,
  ExportProgress,
  ExportResolutionId,
  ExportSettings,
  ExportStartPayload,
} from "@/types/api"

const FORMAT_LABELS: Record<ExportFormatId, string> = {
  "mp4-avc": "MP4 — H.264 (most compatible)",
  "mp4-hevc": "MP4 — HEVC (smaller files)",
  "webm-vp9": "WebM — VP9",
}

const RESOLUTION_LABELS: Record<ExportResolutionId, string> = {
  // `artboard` ends up shown as "Auto (W × H)" — the W×H is computed at
  // render time from the current project's artboard dimensions, so the
  // user can see exactly what they'll get without picking a preset.
  artboard: "Auto",
  "720p": "720p",
  "1080p": "1080p",
  "1440p": "1440p",
  "4k": "4K",
}

const FRAME_RATE_LABELS: Record<ExportFrameRate, string> = {
  30: "30 fps",
  60: "60 fps",
}

type ExportPhase =
  | "loading"
  | "ready"
  | "running"
  | "done"
  | "error"
  | "cancelled"

interface ExportSession {
  payload: ExportStartPayload
  settings: ExportSettings
}

export default function ExportPage() {
  const [phase, setPhase] = useState<ExportPhase>("loading")
  const [session, setSession] = useState<ExportSession | null>(null)
  const [codecSupport, setCodecSupport] = useState<ExportCodecSupport[]>([])
  const [progress, setProgress] = useState<ExportProgress>({
    framesDone: 0,
    framesTotal: 0,
    etaSeconds: null,
  })
  const [stage, setStage] = useState<ExportStage>("preparing")
  const [outputPath, setOutputPath] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const offscreenRef = useRef<HTMLDivElement | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Bootstrap: pull the start payload pushed in from the editor + the
  // persisted settings + a runtime codec probe so the UI knows which
  // formats are encodable on this machine.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const api = window.api?.export
      if (!api) {
        setPhase("error")
        setErrorMessage("Export bridge is unavailable.")
        return
      }
      const [payload, persistedSettings] = await Promise.all([
        api.getStartPayload(),
        api.getSettings(),
      ])
      if (cancelled) return
      if (!payload) {
        setPhase("error")
        setErrorMessage(
          "No project state was provided. Re-open this window from the editor.",
        )
        return
      }
      const merged: ExportSettings = {
        ...defaultExportSettings(),
        ...persistedSettings,
        ...payload.settings,
      }
      setSession({ payload, settings: merged })
      const support = await probeExportFormats({
        artboard: payload.state.artboard,
        resolution: merged.resolution,
        fps: merged.fps,
      })
      if (cancelled) return
      setCodecSupport(support)
      setPhase("ready")
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const patchSettings = useCallback(
    async (patch: Partial<ExportSettings>) => {
      if (!session) return
      const api = window.api?.export
      if (!api) return
      const next = await api.setSettings({ ...session.settings, ...patch })
      setSession({ payload: session.payload, settings: next })
    },
    [session],
  )

  const startEncode = useCallback(async () => {
    if (!session) return
    const api = window.api?.export
    if (!api) return
    const container = offscreenRef.current
    if (!container) {
      setPhase("error")
      setErrorMessage("Render surface missing.")
      return
    }

    const abortController = new AbortController()
    abortControllerRef.current = abortController
    setPhase("running")
    setStage("preparing")
    setProgress({ framesDone: 0, framesTotal: 0, etaSeconds: null })
    setErrorMessage(null)
    setOutputPath(null)

    await api.markPreparing()
    try {
      const result = await runExport({
        state: session.payload.state,
        settings: session.settings,
        assetUrlsByVideoId: session.payload.assetUrlsByVideoId,
        container,
        signal: abortController.signal,
        onStage: (next) => setStage(next),
        onProgress: (p) => {
          // Mirror locally for UI; main keeps the canonical job state so
          // the editor could observe it too in the future.
          setProgress(p)
          void api.reportProgress(p)
        },
      })
      if (abortController.signal.aborted) {
        setPhase("cancelled")
        return
      }
      const done = await api.reportDone(result.bytes)
      setOutputPath(done.outputPath)
      setPhase("done")
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        setPhase("cancelled")
        return
      }
      const message =
        error instanceof Error ? error.message : "Export failed."
      setErrorMessage(message)
      void api.reportError(message)
      setPhase("error")
    } finally {
      abortControllerRef.current = null
    }
  }, [session])

  const cancelEncode = useCallback(() => {
    // Only meaningful while an encode is in flight. Calling cancel from a
    // terminal state (done/error/cancelled) used to flip phase back to
    // 'cancelled' on the main side, which caused the exported file to be
    // deleted by the window's `closed` handler. We guard at the renderer
    // too so the cancel IPC is never sent when nothing is running.
    if (!abortControllerRef.current) return
    abortControllerRef.current.abort()
    void window.api?.export.cancel()
  }, [])

  const supportedFormats = useMemo(() => {
    if (codecSupport.length === 0) return null
    return new Set(
      codecSupport.filter((s) => s.supported).map((s) => s.format),
    )
  }, [codecSupport])

  const dimensionsLabel = useMemo(() => {
    if (!session) return ""
    const { width, height } = exportResolutionPixels(
      session.settings.resolution,
      session.payload.state.artboard,
    )
    return `${width} × ${height}`
  }, [session])

  const closeWindow = useCallback(() => {
    // Close cancels first only when an encode is actually in flight (the
    // cancelEncode guard above). For terminal phases this is a pure window
    // op — the file must remain untouched.
    cancelEncode()
    void window.api?.export.closeWindow()
  }, [cancelEncode])

  return (
    <div
      data-window="export"
      className="text-foreground flex h-screen flex-col bg-transparent p-5"
      style={DRAG}
    >
      <header className="mb-3 flex items-center">
        <h1 className="text-[13px] font-medium leading-tight">Export</h1>
      </header>

      <div className="flex-1 overflow-y-auto" style={NO_DRAG}>
        {phase === "loading" && (
          <p className="text-muted-foreground py-1 text-[11px]">Loading…</p>
        )}
        {phase === "ready" && session && (
          <SettingsForm
            settings={session.settings}
            supportedFormats={supportedFormats}
            dimensionsLabel={dimensionsLabel}
            artboard={session.payload.state.artboard}
            onChange={patchSettings}
          />
        )}
        {phase === "running" && session && (
          <RunningView stage={stage} progress={progress} />
        )}
        {phase === "done" && outputPath && (
          <DoneView outputPath={outputPath} />
        )}
        {(phase === "error" || phase === "cancelled") && (
          <FailureView phase={phase} message={errorMessage} />
        )}
      </div>

      <footer className="mt-4 flex items-center justify-end gap-2">
        {phase === "ready" && (
          <>
            <Button variant="ghost" size="sm" onClick={closeWindow}>
              Close
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={startEncode}
              disabled={!session}
            >
              Export
            </Button>
          </>
        )}
        {phase === "running" && (
          <Button variant="outline" size="sm" onClick={cancelEncode}>
            Cancel
          </Button>
        )}
        {phase === "done" && outputPath && (
          <>
            <Button variant="ghost" size="sm" onClick={closeWindow}>
              Done
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPhase("ready")
                setOutputPath(null)
              }}
            >
              Export again
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                void window.api?.export.revealOutput(outputPath)
              }}
            >
              Reveal in Finder
            </Button>
          </>
        )}
        {(phase === "error" || phase === "cancelled") && (
          <>
            <Button variant="ghost" size="sm" onClick={closeWindow}>
              Done
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => setPhase("ready")}
            >
              Try again
            </Button>
          </>
        )}
      </footer>

      {/*
        Off-screen render surface. The export pipeline attaches its offscreen
        PixiJS application canvas here. We hide it visually but keep it in the
        document so the <video> elements + canvas composite work normally.
      */}
      <div
        ref={offscreenRef}
        aria-hidden
        style={{
          position: "absolute",
          left: -99999,
          top: -99999,
          width: 1,
          height: 1,
          pointerEvents: "none",
          opacity: 0,
        }}
      />
    </div>
  )
}

function SettingsForm({
  settings,
  supportedFormats,
  dimensionsLabel,
  artboard,
  onChange,
}: {
  settings: ExportSettings
  supportedFormats: Set<ExportFormatId> | null
  dimensionsLabel: string
  artboard: { width: number; height: number }
  onChange: (patch: Partial<ExportSettings>) => void
}) {
  const formatOptions = useMemo<SelectOption<ExportFormatId>[]>(
    () =>
      (Object.keys(FORMAT_LABELS) as ExportFormatId[]).map((format) => ({
        value: format,
        label: FORMAT_LABELS[format],
        disabled:
          supportedFormats !== null && !supportedFormats.has(format),
      })),
    [supportedFormats],
  )
  const resolutionOptions = useMemo<SelectOption<ExportResolutionId>[]>(
    () => {
      // Compute "Auto"'s actual output dimensions from the current artboard
      // so the user can read e.g. `Auto (1920 × 1080)` straight from the
      // dropdown without having to select it first to see the description.
      const autoDims = exportResolutionPixels("artboard", artboard)
      return (Object.keys(RESOLUTION_LABELS) as ExportResolutionId[]).map(
        (r) => ({
          value: r,
          label:
            r === "artboard"
              ? `${RESOLUTION_LABELS[r]} (${autoDims.width} × ${autoDims.height})`
              : RESOLUTION_LABELS[r],
        }),
      )
    },
    [artboard],
  )
  const fpsOptions = useMemo<SelectOption<ExportFrameRate>[]>(
    () =>
      ([30, 60] as ExportFrameRate[]).map((fps) => ({
        value: fps,
        label: FRAME_RATE_LABELS[fps],
      })),
    [],
  )

  return (
    <section>
      <SettingRow
        label="Resolution"
        description={`Output ${dimensionsLabel}.`}
      >
        <Select
          value={settings.resolution}
          options={resolutionOptions}
          onChange={(value) => onChange({ resolution: value })}
        />
      </SettingRow>
      <SettingRow
        label="Format"
        description="HEVC needs a recent GPU."
      >
        <Select
          value={settings.format}
          options={formatOptions}
          onChange={(value) => onChange({ format: value })}
        />
      </SettingRow>
      <SettingRow label="Frame rate">
        <Select
          value={settings.fps}
          options={fpsOptions}
          onChange={(value) => onChange({ fps: value })}
        />
      </SettingRow>
    </section>
  )
}

// Per-stage word sequence shown in the running view's headline slot. Each
// phrase gets the same on-screen duration (`MICROPHRASE_INTERVAL_MS`). The
// FIRST entry in each list is what the user sees when the stage starts —
// the "official" headline; subsequent entries are conversational status
// words that make the long encoding phase feel alive (the same trick
// Claude Code uses while a long tool call runs). Stages that complete
// quickly only need one phrase; the cycling hook gracefully no-ops on a
// single-element list.
const STAGE_PHRASES: Record<ExportStage, readonly string[]> = {
  preparing: ["Preparing the stage"],
  "decoding-audio": ["Decoding source audio"],
  encoding: [
    "Encoding frames",
    "Composing",
    "Painting frames",
    "Wiring shadows",
    "Buffering encoder",
    "Tuning bitrate",
    "Squeezing bytes",
    "Polishing edges",
    "Stitching squircles",
    "Crunching pixels",
    "Aligning keyframes",
    "Sampling colors",
    "Smoothing motion",
    "Packing macroblocks",
    "Quantizing detail",
    "Sharpening text",
    "Blending layers",
    "Rasterizing scenes",
    "Warming the encoder",
    "Chasing frames",
    "Compressing time",
    "Threading the GPU",
    "Carving deltas",
    "Dithering gradients",
    "Pacing the pipeline",
    "Herding photons",
    "Trimming the fat",
    "Sealing the container",
    "Counting frames",
    "Almost there",
  ],
  "muxing-audio": ["Muxing audio track"],
  finalizing: ["Finalizing file"],
}

const MICROPHRASE_INTERVAL_MS = 1100

function RunningView({
  stage,
  progress,
}: {
  stage: ExportStage
  progress: ExportProgress
}) {
  // Single phrase slot, cycled every MICROPHRASE_INTERVAL_MS. The first
  // word in each stage's sequence is the "official" headline; once the
  // sequence reaches its end it loops back to it. The hook resets its
  // counter to 0 when `stage` changes, so each new phase begins with its
  // headline — never mid-sequence.
  const phrase = useCyclingPhrase(STAGE_PHRASES[stage], MICROPHRASE_INTERVAL_MS)

  // One monotonic bar across the whole pipeline. Every phase maps to a
  // forward-only slice so the bar starts fresh at 0, advances through
  // prepare → decode → encode → finalize, and NEVER resets or phantom-fills.
  // (The old indeterminate sweep slid a segment to the track's right edge —
  // which read as "100%" during the prep phases — and then the determinate
  // encoding bar appeared at 0, reading as a reset to 0. A single weighted
  // determinate bar removes both illusions.)
  const overallPct = computeOverallPct(stage, progress)

  const etaLabel =
    progress.etaSeconds === null
      ? "Estimating ETA…"
      : `${formatEta(progress.etaSeconds)} remaining`

  // During encoding we have a real frame counter + ETA — put them in a
  // two-column meta row directly under the progress bar (frame count on
  // the left, time-remaining on the right). During other phases we
  // collapse to a single short status string so the bar isn't surrounded
  // by misleading numbers.
  const showEncodingMeta = stage === "encoding" && progress.framesTotal > 0

  return (
    <div className="flex flex-col gap-3 py-4">
      <span className="text-[13px]">{phrase ?? ""}…</span>
      <div className="bg-muted relative h-2 w-full overflow-hidden rounded">
        <div
          className="bg-primary h-full rounded transition-[width] duration-300 ease-out"
          style={{ width: `${overallPct}%` }}
        />
      </div>
      {showEncodingMeta ? (
        <div className="text-muted-foreground flex items-center justify-between text-[11px] tabular-nums">
          <span>
            Frame {progress.framesDone.toLocaleString()} of{" "}
            {progress.framesTotal.toLocaleString()}
          </span>
          <span>{etaLabel}</span>
        </div>
      ) : (
        <div className="text-muted-foreground text-[11px]">
          {progress.framesTotal > 0 && progress.framesDone > 0
            ? `${progress.framesDone.toLocaleString()} of ${progress.framesTotal.toLocaleString()} frames encoded`
            : "Hang tight"}
        </div>
      )}
    </div>
  )
}

function useCyclingPhrase(
  phrases: readonly string[] | null,
  intervalMs: number,
): string | null {
  const [tick, setTick] = useState(0)
  // React-blessed "reset state when a prop changes" pattern: compare the
  // previous phrases reference in render via paired useState and call
  // setTick(0) on mismatch. Avoids both the synchronous-setState-in-effect
  // smell and the ref-mutation-during-render smell.
  const [storedPhrases, setStoredPhrases] = useState(phrases)
  if (storedPhrases !== phrases) {
    setStoredPhrases(phrases)
    setTick(0)
  }
  useEffect(() => {
    if (!phrases || phrases.length === 0) return
    const id = setInterval(() => setTick((t) => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [phrases, intervalMs])
  if (!phrases || phrases.length === 0) return null
  return phrases[tick % phrases.length] ?? phrases[0]
}

function DoneView({ outputPath }: { outputPath: string }) {
  return (
    <div className="flex flex-col gap-2 py-2">
      <p className="text-[13px]">Export complete</p>
      <p
        className="text-muted-foreground break-all text-[10.5px] leading-snug"
        title={outputPath}
      >
        {outputPath}
      </p>
    </div>
  )
}

function FailureView({
  phase,
  message,
}: {
  phase: "error" | "cancelled"
  message: string | null
}) {
  return (
    <div className="flex flex-col gap-2 py-2">
      <p className="text-[13px]">
        {phase === "cancelled" ? "Export cancelled." : "Export failed."}
      </p>
      {message ? (
        <p className="text-muted-foreground text-[10.5px] leading-snug">
          {message}
        </p>
      ) : null}
    </div>
  )
}

function SettingRow({
  label,
  description,
  disabled,
  children,
}: {
  label: string
  description?: React.ReactNode
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 py-1.5",
        disabled && "opacity-50",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] leading-tight">{label}</span>
        {description ? (
          <span className="text-muted-foreground text-[10.5px] leading-snug">
            {description}
          </span>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

interface SelectOption<T extends string | number> {
  value: T
  label: string
  disabled?: boolean
}

function Select<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  width = 220,
}: {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (next: T) => void
  disabled?: boolean
  width?: number
}) {
  const current = options.find((o) => o.value === value) ?? options[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            style={{ ...NO_DRAG, minWidth: width }}
            className="justify-between"
          >
            <span className="truncate">{current?.label}</span>
            <span className="text-muted-foreground ml-2 text-xs">▾</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" style={{ minWidth: width }}>
        {options.map((option) => (
          <DropdownMenuItem
            key={String(option.value)}
            disabled={option.disabled}
            onClick={() => {
              if (option.disabled) return
              onChange(option.value)
            }}
            text={option.label}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Weighted, monotonic progress across the whole export pipeline. Encoding is
// the dominant phase, so it owns the bulk of the bar (4%→96%); the bracketing
// phases get small fixed slices that only ever move the bar forward. The bar
// therefore starts at 0 ("fresh"), climbs once during the real render, and
// holds near full through finalize — it never jumps to 100% early nor resets.
function computeOverallPct(
  stage: ExportStage,
  progress: ExportProgress,
): number {
  const ENCODE_START = 4
  const ENCODE_END = 96
  switch (stage) {
    case "preparing":
      return 0
    case "decoding-audio":
      return ENCODE_START
    case "encoding": {
      if (progress.framesTotal <= 0) return ENCODE_START
      const frac = Math.min(1, progress.framesDone / progress.framesTotal)
      return ENCODE_START + frac * (ENCODE_END - ENCODE_START)
    }
    case "muxing-audio":
      return 98
    case "finalizing":
      return 99
  }
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return "<1s"
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
}
