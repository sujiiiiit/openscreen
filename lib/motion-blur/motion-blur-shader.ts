/**
 * GLSL (WebGL2 / GLSL ES 3.00) source for the motion-blur fragment shader.
 *
 * This is a verbatim port of PixiJS's `MotionBlurFilter` fragment shader
 * (`pixi-filters/src/motion-blur/motion-blur.frag`). The only deviation is
 * that Pixi's global `uInputSize.xy` (the filter framebuffer size, which
 * includes Pixi's auto-padding) is replaced by a plain `uTexSize` uniform we
 * set to the source image's pixel dimensions — we render a single image to a
 * canvas of the same size, so there is no padding to account for.
 *
 * Keeping the math byte-for-byte identical to Pixi is the whole point: the
 * filter does a *directional* blur, sampling `uKernelSize` taps along the
 * velocity vector and averaging them. That is fundamentally different from an
 * isotropic Gaussian blur, which is why a Konva `Blur` + trailing hack can
 * never reproduce the look.
 */

/** Full-screen quad vertex shader. Maps clip-space position to [0,1] UV. */
export const MOTION_BLUR_VERTEX = /* glsl */ `#version 300 es
in vec2 aPosition;
out vec2 vTextureCoord;

void main(void) {
    // aPosition covers [-1, 1]; UV is the same range mapped to [0, 1].
    vTextureCoord = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

/** Directional motion-blur fragment shader (ported from Pixi's motion-blur.frag). */
export const MOTION_BLUR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec2 uVelocity;     // motion in pixels
uniform int uKernelSize;    // odd, >= 5; 0 => passthrough
uniform float uOffset;      // shifts the sampling window
uniform vec2 uTexSize;      // source size in px (stands in for Pixi's uInputSize.xy)

const int MAX_KERNEL_SIZE = 2048;

void main(void) {
    vec4 color = texture(uTexture, vTextureCoord);

    if (uKernelSize == 0) {
        finalColor = color;
        return;
    }

    vec2 velocity = uVelocity / uTexSize;
    float offset = -uOffset / length(uVelocity) - 0.5;
    int k = uKernelSize - 1;

    for (int i = 0; i < MAX_KERNEL_SIZE - 1; i++) {
        if (i == k) {
            break;
        }
        vec2 bias = velocity * (float(i) / float(k) + offset);
        color += texture(uTexture, vTextureCoord + bias);
    }

    finalColor = color / float(uKernelSize);
}
`
