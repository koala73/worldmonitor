// src/data/aircraftIcons.js
/**
 * Nose-up white aircraft silhouettes, one per classifyAircraft() kind, as SVG
 * data URIs for Cesium billboards.
 *
 * FIDELITY NOTE (2026-07-02): redrawn at a 96×96 viewBox (glyph centered at
 * 48,48) instead of the old 32×32. The billboards themselves are still added at
 * width/height 20 (24 tracked) in flights.js / militaryFlights.js, so Cesium
 * DOWN-samples this larger, higher-precision source to the same on-screen
 * footprint — crisp anti-aliased edges instead of an upscaled 32px bitmap. The
 * on-screen size is unchanged and CLASS_SCALE_2D is untouched (no scale
 * compensation needed: the billboard's explicit width/height, not the SVG's,
 * sets the pixel size — the intrinsic SVG size only controls raster fidelity).
 *
 * All glyphs are nose-up (nose toward -Y at rotation 0; the screen-projected
 * rotation pipeline in iconOrientation.js spins the whole glyph). Fill is white
 * with a subtle dark hairline stroke so the tint pipeline (billboard.color =
 * white / cyan-tracked / amber-military, plus .withAlpha fades) keeps working —
 * no per-glyph hardcoded colors that would fight the tint.
 *
 * MIXED-SET UPDATE (2026-08-15, selected asset set): airliner/widebody/
 * turboprop/helicopter use the "refined" recognition-chart redraw;
 * quadjet/glider use the "bold" chart-symbol redraw; light/fastjet keep the
 * original drawings. Raster fidelity doubled (192px source, same 96 coords).
 *
 * Silhouette language follows skylight's type-aware glyphs (MIT,
 * https://github.com/cpaczek/skylight): slender fuselages, swept wings for
 * jets, long high-aspect wings for the glider, straight wings + prop discs for
 * props, a rotor disc + tail boom + tail-rotor for the helicopter, and a delta
 * for the fast jet. Each class has a DISTINCT planform so it reads at ~20px by
 * shape, not just by footprint size.
 */

const VIEW = 96;
const C = VIEW / 2; // 48 — glyph centre

// Hairline dark edge (scaled for the 96 box: ~1.5u ≈ the old 0.5u at 32).
const STROKE = 'stroke="rgba(0,0,0,0.32)" stroke-width="1.4" stroke-linejoin="round"';
// Heavier edge for the chart-symbol ("bold") glyphs adopted 2026-08-15.
const STROKE_BOLD = 'stroke="rgba(0,0,0,0.38)" stroke-width="2" stroke-linejoin="round"';
// Softer white for translucent detail (prop discs, rotor disc) — still white so
// the tint multiplies cleanly; only the alpha differs.
const DISC = 'fill="white" fill-opacity="0.5"';

