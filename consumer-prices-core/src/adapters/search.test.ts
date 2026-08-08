import { describe, it, expect } from 'vitest';
import {
  isTitlePlausible,
  isAllowedHost,
  normalizeAllowedHosts,
  normalizePathFilters,
  matchesAnyPathFilter,
  matchesRequiredPathSegments,
  looksLikeQuantityAsPrice,
} from './search.js';

describe('isAllowedHost', () => {
  it('accepts exact domain match', () => {
    expect(isAllowedHost('https://www.luluhypermarket.com/ae/eggs', 'luluhypermarket.com')).toBe(false);
    expect(isAllowedHost('https://luluhypermarket.com/ae/eggs', 'luluhypermarket.com')).toBe(true);
  });

  it('accepts proper subdomain', () => {
    expect(isAllowedHost('https://www.luluhypermarket.com/ae/eggs', 'luluhypermarket.com')).toBe(false);
    // www is a subdomain — but our allowedHost is the bare hostname from baseUrl
    expect(isAllowedHost('https://www.luluhypermarket.com/item', 'www.luluhypermarket.com')).toBe(true);
  });

  it('blocks domain with shared suffix (no dot boundary)', () => {
    expect(isAllowedHost('https://evilluluhypermarket.com/page', 'luluhypermarket.com')).toBe(false);
  });

  it('blocks entirely different domain', () => {
    expect(isAllowedHost('https://amazon.com/eggs', 'noon.com')).toBe(false);
  });

  it('handles malformed URLs gracefully', () => {
    expect(isAllowedHost('not-a-url', 'noon.com')).toBe(false);
    expect(isAllowedHost('', 'noon.com')).toBe(false);
  });

  it('accepts only explicitly configured host aliases', () => {
    expect(isAllowedHost('https://minutes.noon.com/uae-en/now-product/ABC', ['www.noon.com', 'minutes.noon.com'])).toBe(true);
    expect(isAllowedHost('https://evil-noon.com/uae-en/now-product/ABC', ['www.noon.com', 'minutes.noon.com'])).toBe(false);
  });
});

describe('normalizeAllowedHosts', () => {
  it('keeps the base host, removes duplicates, and normalizes aliases', () => {
    expect(normalizeAllowedHosts('www.noon.com', [' minutes.noon.com ', 'www.noon.com'])).toEqual([
      'www.noon.com',
      'minutes.noon.com',
    ]);
  });
});

describe('isTitlePlausible', () => {
  it('accepts when product name contains canonical tokens', () => {
    expect(isTitlePlausible('Eggs Fresh 12 Pack', 'Farm Fresh Eggs 12 Pack White')).toBe(true);
    expect(isTitlePlausible('Milk 1L', 'Almarai Full Fat Fresh Milk 1 Litre')).toBe(true);
    expect(isTitlePlausible('Basmati Rice 1kg', 'Tilda Pure Basmati Rice 1kg')).toBe(true);
  });

  it('rejects gross mismatches (seeds vs vegetables)', () => {
    expect(isTitlePlausible('Tomatoes Fresh 1kg', 'GGOOT Tomato Seeds 100 pcs Vegetable Garden')).toBe(false);
    expect(isTitlePlausible('Onions 1kg', 'Red Karmen Onion Sets for Planting x200')).toBe(false);
    expect(isTitlePlausible('Eggs Fresh 12 Pack', 'Generic 12 Grids Egg Storage Box Container')).toBe(false);
  });

  it('rejects when productName is undefined or empty', () => {
    expect(isTitlePlausible('Milk 1L', undefined)).toBe(false);
    expect(isTitlePlausible('Milk 1L', '')).toBe(false);
  });

  it('handles short canonical names with single-token check', () => {
    // "Milk" → 1 token, need ≥1 match
    expect(isTitlePlausible('Milk', 'Fresh Pasteurized Milk 1L')).toBe(true);
    expect(isTitlePlausible('Milk', 'Orange Juice 1L')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isTitlePlausible('EGGS FRESH 12 PACK', 'farm fresh eggs 12 pack')).toBe(true);
  });

  it('ignores short tokens (≤2 chars)', () => {
    // "1L" → filtered out, only "Milk" counts
    expect(isTitlePlausible('Milk 1L', 'Fresh Milk Whole 1 Litre')).toBe(true);
  });
});

