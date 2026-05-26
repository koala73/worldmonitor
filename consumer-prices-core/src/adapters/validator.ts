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
    sizeWindow: 'pass' | 'fail' | 'unknown';
    extractedBaseQty: number | null;
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
): { status: 'pass' | 'fail' | 'unknown'; baseQty: number | null } {
  if (item.minBaseQty == null && item.maxBaseQty == null) return { status: 'unknown', baseQty: null };
  if (!sizeText) return { status: 'unknown', baseQty: null };
  const parsed = parseSize(sizeText);
  if (!parsed) return { status: 'unknown', baseQty: null };
  if (parsed.baseUnit !== item.baseUnit) return { status: 'unknown', baseQty: parsed.baseQuantity };
  const min = item.minBaseQty ?? 0;
  const max = item.maxBaseQty ?? Number.POSITIVE_INFINITY;
  const q = parsed.baseQuantity;
  return { status: q >= min && q <= max ? 'pass' : 'fail', baseQty: q };
}

export function validateSearchHit(input: ValidatorInput): ValidatorResult {
  const reasons: string[] = [];
  const signals: ValidatorResult['signals'] = {
    tokenOverlap: 0,
    negativeTokenHit: null,
    nonFoodIndicatorHit: null,
    sizeWindow: 'unknown',
    extractedBaseQty: null,
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
  if (sizeEval.status === 'fail') {
    reasons.push(`size-window-fail:${sizeEval.baseQty}${input.item.baseUnit ?? ''}`);
  }

  // Hard-reject conditions (any single one fails the hit):
  const hardFail = Boolean(nonFood) || Boolean(negHit) || overlap < overlapFloor || sizeEval.status === 'fail';

  // Score combines positive signals even when hard-failing, so candidate rows
  // retain their relative quality for later review.
  // Weights: token overlap 0.55, size 0.35 (or 0.2 neutral when unknown), class-clean 0.10.
  const sizeComponent = sizeEval.status === 'pass' ? 0.35 : sizeEval.status === 'unknown' ? 0.2 : 0;
  const classClean = nonFood || negHit ? 0 : 0.1;
  const score = Math.min(1, Math.max(0, overlap * 0.55 + sizeComponent + classClean));

  return { ok: !hardFail, score, reasons, signals };
}

/** Exported for tests + metrics bucketing. */
export const AUTO_MATCH_THRESHOLD = 0.75;