// Each body is drawn in a centred coordinate frame (origin 0,0 = glyph centre),
// nose toward -Y. Numbers are in the 96-unit space (half-extent up to ~45).
const BODIES = {
  // ── Airliner: slender swept-wing narrow-body, two underwing engine pods,
  //    swept tailplane. The canonical jet; everything else reads against it.
  airliner: `
    <path d="M0,-42 C 3.8,-40 4.6,-34 4.6,-26 L 4.6,-14
             L 32,4 L 34,6 L 34,10 L 31.4,9.2 L 4.6,2.4
             L 4.2,20
             L 14,28 L 14,32 L 0,28.6 L -14,32 L -14,28 L -4.2,20
             L -4.6,2.4 L -31.4,9.2 L -34,10 L -34,6 L -32,4 L -4.6,-14
             L -4.6,-26 C -4.6,-34 -3.8,-40 0,-42 Z" fill="white" ${STROKE}/>
    <path d="M-15.5,-1.5 l3,7.6 4,-1.4 -1.5,-8.4 Z" fill="white"/>
    <path d="M15.5,-1.5 l-3,7.6 -4,-1.4 1.5,-8.4 Z" fill="white"/>
    <path d="M-1.6,33.5 L 1.6,33.5 L 1.6,40 L -1.6,40 Z" fill="white"/>`,

  // ── Widebody: same swept jet but noticeably BIGGER span + fatter fuselage,
  //    twin engines set further out. Reads as a heavier airliner.
  widebody: `
    <path d="M0,-45 C 5.6,-43 6.8,-36 6.8,-27 L 6.8,-12
             L 38,9 L 41.5,12.4 L 41.5,16.6 L 37.6,15 L 6.8,6
             L 6.3,21
             L 17,30 L 17,34.6 L 0,30.4 L -17,34.6 L -17,30 L -6.3,21
             L -6.8,6 L -37.6,15 L -41.5,16.6 L -41.5,12.4 L -38,9 L -6.8,-12
             L -6.8,-27 C -6.8,-36 -5.6,-43 0,-45 Z" fill="white" ${STROKE}/>
    <path d="M-19,2 l3.6,9 4.8,-1.7 -1.8,-10 Z" fill="white"/>
    <path d="M19,2 l-3.6,9 -4.8,-1.7 1.8,-10 Z" fill="white"/>
    <path d="M-2,35.5 L 2,35.5 L 2,42.5 L -2,42.5 Z" fill="white"/>`,

  // ── Quadjet: the widest swept jet, with FOUR bold underwing engine pods (two
  //    per wing) that hang well below the trailing edge — the wing reads as a
  //    4-lumped bar even when the individual pods blur together at ~20px.
  quadjet: `
    <path d="M0,-45 C 7,-42 9,-34 9,-25 L 9,-11
             L 46,12 L 46,21 L 9,11.5
             L 8.4,21 L 20,31 L 20,37.5 L 0,32 L -20,37.5 L -20,31 L -8.4,21
             L -9,11.5 L -46,21 L -46,12 L -9,-11
             L -9,-25 C -9,-34 -7,-42 0,-45 Z" fill="white" ${STROKE_BOLD}/>
    <rect x="-31" y="9" width="7" height="12" rx="2" fill="white"/>
    <rect x="-17" y="4.5" width="7" height="12" rx="2" fill="white"/>
    <rect x="10" y="4.5" width="7" height="12" rx="2" fill="white"/>
    <rect x="24" y="9" width="7" height="12" rx="2" fill="white"/>`,

  // ── Turboprop: bold STRAIGHT (unswept) wings — thicker chord than a jet — two
  //    fat nacelles that jut ahead of the leading edge, each capped by a solid
  //    prop disc. Reads as "straight wing with two lumps + discs" at ~20px.
  turboprop: `
    <path d="M0,-40 C 3.4,-38.5 4.2,-33 4.2,-26 L 4.2,-18
             L 36,-15.5 L 36,-7.5 L 4.2,-8
             L 3.8,22
             L 13,27.5 L 13,31.5 L 0,28.6 L -13,31.5 L -13,27.5 L -3.8,22
             L -4.2,-8 L -36,-7.5 L -36,-15.5 L -4.2,-18
             L -4.2,-26 C -4.2,-33 -3.4,-38.5 0,-40 Z" fill="white" ${STROKE}/>
    <circle cx="-17.5" cy="-16.5" r="7.5" fill="white" fill-opacity="0.5"/>
    <circle cx="17.5" cy="-16.5" r="7.5" fill="white" fill-opacity="0.5"/>
    <path d="M-19.5,-19 h4 v5 h-4 Z" fill="white"/>
    <path d="M15.5,-19 h4 v5 h-4 Z" fill="white"/>
    <path d="M-1.7,31.5 L 1.7,31.5 L 1.7,38.5 L -1.7,38.5 Z" fill="white"/>`,

  // ── Light GA: small and CHUNKY — short, DEEP-chord straight wings and a fat
  //    stubby fuselage make it read as a solid little block (not a thin cross),
  //    with a bold nose prop disc. The short deep wing is the anti-glider cue.
  light: `
    <path d="M0,-27
             C 4,-25 5.2,-20 5.2,-13
             L 5.2,-9
             L 27,-9 L 27,6 L 5.2,6
             L 5.2,16
             L 11.5,23 L 11.5,27 L 0,23.5 L -11.5,27 L -11.5,23 L -5.2,16
             L -5.2,6
             L -27,6 L -27,-9 L -5.2,-9
             L -5.2,-13
             C -5.2,-20 -4,-25 0,-27 Z" fill="white" ${STROKE}/>
    <ellipse cx="0" cy="-29" rx="12" ry="3.8" ${DISC}/>`,

  // ── Glider: VERY long, high-aspect TAPERED wings (fat root → thin tips) on a
  //    slim fuselage with a T-tail. The extreme span is the whole identity — it
  //    reads as "the wide skinny one" against light's short stubby wings.
  glider: `
    <path d="M0,-35 C 2.4,-33 3,-29 3,-25 L 3,-14
             L 45,-10.5 L 45,-3.5 L 2.9,-6
             L 2.2,32 L -2.2,32 L -2.9,-6
             L -45,-3.5 L -45,-10.5 L -3,-14
             L -3,-25 C -3,-29 -2.4,-33 0,-35 Z" fill="white" ${STROKE_BOLD}/>
    <rect x="-10.5" y="32.5" width="21" height="5" rx="1.5" fill="white" ${STROKE_BOLD}/>`,

  // ── Helicopter: a SOLID translucent main-rotor disc (survives downscale as an
  //    obvious circle, unlike a thin ring) with a bold two-blade cross, a
  //    teardrop cabin, a tail boom, and a tail rotor. Unmistakable "disc on top"
  //    silhouette that never reads as a fixed-wing.
  helicopter: `
    <circle cx="0" cy="-6" r="31" fill="white" fill-opacity="0.22"/>
    <g transform="rotate(45 0 -6)">
      <rect x="-30.5" y="-8.2" width="61" height="4.4" rx="2.2" fill="white" fill-opacity="0.9"/>
      <rect x="-30.5" y="-8.2" width="61" height="4.4" rx="2.2" fill="white" fill-opacity="0.9" transform="rotate(90 0 -6)"/>
    </g>
    <path d="M0,-22 C 8,-20 10.5,-13 10.5,-6 C 10.5,2 7.5,7 0,8.5
             C -7.5,7 -10.5,2 -10.5,-6 C -10.5,-13 -8,-20 0,-22 Z" fill="white" ${STROKE}/>
    <path d="M-2.6,8 L 2.6,8 L 1.8,32 L -1.8,32 Z" fill="white" ${STROKE}/>
    <path d="M-8,27 L 8,27 L 8,30.6 L -8,30.6 Z" fill="white"/>
    <circle cx="5.6" cy="35" r="6" fill="white" fill-opacity="0.6"/>
    <circle cx="5.6" cy="35" r="2.1" fill="white"/>`,

  // ── Fast jet: sharp delta/cropped-delta with a pointed nose, LERX root
  //    blend, and twin tail fins. Aggressive, all-wing.
  fastjet: `
    <path d="M0,-43
             L 3.5,-30
             C 4,-24 4.6,-16 5,-8
             L 27,20 L 27,26 L 6,16
             L 8,30 L 8,34 L 3,31
             L 3,38 L 6.5,42 L 6.5,44 L 0,41.5
             L -6.5,44 L -6.5,42 L -3,38
             L -3,31 L -8,34 L -8,30 L -6,16
             L -27,26 L -27,20 L -5,-8
             C -4.6,-16 -4,-24 -3.5,-30 Z" fill="white" ${STROKE}/>`,
  // 2026-08-15 Hangar additions: two NEW classes shipped with the real-model
  // fleet (CLASS_MODEL_REAL). Same contract as the set above: 96×96 nose-up,
  // white fill, hairline stroke, tint-safe.
  // Business jet — slender fuselage, modest swept wing, aft engines, T-tail.
  bizjet: `
    <path d="M0,-42
             L 2.6,-36 L 3.4,-26 L 3.4,-8
             L 27,8 L 27,13 L 3.6,6
             L 3.6,16
             L 8,18 L 8,26 L 3.8,25
             L 3.2,30 L 15,34 L 15,38 L 2.4,36
             L 0,40
             L -2.4,36 L -15,38 L -15,34 L -3.2,30
             L -3.8,25 L -8,26 L -8,18 L -3.6,16
             L -3.6,6 L -27,13 L -27,8 L -3.4,-8
             L -3.4,-26 L -2.6,-36 Z" fill="white" ${STROKE}/>`,
  // ── TR-3B (hidden 9th kind, Easter egg — NOT a classifyAircraft() output).
  //    The canonical black-triangle silhouette: a dark isosceles delta with a
  //    light at each corner and a dimmer one at the centre. Reached only by
  //    explicit user conversion (see tr3bRegistry.js), never by classification.
  //
  //    DELIBERATE BREAK from the white-fill contract above: this glyph is a
  //    SHADOW, so it carries its own near-black fill. The billboard tint still
  //    multiplies (white fleet / cyan tracked / amber military), which darkens
  //    rather than lightens — the triangle stays a silhouette in every layer,
  //    and the corner lights pick the tint up as their hue.
  tr3b: `
    <path d="M0,-38 L 40,30 L -40,30 Z"
          fill="#0d1014" stroke="rgba(158,184,210,0.34)" stroke-width="1.6"
          stroke-linejoin="round"/>
    <circle cx="0" cy="-24" r="8.5" fill="#c9dcf0" fill-opacity="0.13"/>
    <circle cx="-28" cy="21" r="8.5" fill="#c9dcf0" fill-opacity="0.13"/>
    <circle cx="28" cy="21" r="8.5" fill="#c9dcf0" fill-opacity="0.13"/>
    <circle cx="0" cy="-24" r="4.6" fill="#dceaf8" fill-opacity="0.52"/>
    <circle cx="-28" cy="21" r="4.6" fill="#dceaf8" fill-opacity="0.52"/>
    <circle cx="28" cy="21" r="4.6" fill="#dceaf8" fill-opacity="0.52"/>
    <circle cx="0" cy="6" r="3.4" fill="#dceaf8" fill-opacity="0.26"/>`,

  // ── TR-3B, thermal-reactive variant. Same cold airframe, but the three
  //    corner emitters + the centre one render HOT: near-white cores inside a
  //    baked radial glow, so the FLIR/NVG luminance mapping (and any bloom)
  //    lights them up while the hull stays cold. Selected by the layers
  //    whenever their `irBoost` style param is on (surveillance/thermal/nvg).
  tr3bHot: `
    <defs>
      <radialGradient id="tr3bGlow">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.92"/>
        <stop offset="32%" stop-color="#f2f9ff" stop-opacity="0.44"/>
        <stop offset="100%" stop-color="#dcefff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <path d="M0,-38 L 40,30 L -40,30 Z"
          fill="#0b0e12" stroke="rgba(126,148,172,0.3)" stroke-width="1.6"
          stroke-linejoin="round"/>
    <circle cx="0" cy="-24" r="15" fill="url(#tr3bGlow)"/>
    <circle cx="-28" cy="21" r="15" fill="url(#tr3bGlow)"/>
    <circle cx="28" cy="21" r="15" fill="url(#tr3bGlow)"/>
    <circle cx="0" cy="6" r="10" fill="url(#tr3bGlow)"/>
    <circle cx="0" cy="-24" r="5.2" fill="#ffffff"/>
    <circle cx="-28" cy="21" r="5.2" fill="#ffffff"/>
    <circle cx="28" cy="21" r="5.2" fill="#ffffff"/>
    <circle cx="0" cy="6" r="3.6" fill="#ffffff" fill-opacity="0.82"/>`,

  // Large UAV (Reaper-class) — bulbous sensor nose, very long slender
  // straight wings, slim tail boom, canted V-tail.
  uav: `
    <path d="M0,-40
             C 3.6,-40 4.6,-35 4.4,-30
             L 2.4,-12
             L 43,-7 L 43,-2.5 L 2.3,0
             L 2.1,24
             L 13,32 L 13,36 L 1.6,30
             L 0,38
             L -1.6,30 L -13,36 L -13,32 L -2.1,24
             L -2.3,0 L -43,-2.5 L -43,-7 L -2.4,-12
             L -4.4,-30 C -4.6,-35 -3.6,-40 0,-40 Z" fill="white" ${STROKE}/>`,
};