describe('normalizePathFilters', () => {
  it('returns [] for undefined / empty / falsy', () => {
    expect(normalizePathFilters(undefined)).toEqual([]);
    expect(normalizePathFilters('')).toEqual([]);
  });

  it('wraps a single string in an array', () => {
    expect(normalizePathFilters('/p/')).toEqual(['/p/']);
  });

  it('passes arrays through, dropping empty strings', () => {
    expect(normalizePathFilters(['/produto/', '/p'])).toEqual(['/produto/', '/p']);
    expect(normalizePathFilters(['/produto/', '', '/p'])).toEqual(['/produto/', '/p']);
  });
});

describe('matchesAnyPathFilter', () => {
  it('passes any URL when filter list is empty (no constraint)', () => {
    expect(matchesAnyPathFilter('https://x.com/whatever', [])).toBe(true);
  });

  it('passes when at least one filter matches (multi-pattern Carrefour BR fix)', () => {
    // Real URLs Exa returns for mercado.carrefour.com.br — the previous
    // single-substring `/p/` filter rejected all of them.
    const filters = ['/produto/', '/p'];
    expect(matchesAnyPathFilter('https://mercado.carrefour.com.br/produto/arroz-4289', filters)).toBe(true);
    expect(matchesAnyPathFilter('https://mercado.carrefour.com.br/arroz-saboroso-1kg-6565310/p', filters)).toBe(true);
    expect(matchesAnyPathFilter('https://mercado.carrefour.com.br/busca/arroz%20branco', filters)).toBe(false);
  });

  it('Cold Storage SG: `/p/` matches /en/p/<name>/i/<id>.html (not /product/)', () => {
    // Real URLs Exa returns for coldstorage.com.sg — the previous
    // `/product/` filter matched zero of them.
    const filters = ['/p/'];
    expect(
      matchesAnyPathFilter('https://coldstorage.com.sg/en/p/Chews%20Eggs%2010s/i/101640975.html', filters),
    ).toBe(true);
    expect(matchesAnyPathFilter('https://coldstorage.com.sg/category/eggs', filters)).toBe(false);
  });

  it('rejects when no filter matches', () => {
    expect(matchesAnyPathFilter('https://x.com/category/foo', ['/product/', '/item/'])).toBe(false);
  });

  // Documents a known tradeoff for the carrefour_br fix: `/p` over-matches
  // non-product paths like `/promo/`, `/pages/`, `/popular/`, `/help/`.
  // Acceptable because (a) the host check already pins us to the storefront,
  // (b) Firecrawl extraction rejects pages with no price/title at the next
  // stage. Cost is one extra Firecrawl call per false-positive URL. If this
  // ever shows up as material API spend, swap to regex with `/p$` anchor.
  // Update: PR review (codex) round 2 P2 — see carrefour_br.yaml comment.
  it('Carrefour BR `/p` filter: known over-match cases (acceptable tradeoff)', () => {
    const filters = ['/produto/', '/p'];
    // These are NOT product URLs but the loose `/p` substring matches them.
    // Documenting so a future tightening (regex `/p$`) has a regression test
    // to flip — these should become `false` once the filter is anchored.
    expect(matchesAnyPathFilter('https://mercado.carrefour.com.br/promocoes/semana', filters)).toBe(true);
    expect(matchesAnyPathFilter('https://mercado.carrefour.com.br/pages/about', filters)).toBe(true);
    expect(matchesAnyPathFilter('https://mercado.carrefour.com.br/popular/today', filters)).toBe(true);
  });
});

