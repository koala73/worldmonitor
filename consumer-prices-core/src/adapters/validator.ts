/**
 * Structured search-hit validator — deterministic post-extraction gate that
 * replaces the boolean `isTitlePlausible` check for scoring and candidate
 * triage. Evaluates:
 *   1. class-error rejects (basket item's negativeTokens present in title)
 *   2. non-food indicator rejects (shared with legacy gate)
 *   3. token-overlap score (identity tokens from canonicalName vs productName)
 *   4. quantity-window conformance (minBaseQty <= extractedBase <= maxBaseQty)
 *
 * Score is a 0..1 float combining the three positive signals so callers can
 * make graduated decisions (auto vs candidate) instead of the legacy 1.0 shortcut.
 * Reasons are returned so shadow mode and evidence_json can be human-readable.
 */
import { parseSize } from '../normalizers/size.js';
import type { BasketItem } from '../config/types.js';

/**
 * Base units that measure the product's CONTENT.
 *
 * `ct` is deliberately excluded: a count unit on either side proves nothing
 * about content, because a count item routinely carries a packaging weight
 * ("Fresh Eggs 10 Pack" listed as "660g") and a mass item can be listed by
 * slice count.
 */
const CONTENT_MEASURE_UNITS = new Set(['g', 'ml']);

/**
 * Plausible density band for grocery goods, grams per millilitre. Water and
 * most dairy sit near 1.0 and cooking oil near 0.92; the band is deliberately
 * wide because it exists to answer "could this size describe the same product
 * at all?", not to convert precisely.
 *
 * This is what makes a cross-dimension size decidable by MAGNITUDE rather than
 * by the unit token. Judging on the token alone fails in both directions: `oz`
 * maps to grams but US retail writes fluid ounces identically, so exempting
 * the ounce family would re-admit a 128oz jug as the 48oz item (defect A
 * again), while rejecting every mass-vs-volume mismatch would throw away a
 * correct 1L oil bottle whose label reads "910 g".
 */
const DENSITY_G_PER_ML_MIN = 0.8;
const DENSITY_G_PER_ML_MAX = 1.2;

export type SizeWindowStatus = 'pass' | 'fail' | 'unit-mismatch' | 'absent' | 'unverified';

export interface ValidatorInput {
  canonicalName: string;
  productName: string | undefined;
  sizeText: string | undefined;
  item: Pick<BasketItem, 'baseUnit' | 'minBaseQty' | 'maxBaseQty' | 'negativeTokens'>;
}

export interface ValidatorResult {
  ok: boolean;
  score: number;
  reasons: string[];
  signals: {
    tokenOverlap: number;
    negativeTokenHit: string | null;
    nonFoodIndicatorHit: string | null;
    sizeWindow: SizeWindowStatus;
    extractedBaseQty: number | null;
    /** Base unit the extracted size parsed to — disambiguates `extractedBaseQty`. */
    extractedBaseUnit: string | null;
  };
}

const PACKAGING_WORDS = new Set([
  'pack', 'box', 'bag', 'container', 'bottle', 'can', 'jar', 'tin', 'set', 'kit', 'bundle',
]);

const NON_FOOD_INDICATORS = new Set([
  'seeds', 'seed', 'seedling', 'seedlings', 'planting', 'fertilizer', 'fertiliser',
]);

function stem(w: string): string {
  return w.replace(/ies$/, 'y').replace(/es$/, '').replace(/s$/, '');
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/\W+/).filter(Boolean);
}

// Compact size tokens (e.g. "1kg", "500g", "250ml", "12pk") must be stripped
// from identity tokens. The quantity-window check already handles size
// fidelity. Carrying them here creates systematic false misses because
// Firecrawl usually emits size spaced ("1 kg"), which tokenises to
// ["1","kg"] — both below the length>2 floor — so the "1kg" token can
// never match. For short canonical names like "Onions 1kg" that drops
// overlap from 1.0 to 0.5 and pushes valid hits below AUTO_MATCH_THRESHOLD.
const SIZE_LIKE = /^\d+(?:\.\d+)?[a-z]+$/;

function identityTokens(canonicalName: string): string[] {
  return tokens(canonicalName).filter(
    (w) => w.length > 2 && !PACKAGING_WORDS.has(w) && !SIZE_LIKE.test(w),
  );
}

function computeTokenOverlap(canonicalName: string, productName: string): number {
  const ids = identityTokens(canonicalName);
  if (ids.length === 0) return 1;
  const haystack = productName.toLowerCase();
  const hits = ids.filter((w) => {
    if (haystack.includes(w)) return true;
    const s = stem(w);
    return s.length >= 4 && s !== w && haystack.includes(s);
  });
  return hits.length / ids.length;
}

function findNegativeToken(productName: string, negativeTokens: readonly string[] | undefined): string | null {
  if (!negativeTokens || negativeTokens.length === 0) return null;
  const titleTokens = new Set(tokens(productName));
  const lowered = productName.toLowerCase();
  for (const raw of negativeTokens) {
    const t = raw.toLowerCase().trim();
    if (!t) continue;
    // Multi-word entries (e.g. "plant-based") are substring-matched; single
    // words use whole-token match so "pastelaria" never matches "past".
    if (t.includes(' ') || t.includes('-')) {
      if (lowered.includes(t)) return raw;
    } else if (titleTokens.has(t)) {
      return raw;
    }
  }
  return null;
}

function findNonFoodIndicator(productName: string): string | null {
  for (const w of tokens(productName)) {
    if (NON_FOOD_INDICATORS.has(w)) return w;
  }
  return null;
}

