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

const PURCHASE_CODES = new Set(['P', 'A']);
const SALE_CODES = new Set(['S', 'D', 'F']);

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
        .filter(tx => PURCHASE_CODES.has(tx.transactionCode) || SALE_CODES.has(tx.transactionCode))
        .sort((a, b) => new Date(b.transactionDate).getTime() - new Date(a.transactionDate).getTime())
        .slice(0, 20)
        .map(tx => ({
          name: String(tx.name ?? ''),
          shares: Math.abs(tx.change ?? 0),
          value: Math.abs((tx.change ?? 0) * (tx.transactionPrice ?? 0)),
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
