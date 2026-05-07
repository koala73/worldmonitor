/**
 * Lazy-fetch fallback for the bilateral-hs4 store.
 *
 * When `comtrade:bilateral-hs4:{iso2}:v1` is missing in Redis, this module
 * fetches the same Comtrade endpoint that `seed-comtrade-bilateral-hs4.mjs`
 * uses, writes the result to Redis with a 30-day TTL, and returns the
 * products for immediate use by `get-route-impact`.
 *
 * Constraints:
 *   - Concurrency cap: 1 fetch at a time (Comtrade public rate ~1 req/sec)
 *   - Timeout: 5s per request (never block the response longer)
 *   - Cache both success (30d) and known-empty (24h)
 *   - On 429: return null + set a 24h negative-cache sentinel
 */

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import UN_TO_ISO2 from '../../../../scripts/shared/un-to-iso2.json';

const COMTRADE_BASE = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const KEY_PREFIX = 'comtrade:bilateral-hs4:';
const LAZY_SENTINEL_PREFIX = 'comtrade:bilateral-hs4-lazy-sentinel:';
const SUCCESS_TTL = 2592000; // 30 days
const EMPTY_TTL = 86400; // 24h
const FETCH_TIMEOUT_MS = 5000;

const HS4_CODES = [
  '2709', '2711', '8542', '8517', '8703', '3004', '7108', '2710',
  '8471', '8411', '7601', '7202', '3901', '2902', '1001', '1201',
  '6204', '0203', '8704', '8708',
];

const HS4_LABELS: Record<string, string> = {
  '2709': 'Crude Petroleum', '2711': 'LNG & Petroleum Gas',
  '8542': 'Semiconductors', '8517': 'Smartphones & Telecom',
  '8703': 'Passenger Vehicles', '3004': 'Pharmaceuticals',
  '7108': 'Gold', '2710': 'Refined Petroleum',
  '8471': 'Computers', '8411': 'Turbojets & Turbines',
  '7601': 'Aluminium', '7202': 'Ferroalloys (Steel)',
  '3901': 'Plastics (Polyethylene)', '2902': 'Chemicals (Hydrocarbons)',
  '1001': 'Wheat', '1201': 'Soybeans',
  '6204': 'Women\'s Suits (Woven)', '0203': 'Pork',
  '8704': 'Commercial Vehicles', '8708': 'Auto Parts',
};

// UN M49 mostly matches UN Comtrade reporterCodes, except India (699, not 356)
// and Taiwan (490 "Other Asia, nes", not 158). Using M49 codes silently yields
// count:0 from the Comtrade API for these two countries.
const COMTRADE_REPORTER_OVERRIDES: Record<string, string> = { IN: '699', TW: '490' };
const ISO2_TO_UN: Record<string, string> = Object.fromEntries(
  Object.entries(UN_TO_ISO2 as Record<string, string>).map(([un, iso]) => [iso, un]),
);
for (const [iso2, code] of Object.entries(COMTRADE_REPORTER_OVERRIDES)) {
  ISO2_TO_UN[iso2] = code;
}

let fetchInFlight = false;

interface ProductExporter {
  partnerCode: number;
  partnerIso2: string;
  value: number;
  share: number;
}

interface CountryProduct {
  hs4: string;
  description: string;
  totalValue: number;
  topExporters: ProductExporter[];
  year: number;
}

interface ParsedRecord {
  cmdCode: string;
  partnerCode: string;
  primaryValue: number;
  year: number;
}

function parseRecords(data: unknown): ParsedRecord[] {
  const records = (data as { data?: unknown[] })?.data ?? [];
  if (!Array.isArray(records)) return [];
  return records
    .filter((r: any) => r && Number(r.primaryValue ?? 0) > 0)
    .map((r: any) => ({
      cmdCode: String(r.cmdCode ?? ''),
      partnerCode: String(r.partnerCode ?? r.partner2Code ?? '000'),
      primaryValue: Number(r.primaryValue ?? 0),
      year: Number(r.period ?? r.refYear ?? 0),
    }));
}

