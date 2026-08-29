/**
 * Anime / Studio Ghibli Style — Cel-shading + Saturation boost
 * Transforms the world into an animated film look
 */
export const animeShader = {
  name: 'anime',
  uniforms: {
    saturation: { default: 1.0, min: 0, max: 2, label: 'Saturation' },
    edgeThick: { default: 0.5, min: 0, max: 1, label: 'Edge Thickness' },
  },
  fragmentShader: /* glsl */ `
    uniform sampler2D colorTexture;
    uniform vec2 colorTextureDimensions;
    uniform float intensity;
    uniform float saturation;
    uniform float edgeThick;
    in vec2 v_textureCoordinates;

    vec3 rgb2hsv(vec3 c) {
      vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
      vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
      vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
      float d = q.x - min(q.w, q.y);
      float e = 1.0e-10;
      return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
    }

    vec3 hsv2rgb(vec3 c) {
      vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    void main() {
      vec2 uv = v_textureCoordinates;
      vec2 texel = 1.0 / colorTextureDimensions;
      vec4 color = texture(colorTexture, uv);

      // Cel-shade: quantize luminance into bands
      float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      float bands = mix(256.0, 4.0, intensity);
      float celLuma = floor(luma * bands + 0.5) / bands;
      float lumaScale = (luma > 0.001) ? celLuma / luma : 1.0;
      vec3 celColor = color.rgb * lumaScale;

      // Boost saturation for vibrant anime look (driven by saturation uniform)
      vec3 hsv = rgb2hsv(celColor);
      hsv.y = min(hsv.y * (1.0 + 0.6 * intensity * saturation), 1.0);
      hsv.z = min(hsv.z * (1.0 + 0.1 * intensity), 1.0);
      vec3 saturated = hsv2rgb(hsv);

      // Soft edge detection for outlines
      vec4 left  = texture(colorTexture, uv + vec2(-texel.x, 0.0));
      vec4 right = texture(colorTexture, uv + vec2( texel.x, 0.0));
      vec4 up    = texture(colorTexture, uv + vec2(0.0,  texel.y));
      vec4 down  = texture(colorTexture, uv + vec2(0.0, -texel.y));

      float edgeH = length(right.rgb - left.rgb);
      float edgeV = length(up.rgb - down.rgb);
      float edge = sqrt(edgeH * edgeH + edgeV * edgeV);
      float outline = 1.0 - smoothstep(0.05, mix(0.35, 0.1, edgeThick), edge) * 0.6 * intensity;

      // Warm color shift (Ghibli palette tends warm)
      vec3 warmShift = saturated * vec3(1.02, 1.0, 0.95);

      vec3 result = warmShift * outline;
      out_FragColor = vec4(mix(color.rgb, result, intensity), color.a);
    }
  `,
};