describe('matchesRequiredPathSegments', () => {
  it('passes any URL when no segments are configured', () => {
    expect(matchesRequiredPathSegments('https://www.noon.com/uae-en/milk/N1/p/', [])).toBe(true);
  });

  it('admits the configured storefront on both noon hosts', () => {
    expect(matchesRequiredPathSegments('https://www.noon.com/saudi-en/milk/N1/p/', ['/saudi-en/'])).toBe(true);
    expect(matchesRequiredPathSegments('https://minutes.noon.com/saudi-en/now-product/milk-1', ['/saudi-en/'])).toBe(
      true,
    );
  });

  it('rejects a foreign storefront on the same hosts', () => {
    expect(matchesRequiredPathSegments('https://www.noon.com/uae-en/milk/N1/p/', ['/saudi-en/'])).toBe(false);
    expect(matchesRequiredPathSegments('https://minutes.noon.com/egypt-en/now-product/milk-1', ['/saudi-en/'])).toBe(
      false,
    );
  });

  it('matches the pathname only, so query and fragment cannot satisfy it', () => {
    expect(matchesRequiredPathSegments('https://www.noon.com/uae-en/milk/N1/p/?ref=/saudi-en/', ['/saudi-en/'])).toBe(
      false,
    );
    expect(matchesRequiredPathSegments('https://www.noon.com/uae-en/milk/N1/p/#/saudi-en/', ['/saudi-en/'])).toBe(
      false,
    );
  });

  it('requires every listed segment, not any', () => {
    expect(matchesRequiredPathSegments('https://x.example/saudi-en/p/', ['/saudi-en/', '/grocery/'])).toBe(false);
    expect(matchesRequiredPathSegments('https://x.example/saudi-en/grocery/p/', ['/saudi-en/', '/grocery/'])).toBe(true);
  });

  it('fails closed on a malformed URL', () => {
    expect(matchesRequiredPathSegments('not-a-url', ['/saudi-en/'])).toBe(false);
    expect(matchesRequiredPathSegments('', ['/saudi-en/'])).toBe(false);
  });
});

describe('looksLikeQuantityAsPrice', () => {
  it('rejects a quantity echoed as a price for weighted products', () => {
    expect(looksLikeQuantityAsPrice(400, '400g', { baseUnit: 'g' })).toBe(true);
    expect(looksLikeQuantityAsPrice(1000, '1kg', { baseUnit: 'g' })).toBe(true);
    expect(looksLikeQuantityAsPrice(400, undefined, { baseUnit: 'g' }, 'White Bread 400g')).toBe(true);
  });

  it('does not reject normal prices or count-based products', () => {
    expect(looksLikeQuantityAsPrice(4.95, '500g', { baseUnit: 'g' })).toBe(false);
    expect(looksLikeQuantityAsPrice(12, '12 ct', { baseUnit: 'ct' })).toBe(false);
  });

  // The canonical-name fallback must fire whenever sizeText does not PARSE,
  // not only when it is absent — `??` would let these through.
  it('falls back to the canonical size when sizeText is blank or unparseable', () => {
    expect(looksLikeQuantityAsPrice(400, '', { baseUnit: 'g' }, 'White Bread 400g')).toBe(true);
    expect(looksLikeQuantityAsPrice(400, '   ', { baseUnit: 'g' }, 'White Bread 400g')).toBe(true);
    // `gm` and `pack` are absent from UNIT_MAP, so parseSize returns null.
    expect(looksLikeQuantityAsPrice(400, '400 gm', { baseUnit: 'g' }, 'White Bread 400g')).toBe(true);
    expect(looksLikeQuantityAsPrice(400, '24 pack', { baseUnit: 'g' }, 'White Bread 400g')).toBe(true);
  });

  it('still prefers a parseable sizeText over the canonical name', () => {
    // Real 2kg pack priced 400: the page size disagrees with the price, so this
    // is a genuine price, not an echo — the canonical 400g must not override it.
    expect(looksLikeQuantityAsPrice(400, '2kg', { baseUnit: 'g' }, 'White Bread 400g')).toBe(false);
  });
});