function evaluateSizeWindow(
  sizeText: string | undefined,
  item: ValidatorInput['item'],
): { status: SizeWindowStatus; baseQty: number | null; baseUnit: string | null } {
  // `absent` = nothing to verify (no window configured, or no sizeText at all).
  // `unverified` = a size was present but we declined or failed to judge it
  // (unparseable text, or a deliberate carve-out). Downstream scoring treats
  // these differently — see sizeComponent in validateSearchHit (#6868).
  const absent = { status: 'absent' as const, baseQty: null, baseUnit: null };
  if (item.minBaseQty == null && item.maxBaseQty == null) return absent;
  if (!sizeText) return absent;
  const parsed = parseSize(sizeText);
  if (!parsed) return { status: 'unverified', baseQty: null, baseUnit: null };

  const min = item.minBaseQty ?? 0;
  const max = item.maxBaseQty ?? Number.POSITIVE_INFINITY;

  if (parsed.baseUnit !== item.baseUnit) {
    // A count unit on either side carries no content information at all.
    if (!CONTENT_MEASURE_UNITS.has(item.baseUnit) || !CONTENT_MEASURE_UNITS.has(parsed.baseUnit)) {
      return { status: 'unverified', baseQty: parsed.baseQuantity, baseUnit: parsed.baseUnit };
    }
    // Both sides measure content, in different dimensions. Convert across the
    // density band and reject only when NO plausible density lands the product
    // inside the window: a 160g tin is not 1.5L of water at any density, but a
    // 910g label on a 1L oil bottle is the same product and must survive.
    const [lo, hi] =
      item.baseUnit === 'ml'
        ? [parsed.baseQuantity / DENSITY_G_PER_ML_MAX, parsed.baseQuantity / DENSITY_G_PER_ML_MIN]
        : [parsed.baseQuantity * DENSITY_G_PER_ML_MIN, parsed.baseQuantity * DENSITY_G_PER_ML_MAX];
    const plausible = hi >= min && lo <= max;
    return {
      status: plausible ? 'unverified' : 'unit-mismatch',
      baseQty: parsed.baseQuantity,
      baseUnit: parsed.baseUnit,
    };
  }

  const q = parsed.baseQuantity;
  return { status: q >= min && q <= max ? 'pass' : 'fail', baseQty: q, baseUnit: parsed.baseUnit };
}

export function validateSearchHit(input: ValidatorInput): ValidatorResult {
  const reasons: string[] = [];
  const signals: ValidatorResult['signals'] = {
    tokenOverlap: 0,
    negativeTokenHit: null,
    nonFoodIndicatorHit: null,
    sizeWindow: 'absent',
    extractedBaseQty: null,
    extractedBaseUnit: null,
  };

  if (!input.productName) {
    reasons.push('empty-product-name');
    return { ok: false, score: 0, reasons, signals };
  }

  const nonFood = findNonFoodIndicator(input.productName);
  signals.nonFoodIndicatorHit = nonFood;
  if (nonFood) reasons.push(`non-food-indicator:${nonFood}`);

  const negHit = findNegativeToken(input.productName, input.item.negativeTokens);
  signals.negativeTokenHit = negHit;
  if (negHit) reasons.push(`negative-token:${negHit}`);

  const overlap = computeTokenOverlap(input.canonicalName, input.productName);
  signals.tokenOverlap = overlap;
  const overlapFloor = 0.4;
  if (overlap < overlapFloor) reasons.push(`low-token-overlap:${overlap.toFixed(2)}`);

  const sizeEval = evaluateSizeWindow(input.sizeText, input.item);
  signals.sizeWindow = sizeEval.status;
  signals.extractedBaseQty = sizeEval.baseQty;
  signals.extractedBaseUnit = sizeEval.baseUnit;
  if (sizeEval.status === 'fail') {
    reasons.push(`size-window-fail:${sizeEval.baseQty}${input.item.baseUnit ?? ''}`);
  } else if (sizeEval.status === 'unit-mismatch') {
    // Distinct from size-window-fail on purpose: the quantity is not merely
    // outside the window, it measures a different dimension than the item.
    reasons.push(`size-unit-mismatch:${sizeEval.baseQty}${sizeEval.baseUnit}-vs-${input.item.baseUnit ?? ''}`);
  }

  // Hard-reject conditions (any single one fails the hit):
  const sizeRejects = sizeEval.status === 'fail' || sizeEval.status === 'unit-mismatch';
  const hardFail = Boolean(nonFood) || Boolean(negHit) || overlap < overlapFloor || sizeRejects;

  // Score combines positive signals even when hard-failing, so candidate rows
  // retain their relative quality for later review.
  // Weights: token overlap 0.55, size 0.35 on pass / 0.2 when absent / 0.05
  // when unverified (#6868), class-clean 0.10. The absent/unverified split
  // keeps "nothing to check" publishing at 0.85 while "could not verify"
  // lands at 0.70 — below AUTO_MATCH_THRESHOLD — on full overlap alone.
  const sizeComponent =
    sizeEval.status === 'pass' ? 0.35
    : sizeEval.status === 'absent' ? 0.2
    : sizeEval.status === 'unverified' ? 0.05
    : 0;
  const classClean = nonFood || negHit ? 0 : 0.1;
  const score = Math.min(1, Math.max(0, overlap * 0.55 + sizeComponent + classClean));

  return { ok: !hardFail, score, reasons, signals };
}

/** Exported for tests + metrics bucketing. */
export const AUTO_MATCH_THRESHOLD = 0.75;
