/**
 * RPC: GetCountryStockIndex
 * Fetches national stock market index data from Yahoo Finance.
 */

import type {
  ServerContext,
  GetCountryStockIndexRequest,
  GetCountryStockIndexResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { UPSTREAM_TIMEOUT_MS, type YahooChartResponse } from './_shared';

// ========================================================================
// Country-to-index mapping
// ========================================================================

const COUNTRY_INDEX: Record<string, { symbol: string; name: string }> = {
  US: { symbol: '^GSPC', name: 'S&P 500' },
  GB: { symbol: '^FTSE', name: 'FTSE 100' },
  DE: { symbol: '^GDAXI', name: 'DAX' },
  FR: { symbol: '^FCHI', name: 'CAC 40' },
  JP: { symbol: '^N225', name: 'Nikkei 225' },
  CN: { symbol: '000001.SS', name: 'SSE Composite' },
  HK: { symbol: '^HSI', name: 'Hang Seng' },
  IN: { symbol: '^BSESN', name: 'BSE Sensex' },
  KR: { symbol: '^KS11', name: 'KOSPI' },
  TW: { symbol: '^TWII', name: 'TAIEX' },
  AU: { symbol: '^AXJO', name: 'ASX 200' },
  BR: { symbol: '^BVSP', name: 'Bovespa' },
  CA: { symbol: '^GSPTSE', name: 'TSX Composite' },
  MX: { symbol: '^MXX', name: 'IPC Mexico' },
  AR: { symbol: '^MERV', name: 'MERVAL' },
  RU: { symbol: 'IMOEX.ME', name: 'MOEX' },
  ZA: { symbol: '^J203.JO', name: 'JSE All Share' },
  SA: { symbol: '^TASI.SR', name: 'Tadawul' },
  AE: { symbol: 'DFMGI.AE', name: 'DFM General' },
  IL: { symbol: '^TA125.TA', name: 'TA-125' },
  TR: { symbol: 'XU100.IS', name: 'BIST 100' },
  PL: { symbol: '^WIG20', name: 'WIG 20' },
  NL: { symbol: '^AEX', name: 'AEX' },
  CH: { symbol: '^SSMI', name: 'SMI' },
  ES: { symbol: '^IBEX', name: 'IBEX 35' },
  IT: { symbol: 'FTSEMIB.MI', name: 'FTSE MIB' },
  SE: { symbol: '^OMX', name: 'OMX Stockholm 30' },
  NO: { symbol: '^OSEAX', name: 'Oslo All Share' },
  SG: { symbol: '^STI', name: 'STI' },
  TH: { symbol: '^SET.BK', name: 'SET' },
  MY: { symbol: '^KLSE', name: 'KLCI' },
  ID: { symbol: '^JKSE', name: 'Jakarta Composite' },
  PH: { symbol: 'PSEI.PS', name: 'PSEi' },
  NZ: { symbol: '^NZ50', name: 'NZX 50' },
  EG: { symbol: '^EGX30.CA', name: 'EGX 30' },
  CL: { symbol: '^IPSA', name: 'IPSA' },
  PE: { symbol: '^SPBLPGPT', name: 'S&P Lima' },
  AT: { symbol: '^ATX', name: 'ATX' },
  BE: { symbol: '^BFX', name: 'BEL 20' },
  FI: { symbol: '^OMXH25', name: 'OMX Helsinki 25' },
  DK: { symbol: '^OMXC25', name: 'OMX Copenhagen 25' },
  IE: { symbol: '^ISEQ', name: 'ISEQ Overall' },
  PT: { symbol: '^PSI20', name: 'PSI 20' },
  CZ: { symbol: '^PX', name: 'PX Prague' },
  HU: { symbol: '^BUX', name: 'BUX' },
};

// ========================================================================
// Cache
// ========================================================================

let stockIndexCache: Record<string, { data: GetCountryStockIndexResponse; ts: number }> = {};
const STOCK_INDEX_CACHE_TTL = 3_600_000; // 1 hour

// ========================================================================
// Handler
// ========================================================================

export async function getCountryStockIndex(
  _ctx: ServerContext,
  req: GetCountryStockIndexRequest,
): Promise<GetCountryStockIndexResponse> {
  const code = (req.countryCode || '').toUpperCase();
  const notAvailable: GetCountryStockIndexResponse = {
    available: false, code, symbol: '', indexName: '', price: 0, weekChangePercent: 0, currency: '', fetchedAt: '',
  };

  if (!code) return notAvailable;

  const index = COUNTRY_INDEX[code];
  if (!index) return notAvailable;

  const cached = stockIndexCache[code];
  if (cached && Date.now() - cached.ts < STOCK_INDEX_CACHE_TTL) return cached.data;

  try {
    const encodedSymbol = encodeURIComponent(index.symbol);
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?range=1mo&interval=1d`;

    const res = await fetch(yahooUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!res.ok) return notAvailable;

    const data: YahooChartResponse = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return notAvailable;

    const allCloses = result.indicators?.quote?.[0]?.close?.filter((v): v is number => v != null);
    if (!allCloses || allCloses.length < 2) return notAvailable;

    const closes = allCloses.slice(-6);
    const latest = closes[closes.length - 1]!;
    const oldest = closes[0]!;
    const weekChange = ((latest - oldest) / oldest) * 100;
    const meta = result.meta || {};

    const payload: GetCountryStockIndexResponse = {
      available: true,
      code,
      symbol: index.symbol,
      indexName: index.name,
      price: +latest.toFixed(2),
      weekChangePercent: +weekChange.toFixed(2),
      currency: (meta as { currency?: string }).currency || 'USD',
      fetchedAt: new Date().toISOString(),
    };

    stockIndexCache[code] = { data: payload, ts: Date.now() };
    return payload;
  } catch {
    return notAvailable;
  }
}
