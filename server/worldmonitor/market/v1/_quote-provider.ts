/**
 * Authorized market quote provider adapter for ListMarketQuotes gap fetch.
 *
 * Decision (#6304, see docs/finance-data.mdx § Authorized market-data providers):
 *   - Financial Modeling Prep (FMP) is **not** selected: FMP ToS prohibit
 *     commercial display/redistribution without a separate Data Display and
 *     Licensing Agreement (ToS §2.2.1–2.2.2). WorldMonitor is a commercial
 *     product that redistributes quotes to subscribers.
 *   - **Finnhub** is primary for request-time equity gap fetches (the watchlist
 *     picker already resolves symbols through Finnhub search).
 *   - **Alpha Vantage** is the authorized fallback when Finnhub is missing,
 *     rate-limited, errors, or returns not_found for a serviceable symbol.
 *   - Yahoo Finance is **not** used on the edge gap path (see #3731).
 *
 * ListMarketQuotes answers from the fixed Railway seed first. Only symbols the
 * snapshot does not carry reach this seam. Keeping the seam narrow means the
 * handler's budget, ordering, and caching rules stay provider-agnostic.
 *
 * Outcomes are distinct (`ok` / `not_found` / `rate_limited` / `error`) so the
 * handler caches only definitive not-found and never caches provider errors.
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
  fetchQuote(symbol: string, signal?: AbortSignal): Promise<QuoteProviderOutcome>;
}

/**
 * Per-symbol upstream timeout. Well under the shared `UPSTREAM_TIMEOUT_MS`
 * (10s) used by the Railway seeders: this runs inside a user-facing edge
 * request that also has to serve the seeded symbols, so a slow provider must
 * degrade to "unavailable" quickly instead of holding the whole response.
 */
export const QUOTE_PROVIDER_TIMEOUT_MS = 3_000;

function providerSignal(parent?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Provider request timed out', 'TimeoutError')),
    QUOTE_PROVIDER_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort(parent?.reason);

  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

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
export function isYahooNotationSymbol(symbol: string): boolean {
  return symbol.startsWith('^') || symbol.endsWith('=F') || symbol.endsWith('=X');
}

/** Equity / ordinary ticker the authorized equity providers can attempt. */
export function isEquityServiceableSymbol(symbol: string): boolean {
  return !FINNHUB_UNSUPPORTED.has(symbol) && !isYahooNotationSymbol(symbol);
}

export class FinnhubQuoteProvider implements MarketQuoteProvider {
  readonly name = 'finnhub';

  constructor(private readonly apiKey: string) {}

  canQuote(symbol: string): boolean {
    return isEquityServiceableSymbol(symbol);
  }

  async fetchQuote(symbol: string, requestSignal?: AbortSignal): Promise<QuoteProviderOutcome> {
    const attempt = providerSignal(requestSignal);
    try {
      await finnhubGate(attempt.signal);
      const resp = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA, 'X-Finnhub-Token': this.apiKey },
        signal: attempt.signal,
      });

      if (resp.status === 429) return { status: 'rate_limited' };
      if (!resp.ok) return { status: 'error', message: `HTTP ${resp.status}` };

      let data: { c?: number; dp?: number; h?: number; l?: number };
      try {
        data = (await resp.json()) as { c?: number; dp?: number; h?: number; l?: number };
      } catch {
        return { status: 'error', message: 'malformed JSON' };
      }

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
    } finally {
      attempt.cleanup();
    }
  }
}

/**
 * Alpha Vantage GLOBAL_QUOTE — authorized equity fallback (#6304).
 *
 * Covers ordinary equities the watchlist can pick. Declines the same Yahoo-
 * notation futures/FX/index shapes Finnhub declines so the handler does not
 * burn budget on guaranteed misses. Historical / multi-day series remain the
 * seeder's job (AV physical commodity + FX_DAILY helpers in scripts/_shared-av.mjs).
 */
export class AlphaVantageQuoteProvider implements MarketQuoteProvider {
  readonly name = 'alphavantage';

  constructor(private readonly apiKey: string) {}

  canQuote(symbol: string): boolean {
    // AV GLOBAL_QUOTE covers US equities and many ADRs; same shape filter as
    // Finnhub so futures/FX never hit this path from the equity gap fetch.
    return isEquityServiceableSymbol(symbol);
  }

  async fetchQuote(symbol: string, requestSignal?: AbortSignal): Promise<QuoteProviderOutcome> {
    const attempt = providerSignal(requestSignal);
    try {
      const url =
        `https://www.alphavantage.co/query?function=GLOBAL_QUOTE`
        + `&symbol=${encodeURIComponent(symbol)}`
        + `&apikey=${encodeURIComponent(this.apiKey)}`;
      const resp = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
        signal: attempt.signal,
      });

      if (resp.status === 429) return { status: 'rate_limited' };
      if (!resp.ok) return { status: 'error', message: `HTTP ${resp.status}` };

      let json: {
        'Global Quote'?: Record<string, string>;
        Note?: string;
        Information?: string;
        'Error Message'?: string;
      };
      try {
        json = (await resp.json()) as typeof json;
      } catch {
        return { status: 'error', message: 'malformed JSON' };
      }

