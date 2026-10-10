/**
 * Bilateral and sectoral applied-tariff averages for get-tariff-trends, from the
 * World Bank WITS `tradestats-tariff` dataset (UNCTAD TRAINS underneath).
 *
 * WTO's TP_A_0010 is one number per reporter: the MFN average over every line.
 * WITS publishes the same reporter's effectively applied average (AHS, so
 * preferences count) restricted to one partner's goods and/or one product
 * group, simple and import-weighted, from about 1990. Coverage ends where TRAINS
 * does: 2023 for most reporters at the time of writing, and for the United
 * States only MFN rates after 2021, so a US partner series past 2021 carries
 * no preferences. These are schedule rates; Section 301 and other unilateral
 * duties are not in them.
 *
 * Every importer x partner x group combination is too many to seed, so this is
 * fetched on demand and cached for a week (annual data).
 */
import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';
import UN_TO_ISO2 from '../../../../shared/un-to-iso2.json';
import ISO2_TO_ISO3 from '../../../../shared/iso2-to-iso3.json';

export const TRADESTATS_TARIFF_BASE = 'https://wits.worldbank.org/API/V1/SDMX/V21/datasource/tradestats-tariff';
export const TRADESTATS_SOURCE = 'UNCTAD TRAINS via World Bank WITS';
export const TRADESTATS_KEY_PREFIX = 'trade:wits:tradestats-tariff:v1';
export const SIMPLE_INDICATOR = 'AHS-SMPL-AVRG';
export const WEIGHTED_INDICATOR = 'AHS-WGHTD-AVRG';

const SERIES_TTL_SECONDS = 7 * 24 * 3600;
const FAULT_TTL_SECONDS = 300;
const FETCH_TIMEOUT_MS = 8_000;

/** The WITS label for a whole-basket request. */
export const ALL_PRODUCTS_GROUP = 'Total';

/**
 * Product groups WITS publishes, by its own code. A request is matched
 * case-insensitively and sent with WITS's spelling; anything else is answered
 * NOT_COVERED without a fetch (WITS redirects unknown groups to an error page).
 */
export const PRODUCT_GROUPS: readonly string[] = [
  '01-05_Animal', '06-15_Vegetable', '16-24_FoodProd', '25-26_Minerals', '27-27_Fuels',
  '28-38_Chemicals', '39-40_PlastiRub', '41-43_HidesSkin', '44-49_Wood', '50-63_TextCloth',
  '64-67_Footwear', '68-71_StoneGlas', '72-83_Metals', '84-85_MachElec', '86-89_Transport',
  '90-99_Miscellan', 'AgrRaw', 'Chemical', 'Food', 'Fuels', 'manuf', 'OresMtls', 'Textiles',
  'Transp', ALL_PRODUCTS_GROUP,
];
const GROUP_BY_LOWER = new Map(PRODUCT_GROUPS.map((g) => [g.toLowerCase(), g]));

/** "" and "all" mean the whole basket; otherwise WITS's spelling, or null. */
export function witsProductGroup(sector: string): string | null {
  const lower = sector.trim().toLowerCase();
  if (lower === '' || lower === 'all') return ALL_PRODUCTS_GROUP;
  return GROUP_BY_LOWER.get(lower) ?? null;
}

/**
 * WTO member codes that are not the UN M49 code for the same economy. The MFN
 * series is keyed by WTO codes, so callers already pass these.
 */
const WTO_CODE_ISO3: Readonly<Record<string, string>> = {
  '251': 'fra',
  '579': 'nor',
  '699': 'ind',
  '757': 'che',
};

const UN_ISO2 = UN_TO_ISO2 as Record<string, string>;
const ISO3 = ISO2_TO_ISO3 as Record<string, string>;
const own = (map: object, key: string): boolean => Object.prototype.hasOwnProperty.call(map, key);

/**
 * WITS code (lowercase ISO3) for a 3-digit country code, or null when WITS has
 * no such economy. The EU reports as one (`eun`) but is not a partner in this
 * dataset; World is a partner, not a reporter.
 */
export function witsCountry(code: string, role: 'reporter' | 'partner'): string | null {
  if (code === '918') return role === 'reporter' ? 'eun' : null;
  if (code === '000' || code === '') return role === 'partner' ? 'wld' : null;
  const alias = WTO_CODE_ISO3[code];
  if (alias) return alias;
  const iso2 = own(UN_ISO2, code) ? UN_ISO2[code] : undefined;
  const iso3 = iso2 && own(ISO3, iso2) ? ISO3[iso2] : undefined;
  return iso3 ? iso3.toLowerCase() : null;
}