const _iconCache = new Map();

const _b64 = (s) =>
  typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'utf8').toString('base64');

/** Fleet raster: billboards render at ~40–58 DEVICE px (width 20–24 CSS ×
 *  Retina × class scale). Cesium's billboard atlas has no mipmaps, so a big
 *  texture gets GPU-minified into mush (192 px ÷ 40 = 4.8× — the owner's
 *  "soft" glyphs; the pre-2026-08-15 96 px raster aliased instead). Rastering
 *  NEAR the display size lets the browser's SVG AA do the work: crisp AND
 *  smooth. 64 covers the 40–58 px fleet band with ≤1.6× minification. */
const FLEET_RASTER_PX = 64;
/** Tracked raster: the tracked billboard is the one SUSTAINED large 2D glyph
 *  (close-zoom fleet flybys hand off to 3D models). Keep the 192 px texture so
 *  it stays crisp at its biggest on-screen sizes. */
const TRACKED_RASTER_PX = 192;

/** Data URI for a class silhouette (lazily built, cached per kind+size).
 *  Default size serves the fleet; pass `aircraftIcon(kind, TRACKED_ICON_PX)`
 *  (re-exported below) for the tracked billboard. */
export const TRACKED_ICON_PX = TRACKED_RASTER_PX;
export function aircraftIcon(kind, px = FLEET_RASTER_PX) {
  const k = BODIES[kind] ? kind : 'airliner';
  const key = `${k}@${px}`;
  let uri = _iconCache.get(key);
  if (!uri) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${VIEW} ${VIEW}"><g transform="translate(${C},${C})">${BODIES[k]}</g></svg>`;
    uri = 'data:image/svg+xml;base64,' + _b64(svg);
    _iconCache.set(key, uri);
  }
  return uri;
}
