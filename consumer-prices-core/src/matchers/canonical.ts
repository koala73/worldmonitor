import { normalizeBrand } from '../normalizers/brand.js';
import { parseSize } from '../normalizers/size.js';
import { tokenOverlap } from '../normalizers/title.js';
import type { CanonicalProduct } from '../db/models.js';

export interface RawProduct {
  rawTitle: string;
  rawBrand?: string | null;
  rawSizeText?: string | null;
  categoryText?: string | null;
}

export interface MatchResult {
  canonicalProductId: string;
  score: number;
  status: 'auto' | 'review' | 'reject';
  evidence: {
    brandExact: boolean;
    categoryExact: boolean;
    titleOverlap: number;
    sizeExact: boolean;
    sizeClose: boolean;
    packCountMatch: boolean;
    unitPriceRatioOk: boolean;
  };
}

export function scoreMatch(raw: RawProduct, canonical: CanonicalProduct): MatchResult {
  let score = 0;

  const rawBrandNorm = normalizeBrand(raw.rawBrand)?.toLowerCase();
  const canonBrandNorm = canonical.brandNorm?.toLowerCase();
  const brandExact = !!(rawBrandNorm && canonBrandNorm && rawBrandNorm === canonBrandNorm);
  if (brandExact) score += 30;

  const rawCategory = (raw.categoryText ?? '').toLowerCase();
  const canonCategory = canonical.category.toLowerCase();
  const categoryExact = rawCategory.includes(canonCategory) || canonCategory.includes(rawCategory);
  if (categoryExact) score += 20;

  const overlap = tokenOverlap(raw.rawTitle, canonical.canonicalName);
  score += Math.round(overlap * 15);

  const rawParsed = parseSize(raw.rawSizeText);
  const canonHasSize = canonical.sizeValue !== null;

  let sizeExact = false;
  let sizeClose = false;
  let packCountMatch = false;

  if (rawParsed && canonHasSize && canonical.baseUnit === rawParsed.baseUnit) {
    const ratio = rawParsed.baseQuantity / (canonical.baseQuantity ?? rawParsed.baseQuantity);
    sizeExact = Math.abs(ratio - 1) < 0.01;
    sizeClose = Math.abs(ratio - 1) < 0.05;
    packCountMatch = rawParsed.packCount === 1;

    if (sizeExact) score += 20;
    else if (sizeClose) score += 10;
    if (packCountMatch) score += 10;
  }

  const status: MatchResult['status'] = score >= 85 ? 'auto' : score >= 70 ? 'review' : 'reject';

  return {
    canonicalProductId: canonical.id,
    score,
    status,
    evidence: {
      brandExact,
      categoryExact,
      titleOverlap: overlap,
      sizeExact,
      sizeClose,
      packCountMatch,
      unitPriceRatioOk: false,
    },
  };
}

export function bestMatch(raw: RawProduct, candidates: CanonicalProduct[]): MatchResult | null {
  if (candidates.length === 0) return null;

  const scored = candidates.map((c) => scoreMatch(raw, c));
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  return best.status === 'reject' ? null : best;
}
