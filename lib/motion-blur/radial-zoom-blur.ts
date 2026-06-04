export interface RadialZoomBlurOptions {
  /** Center of the zoom blur in output/canvas pixels. */
  centerX: number
  centerY: number
  /** 0..1 user-facing blur amount after motion weighting. */
  amount: number
  /** Extra multiplier for Pixi-style zoom-blur strength after amount is applied. */
  strength?: number
  /** Legacy setting from the old symmetric shader; ignored by the Pixi-style path. */
  falloff?: number
  /** Normalized Pixi-style inner radius that remains sharp around the focus point. */
  innerRadius?: number
  /** Legacy alias for innerRadius from older Zoom panel settings. */
  centerSize?: number
  /** Normalized Pixi-style outer radius; negative values mean infinite radius. */
  radius?: number
  /** Legacy setting from the old symmetric shader; ignored by the Pixi-style path. */
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
uniform float uInnerRadius;
uniform float uRadius;

const int SAMPLE_COUNT = 32;

// Same phase-noise idea as Pixi's ZoomBlurFilter. Jittering the sample offset
// hides visible fixed-kernel bands in smooth gradients and text edges.
float rand(vec2 co, float seed) {
  const float a = 12.9898;
  const float b = 78.233;
  const float c = 43758.5453;
  float dt = dot(co + seed, vec2(a, b));
  float sn = mod(dt, 3.14159);
  return fract(sin(sn) * c + seed);
}

void main(void) {
  vec4 sharp = texture(uTex, vUv);
  float minGradient = uInnerRadius * 0.3;
  float innerRadius = (uInnerRadius + minGradient * 0.5) / uTexSize.x;
  float gradient = uRadius * 0.3;
  float outerRadius = (uRadius - gradient * 0.5) / uTexSize.x;

  float countLimit = float(SAMPLE_COUNT);
  vec2 dir = uCenter - vUv;
  float dist = length(vec2(dir.x, dir.y * uTexSize.y / uTexSize.x));
  float strength = uStrength;

  float delta = 0.0;
  float gap = 0.0;
  if (dist < innerRadius) {
    delta = innerRadius - dist;
    gap = minGradient;
  } else if (uRadius >= 0.0 && dist > outerRadius) {
    delta = dist - outerRadius;
    gap = gradient;
  }

  if (delta > 0.0 && gap > 0.0) {
    float normalCount = gap / uTexSize.x;
    delta = (normalCount - delta) / normalCount;
    countLimit *= delta;
    strength *= delta;
    if (countLimit < 1.0) {
      outColor = sharp;
      return;
    }
  }

  float offset = rand(vUv, 0.0);
  float total = 0.0;
  vec4 color = vec4(0.0);
  dir *= strength;
  for (int i = 0; i < SAMPLE_COUNT; i++) {
    float t = float(i);
    float percent = (t + offset) / float(SAMPLE_COUNT);
    float weight = 4.0 * (percent - percent * percent);
    vec2 uv = vUv + dir * percent;
    color += texture(uTex, uv) * weight;
    total += weight;
    if (t > countLimit) break;
  }

  outColor = total > 0.0 ? color / total : sharp;
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
  const uInnerRadius = gl.getUniformLocation(program, "uInnerRadius")
  const uRadius = gl.getUniformLocation(program, "uRadius")
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
    const innerRadius = Math.min(
      0.5,
      Math.max(0, options.innerRadius ?? options.centerSize ?? 0.02)
    )
    const normalizedRadius =
      typeof options.radius === "number" && Number.isFinite(options.radius)
        ? options.radius
        : -1
    g.uniform2f(uTexSize, canvas.width, canvas.height)
    // Pixi's ZoomBlurFilter treats strength as the fraction of the vector from
    // the current pixel to the center. Feed our velocity-weighted amount into
    // that same unit, with a conservative cap for text-heavy screen recordings.
    g.uniform1f(uStrength, Math.min(0.22, amount * strength))
    // Match Pixi's radius contract: uniforms are pixels and the shader
    // normalizes them by input width. Our setting stores a normalized fraction.
    g.uniform1f(uInnerRadius, innerRadius * canvas.width)
    g.uniform1f(
      uRadius,
      normalizedRadius < 0 ? -1 : Math.max(0, normalizedRadius) * canvas.width
    )
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