      // AV signals quota exhaustion with a Note / Information string and no quote body.
      const throttle = json.Note || json.Information;
      if (throttle) {
        if (/rate|limit|call frequency|premium|too busy|temporarily busy/i.test(throttle)) {
          return { status: 'rate_limited' };
        }
        return { status: 'error', message: throttle.slice(0, 120) };
      }
      // AV uses "Error Message" for invalid keys/params as well as bad symbols.
      // Only treat as not_found when the text clearly names an invalid symbol;
      // otherwise surface as error so the cascade does not negative-cache a
      // credential or config failure for 15 minutes.
      if (json['Error Message']) {
        const msg = json['Error Message'];
        if (/\b(?:invalid|unknown|unsupported)\s+(?:symbol|ticker)\b|\b(?:symbol|ticker)\s+(?:is\s+)?(?:invalid|unknown|not found|unsupported)\b/i.test(msg)) {
          return { status: 'not_found' };
        }
        return { status: 'error', message: msg.slice(0, 120) };
      }

      const gq = json['Global Quote'];
      if (!gq || typeof gq !== 'object') return { status: 'not_found' };

      const price = parseFloat(gq['05. price'] ?? '');
      if (!Number.isFinite(price) || price <= 0) return { status: 'not_found' };

      const changePctRaw = (gq['10. change percent'] ?? '').replace('%', '');
      const changePct = parseFloat(changePctRaw);
      return {
        status: 'ok',
        quote: {
          price,
          change: Number.isFinite(changePct) ? changePct : 0,
          sparkline: [],
        },
      };
    } catch (err) {
      return { status: 'error', message: (err as Error).message || 'fetch failed' };
    } finally {
      attempt.cleanup();
    }
  }
}

/**
 * Try providers in order until one returns `ok` or every serviceable provider
 * has answered. A definitive cascade result:
 *   - `ok` from any provider wins immediately
 *   - `not_found` only if every serviceable provider agrees
 *   - `rate_limited` if no provider succeeded and any provider was throttled
 *   - otherwise the last `error`
 *
 * Providers that `canQuote` returns false for are skipped without counting as
 * an attempt — the cascade only spends time on candidates that can serve.
 */
export class CascadeQuoteProvider implements MarketQuoteProvider {
  readonly name: string;

  constructor(private readonly providers: readonly MarketQuoteProvider[]) {
    if (providers.length === 0) {
      throw new Error('CascadeQuoteProvider requires at least one provider');
    }
    this.name = providers.map((p) => p.name).join('+');
  }

  canQuote(symbol: string): boolean {
    return this.providers.some((p) => p.canQuote(symbol));
  }

  async fetchQuote(symbol: string, signal?: AbortSignal): Promise<QuoteProviderOutcome> {
    const candidates = this.providers.filter((p) => p.canQuote(symbol));
    if (candidates.length === 0) {
      return { status: 'error', message: 'no provider can quote symbol' };
    }

    let notFoundCount = 0;
    let sawRateLimited = false;
    let lastError: QuoteProviderOutcome | null = null;

    for (const provider of candidates) {
      if (signal?.aborted) return { status: 'error', message: 'request deadline exceeded' };
      const outcome = await provider.fetchQuote(symbol, signal);
      if (outcome.status === 'ok') {
        // Observability without credentials: which authorized provider filled the gap.
        console.info(`[quote-provider] ${symbol} via ${provider.name}`);
        return outcome;
      }
      if (outcome.status === 'not_found') {
        notFoundCount += 1;
        continue;
      }
      if (outcome.status === 'rate_limited') {
        sawRateLimited = true;
        console.warn(`[quote-provider] ${provider.name} rate-limited for ${symbol}; trying next`);
        continue;
      }
      lastError = outcome;
      console.warn(`[quote-provider] ${provider.name} error for ${symbol}: ${outcome.message}`);
      if (signal?.aborted) break;
    }

    // Only a unanimous not_found is definitive — the handler negative-caches it
    // for 15m. A mixed not_found + rate_limited/error must NOT cache: the
    // second provider never confirmed the symbol is missing.
    if (notFoundCount === candidates.length) return { status: 'not_found' };
    if (sawRateLimited) return { status: 'rate_limited' };
    return lastError ?? { status: 'error', message: 'all providers failed' };
  }
}

export interface ResolveProviderOptions {
  finnhubKey?: string | null;
  alphaVantageKey?: string | null;
}

/**
 * Build the authorized provider chain from env (or explicit opts for tests).
 *
 * Order: Finnhub → Alpha Vantage. Missing keys are omitted, not treated as
 * errors — `null` means "no authorized provider configured" so the handler
 * can report PROVIDER_NOT_CONFIGURED.
 */
export function resolveMarketQuoteProvider(
  opts: ResolveProviderOptions = {},
): MarketQuoteProvider | null {
  const finnhubKey = opts.finnhubKey === undefined
    ? process.env.FINNHUB_API_KEY
    : opts.finnhubKey;
  const avKey = opts.alphaVantageKey === undefined
    ? process.env.ALPHA_VANTAGE_API_KEY
    : opts.alphaVantageKey;

  const providers: MarketQuoteProvider[] = [];
  if (finnhubKey) providers.push(new FinnhubQuoteProvider(finnhubKey));
  if (avKey) providers.push(new AlphaVantageQuoteProvider(avKey));

  if (providers.length === 0) return null;
  if (providers.length === 1) return providers[0]!;
  return new CascadeQuoteProvider(providers);
}

/**
 * Human-readable skip reason when no authorized provider is configured.
 * Kept free of credential values.
 */
export function providerNotConfiguredReason(): string {
  return 'FINNHUB_API_KEY and ALPHA_VANTAGE_API_KEY not configured';
}
