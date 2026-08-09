// Shared per-company upstream fetchers for the corporate-intelligence handlers
// (issue #5695): Finnhub market profile + earnings surprises, and news mentions
// via the existing per-ticker headline search. All identity resolution happens
// upstream of these helpers through the SEC CIK registry (server/_shared/sec-edgar).

import type {
  CompanyMarketProfile,
  CompanyNewsMention,
  EarningsSurprise,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA, finnhubGate } from '../../../_shared/constants';
import { searchRecentStockHeadlines } from '../../market/v1/stock-news-search';

const PROFILE_TTL = 86_400;
const EARNINGS_TTL = 43_200;
const NEGATIVE_TTL = 300;
const UPSTREAM_TIMEOUT = 10_000;
// Corporate intelligence has a tighter composite budget than the general news
// search. Its AbortSignal is propagated through the complete provider ladder.
const NEWS_TIMEOUT_MS = 6_000;
const MAX_NEWS_MENTIONS = 5;

interface FinnhubProfile {
  name?: string;
  exchange?: string;
  finnhubIndustry?: string;
  marketCapitalization?: number;
  ipo?: string;
  logo?: string;
  country?: string;
  currency?: string;
  weburl?: string;
}

interface CompanyProfileResult {
  market: CompanyMarketProfile;
  website: string;
  fetchedAtMs: number;
}

/** Accept only http(s) URLs without credentials — Finnhub/news can return junk schemes. */
export function safeHttpUrl(raw: string | undefined | null): string {
  if (!raw) return '';
  try {
    const absolute = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const u = new URL(absolute);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (u.username || u.password) return '';
    // Keep the caller's form when it was already absolute http(s) so we do not
    // invent a trailing slash on bare hosts (URL.toString() would).
    if (/^https?:\/\//i.test(raw)) return raw;
    return `https://${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`;
  } catch {
    return '';
  }
}

function mapFinnhubProfile(raw: FinnhubProfile, fetchedAtMs: number): CompanyProfileResult | null {
  if (!raw.name && !raw.exchange) return null;
  return {
    website: safeHttpUrl(raw.weburl),
    fetchedAtMs,
    market: {
      exchange: raw.exchange ?? '',
      industry: raw.finnhubIndustry ?? '',
      marketCapMusd: Number.isFinite(raw.marketCapitalization) ? (raw.marketCapitalization as number) : 0,
      ipoDate: raw.ipo ?? '',
      logoUrl: safeHttpUrl(raw.logo),
      country: raw.country ?? '',
      currency: raw.currency ?? '',
    },
  };
}

function mapEarningsRows(raw: FinnhubEarningsRow[]): EarningsSurprise[] {
  return raw
    // Finnhub returns not-yet-reported quarters with null actual/estimate.
    // Coercing those to 0 would render an unreported period as a 0-vs-0
    // "beat" downstream, so drop any row without both figures reported.
    .filter(row => typeof row?.period === 'string'
      && Number.isFinite(row.actual)
      && Number.isFinite(row.estimate))
    .map(row => {
      const actualEps = row.actual as number;
      const estimateEps = row.estimate as number;
      const surprise = Number.isFinite(row.surprise) ? (row.surprise as number) : actualEps - estimateEps;
      return {
        period: row.period ?? '',
        actualEps,
        estimateEps,
        surprise,
        surprisePercent: Number.isFinite(row.surprisePercent)
          ? (row.surprisePercent as number)
          : (estimateEps !== 0 ? (surprise / Math.abs(estimateEps)) * 100 : 0),
        year: row.year ?? 0,
        quarter: row.quarter ?? 0,
      };
    })
    .sort((a, b) => (a.period < b.period ? 1 : -1));
}

interface FetchedEarnings {
  items: EarningsSurprise[];
  fetchedAtMs: number;
}

/**
 * Profile + earnings under a single Finnhub gate on cold miss. Separate Redis
 * keys preserve independent TTLs and warm partial hits; concurrent enrichment
 * no longer burns two rate-limit slots for one company.
 */
export async function fetchFinnhubCompanyAndEarnings(symbol: string): Promise<{
  profile: CompanyProfileResult | null;
  earnings: EarningsSurprise[] | null;
  fetchedAtMs: number[];
}> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey || !symbol) return { profile: null, earnings: null, fetchedAtMs: [] };

  let gated = false;
  const gateOnce = async () => {
    if (!gated) {
      await finnhubGate();
      gated = true;
    }
  };

  try {
    const [profile, earningsResult] = await Promise.all([
      cachedFetchJson<CompanyProfileResult>(
        `intel:company:finnhub-profile:v2:${symbol}`,
        PROFILE_TTL,
        async () => {
          try {
            await gateOnce();
            const resp = await fetch(
              `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}`,
              {
                headers: { 'X-Finnhub-Token': apiKey, 'User-Agent': CHROME_UA },
                signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
              },
            );
            if (!resp.ok) return null;
            return mapFinnhubProfile((await resp.json()) as FinnhubProfile, Date.now());
          } catch {
            return null;
          }
        },
        NEGATIVE_TTL,
      ),
      cachedFetchJson<FetchedEarnings>(
        `intel:company:earnings-surprises:v2:${symbol}`,
        EARNINGS_TTL,
        async () => {
          try {
            await gateOnce();
            const resp = await fetch(
              `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(symbol)}&limit=8`,
              {
                headers: { 'X-Finnhub-Token': apiKey, 'User-Agent': CHROME_UA },
                signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
              },
            );
            if (!resp.ok) return null;
            const raw = (await resp.json()) as FinnhubEarningsRow[];
            if (!Array.isArray(raw)) return null;
            return { items: mapEarningsRows(raw), fetchedAtMs: Date.now() };
          } catch {
            return null;
          }
        },
        NEGATIVE_TTL,
      ),
    ]);
    return {
      profile,
      earnings: earningsResult?.items ?? null,
      fetchedAtMs: [
        profile?.fetchedAtMs,
        earningsResult?.fetchedAtMs,
      ].filter((value): value is number => Number.isFinite(value)),
    };
  } catch {
    return { profile: null, earnings: null, fetchedAtMs: [] };
  }
}

interface FinnhubEarningsRow {
  period?: string;
  actual?: number | null;
  estimate?: number | null;
  surprise?: number | null;
  surprisePercent?: number | null;
  year?: number;
  quarter?: number;
}

interface CompanyNewsResult {
  mentions: CompanyNewsMention[];
  fetchedAtMs: number;
}

export async function fetchCompanyNewsMentions(
  symbol: string,
  name: string,
  timeoutMs = NEWS_TIMEOUT_MS,
): Promise<CompanyNewsResult | null> {
  if (!symbol) return null;
  try {
    const result = await searchRecentStockHeadlines(symbol, name, MAX_NEWS_MENTIONS, {
      signal: AbortSignal.timeout(timeoutMs),
      cacheNamespace: 'company-intel',
    });
    if (!Array.isArray(result.headlines) || result.headlines.length === 0) return null;
    const mentions = result.headlines.slice(0, MAX_NEWS_MENTIONS).map(headline => ({
      title: headline.title,
      url: safeHttpUrl(headline.link),
      source: headline.source,
      publishedAtMs: Number.isFinite(headline.publishedAt) ? headline.publishedAt : 0,
    })).filter(mention => mention.url !== '' || mention.title !== '');
    return mentions.length > 0 ? { mentions, fetchedAtMs: result.fetchedAtMs } : null;
  } catch {
    return null;
  }
}
