"use client"

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react"
import Konva from "konva"
import type { Application, Sprite } from "pixi.js"
import type { MotionBlurFilter } from "pixi-filters/motion-blur"

import { Slider } from "@/components/ui/slider"
import { konvaMotionBlurFilter } from "@/lib/motion-blur/cpu-motion-blur"
import {
  createSpriteMotionBlurRendererForBackend,
  type SpriteMotionBlurRenderer,
} from "@/lib/motion-blur/sprite-motion-blur"
import { drawMotionBlurTestPattern } from "@/lib/motion-blur/test-pattern"
import {
  DEFAULT_MOTION_BLUR_OPTIONS,
  motionBlurPadding,
  type MotionBlurOptions,
} from "@/lib/motion-blur/types"

// Stage (the visible canvas) is larger than the sprite so it has room to move.
const STAGE_W = 376
const STAGE_H = 260
const SPRITE_W = 210
const SPRITE_H = 140

// Diagonal path (down-right), matching the default {40,40} velocity direction so
// the smear reads as motivated by the movement.
const START = { x: SPRITE_W / 2 + 8, y: SPRITE_H / 2 + 8 }
const END = { x: STAGE_W - SPRITE_W / 2 - 8, y: STAGE_H - SPRITE_H / 2 - 8 }
const ONE_WAY_MS = 900

const INITIAL_OPTIONS: MotionBlurOptions = DEFAULT_MOTION_BLUR_OPTIONS
const KERNEL_CHOICES = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25]

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

/** Imperative handle every panel exposes so one animation clock drives all canvases. */
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

  const pixiRef = useRef<PanelHandle>(null)
  const gpuRef = useRef<PanelHandle>(null)
  const cpuRef = useRef<PanelHandle>(null)
  const rafRef = useRef<number | null>(null)
  const startTimeRef = useRef<number | null>(null)

  // Build the sprite bitmap once on mount (needs a real canvas -> client only).
  useEffect(() => {
    const canvas = drawMotionBlurTestPattern(SPRITE_W, SPRITE_H)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSource(canvas)
  }, [])

  const draw = useCallback((cx: number, cy: number, blurred: boolean) => {
    pixiRef.current?.setFrame(cx, cy, blurred)
    gpuRef.current?.setFrame(cx, cy, blurred)
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
      // Ping-pong 0 -> 1 -> 0 forever while playing.
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
    []
  )

  return (
    <div className="flex min-h-dvh w-dvw flex-col gap-5 overflow-auto bg-neutral-950 p-6 text-neutral-100">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Motion Blur Lab</h1>
          <p className="max-w-4xl text-sm text-neutral-400">
            One shared animation clock drives the real PixiJS MotionBlurFilter,
            the project GPU cursor renderer, and the Konva CPU filter path. Stop
            returns every panel to the sharp sprite so the no-blur preview can
            be checked against the blurred frame.
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

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <PanelCard title="PixiJS" subtitle="pixi-filters/MotionBlurFilter">
          {source && (
            <PixiPanel ref={pixiRef} source={source} options={options} />
          )}
        </PanelCard>
        <PanelCard
          title="Konva GPU"
          subtitle="project cursor renderer -> Konva.Image"
        >
          {source && (
            <KonvaGpuPanel ref={gpuRef} source={source} options={options} />
          )}
        </PanelCard>
        <PanelCard
          title="Konva CPU"
          subtitle="node.cache() + node.filters([...])"
        >
          {source && (
            <KonvaCpuPanel ref={cpuRef} source={source} options={options} />
          )}
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
      <SliderRow
        label="velocity.x"
        value={options.velocityX}
        min={-90}
        max={90}
        onChange={(v) => onChange("velocityX", v)}
      />
      <SliderRow
        label="velocity.y"
        value={options.velocityY}
        min={-90}
        max={90}
        onChange={(v) => onChange("velocityY", v)}
      />
      <SliderRow
        label="offset"
        value={options.offset}
        min={-150}
        max={150}
        onChange={(v) => onChange("offset", v)}
      />
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
      <Slider
        className="flex-1"
        value={[value]}
        min={min}
        max={max}
        step={1}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
      />
      <span className="w-10 shrink-0 text-right text-neutral-400 tabular-nums">
        {value}
      </span>
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
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-right text-xs text-neutral-500">{subtitle}</span>
      </div>
      {children}
    </div>
  )
}

