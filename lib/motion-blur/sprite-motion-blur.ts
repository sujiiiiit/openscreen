import { applyMotionBlur } from "./cpu-motion-blur"
import { motionBlurPadding, type MotionBlurOptions } from "./types"

/**
 * Reusable directional motion-blur renderer for a small sprite (e.g. the cursor).
 *
 * Primary path is **GPU** (WebGL2): the same directional-blur shader as the lab,
 * run on the GPU, premultiplied so the smear feathers cleanly into the
 * transparent margin. It falls back to the **CPU** filter (`applyMotionBlur`)
 * when WebGL2 is unavailable. Either way the result is a *reused* canvas the
 * caller hands straight to `Konva.Image.image()` — no per-frame `node.cache()`,
 * no Konva filter pipeline, no per-frame allocations on the hot path.
 *
 * The returned canvas is expanded by `padding` px per side (Pixi's
 * `motionBlurPadding`) so the smear can spill past the sprite; the caller shifts
 * the node offset by that padding to keep the sprite pinned.
 */
export interface SpriteMotionBlurResult {
  /** Reused canvas of size (renderW + 2·padding) × (renderH + 2·padding). */
  canvas: HTMLCanvasElement
  /** Transparent margin baked into the canvas, px per side. */
  padding: number
}

export interface SpriteMotionBlurRenderer {
  readonly backend: "gpu" | "cpu"
  /**
   * Blur `source` (drawn at `renderW × renderH`) with `options`, returning a
   * reused, padded canvas. The same canvas instance is returned across calls —
   * consume it (draw it) before the next `render`.
   */
  render(
    source: CanvasImageSource,
    renderW: number,
    renderH: number,
    options: MotionBlurOptions,
  ): SpriteMotionBlurResult
  destroy(): void
}

const VERTEX_SRC = /* glsl */ `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main(void) {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

// Directional motion blur, ported from Pixi's motion-blur.frag. The source
// texture carries a transparent margin (premultiplied), so averaging the taps
// feathers the smear out to transparent at the edges.
const FRAGMENT_SRC = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2 uVelocity;  // px
uniform int uKernel;
uniform float uOffset;
uniform vec2 uTexSize;   // px

const int MAX_KERNEL = 64;

void main(void) {
  vec4 c = texture(uTex, vUv);
  if (uKernel == 0) { outColor = c; return; }

  vec2 vel = uVelocity / uTexSize;
  float off = -uOffset / length(uVelocity) - 0.5;
  int k = uKernel - 1;

  for (int i = 0; i < MAX_KERNEL - 1; i++) {
    if (i == k) break;
    vec2 bias = vel * (float(i) / float(k) + off);
    c += texture(uTex, vUv + bias);
  }
  outColor = c / float(uKernel);
}
`

/** Lazily-grown scratch 2D canvas: the sprite drawn onto a transparent margin. */
function ensureSize(canvas: HTMLCanvasElement, w: number, h: number): void {
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`sprite-motion-blur shader compile: ${log}`)
  }
  return sh
}

function tryCreateGpu(): SpriteMotionBlurRenderer | null {
  let glCanvas: HTMLCanvasElement
  let gl: WebGL2RenderingContext | null
  try {
    glCanvas = document.createElement("canvas")
    gl = glCanvas.getContext("webgl2", {
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    })
  } catch {
    return null
  }
  if (!gl) return null

  let program: WebGLProgram
  try {
    program = gl.createProgram()!
    const v = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC)
    const f = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC)
    gl.attachShader(program, v)
    gl.attachShader(program, f)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "link failed")
    }
    gl.deleteShader(v)
    gl.deleteShader(f)
  } catch {
    return null
  }

  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  // prettier-ignore
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
  const aPosition = gl.getAttribLocation(program, "aPosition")
  gl.enableVertexAttribArray(aPosition)
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0)

  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)

  const uVelocity = gl.getUniformLocation(program, "uVelocity")
  const uKernel = gl.getUniformLocation(program, "uKernel")
  const uOffset = gl.getUniformLocation(program, "uOffset")
  const uTexSize = gl.getUniformLocation(program, "uTexSize")
  const uTex = gl.getUniformLocation(program, "uTex")

  // Scratch 2D canvas: the sprite blitted onto its transparent margin, uploaded
  // to the texture each frame (cheap for a small cursor).
  const scratch = document.createElement("canvas")
  const scratchCtx = scratch.getContext("2d")!

  let destroyed = false

  function render(
    source: CanvasImageSource,
    renderW: number,
    renderH: number,
    options: MotionBlurOptions,
  ): SpriteMotionBlurResult {
    const g = gl as WebGL2RenderingContext
    const padding = motionBlurPadding(options)
    const ew = Math.max(1, Math.round(renderW + 2 * padding))
    const eh = Math.max(1, Math.round(renderH + 2 * padding))

    ensureSize(scratch, ew, eh)
    scratchCtx.clearRect(0, 0, ew, eh)
    scratchCtx.drawImage(source, padding, padding, renderW, renderH)

    ensureSize(glCanvas, ew, eh)
    g.viewport(0, 0, ew, eh)
    g.useProgram(program)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, texture)
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, scratch)
    g.uniform1i(uTex, 0)
    g.uniform2f(uVelocity, options.velocityX, options.velocityY)
    g.uniform1i(uKernel, kernelFor(options))
    g.uniform1f(uOffset, options.offset)
    g.uniform2f(uTexSize, ew, eh)
    g.drawArrays(g.TRIANGLES, 0, 6)

    return { canvas: glCanvas, padding }
  }

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    const g = gl as WebGL2RenderingContext
    g.deleteBuffer(buffer)
    g.deleteTexture(texture)
    g.deleteProgram(program)
    g.getExtension("WEBGL_lose_context")?.loseContext()
  }

  return { backend: "gpu", render, destroy }
}

function createCpu(): SpriteMotionBlurRenderer {
  const scratch = document.createElement("canvas")
  const scratchCtx = scratch.getContext("2d")!
  const out = document.createElement("canvas")
  const outCtx = out.getContext("2d")!

  function render(
    source: CanvasImageSource,
    renderW: number,
    renderH: number,
    options: MotionBlurOptions,
  ): SpriteMotionBlurResult {
    const padding = motionBlurPadding(options)
    const ew = Math.max(1, Math.round(renderW + 2 * padding))
    const eh = Math.max(1, Math.round(renderH + 2 * padding))

    ensureSize(scratch, ew, eh)
    scratchCtx.clearRect(0, 0, ew, eh)
    scratchCtx.drawImage(source, padding, padding, renderW, renderH)

    const blurred = applyMotionBlur(scratchCtx.getImageData(0, 0, ew, eh), options)
    ensureSize(out, ew, eh)
    outCtx.putImageData(blurred, 0, 0)
    return { canvas: out, padding }
  }

  return { backend: "cpu", render, destroy: () => {} }
}

/** Match the kernel handling Konva's CPU filter uses (zero velocity ⇒ passthrough). */
function kernelFor(options: MotionBlurOptions): number {
  if (options.velocityX === 0 && options.velocityY === 0) return 0
  return Math.trunc(options.kernelSize)
}

/**
 * Create a sprite motion-blur renderer, preferring the GPU and transparently
 * falling back to CPU when WebGL2 is unavailable (or context creation fails).
 */
export function createSpriteMotionBlurRenderer(): SpriteMotionBlurRenderer {
  return tryCreateGpu() ?? createCpu()
}
