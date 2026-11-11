import { GlUboSystem, GpuUboSystem } from "pixi.js"
// Installs static (CSP-safe) uniform/UBO sync implementations. Must evaluate
// before the patch below wraps them, so it is imported here (not just in
// `create-app.ts`).
import "pixi.js/unsafe-eval"

/** The signature `UboSystem.syncUniformGroup` calls a UBO sync function with. */
type UboSyncFunction = (
  uniforms: Record<string, unknown>,
  data: Float32Array,
  dataInt32: Int32Array | null,
  offset: number
) => void

/** The subset of PixiJS's `UboElement` this fix reads. */
interface UboElementLike {
  offset: number
  data: { name: string; type: string; size: number }
}

type UboSyncGenerator = (uboElements: UboElementLike[]) => UboSyncFunction

interface PatchableUboSystem {
  _generateUboSync?: UboSyncGenerator & { __arityFixed?: true }
}

/**
 * PixiJS 8.18.1's `pixi.js/unsafe-eval` UBO polyfills return
 * `(uniforms, data, offset)`, but `UboSystem.syncUniformGroup` calls the sync
 * function as `(uniforms, data, dataInt32, offset)` (the eval-generated version
 * takes all four). So the polyfill receives `dataInt32` as its offset:
 *
 * - A uniform group with its own buffer passes an `Int32Array` there, and
 *   `Int32Array + n` is a string, so every write lands on a junk property and
 *   the UBO stays all zeros. On WebGPU every filter's uniforms are such UBOs
 *   (`uInputSize`, `uStrength`, …): zero input size divides by zero, and every
 *   filtered frame (radial zoom blur, reframe pan blur) renders BLACK.
 * - A batched group passes `null`, and the real offset is dropped, so the
 *   values are written at the start of the shared buffer.
 *
 * WebGL is unaffected because filter uniforms are not UBOs there. This adapter
 * forwards the real offset. It only wraps 3-parameter sync functions, so it
 * becomes a no-op once PixiJS fixes the polyfill's arity.
 */
export function adaptUboSyncArity(sync: UboSyncFunction): UboSyncFunction {
  if (sync.length !== 3) return sync
  const polyfill = sync as unknown as (
    uniforms: Record<string, unknown>,
    data: Float32Array,
    offset: number
  ) => void
  return (uniforms, data, _dataInt32, offset) =>
    polyfill(uniforms, data, offset)
}

const INT_COMPONENTS: Record<string, number> = {
  i32: 1,
  "vec2<i32>": 2,
  "vec3<i32>": 3,
  "vec4<i32>": 4,
}

const int32Views = new WeakMap<Float32Array, Int32Array>()

function int32ViewOf(data: Float32Array): Int32Array {
  let view = int32Views.get(data)
  if (!view) {
    view = new Int32Array(data.buffer, data.byteOffset, data.length)
    int32Views.set(data, view)
  }
  return view
}

/**
 * The same polyfill's integer setters are wrong too. Its `i32` setter writes
 * through the FLOAT view (`data[offset] = v`), while Pixi's own code writes
 * `dataInt32[offset] = v`, so the shader reads the float's bit pattern
 * (`MotionBlurFilter`'s `uKernelSize = 9` arrives as 1091567616). The loop
 * then runs about a billion times and the reframe pan blur renders black.
 * `vec2/3/4<i32>` have no polyfill setter at all, so the sync throws. Scalar
 * and vector integer uniforms are therefore kept out of the polyfill and
 * written here through an `Int32Array` view of the same buffer. Integer ARRAYS
 * (`size > 1`) still go through the polyfill; no filter in this app uses them.
 */
export function createUboSync(
  generate: (uboElements: UboElementLike[]) => UboSyncFunction,
  uboElements: UboElementLike[]
): UboSyncFunction {
  const intElements = uboElements.filter(
    (element) => element.data.size === 1 && element.data.type in INT_COMPONENTS
  )
  const sync = adaptUboSyncArity(
    generate(
      intElements.length === 0
        ? uboElements
        : uboElements.filter((element) => !intElements.includes(element))
    )
  )
  if (intElements.length === 0) return sync
  const ints = intElements.map((element) => ({
    name: element.data.name,
    index: element.offset / 4,
    components: INT_COMPONENTS[element.data.type],
  }))
  return (uniforms, data, dataInt32, offset) => {
    sync(uniforms, data, dataInt32, offset)
    const view = dataInt32 ?? int32ViewOf(data)
    for (const { name, index, components } of ints) {
      const value = uniforms[name] as number | ArrayLike<number>
      if (components === 1) {
        view[offset + index] = value as number
      } else {
        const vector = value as ArrayLike<number>
        for (let i = 0; i < components; i++) {
          view[offset + index + i] = vector[i]
        }
      }
    }
  }
}

function patchUboSystem(proto: PatchableUboSystem): void {
  const generate = proto._generateUboSync
  if (!generate || generate.__arityFixed) return
  const patched: UboSyncGenerator & { __arityFixed?: true } = function (
    this: unknown,
    uboElements
  ) {
    return createUboSync(
      (elements) => generate.call(this, elements),
      uboElements
    )
  }
  patched.__arityFixed = true
  proto._generateUboSync = patched
}

/** Idempotent; runs on import (via `create-app.ts`, before any renderer exists). */
export function installUboSyncPolyfillFix(): void {
  patchUboSystem(GpuUboSystem.prototype as unknown as PatchableUboSystem)
  patchUboSystem(GlUboSystem.prototype as unknown as PatchableUboSystem)
}

installUboSyncPolyfillFix()