const panelStageClass = "overflow-hidden rounded bg-[#020617]"

function setKonvaImageFrame(
  node: Konva.Image,
  cx: number,
  cy: number,
  image: CanvasImageSource,
  width: number,
  height: number,
  padding = 0
) {
  node.image(image)
  node.size({ width, height })
  node.position({
    x: cx - SPRITE_W / 2 - padding,
    y: cy - SPRITE_H / 2 - padding,
  })
}

function applyPixiOptions(
  filter: MotionBlurFilter,
  options: MotionBlurOptions
) {
  filter.velocityX = options.velocityX
  filter.velocityY = options.velocityY
  filter.kernelSize = options.kernelSize
  filter.offset = options.offset
}

const PixiPanel = forwardRef<PanelHandle, PanelProps>(function PixiPanel(
  { source, options },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<Application | null>(null)
  const spriteRef = useRef<Sprite | null>(null)
  const filterRef = useRef<MotionBlurFilter | null>(null)
  const optionsRef = useRef(options)
  const blurredRef = useRef(false)
  const [status, setStatus] = useState("loading")

  useEffect(() => {
    optionsRef.current = options
  }, [options])

  useImperativeHandle(ref, () => ({
    setFrame(cx, cy, blurred) {
      const app = appRef.current
      const sprite = spriteRef.current
      const filter = filterRef.current
      if (!app || !sprite || !filter) return
      sprite.position.set(cx - SPRITE_W / 2, cy - SPRITE_H / 2)
      if (blurredRef.current !== blurred) {
        sprite.filters = blurred ? [filter] : []
        blurredRef.current = blurred
      }
      app.render()
    },
  }))

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false

    void Promise.all([import("pixi.js"), import("pixi-filters/motion-blur")])
      .then(async ([pixi, filters]) => {
        if (disposed) return

        const app = new pixi.Application()
        await app.init({
          width: STAGE_W,
          height: STAGE_H,
          backgroundColor: 0x020617,
          backgroundAlpha: 1,
          antialias: false,
          autoDensity: false,
          autoStart: false,
          preference: "webgl",
          resolution: 1,
        })
        if (disposed) {
          app.destroy({ removeView: true }, true)
          return
        }

        const canvas = app.canvas as HTMLCanvasElement
        canvas.style.display = "block"
        host.replaceChildren(canvas)

        const sprite = pixi.Sprite.from(source, true)
        sprite.width = SPRITE_W
        sprite.height = SPRITE_H
        sprite.position.set(START.x - SPRITE_W / 2, START.y - SPRITE_H / 2)

        const currentOptions = optionsRef.current
        const filter = new filters.MotionBlurFilter({
          velocity: {
            x: currentOptions.velocityX,
            y: currentOptions.velocityY,
          },
          kernelSize: currentOptions.kernelSize,
          offset: currentOptions.offset,
        })

        app.stage.addChild(sprite)
        appRef.current = app
        spriteRef.current = sprite
        filterRef.current = filter
        blurredRef.current = false
        app.render()
        setStatus("sharp at rest; Pixi filter while moving")
      })
      .catch((error: unknown) => {
        console.error("[motion-blur-lab] Pixi init failed", error)
        setStatus("Pixi init failed")
      })

    return () => {
      disposed = true
      const app = appRef.current
      appRef.current = null
      spriteRef.current = null
      filterRef.current = null
      blurredRef.current = false
      host.replaceChildren()
      app?.destroy({ removeView: true }, true)
    }
  }, [source])

  useEffect(() => {
    const filter = filterRef.current
    const app = appRef.current
    if (!filter || !app) return
    applyPixiOptions(filter, options)
    app.render()
  }, [options])

  return (
    <div className="space-y-1">
      <div ref={hostRef} className={panelStageClass} />
      <span className="text-xs text-neutral-500 tabular-nums">{status}</span>
    </div>
  )
})

