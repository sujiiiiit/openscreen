import { MOTION_BLUR_FRAGMENT, MOTION_BLUR_VERTEX } from "./motion-blur-shader"
import { effectiveKernelSize, type MotionBlurOptions } from "./types"

/**
 * Offscreen WebGL2 runner that applies the directional motion-blur shader to a
 * source image and returns the rendered canvas.
 *
 * This runs the *exact same GLSL* as PixiJS (see `motion-blur-shader.ts`), with
 * `LINEAR` filtering + `CLAMP_TO_EDGE` wrapping to match Pixi's default sampler.
 * The output is therefore pixel-identical to Pixi's `MotionBlurFilter`, while
 * being composited through Konva (the returned canvas is fed to a `Konva.Image`).
 *
 * Note: the source image should be opaque. Like Pixi, sampling happens in the
 * texture's stored (premultiplied) space; for fully-opaque pixels this is a
 * no-op, so an opaque test image keeps the comparison clean.
 */
export interface MotionBlurRenderer {
  /** Render `source` with the given options into the internal canvas; returns it. */
  render(source: TexImageSource, width: number, height: number, options: MotionBlurOptions): HTMLCanvasElement
  readonly canvas: HTMLCanvasElement
  destroy(): void
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error("Failed to create shader")
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Motion-blur shader compile error: ${log}`)
  }
  return shader
}

export function createMotionBlurRenderer(): MotionBlurRenderer {
  const canvas = document.createElement("canvas")
  // Premultiplied alpha, matching Pixi's filter pipeline
  // (`FilterSystem` tags the output `premultiplied-alpha`). This is what lets the
  // smear feather cleanly into the transparent margin around the sprite instead
  // of dragging edge colours toward black.
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false })
  if (!gl) throw new Error("WebGL2 is not available")

  const program = gl.createProgram()
  if (!program) throw new Error("Failed to create program")
  const vert = compileShader(gl, gl.VERTEX_SHADER, MOTION_BLUR_VERTEX)
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, MOTION_BLUR_FRAGMENT)
  gl.attachShader(program, vert)
  gl.attachShader(program, frag)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Motion-blur program link error: ${gl.getProgramInfoLog(program)}`)
  }
  gl.deleteShader(vert)
  gl.deleteShader(frag)

  // Full-screen quad (two triangles).
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  // prettier-ignore
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1,
  ]), gl.STATIC_DRAW)

  const aPosition = gl.getAttribLocation(program, "aPosition")
  gl.enableVertexAttribArray(aPosition)
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0)

  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  // Match Pixi's default sampler: bilinear + clamp-to-edge.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  // Flip Y on upload so the rendered canvas comes out upright when drawn into Konva.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
  // Premultiply on upload so sampling/averaging happens in premultiplied space.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)

  const uVelocity = gl.getUniformLocation(program, "uVelocity")
  const uKernelSize = gl.getUniformLocation(program, "uKernelSize")
  const uOffset = gl.getUniformLocation(program, "uOffset")
  const uTexSize = gl.getUniformLocation(program, "uTexSize")
  const uTexture = gl.getUniformLocation(program, "uTexture")

  let destroyed = false

  function render(
    source: TexImageSource,
    width: number,
    height: number,
    options: MotionBlurOptions,
  ): HTMLCanvasElement {
    if (destroyed) throw new Error("Renderer has been destroyed")
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }

    gl!.viewport(0, 0, width, height)
    gl!.useProgram(program)

    gl!.activeTexture(gl!.TEXTURE0)
    gl!.bindTexture(gl!.TEXTURE_2D, texture)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, source)

    gl!.uniform1i(uTexture, 0)
    gl!.uniform2f(uVelocity, options.velocityX, options.velocityY)
    gl!.uniform1i(uKernelSize, effectiveKernelSize(options))
    gl!.uniform1f(uOffset, options.offset)
    gl!.uniform2f(uTexSize, width, height)

    gl!.drawArrays(gl!.TRIANGLES, 0, 6)
    return canvas
  }

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    gl!.deleteBuffer(buffer)
    gl!.deleteTexture(texture)
    gl!.deleteProgram(program)
    const lose = gl!.getExtension("WEBGL_lose_context")
    lose?.loseContext()
  }

  return { render, destroy, canvas }
}
