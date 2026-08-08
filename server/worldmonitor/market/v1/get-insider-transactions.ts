import type {
  ServerContext,
  GetInsiderTransactionsRequest,
  GetInsiderTransactionsResponse,
  InsiderTransaction,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA, finnhubGate } from '../../../_shared/constants';
import { UPSTREAM_TIMEOUT_MS, sanitizeSymbol } from './_shared';

const CACHE_TTL_SECONDS = 86_400;
const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1_000;

// Only genuine open-market Form 4 codes count toward buy/sell conviction:
//   P = open-market or private purchase
//   S = open-market or private sale
const PURCHASE_CODES = new Set(['P']);
const SALE_CODES = new Set(['S']);
// Non-market Form 4 codes we still surface in the transactions list so the
// panel does not look empty, but which do NOT contribute to buy/sell totals
// because their transactionPrice is not a market execution price:
//   M = exercise/conversion of derivative (price = strike)
//   A = grant/award (compensation, not a purchase)
//   D = disposition to issuer (e.g. buyback redemption)
//   F = payment of exercise price or tax withholding (mechanical)
const NEUTRAL_CODES = new Set(['M', 'A', 'D', 'F']);

interface FinnhubTransaction {
  name: string;
  share: number;
  change: number;
  transactionPrice: number;
  transactionCode: string;
  transactionDate: string;
  filingDate: string;
}

interface FinnhubInsiderResponse {
  data?: FinnhubTransaction[];
  symbol?: string;
}

export async function getInsiderTransactions(
  _ctx: ServerContext,
  req: GetInsiderTransactionsRequest,
): Promise<GetInsiderTransactionsResponse> {
  const symbol = sanitizeSymbol(req.symbol);
  if (!symbol) {
    return { unavailable: true, symbol: '', totalBuys: 0, totalSells: 0, netValue: 0, transactions: [], fetchedAt: '' };
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return { unavailable: true, symbol, totalBuys: 0, totalSells: 0, netValue: 0, transactions: [], fetchedAt: '' };
  }

  const cacheKey = `insider:${symbol}:v1`;

  try {
    const result = await cachedFetchJson<{
      totalBuys: number;
      totalSells: number;
      netValue: number;
      transactions: InsiderTransaction[];
      fetchedAt: string;
    }>(cacheKey, CACHE_TTL_SECONDS, async () => {
      await finnhubGate();
      const url = `https://finnhub.io/api/v1/stock/insider-transactions?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      const raw = (await resp.json()) as FinnhubInsiderResponse;
      if (!raw.data || raw.data.length === 0) return {
        totalBuys: 0,
        totalSells: 0,
        netValue: 0,
        transactions: [] as InsiderTransaction[],
        fetchedAt: new Date().toISOString(),
      };

      const cutoff = Date.now() - SIX_MONTHS_MS;
      const recent = raw.data.filter(tx => {
        const txDate = new Date(tx.transactionDate).getTime();
        return Number.isFinite(txDate) && txDate >= cutoff;
      });

      let totalBuys = 0;
      let totalSells = 0;
      for (const tx of recent) {
        const val = Math.abs((tx.change ?? 0) * (tx.transactionPrice ?? 0));
        if (PURCHASE_CODES.has(tx.transactionCode)) totalBuys += val;
        else if (SALE_CODES.has(tx.transactionCode)) totalSells += val;
      }

      const mapped: InsiderTransaction[] = recent
        .filter(tx =>
          PURCHASE_CODES.has(tx.transactionCode)
          || SALE_CODES.has(tx.transactionCode)
          || NEUTRAL_CODES.has(tx.transactionCode),
        )
        .sort((a, b) => new Date(b.transactionDate).getTime() - new Date(a.transactionDate).getTime())
        .slice(0, 20)
        .map(tx => ({
          name: String(tx.name ?? ''),
          shares: Math.abs(tx.change ?? 0),
          // For exercise/conversion (code M), transactionPrice is the option
          // strike price, not a market execution price, so the derived
          // dollar amount would be misleading. Zero it out and let the UI
          // render a placeholder. The buy/sell totals above already
          // exclude M rows.
          value: NEUTRAL_CODES.has(tx.transactionCode)
            ? 0
            : Math.abs((tx.change ?? 0) * (tx.transactionPrice ?? 0)),
          transactionCode: tx.transactionCode,
          transactionDate: tx.transactionDate,
        }));

      return {
        totalBuys: Math.round(totalBuys),
        totalSells: Math.round(totalSells),
        netValue: Math.round(totalBuys - totalSells),
        transactions: mapped,
        fetchedAt: new Date().toISOString(),
      };
    });

    if (!result) {
      return { unavailable: true, symbol, totalBuys: 0, totalSells: 0, netValue: 0, transactions: [], fetchedAt: '' };
    }

    return {
      unavailable: false,
      symbol,
      totalBuys: result.totalBuys,
      totalSells: result.totalSells,
      netValue: result.netValue,
      transactions: result.transactions,
      fetchedAt: result.fetchedAt,
    };
  } catch {
    return { unavailable: true, symbol, totalBuys: 0, totalSells: 0, netValue: 0, transactions: [], fetchedAt: '' };
  }
}
