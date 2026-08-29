/**
 * Night Vision / NVG — PVS-14 Image Intensifier Emulation
 * P43 phosphor green, intensifier tube bloom, circular vignette,
 * scintillation noise, honeycomb pattern, auto-gain, HUD overlay.
 *
 * Exposed uniforms:
 *   gain (0-1)        — intensifier gain (bloom + noise balance)
 *   bloom (0-1)       — bloom/halo intensity around bright sources
 *   scanlineStr (0-1) — scanline intensity (kept for compatibility)
 *   pixelation (1-6)  — intensifier tube resolution pixelation
 */
export const nightVisionShader = {
  name: 'surveillance',
  uniforms: {
    gain: { default: 0.55, min: 0, max: 1, label: 'Gain' },
    bloom: { default: 0.30, min: 0, max: 1, label: 'Bloom' },
    scanlineStr: { default: 1.0, min: 0, max: 1, label: 'Scanlines' },
    pixelation: { default: 2.5, min: 1, max: 6, label: 'Pixelation' },
  },
  fragmentShader: /* glsl */ `
    uniform sampler2D colorTexture;
    uniform vec2 colorTextureDimensions;
    uniform float intensity;
    uniform float time;
    uniform float gain;
    uniform float bloom;
    uniform float scanlineStr;
    uniform float pixelation;
    in vec2 v_textureCoordinates;

    // ── Noise functions ───────────────────────────────────
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    // ── Barrel distortion (NVG lens) ──────────────────────
    vec2 barrelDistort(vec2 uv, float strength) {
      vec2 c = uv * 2.0 - 1.0;
      float r2 = dot(c, c);
      float distort = 1.0 + r2 * strength * 0.5 + r2 * r2 * strength * 0.15;
      c *= distort;
      return c * 0.5 + 0.5;
    }

    // ── Honeycomb pattern (fiber optic plate texture) ─────
    float honeycomb(vec2 uv) {
      vec2 dims = colorTextureDimensions;
      float scale = min(dims.x, dims.y) * 0.008;
      vec2 p = uv * dims * scale;
      // Hex grid
      vec2 r = vec2(1.0, 1.732);
      vec2 h = r * 0.5;
      vec2 a = mod(p, r) - h;
      vec2 b = mod(p - h, r) - h;
      vec2 gv = dot(a, a) < dot(b, b) ? a : b;
      float d = max(abs(gv.x), abs(gv.y * 0.577 + abs(gv.x) * 0.5));
      return smoothstep(0.4, 0.45, d);
    }

    // ── 7-segment digit renderer ──────────────────────────
    float segment(vec2 p, int seg) {
      float s = 0.0;
      if (seg == 0) s = step(0.2, p.x) * step(p.x, 0.8) * step(0.85, p.y) * step(p.y, 1.0);
      if (seg == 1) s = step(0.7, p.x) * step(p.x, 0.9) * step(0.5, p.y) * step(p.y, 0.95);
      if (seg == 2) s = step(0.7, p.x) * step(p.x, 0.9) * step(0.05, p.y) * step(p.y, 0.5);
      if (seg == 3) s = step(0.2, p.x) * step(p.x, 0.8) * step(0.0, p.y) * step(p.y, 0.15);
      if (seg == 4) s = step(0.1, p.x) * step(p.x, 0.3) * step(0.05, p.y) * step(p.y, 0.5);
      if (seg == 5) s = step(0.1, p.x) * step(p.x, 0.3) * step(0.5, p.y) * step(p.y, 0.95);
      if (seg == 6) s = step(0.2, p.x) * step(p.x, 0.8) * step(0.42, p.y) * step(p.y, 0.58);
      return s;
    }

    float digit(vec2 p, int d) {
      int masks[10] = int[10](0x7E, 0x30, 0x6D, 0x79, 0x33, 0x5B, 0x5F, 0x70, 0x7F, 0x7B);
      int m = masks[d];
      float s = 0.0;
      for (int i = 0; i < 7; i++) {
        if ((m >> (6 - i) & 1) == 1) s += segment(p, i);
      }
      return clamp(s, 0.0, 1.0);
    }

    // Render HH:MM:SS timestamp
    float renderTimestamp(vec2 uv) {
      vec2 tsOrigin = vec2(0.02, 0.03);
      vec2 tsSize = vec2(0.22, 0.035);
      vec2 p = (uv - tsOrigin) / tsSize;
      if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 0.0;

      int totalSec = int(mod(time, 86400.0));
      int hours = totalSec / 3600;
      int minutes = (totalSec % 3600) / 60;
      int seconds = totalSec % 60;

      float charWidth = 1.0 / 8.5;
      int charIdx = int(p.x / charWidth);
      float localX = mod(p.x, charWidth) / charWidth;
      vec2 localP = vec2(localX, p.y);

      int dv = -1;
      if (charIdx == 0) dv = hours / 10;
      else if (charIdx == 1) dv = hours % 10;
      else if (charIdx == 2) return (step(0.3, localP.x) * step(localP.x, 0.7)) *
                                    (step(0.2, localP.y) * step(localP.y, 0.4) + step(0.6, localP.y) * step(localP.y, 0.8));
      else if (charIdx == 3) dv = minutes / 10;
      else if (charIdx == 4) dv = minutes % 10;
      else if (charIdx == 5) return (step(0.3, localP.x) * step(localP.x, 0.7)) *
                                    (step(0.2, localP.y) * step(localP.y, 0.4) + step(0.6, localP.y) * step(localP.y, 0.8));
      else if (charIdx == 6) dv = seconds / 10;
      else if (charIdx == 7) dv = seconds % 10;

      if (dv < 0 || dv > 9) return 0.0;
      return digit(localP, dv);
    }

    // ── Crosshair (thin, subtle NVG reticle) ──────────────
    float crosshair(vec2 uv) {
      vec2 c = uv - 0.5;
      float h = smoothstep(0.001, 0.0004, abs(c.y)) *
                step(0.01, abs(c.x)) * step(abs(c.x), 0.025);
      float v = smoothstep(0.001, 0.0004, abs(c.x)) *
                step(0.01, abs(c.y)) * step(abs(c.y), 0.025);
      return clamp(h + v, 0.0, 1.0);
    }

    void main() {
      vec2 uv = v_textureCoordinates;
      vec2 dims = colorTextureDimensions;
      vec2 texel = 1.0 / dims;

      // ── Barrel distortion (NVG lens distortion) ─────────
      float dist = 0.5 * intensity;
      vec2 distUV = barrelDistort(uv, dist);

      // ── Circular vignette mask (NVG tube field of view) ──
      vec2 centered = uv * 2.0 - 1.0;
      float aspect = dims.x / dims.y;
      centered.x *= aspect;
      float radius = length(centered);
      float tubeMask = pow(1.0 - smoothstep(0.6, 1.05, radius), 0.7);
      // Tube brightness falloff (center brightest)
      float tubeShading = 1.0 - radius * radius * 0.3;
      tubeShading = max(tubeShading, 0.0);

      // If outside tube, render black
      if (tubeMask < 0.001) {
        out_FragColor = vec4(vec3(0.0), 1.0);
        return;
      }

      // Black outside distorted area
      if (distUV.x < 0.0 || distUV.x > 1.0 || distUV.y < 0.0 || distUV.y > 1.0) {
        out_FragColor = vec4(vec3(0.0), 1.0);
        return;
      }

      // ── Intensifier tube resolution pixelation ────────────
      float pixSize = mix(1.0, pixelation, intensity);
      vec2 snappedUV = floor(distUV * dims / pixSize) * pixSize / dims;
      distUV = mix(distUV, snappedUV, intensity);

      vec4 original = texture(colorTexture, distUV);

      // ── Luminance ───────────────────────────────────────
      float luma = dot(original.rgb, vec3(0.299, 0.587, 0.114));

      // ── Auto-gain response ──────────────────────────────
      // Higher gain = more amplification, more noise, more bloom
      float gainLevel = mix(0.8, 2.5, gain);
      float amplified = clamp(luma * gainLevel, 0.0, 1.0);

      // Slight contrast curve for gain response
      amplified = pow(amplified, mix(1.2, 0.7, gain));

      // ── Intensifier tube bloom (THE key NVG visual) ─────
      // Bloom around bright sources — wider kernel for realistic halos
      float bloomAccum = 0.0;
      float bloomW = 0.0;
      for (int y = -5; y <= 5; y++) {
        for (int x = -5; x <= 5; x++) {
          vec2 offset = vec2(float(x), float(y)) * texel * 4.0;
          float sLuma = dot(texture(colorTexture, distUV + offset).rgb, vec3(0.299, 0.587, 0.114));
          float bright = smoothstep(0.4, 0.9, sLuma * gainLevel);
          float w = exp(-float(x * x + y * y) / 18.0);
          bloomAccum += bright * w;
          bloomW += w;
        }
      }
      bloomAccum /= bloomW;

      // Edge glow / corona on bright objects
      float corona = bloomAccum * bloom * 1.5;

      // ── P43 phosphor green (530nm) ──────────────────────
      vec3 phosphor = vec3(0.16, 1.0, 0.22);
      vec3 nvgColor = phosphor * (amplified + corona);

      // ── Scintillation (image intensifier sparkle noise) ──
      // Base tube grain (slow, coherent)
      vec2 grainCoord = uv * 120.0 + vec2(time * 0.5, time * 0.3);
      float tubeGrain = valueNoise(grainCoord);
      tubeGrain = (tubeGrain - 0.5) * mix(0.06, 0.2, gain) * intensity;
      nvgColor += phosphor * tubeGrain;

      // More noise in dark areas (real gain response)
      float darkNoise = (1.0 - amplified) * hash(uv * dims + vec2(time * 200.0, time * 300.0));
      nvgColor += phosphor * darkNoise * 0.08 * gain * intensity;

      // ── Honeycomb fiber optic plate ─────────────────────
      float hc = honeycomb(distUV);
      nvgColor *= 1.0 - hc * 0.04 * intensity; // very subtle

      // ── Scanlines (subtle, from the display) ────────────
      float scanline = sin(distUV.y * dims.y * 1.2 + time * 2.0) * 0.5 + 0.5;
      scanline = pow(scanline, 2.5);
      nvgColor *= 1.0 - scanline * scanlineStr * 0.15 * intensity;

      // ── Tube shading (brightness falloff from center) ───
      nvgColor *= tubeShading;

      // ── Circular vignette (dark edges, NVG tube shape) ──
      nvgColor *= tubeMask;

      // ── HUD Overlay ─────────────────────────────────────

      // Top-left: "NVG" / "I²" label marker
      vec2 labelArea = (uv - vec2(0.03, 0.92)) / vec2(0.06, 0.03);
      if (labelArea.x >= 0.0 && labelArea.x <= 1.0 && labelArea.y >= 0.0 && labelArea.y <= 1.0) {
        float lbl = step(0.1, labelArea.x) * step(labelArea.x, 0.9) *
                    step(0.2, labelArea.y) * step(labelArea.y, 0.8);
        nvgColor += phosphor * lbl * 0.3 * intensity;
      }

      // Gain indicator below label: "AUTO" marker
      vec2 gainArea = (uv - vec2(0.03, 0.88)) / vec2(0.05, 0.025);
      if (gainArea.x >= 0.0 && gainArea.x <= 1.0 && gainArea.y >= 0.0 && gainArea.y <= 1.0) {
        float gLbl = step(0.1, gainArea.x) * step(gainArea.x, 0.9) *
                     step(0.2, gainArea.y) * step(gainArea.y, 0.8);
        nvgColor += phosphor * gLbl * 0.2 * intensity;
      }

      // Center crosshair (thin, subtle)
      float ch = crosshair(uv);
      nvgColor += phosphor * ch * 0.4 * intensity;

      // Bottom-left: Timestamp (7-segment)
      float ts = renderTimestamp(uv);
      nvgColor += phosphor * ts * 0.6 * intensity;

      // REC indicator — top-right (blinking)
      vec2 recPos = uv - vec2(0.95, 0.94);
      float recDot = smoothstep(0.008, 0.004, length(recPos));
      float blink = step(0.5, fract(time * 0.8));
      // REC dot in slightly warmer green
      nvgColor += vec3(0.3, 1.0, 0.2) * recDot * blink * intensity;

      // ── Final composite ─────────────────────────────────
      nvgColor = clamp(nvgColor, 0.0, 1.0);

      // Keep NVG output fully tube-masked at full intensity to avoid color bleed at the lens edge.
      vec3 finalColor = mix(original.rgb, nvgColor * tubeMask, intensity);

      out_FragColor = vec4(finalColor, 1.0);
    }
  `,
};
