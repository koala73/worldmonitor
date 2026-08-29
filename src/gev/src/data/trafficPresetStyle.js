/**
 * @file Preset-aware traffic dot styling — pure lookup tables mapping the
 * active post-FX style (StyleManager preset name) + congestion bucket to a
 * dot treatment the shaders cannot destroy.
 *
 * Why: traffic dots are in-scene PointPrimitives, so they pass THROUGH the
 * post-FX shaders (unlike the detection/FIRMS canvases composited above
 * them). NVG and FLIR reduce the scene to luminance (hue is discarded), and
 * the shipped bucket palette's Rec.601 luma ordering is free 0.58 / slow
 * 0.72 / jam 0.49 — under NVG a jam renders DIMMER than free flow. CRT
 * keeps hue but its 5-px pixelation + dithering shred 4–6 px dots.
 *
 * Encoding per profile (validated behavior 2026-07-23 round 2: "just bright
 * dots" — a luminance RAMP failed in the field because dim free-flow dots
 * read as dark holes on NVG-bright roads; classification is the detection
 * brackets' job via `trafficBucketTier`, presence is the dots' job):
 *  - `mono` (surveillance/NVG, thermal/FLIR, noir): every colored dot is a
 *    bright white core with a thin black halo (local contrast survives any
 *    luma mapping, including Ironbow where white stays the hottest end);
 *    jam keeps a size bump so queues read as fat beads.
 *  - `crt` (retro): saturated primaries that survive 10-level posterization
 *    plus an all-bucket size boost to out-shout the pixel grid.
 *  - `normal` (normal/anime/snow/unknown): every lookup returns null/0 —
 *    the shipped palette and sizing apply untouched.
 *
 * Sim/uncovered dots (bucket null/'sim') are NEVER restyled under any
 * style: the keyless simulation path stays byte-identical (qa-traffic
 * gate v), and white is already luminance-legible everywhere.
 *
 * Cesium-free so the tables are unit-testable; traffic.js maps tuples to
 * Cesium colors at spawn/restyle time (see `trafficFlowStyle.js` pattern).
 *
 * @module data/trafficPresetStyle
 */

/** @const {Object<string,'mono'|'crt'>} Style name → non-normal profile. */
const PROFILE_BY_STYLE = {
  surveillance: 'mono', // NVG — P43 phosphor × luma
  thermal: 'mono',      // FLIR — grayscale/ironbow × luma
  noir: 'mono',         // full desaturation
  retro: 'crt',         // CRT — hue survives, small dots don't
};

/**
 * Per-profile bucket treatments: rgba ([r,g,b] 0–255 + alpha 0–1) and the
 * pixel-size delta added ON TOP of the shipped sizing (which already gives
 * jam +1). Mono luma: jam 1.00 / slow 0.70 / free 0.36.
 * @const {Object<string, Object<string, {rgba:number[], sizeDelta:number}>>}
 */
const DOT_STYLE = {
  mono: {
    jam: { rgba: [255, 255, 255, 0.95], sizeDelta: 3, outline: { rgba: [0, 0, 0, 0.9], width: 2 } },
    slow: { rgba: [255, 255, 255, 0.9], sizeDelta: 1, outline: { rgba: [0, 0, 0, 0.85], width: 1 } },
    free: { rgba: [255, 255, 255, 0.85], sizeDelta: 0, outline: { rgba: [0, 0, 0, 0.8], width: 1 } },
  },
  crt: {
    jam: { rgba: [255, 59, 48, 0.95], sizeDelta: 3, outline: { rgba: [0, 0, 0, 0.9], width: 2 } },
    slow: { rgba: [255, 179, 0, 0.92], sizeDelta: 2, outline: { rgba: [0, 0, 0, 0.85], width: 1 } },
    free: { rgba: [0, 255, 102, 0.9], sizeDelta: 1, outline: null },
  },
};

/**
 * Classify a StyleManager preset name into a traffic styling profile.
 * @param {string|null|undefined} styleName - Active style (e.g. 'surveillance').
 * @returns {'normal'|'mono'|'crt'} Styling profile; unknown → 'normal'.
 */
export function trafficStyleProfile(styleName) {
  return PROFILE_BY_STYLE[styleName] || 'normal';
}

/**
 * Preset dot color for a congestion bucket, or null to keep the shipped
 * FLOW_BUCKET_COLORS value. Null/'sim' buckets always return null.
 * @param {string|null|undefined} styleName - Active style name.
 * @param {'free'|'slow'|'jam'|'sim'|null|undefined} bucket - Flow bucket.
 * @returns {number[]|null} [r,g,b,a] with rgb 0–255, alpha 0–1, or null.
 */
export function presetDotRgba(styleName, bucket) {
  const entry = DOT_STYLE[trafficStyleProfile(styleName)]?.[bucket];
  return entry ? entry.rgba : null;
}

/**
 * Pixel-size delta a preset adds on top of the shipped dot sizing.
 * @param {string|null|undefined} styleName - Active style name.
 * @param {'free'|'slow'|'jam'|'sim'|null|undefined} bucket - Flow bucket.
 * @returns {number} Pixels to add (0 under the normal profile / sim dots).
 */
export function presetSizeDelta(styleName, bucket) {
  const entry = DOT_STYLE[trafficStyleProfile(styleName)]?.[bucket];
  return entry ? entry.sizeDelta : 0;
}

/**
 * Dark halo for a preset dot, or null for none. Why: NVG auto-gain pushes
 * the whole scene near saturation, so a bright dot has almost no contrast
 * against a bright road — a dark outline restores LOCAL contrast, which
 * every luma-mapping shader preserves. Null under the normal profile and
 * for sim dots (shipped dots never draw outlines).
 * @param {string|null|undefined} styleName - Active style name.
 * @param {'free'|'slow'|'jam'|'sim'|null|undefined} bucket - Flow bucket.
 * @returns {{rgba:number[], width:number}|null} Outline spec or null.
 */
export function presetDotOutline(styleName, bucket) {
  const entry = DOT_STYLE[trafficStyleProfile(styleName)]?.[bucket];
  return entry?.outline || null;
}

/**
 * Detection-overlay tier key for a traffic contact's flow bucket. The
 * detection canvas composites ABOVE the post-FX chain, so tier colors are
 * literal screen RGB in every preset — the brackets carry the congestion
 * classification the in-scene dots can no longer encode under mono
 * presets. Per-theme colors live in detection.js THEME_MAP `tiers`
 * (veh_jam / veh_slow / veh_free / veh_nodata).
 *
 * Callers pass 'sim' for LIVE-mode roads TomTom has no data for; in
 * keyless mode they must pass null so contacts keep the stock 'vehicle'
 * tier — the keyless experience stays byte-identical.
 *
 * @param {'free'|'slow'|'jam'|'sim'|null|undefined} bucket - Flow bucket.
 * @returns {string|null} Tier key, or null (no override → stock 'vehicle').
 */
export function trafficBucketTier(bucket) {
  if (bucket === 'free' || bucket === 'slow' || bucket === 'jam') return `veh_${bucket}`;
  if (bucket === 'sim') return 'veh_nodata';
  return null;
}