export interface TradestatsPoint {
  year: number;
  simple: number;
  weighted: number;
}

export interface TradestatsSeries {
  points: TradestatsPoint[];
  fetchedAt: string;
}

/**
 * Parse an SDMX 2.1 structure-specific answer into one point per year that has
 * the simple average. The weighted average is 0 where WITS has none (no
 * imports from that partner in that group).
 */
export function parseTradestatsTariff(xml: string): TradestatsPoint[] {
  const byYear = new Map<number, { simple?: number; weighted?: number }>();
  for (const series of xml.matchAll(/<Series\b([^>]*)>([\s\S]*?)<\/Series>/g)) {
    const indicator = /\bINDICATOR="([^"]*)"/.exec(series[1]!)?.[1];
    const field = indicator === SIMPLE_INDICATOR ? 'simple' : indicator === WEIGHTED_INDICATOR ? 'weighted' : null;
    if (!field) continue;
    for (const obs of series[2]!.matchAll(/<Obs\b([^>]*?)\/?>/g)) {
      const year = Number.parseInt(/\bTIME_PERIOD="(\d{4})"/.exec(obs[1]!)?.[1] ?? '', 10);
      const value = Number.parseFloat(/\bOBS_VALUE="([^"]*)"/.exec(obs[1]!)?.[1] ?? '');
      if (!Number.isFinite(year) || !Number.isFinite(value)) continue;
      const entry = byYear.get(year) ?? {};
      entry[field] = value;
      byYear.set(year, entry);
    }
  }
  return [...byYear.entries()]
    .filter(([, v]) => v.simple !== undefined)
    .map(([year, v]) => ({
      year,
      simple: round3(v.simple!),
      weighted: v.weighted === undefined ? 0 : round3(v.weighted),
    }))
    .sort((a, b) => a.year - b.year);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function tradestatsKey(reporter: string, partner: string, group: string): string {
  return `${TRADESTATS_KEY_PREFIX}:${reporter}:${partner}:${group.toLowerCase()}`;
}

export function tradestatsUrl(reporter: string, partner: string, group: string): string {
  return `${TRADESTATS_TARIFF_BASE}/reporter/${reporter}/year/all/partner/${partner}/product/${group}/indicator/${SIMPLE_INDICATOR};${WEIGHTED_INDICATOR}`;
}

/** An empty series is a coverage answer and is cached; null is a fault and is not. */
async function fetchSeries(reporter: string, partner: string, group: string): Promise<TradestatsSeries | null> {
  try {
    const res = await fetch(tradestatsUrl(reporter, partner, group), {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1' },
      // WITS answers an unknown code with a redirect to an error page; keep it
      // visible instead of following it to a 200 HTML body.
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await res.text();
    const fetchedAt = new Date().toISOString();
    if (res.status === 404 && /NoRecordsFound/i.test(body)) return { points: [], fetchedAt };
    if (res.status >= 300 && res.status < 400 && /WITSAPIError/i.test(res.headers.get('location') ?? body)) {
      return { points: [], fetchedAt };
    }
    if (!res.ok) {
      console.warn(`[wits] tradestats-tariff HTTP ${res.status} ${reporter}/${partner}/${group}`);
      return null;
    }
    // A body cut short would parse into a partial series (missing years, or
    // weighted rates read as 0) and be cached for a week; require the whole
    // document.
    if (!/<message:StructureSpecificData\b/.test(body) || !/<\/message:StructureSpecificData>\s*$/.test(body)) {
      console.warn(`[wits] tradestats-tariff unexpected or truncated body ${reporter}/${partner}/${group}`);
      return null;
    }
    return { points: parseTradestatsTariff(body), fetchedAt };
  } catch (error) {
    console.warn(`[wits] tradestats-tariff fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** The cached series, or null when it could be neither read nor fetched. */
export async function readTradestatsSeries(
  reporter: string,
  partner: string,
  group: string,
): Promise<TradestatsSeries | null> {
  const key = tradestatsKey(reporter, partner, group);
  try {
    return await cachedFetchJson<TradestatsSeries>(
      key,
      SERIES_TTL_SECONDS,
      () => fetchSeries(reporter, partner, group),
      FAULT_TTL_SECONDS,
    );
  } catch (error) {
    console.warn(`[wits] ${key} read failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
