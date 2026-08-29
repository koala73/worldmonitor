/**
 * @module cctvCards
 * @description Screen-space thumbnail cards for the citywide ambient CCTV
 * tier described in `docs/CURRENT-STATE.md`.
 * Replaces the rejected world-space static-plane ring with small canvas cards
 * anchored to each LOD-selected camera's screen position, showing its latest
 * paced static frame.
 *
 * The shared world-overlay host owns projection, collision, paint, and hit
 * rectangles. This module owns the source-side entry policy and every frame
 * lifecycle concern: fetching, stable slots, retry pacing, persistence, and
 * cache pruning.
 *
 * Division of labor mirrors vesselLabels: cctv.js OWNS selection and frame
 * fetching (moveEnd-driven LOD + grace + the policy-gated pacer: cold-fill
 * burst, then the 1-fetch/s steady gate — never per
 * frame); this module owns the pure card policy helpers (declutter, frame
 * persistence, retry pacing, cache pruning) and supplies ready-to-draw stable
 * frame-slot references to the host.
 *
 * Zero-flicker contract (product requirement):
 * - An AMBIENT entry whose frame slot has no drawn frame yet (`stamp === 0`)
 *   renders NOTHING — no placeholder, no chip. The camera icon alone carries
 *   it. Sole documented exception (follow-up round 2, item B): a PINNED entry
 *   (hover-summoned, `entry.pinned === true`) paints its chrome immediately —
 *   explicit user gesture wants instant feedback — with an empty thumb area
 *   until its fast-tracked frame lands.
 * - Entries hold a LIVE reference to their per-camera frame slot; when a
 *   fetched frame lands (applyFrameResult assigned onto the stable slot) the
 *   card appears/updates on the next postRender without any entry rebuild.
 * - A failed fetch never clears a drawn frame (applyFrameResult persistence).
 *
 * Edge fade consistency (owner note): cards fade toward the screen edges via
 * the SAME radial keyhole ramp the detection overlay uses
 * (keyholeLabelAlphaFromGeometry — opaque inside the central keyhole, linear
 * feather outward), multiplied with the shared distance ramp (cardAlpha).
 */

import { CCTV_THUMBNAIL_STYLE } from '../overlays/worldOverlayTokens.js';

// ─── Card geometry / style constants ───────────────────────────────────────

/** Thumbnail display size (CSS px, 16:9). */
export const CCTV_CARD_THUMB_W = 96;
export const CCTV_CARD_THUMB_H = 54;
/** Offscreen frame-canvas size (2x thumb for DPI crispness). */
export const CCTV_FRAME_CANVAS_W = 192;
export const CCTV_FRAME_CANVAS_H = 108;
/**
 * Min screen separation between accepted card anchors (greedy declutter).
 * Field test 2026-07-30: 130 read too sparse once the HUD safe-zone
 * filter started dropping cards as well. 112 still exceeds the card box width
 * (104 px) so accepted boxes cannot overlap. This is THE density knob.
 */
export const CCTV_CARD_MIN_SEP_PX = 112;
/** Ambient cards yield the top HUD band to mission text and controls. */
export const CCTV_CARD_SAFE_TOP_RATIO = 0.18;
export const CCTV_CARD_SAFE_TOP_MAX_PX = 150;
/** Bounded thumbnail cache (frame slots kept beyond the live card set). */
export const CCTV_FRAME_CACHE_MAX = 96;

// ─── Altitude scaling (field test finding 5, 2026-07-29) ──────────────
// Validated curve: cards are full size at street level, "start to get
// smaller" from ~1,800 m, "scale down progressively" to ~0.45 by 6,000 m,
// keep shrinking slightly and alpha-fade out across 7,500→9,500 m, and are
// fully hidden above that ("just the icons" at the highest zooms).
export const CCTV_CARD_SCALE_FULL_M = 1_800;
export const CCTV_CARD_SCALE_MID_M = 6_000;
export const CCTV_CARD_FADE_START_M = 7_500;
export const CCTV_CARD_FADE_END_M = 9_500;
export const CCTV_CARD_SCALE_AT_MID = 0.45;
export const CCTV_CARD_SCALE_MIN = 0.35;

