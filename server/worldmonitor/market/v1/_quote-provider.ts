/**
 * Market quote provider adapter for the ListMarketQuotes gap fetch.
 *
 * ListMarketQuotes answers from the fixed Railway seed snapshot first. Only the
 * symbols that snapshot does not carry — the user's custom watchlist tickers —
 * reach a provider, and only through this seam. Keeping the seam narrow is the
 * point: #6304 can add or swap an authorized provider behind
 * `resolveMarketQuoteProvider()` without touching the handler's budget,
 * ordering, or caching rules.
 *
 * Finnhub is the first implementation because the watchlist picker resolves
 * symbols through Finnhub search (`api/symbol-search.ts`), so every ticker a
 * user can pick is a ticker this provider can quote. It reports `not_found`,
 * `rate_limited`, and `error` as distinct outcomes rather than collapsing them
 * to null — the handler caches only the first, and surfaces all three.
 */
import { CHROME_UA, finnhubGate } from '../../../_shared/constants';
import stocksConfig from '../../../../shared/stocks.json';

/** A quote as returned by a provider. Sparklines are seed-only; see `sparkline`. */
export interface ProviderQuote {
  price: number;
  change: number;
  /**
   * Always empty. A sparkline needs a second (historical) upstream call per
   * symbol, which would double a request-time gap fetch that is deliberately
   * budget-bound. Seeded symbols keep the sparkline the Railway seeder fetched.
   */
  sparkline: number[];
}

export type QuoteProviderOutcome =
  | { status: 'ok'; quote: ProviderQuote }
  | { status: 'not_found' }
  | { status: 'rate_limited' }
  | { status: 'error'; message: string };

export interface MarketQuoteProvider {
  /** Stable identifier for logs and telemetry. Never contains credentials. */
  readonly name: string;
  /**
   * Whether this provider can serve the symbol at all. Lets the handler spend
   * its bounded lookup budget only on symbols with a chance of resolving,
   * without the handler needing to know anything about the provider.
   */
  canQuote(symbol: string): boolean;
  fetchQuote(symbol: string): Promise<QuoteProviderOutcome>;
}

/**
 * Per-symbol upstream timeout. Well under the shared `UPSTREAM_TIMEOUT_MS`
 * (10s) used by the Railway seeders: this runs inside a user-facing edge
 * request that also has to serve the seeded symbols, so a slow provider must
 * degrade to "unavailable" quickly instead of holding the whole response.
 */
export const QUOTE_PROVIDER_TIMEOUT_MS = 3_000;

/**
 * Symbols the Railway relay deliberately routes through Yahoo rather than
 * Finnhub — indices plus the Shanghai/Shenzhen/Hong Kong/India listings that
 * Finnhub's plan does not cover. They only reach the gap fetch when the seeder
 * itself dropped one, and asking Finnhub for them would burn the request's
 * lookup budget on a guaranteed miss.
 */
const FINNHUB_UNSUPPORTED = new Set<string>(stocksConfig.yahooOnly);

/**
 * Futures (`GC=F`) and FX pairs (`EURUSD=X`) in Yahoo notation, plus index
 * tickers (`^GSPC`). The set above covers every such symbol in the default
 * universe; this shape check also catches them in a watchlist saved by the
 * pre-#3698 free-text editor, which accepted arbitrary strings.
 */
function isYahooNotationSymbol(symbol: string): boolean {
  return symbol.startsWith('^') || symbol.endsWith('=F') || symbol.endsWith('=X');
}

class FinnhubQuoteProvider implements MarketQuoteProvider {
  readonly name = 'finnhub';

  constructor(private readonly apiKey: string) {}

  canQuote(symbol: string): boolean {
    return !FINNHUB_UNSUPPORTED.has(symbol) && !isYahooNotationSymbol(symbol);
  }

  async fetchQuote(symbol: string): Promise<QuoteProviderOutcome> {
    try {
      await finnhubGate();
      const resp = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA, 'X-Finnhub-Token': this.apiKey },
        signal: AbortSignal.timeout(QUOTE_PROVIDER_TIMEOUT_MS),
      });

      if (resp.status === 429) return { status: 'rate_limited' };
      if (!resp.ok) return { status: 'error', message: `HTTP ${resp.status}` };

      const data = (await resp.json()) as { c?: number; dp?: number; h?: number; l?: number };
      // Finnhub answers an unknown ticker with an all-zero quote rather than a
      // 404, so a non-positive last price is the only "no such symbol" signal
      // available here.
      if (!Number.isFinite(data.c) || (data.c as number) <= 0) return { status: 'not_found' };

      return {
        status: 'ok',
        quote: {
          price: data.c as number,
          change: Number.isFinite(data.dp) ? (data.dp as number) : 0,
          sparkline: [],
        },
      };
    } catch (err) {
      return { status: 'error', message: (err as Error).message || 'fetch failed' };
    }
  }
}

/**
 * The provider to use for request-time gap fetches, or `null` when none is
 * configured — the handler reports that as
 * `MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_NOT_CONFIGURED` rather than
 * quietly returning a short list.
 */
export function resolveMarketQuoteProvider(): MarketQuoteProvider | null {
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (finnhubKey) return new FinnhubQuoteProvider(finnhubKey);
  return null;
}
