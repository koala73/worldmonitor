import type {
  ServerContext,
  GetGoldIntelligenceRequest,
  GetGoldIntelligenceResponse,
  GoldCrossCurrencyPrice,
  GoldCotPositioning,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const COMMODITY_KEY = 'market:commodities-bootstrap:v1';
const COT_KEY = 'market:cot:v1';

interface RawQuote {
  symbol: string;
  name?: string;
  display?: string;
  price: number | null;
  change: number | null;
  sparkline?: number[];
}

interface RawCotInstrument {
  name: string;
  code: string;
  reportDate: string;
  assetManagerLong: number;
  assetManagerShort: number;
  dealerLong: number;
  dealerShort: number;
  netPct: number;
}

const XAU_FX = [
  { symbol: 'EURUSD=X', label: 'EUR', flag: '\u{1F1EA}\u{1F1FA}', multiply: false },
  { symbol: 'GBPUSD=X', label: 'GBP', flag: '\u{1F1EC}\u{1F1E7}', multiply: false },
  { symbol: 'USDJPY=X', label: 'JPY', flag: '\u{1F1EF}\u{1F1F5}', multiply: true },
  { symbol: 'USDCNY=X', label: 'CNY', flag: '\u{1F1E8}\u{1F1F3}', multiply: true },
  { symbol: 'USDINR=X', label: 'INR', flag: '\u{1F1EE}\u{1F1F3}', multiply: true },
  { symbol: 'USDCHF=X', label: 'CHF', flag: '\u{1F1E8}\u{1F1ED}', multiply: false },
];

export async function getGoldIntelligence(
  _ctx: ServerContext,
  _req: GetGoldIntelligenceRequest,
): Promise<GetGoldIntelligenceResponse> {
  try {
    const [rawPayload, rawCot] = await Promise.all([
      getCachedJson(COMMODITY_KEY, true) as Promise<{ quotes?: RawQuote[] } | null>,
      getCachedJson(COT_KEY, true) as Promise<{ instruments?: RawCotInstrument[]; reportDate?: string } | null>,
    ]);

    const rawQuotes = rawPayload?.quotes;
    if (!rawQuotes || !Array.isArray(rawQuotes) || rawQuotes.length === 0) {
      return { goldPrice: 0, goldChangePct: 0, goldSparkline: [], silverPrice: 0, platinumPrice: 0, palladiumPrice: 0, crossCurrencyPrices: [], updatedAt: '', unavailable: true };
    }

    const quoteMap = new Map(rawQuotes.map(q => [q.symbol, q]));

    const gold = quoteMap.get('GC=F');
    if (!gold) {
      return { goldPrice: 0, goldChangePct: 0, goldSparkline: [], silverPrice: 0, platinumPrice: 0, palladiumPrice: 0, crossCurrencyPrices: [], updatedAt: '', unavailable: true };
    }
    const silver = quoteMap.get('SI=F');
    const platinum = quoteMap.get('PL=F');
    const palladium = quoteMap.get('PA=F');

    const goldPrice = gold?.price ?? 0;
    const silverPrice = silver?.price ?? 0;
    const platinumPrice = platinum?.price ?? 0;
    const palladiumPrice = palladium?.price ?? 0;

    const goldSilverRatio = (goldPrice > 0 && silverPrice > 0) ? goldPrice / silverPrice : undefined;
    const goldPlatinumPremiumPct = (goldPrice > 0 && platinumPrice > 0) ? ((goldPrice - platinumPrice) / platinumPrice) * 100 : undefined;

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

    let cot: GoldCotPositioning | undefined;
    if (rawCot?.instruments) {
      const gc = rawCot.instruments.find(i => i.code === 'GC');
      if (gc) {
        cot = {
          reportDate: String(gc.reportDate ?? rawCot.reportDate ?? ''),
          managedMoneyLong: Number(gc.assetManagerLong ?? 0),
          managedMoneyShort: Number(gc.assetManagerShort ?? 0),
          netPct: Number(gc.netPct ?? 0),
          dealerLong: Number(gc.dealerLong ?? 0),
          dealerShort: Number(gc.dealerShort ?? 0),
        };
      }
    }

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
      updatedAt: new Date().toISOString(),
      unavailable: false,
    };
  } catch {
    return { goldPrice: 0, goldChangePct: 0, goldSparkline: [], silverPrice: 0, platinumPrice: 0, palladiumPrice: 0, crossCurrencyPrices: [], updatedAt: '', unavailable: true };
  }
}
