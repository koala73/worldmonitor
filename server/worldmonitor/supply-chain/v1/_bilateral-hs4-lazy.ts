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

const ISO2_TO_UN: Record<string, string> = Object.fromEntries(
  Object.entries(UN_TO_ISO2 as Record<string, string>).map(([un, iso]) => [iso, un]),
);

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

async function fetchComtradeBilateral(reporterCode: string): Promise<CountryProduct[] | null> {
  const url = new URL(COMTRADE_BASE);
  url.searchParams.set('reporterCode', reporterCode);
  url.searchParams.set('cmdCode', HS4_CODES.join(','));
  url.searchParams.set('flowCode', 'M');

  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (resp.status === 429) return null;
  if (!resp.ok) return null;

  const data = await resp.json();
  const records = parseRecords(data);
  return groupByProduct(records);
}

export interface LazyFetchResult {
  products: CountryProduct[];
  comtradeSource: 'bilateral-hs4' | 'lazy' | 'empty';
  rateLimited?: boolean;
}

/**
 * Attempt a lazy fetch for a destination country's bilateral HS4 data.
 * Returns null if the fetch is already in-flight (concurrency cap) or
 * if a negative-cache sentinel exists (recent 429 or known-empty).
 */
export async function lazyFetchBilateralHs4(iso2: string): Promise<LazyFetchResult | null> {
  const sentinelKey = `${LAZY_SENTINEL_PREFIX}${iso2}:v1`;
  const sentinel = await getCachedJson(sentinelKey, true).catch(() => null);
  if (sentinel) return null;

  if (fetchInFlight) return null;
  fetchInFlight = true;

  const unCode = ISO2_TO_UN[iso2];
  if (!unCode) {
    fetchInFlight = false;
    await setCachedJson(sentinelKey, { empty: true }, EMPTY_TTL);
    return { products: [], comtradeSource: 'empty' };
  }

  try {
    const products = await fetchComtradeBilateral(unCode);

    if (products === null) {
      await setCachedJson(sentinelKey, { rateLimited: true }, EMPTY_TTL);
      return { products: [], comtradeSource: 'empty', rateLimited: true };
    }

    if (products.length === 0) {
      await setCachedJson(sentinelKey, { empty: true }, EMPTY_TTL);
      return { products: [], comtradeSource: 'empty' };
    }

    const cacheKey = `${KEY_PREFIX}${iso2}:v1`;
    const payload = { iso2, products, fetchedAt: new Date().toISOString() };
    await setCachedJson(cacheKey, payload, SUCCESS_TTL);
    return { products, comtradeSource: 'bilateral-hs4' };
  } catch {
    return { products: [], comtradeSource: 'lazy' };
  } finally {
    fetchInFlight = false;
  }
}
