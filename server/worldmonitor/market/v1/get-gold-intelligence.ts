import type {
  ServerContext,
  GetGoldIntelligenceRequest,
  GetGoldIntelligenceResponse,
  GoldCrossCurrencyPrice,
  GoldCotPositioning,
  GoldCotCategory,
  GoldSessionRange,
  GoldReturns,
  GoldRange52w,
  GoldDriver,
  GoldEtfFlows,
  GoldCbReserves,
  GoldCbHolder,
  GoldCbMover,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const COMMODITY_KEY = 'market:commodities-bootstrap:v1';
const COT_KEY = 'market:cot:v1';
const GOLD_EXTENDED_KEY = 'market:gold-extended:v1';
const GOLD_ETF_FLOWS_KEY = 'market:gold-etf-flows:v1';
const GOLD_CB_RESERVES_KEY = 'market:gold-cb-reserves:v1';

interface RawQuote {
  symbol: string;
  name?: string;
  display?: string;
  price: number | null;
  change: number | null;
  sparkline?: number[];
}

interface RawCotCategory {
  longPositions: number;
  shortPositions: number;
  netPct: number;
  oiSharePct: number;
  wowNetDelta: number;
}

interface RawCotInstrument {
  name: string;
  code: string;
  reportDate: string;
  nextReleaseDate?: string;
  openInterest?: number;
  managedMoney?: RawCotCategory;
  producerSwap?: RawCotCategory;
  // legacy
  assetManagerLong?: number;
  assetManagerShort?: number;
  dealerLong?: number;
  dealerShort?: number;
  netPct?: number;
}

interface GoldExtendedMetal {
  price: number;
  dayHigh: number;
  dayLow: number;
  prevClose: number;
  returns: { w1: number; m1: number; ytd: number; y1: number };
  range52w: { hi: number; lo: number; positionPct: number };
}

interface GoldExtendedDriver {
  symbol: string;
  label: string;
  value: number;
  changePct: number;
  correlation30d: number;
}

interface GoldExtendedPayload {
  updatedAt: string;
  gold?: GoldExtendedMetal | null;
  silver?: GoldExtendedMetal | null;
  drivers?: GoldExtendedDriver[];
}

interface GoldCbHolderRaw { iso3: string; name: string; tonnes: number; pctOfReserves: number }
interface GoldCbMoverRaw { iso3: string; name: string; deltaTonnes12m: number }
interface GoldCbReservesPayload {
  updatedAt: string;
  asOfMonth: string;
  totalTonnes: number;
  topHolders: GoldCbHolderRaw[];
  topBuyers12m: GoldCbMoverRaw[];
  topSellers12m: GoldCbMoverRaw[];
}

interface GoldEtfFlowsPayload {
  updatedAt: string;
  asOfDate: string;
  tonnes: number;
  aumUsd: number;
  nav: number;
  changeW1Tonnes: number;
  changeM1Tonnes: number;
  changeY1Tonnes: number;
  changeW1Pct: number;
  changeM1Pct: number;
  changeY1Pct: number;
  sparkline90d: number[];
}

const XAU_FX = [
  { symbol: 'EURUSD=X', label: 'EUR', flag: '\u{1F1EA}\u{1F1FA}', multiply: false },
  { symbol: 'GBPUSD=X', label: 'GBP', flag: '\u{1F1EC}\u{1F1E7}', multiply: false },
  { symbol: 'USDJPY=X', label: 'JPY', flag: '\u{1F1EF}\u{1F1F5}', multiply: true },
  { symbol: 'USDCNY=X', label: 'CNY', flag: '\u{1F1E8}\u{1F1F3}', multiply: true },
  { symbol: 'USDINR=X', label: 'INR', flag: '\u{1F1EE}\u{1F1F3}', multiply: true },
  { symbol: 'USDCHF=X', label: 'CHF', flag: '\u{1F1E8}\u{1F1ED}', multiply: false },
];

function emptyResponse(): GetGoldIntelligenceResponse {
  return {
    goldPrice: 0,
    goldChangePct: 0,
    goldSparkline: [],
    silverPrice: 0,
    platinumPrice: 0,
    palladiumPrice: 0,
    crossCurrencyPrices: [],
    drivers: [],
    updatedAt: '',
    unavailable: true,
  };
}

function mapCategory(c: RawCotCategory | undefined): GoldCotCategory | undefined {
  if (!c) return undefined;
  return {
    longPositions: String(Math.round(c.longPositions ?? 0)),
    shortPositions: String(Math.round(c.shortPositions ?? 0)),
    netPct: Number(c.netPct ?? 0),
    oiSharePct: Number(c.oiSharePct ?? 0),
    wowNetDelta: String(Math.round(c.wowNetDelta ?? 0)),
  };
}

function mapCot(raw: RawCotInstrument | undefined): GoldCotPositioning | undefined {
  if (!raw) return undefined;
  // Legacy fallback: derive v2 category fields from flat long/short so a
  // pre-migration seed payload still renders the new panel correctly. OI share
  // stays 0 because old payloads don't carry open_interest; WoW delta stays 0
  // because the prior-week row wasn't captured before this migration.
  const netPctFrom = (long: number, short: number) => {
    const gross = Math.max(long + short, 1);
    return ((long - short) / gross) * 100;
  };
  const mmLong = raw.assetManagerLong ?? 0;
  const mmShort = raw.assetManagerShort ?? 0;
  const psLong = raw.dealerLong ?? 0;
  const psShort = raw.dealerShort ?? 0;
  const managedMoney = raw.managedMoney
    ? mapCategory(raw.managedMoney)
    : mapCategory({
      longPositions: mmLong,
      shortPositions: mmShort,
      netPct: raw.netPct ?? netPctFrom(mmLong, mmShort),
      oiSharePct: 0,
      wowNetDelta: 0,
    });
  const producerSwap = raw.producerSwap
    ? mapCategory(raw.producerSwap)
    : mapCategory({
      longPositions: psLong,
      shortPositions: psShort,
      netPct: netPctFrom(psLong, psShort),
      oiSharePct: 0,
      wowNetDelta: 0,
    });
  return {
    reportDate: String(raw.reportDate ?? ''),
    nextReleaseDate: String(raw.nextReleaseDate ?? ''),
    openInterest: String(Math.round(raw.openInterest ?? 0)),
    managedMoney,
    producerSwap,
  };
}

export async function getGoldIntelligence(
  _ctx: ServerContext,
  _req: GetGoldIntelligenceRequest,
): Promise<GetGoldIntelligenceResponse> {
  try {
    const [rawPayload, rawCot, rawExtended, rawEtfFlows, rawCbReserves] = await Promise.all([
      getCachedJson(COMMODITY_KEY, true) as Promise<{ quotes?: RawQuote[] } | null>,
      getCachedJson(COT_KEY, true) as Promise<{ instruments?: RawCotInstrument[]; reportDate?: string } | null>,
      getCachedJson(GOLD_EXTENDED_KEY, true) as Promise<GoldExtendedPayload | null>,
      getCachedJson(GOLD_ETF_FLOWS_KEY, true) as Promise<GoldEtfFlowsPayload | null>,
      getCachedJson(GOLD_CB_RESERVES_KEY, true) as Promise<GoldCbReservesPayload | null>,
    ]);

    const rawQuotes = rawPayload?.quotes;
    if (!rawQuotes || !Array.isArray(rawQuotes) || rawQuotes.length === 0) return emptyResponse();

    const quoteMap = new Map(rawQuotes.map(q => [q.symbol, q]));
    const gold = quoteMap.get('GC=F');
    if (!gold) return emptyResponse();

    const silver = quoteMap.get('SI=F');
    const platinum = quoteMap.get('PL=F');
    const palladium = quoteMap.get('PA=F');

    const goldPrice = gold?.price ?? 0;
    const silverPrice = silver?.price ?? 0;
    const platinumPrice = platinum?.price ?? 0;
    const palladiumPrice = palladium?.price ?? 0;

    const goldSilverRatio = (goldPrice > 0 && silverPrice > 0) ? goldPrice / silverPrice : undefined;
    const goldPlatinumPremiumPct = (goldPrice > 0 && platinumPrice > 0)
      ? ((goldPrice - platinumPrice) / platinumPrice) * 100
      : undefined;

    const crossCurrencyPrices: GoldCrossCurrencyPrice[] = [];
    if (goldPrice > 0) {
      for (const cfg of XAU_FX) {
        const fx = quoteMap.get(cfg.symbol);
        if (!fx?.price || !Number.isFinite(fx.price) || fx.price <= 0) continue;
        const xauPrice = cfg.multiply ? goldPrice * fx.price : goldPrice / fx.price;
        if (!Number.isFinite(xauPrice) || xauPrice <= 0) continue;
        crossCurrencyPrices.push({ currency: cfg.label, flag: cfg.flag, price: xauPrice });
      }
    }

    const cot = mapCot(rawCot?.instruments?.find(i => i.code === 'GC'));

    const goldExt = rawExtended?.gold;
    const session: GoldSessionRange | undefined = goldExt
      ? { dayHigh: goldExt.dayHigh, dayLow: goldExt.dayLow, prevClose: goldExt.prevClose }
      : undefined;
    const returns: GoldReturns | undefined = goldExt ? { ...goldExt.returns } : undefined;
    const range52w: GoldRange52w | undefined = goldExt ? { ...goldExt.range52w } : undefined;
    const drivers: GoldDriver[] = (rawExtended?.drivers ?? []).map(d => ({
      symbol: d.symbol,
      label: d.label,
      value: d.value,
      changePct: d.changePct,
      correlation30d: d.correlation30d,
    }));

    const cbReserves: GoldCbReserves | undefined = rawCbReserves && Array.isArray(rawCbReserves.topHolders) && rawCbReserves.topHolders.length >= 5
      ? {
        asOfMonth: rawCbReserves.asOfMonth,
        totalTonnes: rawCbReserves.totalTonnes,
        topHolders: rawCbReserves.topHolders.map<GoldCbHolder>(h => ({
          iso3: h.iso3, name: h.name, tonnes: h.tonnes, pctOfReserves: h.pctOfReserves,
        })),
        topBuyers12m: (rawCbReserves.topBuyers12m ?? []).map<GoldCbMover>(m => ({
          iso3: m.iso3, name: m.name, deltaTonnes12m: m.deltaTonnes12m,
        })),
        topSellers12m: (rawCbReserves.topSellers12m ?? []).map<GoldCbMover>(m => ({
          iso3: m.iso3, name: m.name, deltaTonnes12m: m.deltaTonnes12m,
        })),
      }
      : undefined;

    const etfFlows: GoldEtfFlows | undefined = rawEtfFlows && Number.isFinite(rawEtfFlows.tonnes) && rawEtfFlows.tonnes > 0
      ? {
        asOfDate: rawEtfFlows.asOfDate,
        tonnes: rawEtfFlows.tonnes,
        aumUsd: rawEtfFlows.aumUsd,
        nav: rawEtfFlows.nav,
        changeW1Tonnes: rawEtfFlows.changeW1Tonnes,
        changeM1Tonnes: rawEtfFlows.changeM1Tonnes,
        changeY1Tonnes: rawEtfFlows.changeY1Tonnes,
        changeW1Pct: rawEtfFlows.changeW1Pct,
        changeM1Pct: rawEtfFlows.changeM1Pct,
        changeY1Pct: rawEtfFlows.changeY1Pct,
        sparkline90d: rawEtfFlows.sparkline90d ?? [],
      }
      : undefined;

    return {
      goldPrice,
      goldChangePct: gold?.change ?? 0,
      goldSparkline: gold?.sparkline ?? [],
      silverPrice,
      platinumPrice,
      palladiumPrice,
      goldSilverRatio,
      goldPlatinumPremiumPct,
      crossCurrencyPrices,
      cot,
      session,
      returns,
      range52w,
      drivers,
      etfFlows,
      cbReserves,
      // updatedAt reflects the *enrichment* layer's freshness. If the extended
      // key is missing we deliberately emit empty so the panel renders "Updated —"
      // rather than a misleading "just now" stamp while session/returns/drivers
      // are all absent.
      updatedAt: rawExtended?.updatedAt ?? '',
      unavailable: false,
    };
  } catch {
    return emptyResponse();
  }
}
