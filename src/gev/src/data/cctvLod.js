/**
 * @module cctvLod
 *
 * Pure selection policy for the citywide ambient CCTV card tier.
 * Cesium-specific visibility projection stays in cctv.js; this module turns
 * the resulting in-view candidates into a bounded, nearest-first ambient
 * card set, keeps that set stable across small camera moves (eviction
 * grace), and paces static-frame refreshes per source.
 *
 * The engine retains zoom-scaled budgets, distance-ranked in-view selection,
 * an eviction-grace planner, and source-aware refresh cadences, retargeted
 * from the rejected world-space static-plane ring to the
 * screen-space thumbnail cards (see
 * the ambient-card behavior documented in `docs/CURRENT-STATE.md`).
 */

// Ambient-card budgets (follow-up round 2, item C: raised 16/24/32 → 20/28/40 —
// "a lot of empty space"). Tunable as a set, together with the card
// scale waypoints (1,800/6,000/9,500 m, cctvCards.js) and
// CCTV_CARD_MIN_SEP_PX: budgets say how many cameras HOLD cards, the
// waypoints and separation say how many fit on screen.
export const CCTV_AMBIENT_CARD_MAX = 40;
export const CCTV_AMBIENT_CARD_MID = 28;
export const CCTV_AMBIENT_CARD_MIN = 20;

const STREET_HEIGHT_M = 2_500;
const CITY_HEIGHT_M = 15_000;
const DEFAULT_STATIC_REFRESH_MS = 5 * 60 * 1000;
const PROVIDER_STATIC_REFRESH_MS = Object.freeze({
  'austin transportation & public works': 5 * 60 * 1000,
  'transport for london': 3 * 60 * 1000,
  caltrans: 3 * 60 * 1000,
});

/**
 * Returns the bounded ambient-card budget for the current viewer height.
 * Card counts stay inside the 20..40 range (follow-up round 2): street level
 * keeps the overlay sparse, metro scale earns the full ring.
 *
 * @param {number} cameraHeightM
 * @returns {{cardLimit:number}}
 */
export function cctvLodBudgets(cameraHeightM) {
  const height = Number.isFinite(cameraHeightM) ? Math.max(0, cameraHeightM) : CITY_HEIGHT_M;
  if (height <= STREET_HEIGHT_M) {
    return { cardLimit: CCTV_AMBIENT_CARD_MIN };
  }
  if (height <= CITY_HEIGHT_M) {
    return { cardLimit: CCTV_AMBIENT_CARD_MID };
  }
  return { cardLimit: CCTV_AMBIENT_CARD_MAX };
}

/**
 * Selection-level incumbency (field test finding 4, 2026-07-29): a
 * camera currently holding a card ranks with its distance discounted by this
 * factor, so a small camera move never batch-swaps the ring — a non-carded
 * camera displaces a carded one only when it is meaningfully (>20%) closer.
 */
export const CCTV_CARD_INCUMBENT_FACTOR = 0.8;

/**
 * Effective ranking distance for the ambient-card selection: incumbents
 * (cameras that already hold a card) get the 20% distance discount.
 * @param {number} distanceKm
 * @param {boolean} isIncumbent
 * @param {number} [factor]
 * @returns {number}
 */
export function incumbentRankKm(distanceKm, isIncumbent, factor = CCTV_CARD_INCUMBENT_FACTOR) {
  const km = Number.isFinite(distanceKm) ? Math.max(0, distanceKm) : Infinity;
  return isIncumbent ? km * factor : km;
}

/** Fraction of the ambient-card rank contributed by screen-center distance. */
export const CCTV_CARD_CENTER_WEIGHT = 0.5;

/** Robust pool-distance percentile used to scale the screen-space term. */
export const CCTV_CARD_SPREAD_PERCENTILE = 0.9;

/** True only when both viewport dimensions are finite positive pixels. */
export function hasFiniteCctvViewport(viewW, viewH) {
  return Number.isFinite(viewW) && viewW > 0
    && Number.isFinite(viewH) && viewH > 0;
}