// ─── Frame-fetch pacing (field test finding 3, 2026-07-29) ────────────
/** Steady-state global gate: one card-frame fetch per second. */
export const CCTV_CARD_FETCH_STEADY_SPACING_MS = 1_000;
/** Cold-fill burst spacing between fetch launches. */
export const CCTV_CARD_FETCH_BURST_SPACING_MS = 250;
/** Cold-fill burst max concurrent in-flight fetches. */
export const CCTV_CARD_FETCH_BURST_LIMIT = 4;

/** Distance fade: full inside 70%, gone past this (metro scale stays live). */
const FADE_DISTANCE_M = 150000;
/** Base per-camera retry spacing; doubles per consecutive failure. */
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 5 * 60 * 1000;

export const CCTV_OVERLAY_SOURCE_ID = 'cctv';
export const CCTV_THUMBNAIL_ALTITUDE_SCALE = Object.freeze({
  fullEnd: CCTV_CARD_SCALE_FULL_M,
  midEnd: CCTV_CARD_SCALE_MID_M,
  end: CCTV_CARD_FADE_END_M,
  midValue: CCTV_CARD_SCALE_AT_MID,
  endValue: CCTV_CARD_SCALE_MIN,
  smoothToMid: true,
});

// ─── Pure helpers (exported for unit tests — no Cesium, no DOM) ────────────

/**
 * Returns whether an ambient card anchor is outside the protected top HUD
 * band. A user-pinned hover card may intentionally enter the band because it
 * is temporary and requested; persistent ambient cards yield to the HUD.
 *
 * @param {Object} input
 * @param {number} input.sy - Anchor Y in CSS pixels.
 * @param {number} input.viewH - Viewport height in CSS pixels.
 * @param {boolean} [input.pinned=false]
 * @returns {boolean}
 */
export function isCctvCardAnchorSafe({ sy, viewH, pinned = false } = {}) {
  if (pinned) return Number.isFinite(sy);
  if (!Number.isFinite(sy) || !Number.isFinite(viewH) || viewH <= 0) return false;
  const safeTop = Math.min(CCTV_CARD_SAFE_TOP_MAX_PX, viewH * CCTV_CARD_SAFE_TOP_RATIO);
  return sy >= safeTop;
}

/**
 * Greedy nearest-first screen-space declutter over LOD-selected candidates
 * (the vessel/FIRMS min-separation idiom): accept a candidate only when its
 * anchor keeps `minSepPx` from every already-accepted anchor, so cards never
 * pile onto each other or bury neighboring camera icons.
 * @param {Array<{id:string,sx:number,sy:number,distanceKm:number}>} candidates
 * @param {Object} [options]
 * @param {number} [options.minSepPx]
 * @param {number} [options.limit]
 * @returns {string[]} Accepted ids, nearest-first.
 */
export function declutterCctvCards(candidates, { minSepPx = CCTV_CARD_MIN_SEP_PX, limit = Infinity } = {}) {
  const valid = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && typeof c.id === 'string' && c.id
      && Number.isFinite(c.sx) && Number.isFinite(c.sy))
    .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || a.id.localeCompare(b.id));
  const minSq = minSepPx * minSepPx;
  const accepted = [];
  const acceptedIds = [];
  for (const candidate of valid) {
    if (acceptedIds.length >= limit) break;
    let clear = true;
    for (let i = 0; i < accepted.length; i++) {
      const dx = candidate.sx - accepted[i].sx;
      const dy = candidate.sy - accepted[i].sy;
      if (dx * dx + dy * dy < minSq) { clear = false; break; }
    }
    if (!clear) continue;
    accepted.push(candidate);
    acceptedIds.push(candidate.id);
  }
  return acceptedIds;
}