const KonvaGpuPanel = forwardRef<PanelHandle, PanelProps>(
  function KonvaGpuPanel({ source, options }, ref) {
    const hostRef = useRef<HTMLDivElement>(null)
    const layerRef = useRef<Konva.Layer | null>(null)
    const imageRef = useRef<Konva.Image | null>(null)
    const rendererRef = useRef<SpriteMotionBlurRenderer | null>(null)
    const optionsRef = useRef(options)
    const [status, setStatus] = useState("loading")

    useEffect(() => {
      optionsRef.current = options
    }, [options])

    useImperativeHandle(ref, () => ({
      setFrame(cx, cy, blurred) {
        const node = imageRef.current
        const layer = layerRef.current
        const renderer = rendererRef.current
        if (!node || !layer) return

        if (blurred && renderer) {
          const { canvas, padding } = renderer.render(
            source,
            SPRITE_W,
            SPRITE_H,
            optionsRef.current
          )
          setKonvaImageFrame(
            node,
            cx,
            cy,
            canvas,
            SPRITE_W + 2 * padding,
            SPRITE_H + 2 * padding,
            padding
          )
        } else {
          setKonvaImageFrame(node, cx, cy, source, SPRITE_W, SPRITE_H)
        }

        layer.batchDraw()
      },
    }))

    useEffect(() => {
      if (!hostRef.current) return

      const renderer = createSpriteMotionBlurRendererForBackend("gpu")
      rendererRef.current = renderer
      setStatus(
        renderer
          ? "sharp at rest; WebGL2 shader while moving"
          : "WebGL2 unavailable"
      )

      const stage = new Konva.Stage({
        container: hostRef.current,
        width: STAGE_W,
        height: STAGE_H,
      })
      const layer = new Konva.Layer({ listening: false })
      const image = new Konva.Image({
        image: source,
        width: SPRITE_W,
        height: SPRITE_H,
        x: START.x - SPRITE_W / 2,
        y: START.y - SPRITE_H / 2,
        listening: false,
        perfectDrawEnabled: false,
      })

      layer.add(image)
      stage.add(layer)
      layerRef.current = layer
      imageRef.current = image

      return () => {
        renderer?.destroy()
        stage.destroy()
        rendererRef.current = null
        layerRef.current = null
        imageRef.current = null
      }
    }, [source])

    return (
      <div className="space-y-1">
        <div ref={hostRef} className={panelStageClass} />
        <span className="text-xs text-neutral-500 tabular-nums">{status}</span>
      </div>
    )
  }
)

/** Konva panel using the idiomatic CPU custom filter: node.cache() + node.filters(). */
const KonvaCpuPanel = forwardRef<PanelHandle, PanelProps>(
  function KonvaCpuPanel({ source, options }, ref) {
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
      const stage = new Konva.Stage({
        container: hostRef.current,
        width: STAGE_W,
        height: STAGE_H,
      })
      const layer = new Konva.Layer({ listening: false })
      const common = {
        image: source,
        width: SPRITE_W,
        height: SPRITE_H,
        x: START.x - SPRITE_W / 2,
        y: START.y - SPRITE_H / 2,
        listening: false,
        perfectDrawEnabled: false,
      }
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
      blur.clearCache()
      blur.cache({ pixelRatio: 1, offset: motionBlurPadding(options) })
      setMs(performance.now() - t0)
      layerRef.current?.batchDraw()
    }, [source, options])

    return (
      <div className="space-y-1">
        <div ref={hostRef} className={panelStageClass} />
        <span className="text-xs text-neutral-500 tabular-nums">
          {ms == null ? "cache not built" : `recache: ${ms.toFixed(2)} ms`}
        </span>
      </div>
    )
  }
)