/**
 * Returns an anchor's normalized distance from screen center: zero at center,
 * one at or beyond a viewport corner.
 * @param {number} sx
 * @param {number} sy
 * @param {number} viewW
 * @param {number} viewH
 * @returns {number}
 */
export function screenCenterFraction(sx, sy, viewW, viewH) {
  if (!hasFiniteCctvViewport(viewW, viewH)) return 0;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return 1;
  const centerX = viewW / 2;
  const centerY = viewH / 2;
  const halfDiagonalPx = Math.hypot(centerX, centerY) || 1;
  return Math.min(1, Math.hypot(sx - centerX, sy - centerY) / halfDiagonalPx);
}

/**
 * Returns a robust distance scale for the eligible candidate pool.
 * @param {number[]} distancesKm
 * @param {number} [percentile]
 * @returns {number}
 */
export function cctvCandidateSpreadKm(
  distancesKm,
  percentile = CCTV_CARD_SPREAD_PERCENTILE,
) {
  const finite = (Array.isArray(distancesKm) ? distancesKm : [])
    .filter((distanceKm) => Number.isFinite(distanceKm) && distanceKm >= 0)
    .sort((a, b) => a - b);
  if (!finite.length) return 0;
  const p = Math.min(1, Math.max(0, Number.isFinite(percentile) ? percentile : 0));
  return finite[Math.round(p * (finite.length - 1))];
}

/**
 * Blends viewer distance with screen-center distance in common km units.
 * @param {number} distanceKm
 * @param {number} centerFraction
 * @param {number} spreadKm
 * @param {number} [weight]
 * @returns {number}
 */
export function blendCenterRankKm(
  distanceKm,
  centerFraction,
  spreadKm,
  weight = CCTV_CARD_CENTER_WEIGHT,
) {
  const km = Number.isFinite(distanceKm) ? Math.max(0, distanceKm) : Infinity;
  if (!Number.isFinite(km)) return Infinity;
  const w = Math.min(1, Math.max(0, Number.isFinite(weight) ? weight : 0));
  const spread = Number.isFinite(spreadKm) && spreadKm > 0 ? spreadKm : 0;
  const fraction = Number.isFinite(centerFraction)
    ? Math.min(1, Math.max(0, centerFraction))
    : 1;
  return (1 - w) * km + w * spread * fraction;
}

// Screen-distribution grid (follow-up round 2, item C — "a lot of empty space"):
// pure nearest-first selection clusters winners at screen center (nearest ==
// most central at typical view pitch) and leaves the periphery bare. The
// viewport is bucketed into this grid and every occupied cell gets its best
// candidate before global rank fills the rest. Tunable together with
// the budgets above.
export const CCTV_CARD_GRID_COLS = 5;
export const CCTV_CARD_GRID_ROWS = 4;

/**
 * Screen-space distribution pass (follow-up round 2, item C). Buckets the
 * viewport into a CCTV_CARD_GRID_COLS × CCTV_CARD_GRID_ROWS grid, assigns
 * each candidate to its cell (anchors just outside the viewport clamp to
 * the edge cells), ranks within cells by effective distance (`rankKm` —
 * incumbency discount already applied by the caller), then takes each
 * occupied cell's best — nearest cell-winners first, so an under-budget cut
 * stays deterministic — until the budget is filled; leftover budget goes to
 * the remaining candidates in global rank order. Empty cells are skipped.
 * Pure and allocation-honest: decides only WHICH cameras hold cards — the
 * per-frame draw-pass declutter stays authoritative over what paints.
 *
 * @param {Array<{id:string,sx:number,sy:number,rankKm:number}>} candidates
 * @param {Object} [options]
 * @param {number} [options.budget] - Max ids returned.
 * @param {number} [options.viewW] - Viewport width (CSS px).
 * @param {number} [options.viewH] - Viewport height (CSS px).
 * @param {number} [options.cols]
 * @param {number} [options.rows]
 * @returns {string[]} Winner ids in priority order (cell winners, then
 *   global-rank fill).
 */