/**
 * Altitude-driven card scale + opacity (field test finding 5,
 * 2026-07-29 — curve constants above). Piecewise, monotonic non-increasing
 * in both channels:
 *   - ≤1,800 m: full size, fully opaque.
 *   - 1,800→6,000 m: smoothstep shrink 1.0 → 0.45 (opaque).
 *   - 6,000→9,500 m: slight continued linear shrink 0.45 → 0.35; opaque
 *     until 7,500 m, then a linear alpha fade to 0 at 9,500 m.
 *   - ≥9,500 m: fully hidden (alpha 0) — entries may persist, nothing paints.
 * @param {number} cameraHeightM - Viewer camera height above the ellipsoid.
 * @returns {{scale:number, alpha:number}}
 */
export function cardScaleForAltitude(cameraHeightM) {
  const h = Number.isFinite(cameraHeightM) ? Math.max(0, cameraHeightM) : 0;
  if (h <= CCTV_CARD_SCALE_FULL_M) return { scale: 1, alpha: 1 };
  if (h <= CCTV_CARD_SCALE_MID_M) {
    const t = (h - CCTV_CARD_SCALE_FULL_M) / (CCTV_CARD_SCALE_MID_M - CCTV_CARD_SCALE_FULL_M);
    const s = t * t * (3 - 2 * t); // smoothstep — no visible kink at either end
    return { scale: 1 + (CCTV_CARD_SCALE_AT_MID - 1) * s, alpha: 1 };
  }
  const t = Math.min(1, (h - CCTV_CARD_SCALE_MID_M) / (CCTV_CARD_FADE_END_M - CCTV_CARD_SCALE_MID_M));
  const scale = CCTV_CARD_SCALE_AT_MID + (CCTV_CARD_SCALE_MIN - CCTV_CARD_SCALE_AT_MID) * t;
  if (h >= CCTV_CARD_FADE_END_M) return { scale: CCTV_CARD_SCALE_MIN, alpha: 0 };
  if (h <= CCTV_CARD_FADE_START_M) return { scale, alpha: 1 };
  const alpha = 1 - (h - CCTV_CARD_FADE_START_M) / (CCTV_CARD_FADE_END_M - CCTV_CARD_FADE_START_M);
  return { scale, alpha };
}

/**
 * Cold-fill burst pacing policy (field test finding 3, 2026-07-29), as
 * a pure decision so the pacer tick stays trivially testable. While any
 * selected card still lacks its FIRST frame (`coldFill`), up to
 * `CCTV_CARD_FETCH_BURST_LIMIT` fetches may be in flight with
 * `CCTV_CARD_FETCH_BURST_SPACING_MS` between launches; once every selected
 * card has a first frame the layer drops back to the steady-state global
 * gate (single in-flight fetch, one launch per second — an in-flight fetch
 * still blocks the tick, so slow responses only lower the rate).
 * @param {Object} [input]
 * @param {boolean} [input.coldFill] - A selected card lacks its first frame.
 * @param {number} [input.inFlight] - Current in-flight fetch count.
 * @param {number} [input.sinceLastLaunchMs] - Ms since the last fetch launch.
 * @returns {{mode:('burst'|'steady'), launch:boolean}}
 */
export function cardFetchPolicy({ coldFill = false, inFlight = 0, sinceLastLaunchMs = Infinity } = {}) {
  if (coldFill) {
    return {
      mode: 'burst',
      launch: inFlight < CCTV_CARD_FETCH_BURST_LIMIT
        && sinceLastLaunchMs >= CCTV_CARD_FETCH_BURST_SPACING_MS,
    };
  }
  return {
    mode: 'steady',
    launch: inFlight === 0 && sinceLastLaunchMs >= CCTV_CARD_FETCH_STEADY_SPACING_MS,
  };
}

