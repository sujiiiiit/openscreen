import { createUboElementsWGSL, GpuUboSystem } from "pixi.js"
import { describe, expect, it } from "vitest"

import { adaptUboSyncArity } from "../pixi/ubo-sync-polyfill-fix"

type Sync = (
  uniforms: Record<string, unknown>,
  data: Float32Array,
  dataInt32: Int32Array | null,
  offset: number
) => void

// ZoomBlurFilter's uniform block: f32 + vec2 (point) + vec2 (array).
const uniformData = [
  { name: "uStrength", type: "f32", size: 1, value: 0.25 },
  { name: "uCenter", type: "vec2<f32>", size: 1, value: { x: 10, y: 20 } },
  { name: "uRadii", type: "vec2<f32>", size: 1, value: new Float32Array([3, -1]) },
]
const uniforms = {
  uStrength: 0.25,
  uCenter: { x: 10, y: 20 },
  uRadii: new Float32Array([3, -1]),
}

function generateSync(data: readonly unknown[] = uniformData): Sync {
  const { uboElements } = createUboElementsWGSL(data as never)
  const proto = GpuUboSystem.prototype as unknown as {
    _generateUboSync: (els: unknown) => Sync
  }
  return proto._generateUboSync(uboElements)
}

describe("ubo-sync-polyfill-fix", () => {
  it("writes a self-buffered uniform group (dataInt32 passed) — the WebGPU filter case", () => {
    const data = new Float32Array(8)
    generateSync()(uniforms, data, new Int32Array(data.buffer), 0)
    // WGSL layout: f32 @0, vec2 @8 bytes (index 2), vec2 @16 bytes (index 4).
    expect(Array.from(data.slice(0, 6))).toEqual([0.25, 0, 10, 20, 3, -1])
  })

  it("honours the offset for a batched group (dataInt32 null)", () => {
    const data = new Float32Array(16)
    generateSync()(uniforms, data, null, 8)
    expect(Array.from(data.slice(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(Array.from(data.slice(8, 14))).toEqual([0.25, 0, 10, 20, 3, -1])
  })

  it("writes i32 uniforms as integers — MotionBlurFilter's kernel size", () => {
    const motionBlur = [
      { name: "uVelocity", type: "vec2<f32>", size: 1, value: { x: 12, y: -4 } },
      { name: "uKernelSize", type: "i32", size: 1, value: 9 },
      { name: "uOffset", type: "f32", size: 1, value: 0 },
    ]
    const data = new Float32Array(4)
    const ints = new Int32Array(data.buffer)
    generateSync(motionBlur)(
      { uVelocity: { x: 12, y: -4 }, uKernelSize: 9, uOffset: 0.5 },
      data,
      ints,
      0
    )
    expect([data[0], data[1]]).toEqual([12, -4])
    // Read through the int view, as the shader does: 9, not the float's bits.
    expect(ints[2]).toBe(9)
    expect(data[3]).toBe(0.5)
  })

  it("writes vector i32 uniforms (no polyfill setter exists for them)", () => {
    const layout = [{ name: "uSteps", type: "vec2<i32>", size: 1, value: new Int32Array([3, 7]) }]
    const data = new Float32Array(4)
    generateSync(layout)({ uSteps: new Int32Array([3, 7]) }, data, null, 0)
    const ints = new Int32Array(data.buffer)
    expect([ints[0], ints[1]]).toEqual([3, 7])
  })

  it("leaves a correct 4-parameter sync function untouched", () => {
    const sync: Sync = () => {}
    const fourArg: Sync = (_u, _d, _i, _o) => sync(_u, _d, _i, _o)
    expect(adaptUboSyncArity(fourArg)).toBe(fourArg)
  })
})
