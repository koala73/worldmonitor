/**
 * CRT Terminal — Dynamic CRT Monitor Aesthetic
 * Pixelation + Bayer dithering + barrel distortion + scanlines +
 * chromatic aberration + vignette + phosphor persistence/ghosting +
 * horizontal jitter + flicker + glitch lines + RGB shadow mask subpixels
 *
 * Exposed uniforms:
 *   pixelation (1-10)  — pixel grid size
 *   distortion (0-1)   — CRT barrel/lens bulge strength
 *   instability (0-1)  — jitter, flicker, glitch frequency
 */
export const retroShader = {
  name: 'retro',
  uniforms: {
    pixelation: { default: 5.0, min: 1, max: 10, label: 'Pixelation' },
    distortion: { default: 0, min: 0, max: 1, label: 'Distortion' },
    instability: { default: 0.4, min: 0, max: 1, label: 'Instability' },
  },
  fragmentShader: /* glsl */ `
    uniform sampler2D colorTexture;
    uniform vec2 colorTextureDimensions;
    uniform float intensity;
    uniform float pixelation;
    uniform float distortion;
    uniform float instability;
    uniform float time;
    in vec2 v_textureCoordinates;

    // ── Hash for noise/randomness ─────────────────────────
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // 8x8 Bayer dithering matrix (normalized 0-1)
    float bayer8(vec2 pos) {
      ivec2 p = ivec2(mod(pos, 8.0));
      int index = p.x + p.y * 8;
      int bayer[64] = int[64](
         0, 32,  8, 40,  2, 34, 10, 42,
        48, 16, 56, 24, 50, 18, 58, 26,
        12, 44,  4, 36, 14, 46,  6, 38,
        60, 28, 52, 20, 62, 30, 54, 22,
         3, 35, 11, 43,  1, 33,  9, 41,
        51, 19, 59, 27, 49, 17, 57, 25,
        15, 47,  7, 39, 13, 45,  5, 37,
        63, 31, 55, 23, 61, 29, 53, 21
      );
      return float(bayer[index]) / 64.0;
    }

    // CRT barrel distortion
    vec2 barrelDistort(vec2 uv, float strength) {
      vec2 centered = uv * 2.0 - 1.0;
      float r2 = dot(centered, centered);
      float distort = 1.0 + r2 * strength * 0.4;
      centered *= distort;
      return centered * 0.5 + 0.5;
    }

    void main() {
      vec2 uv = v_textureCoordinates;
      vec2 dims = colorTextureDimensions;
      vec2 texel = 1.0 / dims;

      // ── Barrel distortion (CRT monitor bulge) ───────────
      float dist = distortion * intensity;
      vec2 distUV = barrelDistort(uv, dist);

      // Black outside the distorted area
      if (distUV.x < 0.0 || distUV.x > 1.0 || distUV.y < 0.0 || distUV.y > 1.0) {
        out_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      // ── Horizontal jitter (random scanline displacement) ──
      float lineY = floor(distUV.y * dims.y);
      float jitterSeed = hash(vec2(lineY, floor(time * 8.0)));
      // Only jitter a few lines at a time (sparse)
      float jitterActive = step(0.97 - instability * 0.04, jitterSeed);
      float jitterAmount = (hash(vec2(lineY * 7.0, floor(time * 12.0))) - 0.5) *
                           0.008 * instability * jitterActive * intensity;
      vec2 jitteredUV = distUV + vec2(jitterAmount, 0.0);

      // ── Chromatic aberration — slight RGB channel offset ──
      vec2 centered = jitteredUV - 0.5;
      float caStrength = length(centered) * 0.008 * intensity;
      float r = texture(colorTexture, jitteredUV + centered * caStrength).r;
      float g = texture(colorTexture, jitteredUV).g;
      float b = texture(colorTexture, jitteredUV - centered * caStrength).b;
      vec4 color = vec4(r, g, b, 1.0);

      // ── Pixelation: snap UV to grid ─────────────────────
      float pixSize = mix(1.0, pixelation, intensity);
      vec2 pixelUV = floor(jitteredUV * dims / pixSize) * pixSize / dims;
      vec4 pixelColor = texture(colorTexture, mix(jitteredUV, pixelUV, intensity));

      // Blend chromatic aberration with pixelated sample
      color = mix(color, pixelColor, 0.7 * intensity);

      // ── Bayer dithering before posterization ────────────
      vec2 ditherCoord = jitteredUV * dims / pixSize;
      float dither = bayer8(ditherCoord) - 0.5;
      float ditherAmount = 0.12 * intensity;
      vec3 dithered = color.rgb + dither * ditherAmount;

      // ── Posterize: reduce color levels ──────────────────
      float levels = mix(256.0, 10.0, intensity);
      vec3 posterized = floor(dithered * levels + 0.5) / levels;

      // ── Slight saturation boost ─────────────────────────
      float gray = dot(posterized, vec3(0.299, 0.587, 0.114));
      vec3 saturated = mix(vec3(gray), posterized, 1.0 + 0.3 * intensity);

      // ── RGB shadow mask subpixel pattern ────────────────
      // Each pixel shows faint R/G/B vertical stripes
      float subpixelX = mod(distUV.x * dims.x, 3.0);
      vec3 subpixelMask = vec3(
        smoothstep(0.0, 0.8, 1.0 - abs(subpixelX - 0.5)),   // R stripe
        smoothstep(0.0, 0.8, 1.0 - abs(subpixelX - 1.5)),   // G stripe
        smoothstep(0.0, 0.8, 1.0 - abs(subpixelX - 2.5))    // B stripe
      );
      // Only apply at higher pixelation (visible "pixels")
      float subpixelStrength = smoothstep(2.0, 6.0, pixSize) * 0.3 * intensity;
      vec3 withSubpixels = mix(saturated, saturated * (subpixelMask * 0.7 + 0.3), subpixelStrength);

      // ── Block edge darkening ────────────────────────────
      vec2 pixelCenter = fract(distUV * dims / pixSize);
      float blockEdge = smoothstep(0.0, 0.08, min(min(pixelCenter.x, 1.0 - pixelCenter.x),
                                                    min(pixelCenter.y, 1.0 - pixelCenter.y)));
      float edgeFactor = mix(1.0, blockEdge * 0.15 + 0.85, intensity);

      vec3 result = withSubpixels * edgeFactor;

      // ── Horizontal scanlines — rolling CRT refresh ──────
      float scanY = distUV.y * dims.y;
      float scanline = sin(scanY * 1.0 + time * 2.5) * 0.5 + 0.5;
      scanline = pow(scanline, 1.5);
      float scanFade = 0.35 * intensity;
      result *= mix(1.0, scanline * scanFade + (1.0 - scanFade), intensity);

      // ── Phosphor persistence / ghosting ─────────────────
      // Approximate by blurring in a direction (simulates previous frame lingering)
      vec3 ghost = texture(colorTexture, jitteredUV - vec2(texel.x * 2.0, 0.0)).rgb;
      float ghostGray = dot(ghost, vec3(0.299, 0.587, 0.114));
      // Blend a dim ghost of the offset sample
      result = mix(result, result + vec3(ghostGray) * 0.08, instability * intensity);

      // ── Flicker (overall brightness fluctuation ~50-60Hz) ──
      float flicker = sin(time * 188.5) * 0.5 + 0.5; // ~60Hz equivalent
      flicker = 1.0 - flicker * 0.03 * instability * intensity; // very subtle
      result *= flicker;

      // ── Glitch lines (rare horizontal bright bars) ──────
      float glitchSeed = hash(vec2(floor(time * 2.0), 0.0));
      float glitchLine = step(0.92 - instability * 0.08, glitchSeed);
      if (glitchLine > 0.0) {
        float glitchY = hash(vec2(floor(time * 2.0), 1.0));
        float glitchHit = smoothstep(0.0, 0.003, abs(distUV.y - glitchY));
        glitchHit = 1.0 - glitchHit;
        result += glitchHit * 0.3 * instability * intensity;
      }

      // ── Warm phosphor tint (P1 green-amber) ─────────────
      vec3 warmTint = result * vec3(1.02, 1.0, 0.94);
      result = mix(result, warmTint, 0.4 * intensity);

      // ── Edge vignette (darker corners — CRT curvature) ──
      vec2 vigUV = distUV * (1.0 - distUV);
      float vig = vigUV.x * vigUV.y * 20.0;
      vig = clamp(pow(vig, 0.25 + 0.15 * intensity), 0.0, 1.0);
      result *= mix(1.0, vig, 0.6 * intensity);

      out_FragColor = vec4(mix(texture(colorTexture, uv).rgb, result, intensity), 1.0);
    }
  `,
};