/**
 * Creates an empty per-camera frame slot. Slots are STABLE objects — card
 * entries reference them directly, and fetch results are Object.assign-ed
 * onto them (via applyFrameResult) so the renderer sees new frames without
 * an entry rebuild.
 * @returns {{frame:*, stamp:number, failCount:number, lastAttemptAt:number}}
 */
export function createFrameSlot() {
  return { frame: null, stamp: 0, failCount: 0, lastAttemptAt: 0 };
}

/**
 * The no-flicker persistence rule, as a pure state transition. A successful
 * fetch replaces the frame and stamps it; a FAILED fetch keeps the previous
 * frame and stamp untouched (the drawn card persists) and only bumps the
 * failure count for retry backoff.
 * @param {{frame:*, stamp:number, failCount:number, lastAttemptAt:number}} prev
 * @param {{ok:boolean, frame?:*}} result
 * @param {number} nowMs
 * @returns {{frame:*, stamp:number, failCount:number, lastAttemptAt:number}}
 */
export function applyFrameResult(prev, result, nowMs) {
  const base = prev || createFrameSlot();
  if (result?.ok && result.frame) {
    return { frame: result.frame, stamp: nowMs, failCount: 0, lastAttemptAt: nowMs };
  }
  return {
    frame: base.frame,
    stamp: base.stamp,
    failCount: (base.failCount || 0) + 1,
    lastAttemptAt: nowMs,
  };
}

/**
 * Per-camera attempt spacing: a base gap between attempts, doubling per
 * consecutive failure, capped (a dead source settles at one try per 5 min).
 * @param {number} failCount
 * @returns {number}
 */
export function frameRetryDelayMs(failCount) {
  const fails = Math.max(0, Number(failCount) || 0);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** fails);
}

/**
 * Whether a frame fetch should be attempted for a slot: the slot must be
 * stale against its source cadence (or never filled), and past the retry
 * spacing since its last attempt.
 * @param {{stamp:number, failCount:number, lastAttemptAt:number}|null} slot
 * @param {number} refreshMs - Source cadence (staticFrameRefreshMs).
 * @param {number} nowMs
 * @returns {boolean}
 */
export function frameFetchDue(slot, refreshMs, nowMs) {
  if (!slot) return false;
  const stale = !(slot.stamp > 0) || nowMs - slot.stamp >= refreshMs;
  if (!stale) return false;
  if (!(slot.lastAttemptAt > 0)) return true;
  return nowMs - slot.lastAttemptAt >= frameRetryDelayMs(slot.failCount);
}

/**
 * Plans the bounded-LRU prune of the thumbnail cache: live card ids are
 * NEVER dropped (their persisted frames are the no-flicker guarantee, grace
 * included); beyond them the newest-stamped slots fill the cap and the rest
 * are dropped.
 * @param {Array<{id:string, stamp:number}>} slots - Cached slot ids + stamps.
 * @param {Iterable<string>} keepIds - Live card ids (selection + grace).
 * @param {number} [cap]
 * @returns {string[]} Ids to drop from the cache.
 */
export function planFrameCachePrune(slots, keepIds, cap = CCTV_FRAME_CACHE_MAX) {
  const keep = new Set(keepIds);
  const spare = (Array.isArray(slots) ? slots : [])
    .filter((slot) => slot && typeof slot.id === 'string' && !keep.has(slot.id))
    .sort((a, b) => (b.stamp || 0) - (a.stamp || 0) || a.id.localeCompare(b.id));
  const capacity = Math.max(0, cap - keep.size);
  return spare.slice(capacity).map((slot) => slot.id);
}

