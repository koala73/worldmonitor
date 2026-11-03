/**
 * Route-shape regression lock for #6182.
 *
 * A retailer's `urlPathContains` filter decides which discovered URLs are even
 * attempted. When it points at a route the retailer has retired, discovery logs
 * a healthy "N URLs passed host/path check" and every one of them is a 404 SPA
 * shell, so the loss surfaces as `missing-price` and looks like an extraction
 * problem. These cases were confirmed live against the retailers on 2026-08-05:
 *
 *   jiomart.com/product/onion-1-kg-pack-mffneb-7550741   → 200, renders, ₹37
 *   jiomart.com/p/groceries/onion-1-kg/590001600         → 200, "We couldn't
 *                                                           find the page",
 *                                                           3.6KB shell (5/5
 *                                                           sampled /p/ URLs)
 *   coldstorage.com.sg/product/evian-natural-mineral-water-1-5l → live route
 *                                                           Exa returns and the
 *                                                           `/p/` filter drops
 *
 * Exa returns BOTH shapes for these retailers, so the filter — not the
 * extractor — decides whether the live page is ever fetched.
 */
import { describe, expect, it } from 'vitest';
import { loadRetailerConfig } from '../config/loader.js';
import { matchesAnyPathFilter, normalizePathFilters } from './search.js';

function filtersFor(slug: string): string[] {
  return normalizePathFilters(loadRetailerConfig(slug).searchConfig?.urlPathContains);
}

describe('retailer product-route filters admit the live route', () => {
  it('jiomart_in admits the live /product/ route', () => {
    const filters = filtersFor('jiomart_in');
    expect(matchesAnyPathFilter('https://www.jiomart.com/product/onion-1-kg-pack-mffneb-7550741', filters)).toBe(true);
    expect(matchesAnyPathFilter('https://www.jiomart.com/product/tomato-hybrid-mix1gg-35767197', filters)).toBe(true);
  });

  it('jiomart_in does not send the scrape at the retired /p/groceries/ route', () => {
    const filters = filtersFor('jiomart_in');
    expect(matchesAnyPathFilter('https://www.jiomart.com/p/groceries/onion-1-kg/590001600', filters)).toBe(false);
    expect(matchesAnyPathFilter('https://www.jiomart.com/p/groceries/white-bread-400-gm/491390026', filters)).toBe(false);
  });

  it('coldstorage_sg admits both live product routes', () => {
    const filters = filtersFor('coldstorage_sg');
    // Catalogue route.
    expect(
      matchesAnyPathFilter('https://coldstorage.com.sg/en/p/Meadows%20Fresh%20Full%20Cream%20Milk%201l/i/101677183.html', filters),
    ).toBe(true);
    // Legacy slug route — the only shape Exa returns for mineral water, and the
    // single page coldstorage_sg loses at the discovery filter today.
    expect(matchesAnyPathFilter('https://coldstorage.com.sg/product/evian-natural-mineral-water-1-5l', filters)).toBe(true);
  });

  it('keeps every priority retailer filter anchored to a path segment', () => {
    // A bare substring like "p" would match any URL; each filter must look like
    // a path segment so the host allowlist is not the only real constraint.
    for (const slug of ['jiomart_in', 'noon_grocery_ae', 'noon_sa', 'carrefour_sa', 'coldstorage_sg']) {
      const filters = filtersFor(slug);
      expect(filters.length).toBeGreaterThan(0);
      for (const f of filters) expect(f.startsWith('/')).toBe(true);
    }
  });

  // Confirmed live 2026-10-29. Coop ends every product URL in `/p/<id>` under a
  // per-language category tree; Naivas serves products from root slugs, so its
  // old `/product/` filter rejected all 12 essentials-ke URLs Exa returned.
  it('coop_ch admits product pages in every site language and drops corporate pages', () => {
    const filters = filtersFor('coop_ch');
    expect(
      matchesAnyPathFilter(
        'https://www.coop.ch/de/lebensmittel/vorraete/grundnahrungsmittel/mehl-zucker/kristallzucker-rohrzucker/prix-garantie-feinkristallzucker/p/6582329',
        filters,
      ),
    ).toBe(true);
    expect(matchesAnyPathFilter('https://www.coop.ch/fr/nourriture/produits-laitiers-oeufs/lait/lait-entier/p/3045429', filters)).toBe(true);
    expect(matchesAnyPathFilter('https://www.coop.ch/de/unternehmen/medien/medienmitteilungen.html', filters)).toBe(false);
  });

  it('naivas_ke admits root-slug product pages', () => {
    const filters = filtersFor('naivas_ke');
    expect(matchesAnyPathFilter('https://www.naivas.online/brookside-fresh-milk-500ml-std', filters)).toBe(true);
  });

  it('runs Kenya and Switzerland on keyword search behind the strict validator', () => {
    for (const slug of ['naivas_ke', 'coop_ch']) {
      const config = loadRetailerConfig(slug);
      expect(config.enabled, slug).toBe(true);
      expect(config.searchConfig?.searchType, slug).toBe('keyword');
      expect(config.searchConfig?.requireStrictValidator, slug).toBe(true);
      expect(config.searchConfig?.requirePageTitleMatch, slug).toBe(true);
    }
  });
});
