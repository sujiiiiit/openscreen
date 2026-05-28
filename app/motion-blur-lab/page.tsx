"use client"

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import Konva from "konva"

import { Slider } from "@/components/ui/slider"
import { drawMotionBlurTestPattern } from "@/lib/motion-blur/test-pattern"
import { konvaMotionBlurFilter } from "@/lib/motion-blur/cpu-motion-blur"
import { motionBlurPadding, type MotionBlurOptions } from "@/lib/motion-blur/types"

// Stage (the visible canvas) is larger than the sprite so it has room to move.
const STAGE_W = 560
const STAGE_H = 380
const SPRITE_W = 300
const SPRITE_H = 200

// Diagonal path (down-right), matching the default {40,40} velocity direction so
// the smear reads as motivated by the movement.
const START = { x: SPRITE_W / 2 + 10, y: SPRITE_H / 2 + 10 }
const END = { x: STAGE_W - SPRITE_W / 2 - 10, y: STAGE_H - SPRITE_H / 2 - 10 }
const ONE_WAY_MS = 900

const INITIAL_OPTIONS: MotionBlurOptions = { velocityX: 40, velocityY: 40, kernelSize: 25, offset: 0 }
const KERNEL_CHOICES = [5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25]

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** Imperative handle the panel exposes so the animation clock can drive it per-frame. */
interface PanelHandle {
  setFrame(cx: number, cy: number, blurred: boolean): void
}

interface PanelProps {
  source: HTMLCanvasElement
  options: MotionBlurOptions
}

export default function MotionBlurLabPage() {
  const [options, setOptions] = useState<MotionBlurOptions>(INITIAL_OPTIONS)
  const [source, setSource] = useState<HTMLCanvasElement | null>(null)
  const [playing, setPlaying] = useState(false)

  const cpuRef = useRef<PanelHandle>(null)
  const rafRef = useRef<number | null>(null)
  const startTimeRef = useRef<number | null>(null)

  // Build the sprite bitmap once on mount (needs a real canvas → client only).
  useEffect(() => {
    const canvas = drawMotionBlurTestPattern(SPRITE_W, SPRITE_H)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSource(canvas)
  }, [])

  const draw = useCallback((cx: number, cy: number, blurred: boolean) => {
    cpuRef.current?.setFrame(cx, cy, blurred)
  }, [])

  // Animation clock: blur is applied during motion, removed at rest.
  useEffect(() => {
    if (!playing) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      startTimeRef.current = null
      draw(START.x, START.y, false) // idle: sharp, at the start position
      return
    }

    const frame = (now: number) => {
      if (startTimeRef.current == null) startTimeRef.current = now
      const elapsed = now - startTimeRef.current
      // Ping-pong 0 → 1 → 0 forever while playing.
      const phase = (elapsed % (2 * ONE_WAY_MS)) / ONE_WAY_MS
      const tri = phase <= 1 ? phase : 2 - phase
      const t = easeInOut(tri)
      draw(lerp(START.x, END.x, t), lerp(START.y, END.y, t), true)
      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [playing, draw])

  const setField = useCallback(
    (key: keyof MotionBlurOptions, value: number) =>
      setOptions((prev) => ({ ...prev, [key]: value })),
    [],
  )

  return (
    <div className="flex min-h-dvh w-dvw flex-col gap-5 overflow-auto bg-neutral-950 p-6 text-neutral-100">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Motion Blur Lab</h1>
          <p className="max-w-3xl text-sm text-neutral-400">
            A moving sprite with directional motion blur applied during motion (and removed at
            rest). The blur is a CPU port of PixiJS&apos;s <code className="px-1">MotionBlurFilter</code>{" "}
            wired through Konva via <code className="px-1">node.cache()</code> +{" "}
            <code className="px-1">node.filters([…])</code>. Press <strong>Auto Move</strong> to see
            it in motion.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-400"
        >
          {playing ? "Stop" : "Auto Move"}
        </button>
      </header>

      <Controls options={options} onChange={setField} />

      <div className="grid grid-cols-1">
        <PanelCard title="Konva · CPU motion blur" subtitle="node.cache() + node.filters([…])">
          {source && <CpuPanel ref={cpuRef} source={source} options={options} />}
        </PanelCard>
      </div>
    </div>
  )
}

function Controls({
  options,
  onChange,
}: {
  options: MotionBlurOptions
  onChange: (key: keyof MotionBlurOptions, value: number) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 sm:grid-cols-2">
      <SliderRow label="velocity.x" value={options.velocityX} min={-90} max={90} onChange={(v) => onChange("velocityX", v)} />
      <SliderRow label="velocity.y" value={options.velocityY} min={-90} max={90} onChange={(v) => onChange("velocityY", v)} />
      <SliderRow label="offset" value={options.offset} min={-150} max={150} onChange={(v) => onChange("offset", v)} />
      <label className="flex items-center justify-between gap-4 text-sm">
        <span className="w-24 shrink-0 text-neutral-300">kernelSize</span>
        <select
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-neutral-100"
          value={options.kernelSize}
          onChange={(e) => onChange("kernelSize", Number(e.target.value))}
        >
          {KERNEL_CHOICES.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <label className="flex items-center gap-4 text-sm">
      <span className="w-24 shrink-0 text-neutral-300">{label}</span>
      <Slider className="flex-1" value={[value]} min={min} max={max} step={1} onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)} />
      <span className="w-10 shrink-0 text-right tabular-nums text-neutral-400">{value}</span>
    </label>
  )
}

function PanelCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-neutral-500">{subtitle}</span>
      </div>
      {children}
    </div>
  )
}

/** Konva panel using the idiomatic CPU custom filter: node.cache() + node.filters(). */
const CpuPanel = forwardRef<PanelHandle, PanelProps>(function CpuPanel({ source, options }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<Konva.Layer | null>(null)
  const sharpRef = useRef<Konva.Image | null>(null)
  const blurRef = useRef<Konva.Image | null>(null)
  const [ms, setMs] = useState<number | null>(null)

  useImperativeHandle(ref, () => ({
    setFrame(cx, cy, blurred) {
      const layer = layerRef.current
      const sharp = sharpRef.current
      const blur = blurRef.current
      if (!layer || !sharp || !blur) return
      const x = cx - SPRITE_W / 2
      const y = cy - SPRITE_H / 2
      sharp.position({ x, y })
      blur.position({ x, y })
      sharp.visible(!blurred)
      blur.visible(blurred)
      layer.batchDraw()
    },
  }))

  useEffect(() => {
    if (!hostRef.current) return
    const stage = new Konva.Stage({ container: hostRef.current, width: STAGE_W, height: STAGE_H })
    const layer = new Konva.Layer()
    const common = { image: source, width: SPRITE_W, height: SPRITE_H, x: START.x - SPRITE_W / 2, y: START.y - SPRITE_H / 2 }
    const sharp = new Konva.Image(common)
    // The blurred node is cached + filtered; toggling visibility avoids per-frame caching.
    const blur = new Konva.Image({ ...common, visible: false })
    blur.filters([konvaMotionBlurFilter])
    layer.add(sharp)
    layer.add(blur)
    stage.add(layer)
    layerRef.current = layer
    sharpRef.current = sharp
    blurRef.current = blur
    return () => {
      stage.destroy()
      layerRef.current = null
      sharpRef.current = null
      blurRef.current = null
    }
  }, [source])

  // Re-cache the blurred node whenever options change (the expensive CPU pass).
  useEffect(() => {
    const blur = blurRef.current
    if (!blur) return
    blur.setAttr("motionBlur", options)
    // `offset` expands the cache with a transparent margin so the smear can spill
    // beyond the sprite (Konva's native mechanism, sized by Pixi's padding rule).
    const t0 = performance.now()
    blur.cache({ pixelRatio: 1, offset: motionBlurPadding(options) })
    setMs(performance.now() - t0)
    layerRef.current?.batchDraw()
  }, [source, options])

  return (
    <div className="space-y-1">
      <div ref={hostRef} className="overflow-hidden rounded bg-neutral-950" />
      <span className="text-xs tabular-nums text-neutral-500">
        {ms == null ? "—" : `blur frame: ${ms.toFixed(2)} ms`}
      </span>
    </div>
  )
})
