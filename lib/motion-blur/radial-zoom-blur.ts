export interface RadialZoomBlurOptions {
  /** Center of the zoom blur in output/canvas pixels. */
  centerX: number
  centerY: number
  /** 0..1 user-facing blur amount after motion weighting. */
  amount: number
  /** Extra multiplier for blur reach after amount is applied. */
  strength?: number
  /** Normalized radius where blur reaches full strength. */
  falloff?: number
  /** Normalized radius of the preserved focus area. */
  centerSize?: number
  /** How much sharp detail is mixed back into the focus area. */
  centerSharpness?: number
}

export interface RadialZoomBlurRenderer {
  render(
    source: CanvasImageSource,
    width: number,
    height: number,
    options: RadialZoomBlurOptions
  ): HTMLCanvasElement
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

const FRAGMENT_SRC = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2 uCenter;
uniform vec2 uTexSize;
uniform float uStrength;
uniform float uAmount;
uniform float uFalloff;
uniform float uCenterSize;
uniform float uCenterSharpness;

const int SAMPLE_COUNT = 31;

void main(void) {
  vec2 dir = vUv - uCenter;
  float radius = length(dir * uTexSize) / max(uTexSize.x, uTexSize.y);
  float radiusFalloff = smoothstep(0.015, uFalloff, radius);
  float shutter = uStrength * radiusFalloff;
  vec4 color = vec4(0.0);
  float total = 0.0;

  for (int i = 0; i < SAMPLE_COUNT; i++) {
    float t = float(i) / float(SAMPLE_COUNT - 1);
    float signedT = t * 2.0 - 1.0;
    float gaussian = exp(-signedT * signedT * 5.25);
    float centerWeight = 1.0 - abs(signedT);
    float weight = gaussian * (0.35 + centerWeight * 0.65);
    float shutterT = sign(signedT) * pow(abs(signedT), 1.25);
    vec2 uv = uCenter + dir * (1.0 + shutterT * shutter);
    uv = clamp(uv, vec2(0.001), vec2(0.999));
    color += texture(uTex, uv) * weight;
    total += weight;
  }

  vec4 blurred = color / max(total, 0.0001);
  vec4 sharp = texture(uTex, vUv);
  float centerPreserve = (1.0 - smoothstep(0.0, max(0.001, uCenterSize), radius)) * uCenterSharpness;
  float subtlePreserve = (1.0 - uAmount) * 0.12;
  outColor = mix(blurred, sharp, clamp(centerPreserve + subtlePreserve, 0.0, 0.78));
}
`

function ensureSize(canvas: HTMLCanvasElement, width: number, height: number) {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
}

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string
): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`radial-zoom-blur shader compile: ${log}`)
  }
  return shader
}

export function createRadialZoomBlurRenderer(): RadialZoomBlurRenderer | null {
  let canvas: HTMLCanvasElement
  let gl: WebGL2RenderingContext | null
  try {
    canvas = document.createElement("canvas")
    gl = canvas.getContext("webgl2", {
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
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC)
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC)
    program = gl.createProgram()!
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "link failed")
    }
  } catch {
    return null
  }

  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  )
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

  const uTex = gl.getUniformLocation(program, "uTex")
  const uCenter = gl.getUniformLocation(program, "uCenter")
  const uTexSize = gl.getUniformLocation(program, "uTexSize")
  const uStrength = gl.getUniformLocation(program, "uStrength")
  const uAmount = gl.getUniformLocation(program, "uAmount")
  const uFalloff = gl.getUniformLocation(program, "uFalloff")
  const uCenterSize = gl.getUniformLocation(program, "uCenterSize")
  const uCenterSharpness = gl.getUniformLocation(program, "uCenterSharpness")
  let destroyed = false

  function render(
    source: CanvasImageSource,
    width: number,
    height: number,
    options: RadialZoomBlurOptions
  ): HTMLCanvasElement {
    const g = gl as WebGL2RenderingContext
    ensureSize(canvas, width, height)
    g.viewport(0, 0, canvas.width, canvas.height)
    g.useProgram(program)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, texture)
    g.texImage2D(
      g.TEXTURE_2D,
      0,
      g.RGBA,
      g.RGBA,
      g.UNSIGNED_BYTE,
      source as TexImageSource
    )
    g.uniform1i(uTex, 0)
    g.uniform2f(
      uCenter,
      options.centerX / Math.max(1, canvas.width),
      1 - options.centerY / Math.max(1, canvas.height)
    )
    const amount = Math.min(1, Math.max(0, options.amount))
    const strength = Math.min(2, Math.max(0, options.strength ?? 1))
    const falloff = Math.min(1, Math.max(0.05, options.falloff ?? 0.65))
    const centerSize = Math.min(0.5, Math.max(0.02, options.centerSize ?? 0.26))
    const centerSharpness = Math.min(
      1,
      Math.max(0, options.centerSharpness ?? 0.75)
    )
    g.uniform2f(uTexSize, canvas.width, canvas.height)
    g.uniform1f(uStrength, Math.min(0.2, amount * strength * 0.12))
    g.uniform1f(uAmount, amount)
    g.uniform1f(uFalloff, falloff)
    g.uniform1f(uCenterSize, centerSize)
    g.uniform1f(uCenterSharpness, centerSharpness)
    g.drawArrays(g.TRIANGLES, 0, 6)
    return canvas
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    const g = gl as WebGL2RenderingContext
    g.deleteBuffer(buffer)
    g.deleteTexture(texture)
    g.deleteProgram(program)
    g.getExtension("WEBGL_lose_context")?.loseContext()
  }

  return { render, destroy }
}