export function distributeCctvCards(candidates, {
  budget = CCTV_AMBIENT_CARD_MAX,
  viewW = 0,
  viewH = 0,
  cols = CCTV_CARD_GRID_COLS,
  rows = CCTV_CARD_GRID_ROWS,
} = {}) {
  const cap = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
  const valid = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && typeof c.id === 'string' && c.id
      && Number.isFinite(c.sx) && Number.isFinite(c.sy));
  if (!cap || !valid.length) return [];
  const validViewport = hasFiniteCctvViewport(viewW, viewH);
  const width = validViewport ? viewW : 1;
  const height = validViewport ? viewH : 1;
  const nCols = Math.max(1, Math.floor(cols));
  const nRows = Math.max(1, Math.floor(rows));
  const byRank = (a, b) => (Number.isFinite(a.rankKm) ? a.rankKm : Infinity)
    - (Number.isFinite(b.rankKm) ? b.rankKm : Infinity)
    || a.id.localeCompare(b.id);

  /** @type {Map<number, Array>} occupied cell -> its candidates */
  const cells = new Map();
  for (const candidate of valid) {
    const col = Math.min(nCols - 1, Math.max(0, Math.floor((candidate.sx / width) * nCols)));
    const row = Math.min(nRows - 1, Math.max(0, Math.floor((candidate.sy / height) * nRows)));
    const key = row * nCols + col;
    const bucket = cells.get(key);
    if (bucket) bucket.push(candidate);
    else cells.set(key, [candidate]);
  }

  const cellBest = [];
  const rest = [];
  for (const bucket of cells.values()) {
    bucket.sort(byRank);
    cellBest.push(bucket[0]);
    for (let i = 1; i < bucket.length; i++) rest.push(bucket[i]);
  }
  cellBest.sort(byRank);
  rest.sort(byRank);

  const picked = cellBest.slice(0, cap);
  for (const candidate of rest) {
    if (picked.length >= cap) break;
    picked.push(candidate);
  }
  return picked.map((candidate) => candidate.id);
}

/**
 * Selects the ambient card cameras from already projected in-view
 * candidates: nearest-first up to the zoom budget. Static image cameras
 * only — video cameras stay icon-only until explicitly activated (the frame
 * endpoint pacing is built for stills), and the ACTIVE camera is excluded
 * upstream by the caller (its monitor plane is the richer representation).
 * Cameras in `incumbentIds` (current card holders) rank with the 20%
 * incumbency discount (finding 4) so the ring changes gradually.
 *
 * When the caller supplies viewport dimensions (`viewW`/`viewH`) and screen
 * anchors (`sx`/`sy` per candidate), ranking blends eye distance with
 * screen-center offset before the existing screen-distribution pass. Without
 * screen info the original nearest-first cap applies unchanged.
 *
 * @param {Array<{id:string,distanceKm:number,inView:boolean,isVideo?:boolean,sx?:number,sy?:number}>} candidates
 * @param {Object} [options]
 * @param {number} [options.cameraHeightM]
 * @param {Iterable<string>|Set<string>} [options.incumbentIds]
 * @param {number} [options.viewW] - Viewport width (CSS px) — enables the
 *   screen-distribution pass.
 * @param {number} [options.viewH] - Viewport height (CSS px).
 * @returns {{cardIds:string[],budgets:{cardLimit:number}}}
 */