/**
 * Build the normalized source-side presentation for one CCTV thumbnail. The
 * stable frame slot is passed by reference; the host reads `slot.frame` on
 * every paint, so a successful fetch appears without rebuilding the entry and
 * a failed fetch cannot clear the last successful pixels.
 * @param {object} input
 * @param {string} input.id
 * @param {object} input.position
 * @param {string} input.title
 * @param {{frame:*,stamp:number}} input.frameSlot
 * @param {number} [input.rank=0]
 * @param {boolean} [input.pinned=false]
 * @param {boolean} [input.active=false]
 * @param {number} [input.gapPx=16]
 * @returns {object}
 */
export function createCctvThumbnailOverlayEntry({
  id,
  position,
  title,
  frameSlot,
  rank = 0,
  pinned = false,
  active = false,
  gapPx = 16,
} = {}) {
  const hostGap = Math.max(14, (Number(gapPx) || 14) + 6);
  return {
    id,
    position,
    variant: 'thumbnail',
    paintLane: 'thumbnail',
    title,
    details: [],
    image: frameSlot,
    requireImage: true,
    accent: CCTV_THUMBNAIL_STYLE.accent,
    priority: active ? 1_000_000 : pinned ? 900_000 : 100_000 - rank,
    selected: false,
    pinned,
    protected: active,
    active,
    collisionGroup: 'ambient-card',
    zIndex: 50,
    interactive: true,
    minDistance: 0,
    maxDistance: FADE_DISTANCE_M,
    distanceFadeStartRatio: 0.7,
    altitudeScale: CCTV_THUMBNAIL_ALTITUDE_SCALE,
    altitudeFadeStart: CCTV_CARD_FADE_START_M,
    altitudeFadeEnd: CCTV_CARD_FADE_END_M,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: hostGap,
    leaderOffsetPx: Math.max(2, hostGap - 6),
    verticalOnly: true,
    // CCTV shipped as a STATELESS per-frame rebuild: cards popped in and out on
    // the frame the geometry said so, and above/below was re-decided from
    // geometry every frame with no memory. Opting out of the shared arbiter's
    // min-lifetime, re-entry cooldown, fades and sticky corner restores that
    // feel — the hysteresis is what produced sticky mid-screen below-placements
    // and the ~1.5 s delay before a card could come back after a nadir sweep.
    stateless: true,
    // The shipped per-frame pass rejected cards whose ANCHORS were closer than
    // this (scaled with the card). Rectangle overlap alone let them stack about
    // twice as densely, because the leader gap does not shrink with the card.
    minAnchorSeparationPx: CCTV_CARD_MIN_SEP_PX,
    viewportMargin: 4,
    viewportPadding: 60,
    safeTopRatio: CCTV_CARD_SAFE_TOP_RATIO,
    safeTopMaxPx: CCTV_CARD_SAFE_TOP_MAX_PX,
    pinnedBypassesSafeTop: true,
    thumbnailWidth: CCTV_CARD_THUMB_W,
    thumbnailHeight: CCTV_CARD_THUMB_H,
    thumbnailPadX: CCTV_THUMBNAIL_STYLE.padding,
    thumbnailPadTop: CCTV_THUMBNAIL_STYLE.padding,
    thumbnailPadBottom: CCTV_THUMBNAIL_STYLE.padding,
    thumbnailTitleGap: 2,
    thumbnailTitleHeight: CCTV_THUMBNAIL_STYLE.titleHeight,
    thumbnailTitleChars: CCTV_THUMBNAIL_STYLE.titleChars,
    thumbnailBackground: CCTV_THUMBNAIL_STYLE.background,
    thumbnailTitleColor: CCTV_THUMBNAIL_STYLE.titleColor,
    thumbnailTitleFont: CCTV_THUMBNAIL_STYLE.titleFont,
    thumbnailLeaderColor: CCTV_THUMBNAIL_STYLE.leader,
    thumbnailRuleColor: CCTV_THUMBNAIL_STYLE.rule,
    thumbnailRuleHeight: CCTV_THUMBNAIL_STYLE.ruleHeight,
    thumbnailRadius: CCTV_THUMBNAIL_STYLE.radius,
  };
}