function groupByProduct(records: ParsedRecord[]): CountryProduct[] {
  const byCode = new Map<string, Map<string, { value: number; year: number }>>();
  for (const r of records) {
    if (!byCode.has(r.cmdCode)) byCode.set(r.cmdCode, new Map());
    const partners = byCode.get(r.cmdCode)!;
    const existing = partners.get(r.partnerCode);
    if (!existing || r.primaryValue > existing.value) {
      partners.set(r.partnerCode, { value: r.primaryValue, year: r.year });
    }
  }
  const products: CountryProduct[] = [];
  for (const [hs4, partners] of byCode) {
    const sorted = [...partners.entries()]
      .sort((a, b) => b[1].value - a[1].value)
      .filter(([pc]) => pc !== '0' && pc !== '000');
    const totalValue = sorted.reduce((s, [, v]) => s + v.value, 0);
    if (totalValue <= 0) continue;
    const top5 = sorted.slice(0, 5);
    const years = sorted.map(([, v]) => v.year).filter((y) => y > 0);
    const latestYear = years.length > 0 ? Math.max(...years) : 0;
    products.push({
      hs4,
      description: HS4_LABELS[hs4] ?? hs4,
      totalValue,
      topExporters: top5.map(([pc, v]) => ({
        partnerCode: Number(pc),
        partnerIso2: (UN_TO_ISO2 as Record<string, string>)[pc.padStart(3, '0')] ?? '',
        value: v.value,
        share: totalValue > 0 ? v.value / totalValue : 0,
      })),
      year: latestYear,
    });
  }
  return products;
}

interface ComtradeResult {
  products: CountryProduct[];
  rateLimited: boolean;
  serverError: boolean;
}

async function fetchComtradeBilateral(reporterCode: string): Promise<ComtradeResult> {
  const url = new URL(COMTRADE_BASE);
  url.searchParams.set('reporterCode', reporterCode);
  url.searchParams.set('cmdCode', HS4_CODES.join(','));
  url.searchParams.set('flowCode', 'M');

  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (resp.status === 429) return { products: [], rateLimited: true, serverError: false };
  if (!resp.ok) return { products: [], rateLimited: false, serverError: resp.status >= 500 };

  const data = await resp.json();
  const records = parseRecords(data);
  return { products: groupByProduct(records), rateLimited: false, serverError: false };
}

export interface LazyFetchResult {
  products: CountryProduct[];
  comtradeSource: 'bilateral-hs4' | 'lazy' | 'empty';
  rateLimited?: boolean;
}

/**
 * Attempt a lazy fetch for a destination country's bilateral HS4 data.
 * Returns null only for truly transient states (concurrent fetch in-flight).
 * When a sentinel exists, returns the sentinel's encoded reason so callers
 * can distinguish permanent empties from transient rate-limits.
 */
export async function lazyFetchBilateralHs4(iso2: string): Promise<LazyFetchResult | null> {
  const sentinelKey = `${LAZY_SENTINEL_PREFIX}${iso2}:v1`;
  const sentinel = await getCachedJson(sentinelKey, true).catch(() => null) as { empty?: boolean; rateLimited?: boolean } | null;
  if (sentinel) {
    if (sentinel.rateLimited) {
      return { products: [], comtradeSource: 'lazy', rateLimited: true };
    }
    return { products: [], comtradeSource: 'empty' };
  }

  if (fetchInFlight) return null;
  fetchInFlight = true;

  const unCode = ISO2_TO_UN[iso2];
  if (!unCode) {
    fetchInFlight = false;
    await setCachedJson(sentinelKey, { empty: true }, EMPTY_TTL, true);
    return { products: [], comtradeSource: 'empty' };
  }

  try {
    const result = await fetchComtradeBilateral(unCode);

    if (result.rateLimited) {
      await setCachedJson(sentinelKey, { rateLimited: true }, EMPTY_TTL, true);
      return { products: [], comtradeSource: 'empty', rateLimited: true };
    }

    // Transient server error (500/503): don't write a 24h sentinel, just return
    // empty so the next request retries instead of being suppressed for a day
    if (result.serverError) {
      return { products: [], comtradeSource: 'lazy' };
    }

    if (result.products.length === 0) {
      await setCachedJson(sentinelKey, { empty: true }, EMPTY_TTL, true);
      return { products: [], comtradeSource: 'empty' };
    }

    const cacheKey = `${KEY_PREFIX}${iso2}:v1`;
    const payload = { iso2, products: result.products, fetchedAt: new Date().toISOString() };
    await setCachedJson(cacheKey, payload, SUCCESS_TTL, true);
    return { products: result.products, comtradeSource: 'bilateral-hs4' };
  } catch {
    return { products: [], comtradeSource: 'lazy' };
  } finally {
    fetchInFlight = false;
  }
}