export function selectCctvLod(candidates, { cameraHeightM, incumbentIds, viewW, viewH } = {}) {
  const budgets = cctvLodBudgets(cameraHeightM);
  const incumbents = incumbentIds instanceof Set ? incumbentIds : new Set(incumbentIds || []);
  const screened = hasFiniteCctvViewport(viewW, viewH);
  if (!screened) {
    // Preserve the pre-refinement nearest-first path byte-for-behavior,
    // including its acceptance of any non-empty string ID. The stricter
    // valid-viewport rules below must not leak into this compatibility branch.
    const inView = (Array.isArray(candidates) ? candidates : [])
      .filter((candidate) => candidate && typeof candidate.id === 'string' && candidate.id)
      .map((candidate) => ({
        id: candidate.id,
        distanceKm: Number.isFinite(candidate.distanceKm) ? Math.max(0, candidate.distanceKm) : Infinity,
        rankKm: incumbentRankKm(candidate.distanceKm, incumbents.has(candidate.id)),
        inView: candidate.inView === true,
        isVideo: candidate.isVideo === true,
      }))
      .filter((candidate) => candidate.inView)
      .sort((a, b) => (
        a.rankKm - b.rankKm
        || a.distanceKm - b.distanceKm
        || a.id.localeCompare(b.id)
      ));
    const cardIds = [];
    const seen = new Set();
    for (const candidate of inView) {
      if (candidate.isVideo || seen.has(candidate.id)) continue;
      cardIds.push(candidate.id);
      seen.add(candidate.id);
      if (cardIds.length >= budgets.cardLimit) break;
    }
    return { cardIds, budgets };
  }
  const eligibleById = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id.trim()
      || candidate.inView !== true || candidate.isVideo === true
      || !Number.isFinite(candidate.distanceKm)) continue;
    const normalized = {
      id: candidate.id,
      distanceKm: Math.max(0, candidate.distanceKm),
      rankKm: Infinity,
      sx: Number.isFinite(candidate.sx) ? candidate.sx : NaN,
      sy: Number.isFinite(candidate.sy) ? candidate.sy : NaN,
    };
    const current = eligibleById.get(normalized.id);
    if (!current || compareCctvRepresentative(normalized, current, { screened, viewW, viewH }) < 0) {
      eligibleById.set(normalized.id, normalized);
    }
  }

  // Only rankable, still-image, in-view, deduplicated candidates influence the
  // robust distance scale or consume a bounded ambient-card slot.
  const stills = [...eligibleById.values()];

  const spreadKm = cctvCandidateSpreadKm(stills.map((candidate) => candidate.distanceKm));
  for (const candidate of stills) {
    const blendedKm = blendCenterRankKm(
      candidate.distanceKm,
      screenCenterFraction(candidate.sx, candidate.sy, viewW, viewH),
      spreadKm,
    );
    candidate.rankKm = incumbentRankKm(blendedKm, incumbents.has(candidate.id));
  }
  stills.sort((a, b) => (
    a.rankKm - b.rankKm
    || a.distanceKm - b.distanceKm
    || a.id.localeCompare(b.id)
  ));

  let cardIds;
  // Item C: screen-distributed fill. Candidates lacking screen anchors are
  // dropped by the distribution pass; top up from the ranked pool
  // (defensive — cctv.js always projects anchors for in-view candidates).
  cardIds = distributeCctvCards(stills, { budget: budgets.cardLimit, viewW, viewH });
  if (cardIds.length < budgets.cardLimit) {
    const chosen = new Set(cardIds);
    for (const candidate of stills) {
      if (cardIds.length >= budgets.cardLimit) break;
      if (!chosen.has(candidate.id)) cardIds.push(candidate.id);
    }
  }

  return { cardIds, budgets };
}

function compareCctvRepresentative(a, b, { screened, viewW, viewH }) {
  if (a.distanceKm !== b.distanceKm) return a.distanceKm < b.distanceKm ? -1 : 1;
  if (screened) {
    const centerDelta = screenCenterFraction(a.sx, a.sy, viewW, viewH)
      - screenCenterFraction(b.sx, b.sy, viewW, viewH);
    if (centerDelta) return centerDelta;
  }
  const ax = Number.isFinite(a.sx) ? a.sx : Infinity;
  const bx = Number.isFinite(b.sx) ? b.sx : Infinity;
  if (ax !== bx) return ax < bx ? -1 : 1;
  const ay = Number.isFinite(a.sy) ? a.sy : Infinity;
  const by = Number.isFinite(b.sy) ? b.sy : Infinity;
  if (ay !== by) return ay < by ? -1 : 1;
  return 0;
}

export const CCTV_LOD_GRACE_PASSES = 2;
export const CCTV_LOD_GRACE_MS = 5_000;

/**
 * Eviction-grace hysteresis for the ambient card set (Part C review finding
 * P2, kept verbatim).
 *
 * Raw per-pass selection has no memory: a camera sitting at the edge of the
 * card budget churns in/out on every small camera move, blinking its card
 * while orbiting. This planner keeps an already-built card alive for a short
 * grace window after it falls out of the selection — it is only dropped once
 * it STAYS unselected for `gracePasses` consecutive selection passes or
 * `graceMs` of wall time, whichever is crossed first. A newly selected
 * camera always enters immediately, and the hard `cardLimit` cap is never
 * exceeded: when selected + graced cards would overflow the budget,
 * grace-period cards are evicted first, oldest-in-grace first.
 *
 * Pure function: `graceState` is never mutated; the returned `graceState`
 * replaces it for the next pass.
 *
 * @param {Object} [input]
 * @param {string[]} [input.selectedIds] - This pass's selected card ids
 *   (already budget-capped, nearest-first — `selectCctvLod().cardIds` after
 *   declutter).
 * @param {string[]} [input.builtIds] - Ids that currently have a live card.
 * @param {Map<string,{misses:number,since:number}>} [input.graceState] - Prior
 *   pass's grace bookkeeping (id -> consecutive misses + first-miss timestamp).
 * @param {number} [input.nowMs] - Current wall time in ms.
 * @param {number} [input.cardLimit] - Hard cap on total kept cards.
 * @param {number} [input.gracePasses] - Consecutive unselected passes tolerated.
 * @param {number} [input.graceMs] - Max wall-time a card may linger in grace.
 * @returns {{keepIds:string[], evictIds:string[], graceState:Map<string,{misses:number,since:number}>}}
 */
export function applyEvictionGrace({
  selectedIds = [],
  builtIds = [],
  graceState = new Map(),
  nowMs = 0,
  cardLimit = CCTV_AMBIENT_CARD_MAX,
  gracePasses = CCTV_LOD_GRACE_PASSES,
  graceMs = CCTV_LOD_GRACE_MS,
} = {}) {
  const selectedSet = new Set(selectedIds);
  const keepIds = [...selectedSet];
  const evictIds = [];
  const nextGrace = new Map();

  const graced = [];
  for (const id of builtIds) {
    if (typeof id !== 'string' || !id || selectedSet.has(id)) continue;
    const prior = graceState.get(id);
    const misses = (prior?.misses || 0) + 1;
    const since = Number.isFinite(prior?.since) ? prior.since : nowMs;
    if (misses > gracePasses || nowMs - since >= graceMs) {
      evictIds.push(id);
    } else {
      graced.push({ id, misses, since });
    }
  }

  // Under cap pressure the grace-period cards go first, oldest-in-grace
  // first (they have had the longest chance to return); ties break on more
  // misses, then id for determinism.
  graced.sort((a, b) => a.since - b.since || b.misses - a.misses || a.id.localeCompare(b.id));
  const capacity = Math.max(0, cardLimit - keepIds.length);
  const overflow = Math.max(0, graced.length - capacity);
  for (let i = 0; i < graced.length; i++) {
    if (i < overflow) {
      evictIds.push(graced[i].id);
      continue;
    }
    keepIds.push(graced[i].id);
    nextGrace.set(graced[i].id, { misses: graced[i].misses, since: graced[i].since });
  }

  return { keepIds, evictIds, graceState: nextGrace };
}

/**
 * Returns the source-aware static-frame refresh cadence. An explicit source
 * value wins, bounded to one minute through twenty minutes; otherwise known
 * public-pack cadences provide conservative defaults.
 *
 * @param {Object} camera
 * @returns {number}
 */
export function staticFrameRefreshMs(camera) {
  const explicit = Number(camera?.frameRefreshMs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(60_000, Math.min(20 * 60 * 1000, Math.round(explicit)));
  }
  const provider = String(camera?.provider || '').trim().toLowerCase();
  return PROVIDER_STATIC_REFRESH_MS[provider] || DEFAULT_STATIC_REFRESH_MS;
}
