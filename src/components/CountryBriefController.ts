import { IS_EMBEDDED_PREVIEW } from '@/utils/embedded-preview';
import type { ChinaDecisionSignalSnapshot } from '../../shared/china-decision-signals';
import type { ChinaCountrySummaryData, CountryBriefPanel, StockIndexData } from './CountryBriefPanel';
import type { BriefSectionId } from '../../shared/country-brief-sections';
import type { CountryBriefSource } from '@/services/country-brief-source';
import { CountrySectionError } from '@/services/country-brief-error';
import { combineAbortSignals } from '@/services/timeout-signal';
import { getImfCountryBundle, buildImfEconomicIndicators, type ImfCountryBundle, type ImfMacroEntry, type ImfGrowthEntry, type ImfLaborEntry, type ImfExternalEntry } from '@/services/imf-country-data';
import { getCountryDefenseIndustrialBase } from '@/services/defense-industrial';
import { fetchCountryMarkets, protoToMarket } from '@/services/prediction';
import { iso2ToIso3, iso2ToUnCode, iso2ToComtradeReporterCode } from '@/utils/country-codes';
import { toApiUrl } from '@/services/runtime';

export type CountrySectionStatus =
  | { state: 'loading' }
  | { state: 'ready'; value: unknown }
  | { state: 'locked' | 'unavailable'; reason: string };
export type CountryBriefSnapshot = { countryCode: string; revision: number; sections: Partial<Record<BriefSectionId | 'stock', CountrySectionStatus>> };

type HousingPayload = { data?: {
  bisDsr?: { entries?: Array<{ countryCode: string; dsrPct: number; change: number | null; period: string }> };
  bisPropertyResidential?: { entries?: Array<{ countryCode: string; indexValue: number; qoqChange: number | null; yoyChange: number | null; period: string }> };
  bisPropertyCommercial?: { entries?: Array<{ countryCode: string; indexValue: number; qoqChange: number | null; yoyChange: number | null; period: string }> };
} };
const EURO_AREA = new Set(['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'IE', 'PT', 'GR', 'FI', 'SK', 'SI', 'LV', 'LT', 'EE', 'CY', 'MT', 'LU', 'HR']);
export function projectCountryHousing(body: HousingPayload, code: string) {
  const pick = <T extends { countryCode: string }>(entries: T[] | undefined): T | null => entries?.find(e => e.countryCode === code) ?? (EURO_AREA.has(code) ? entries?.find(e => e.countryCode === 'XM') : null) ?? null;
  const res = pick(body.data?.bisPropertyResidential?.entries);
  const com = pick(body.data?.bisPropertyCommercial?.entries);
  const dsr = pick(body.data?.bisDsr?.entries);
  return {
    residential: res ? { indexValue: res.indexValue, qoqChange: res.qoqChange, yoyChange: res.yoyChange, period: res.period } : null,
    commercial: com ? { indexValue: com.indexValue, qoqChange: com.qoqChange, yoyChange: com.yoyChange, period: com.period } : null,
    dsr: dsr ? { dsrPct: dsr.dsrPct, change: dsr.change, period: dsr.period } : null,
  };
}

export class CountryBriefController {
  private request = new AbortController();
  private premiumRequest = new AbortController();
  private snapshot: CountryBriefSnapshot = { countryCode: '', revision: 0, sections: {} };
  constructor(private readonly source: CountryBriefSource, private readonly panel: CountryBriefPanel, private readonly changed: (snapshot: CountryBriefSnapshot) => void = () => {}) {}

  dispose(): void { this.request.abort(); this.premiumRequest.abort(); this.snapshot.revision++; }

  private async read<T>(id: BriefSectionId | 'stock', load: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, premium = false): Promise<T | null> {
    const revision = this.snapshot.revision;
    const signal = combineAbortSignals([this.request.signal, this.panel.signal ?? new AbortController().signal, ...(premium ? [this.premiumRequest.signal] : [])]);
    const current = () => !signal.aborted && revision === this.snapshot.revision && this.panel.getCode() === this.snapshot.countryCode;
    this.snapshot.sections[id] = { state: 'loading' };
    this.changed(this.snapshot);
    try {
      const value = await load(signal);
      if (!current()) return null;
      apply(value);
      this.snapshot.sections[id] = { state: 'ready', value };
      return value;
    } catch (error) {
      if (!current()) return null;
      const state = error instanceof CountrySectionError ? error.state : 'unavailable';
      const reason = state === 'locked' ? 'This section is not authorized by the current connection.' : 'This section could not be loaded. Retry to refresh it.';
      this.snapshot.sections[id] = { state, reason };
      if (id !== 'stock') this.panel.setSectionFailure?.(id, state, reason);
      if (id === 'trade') this.panel.setSectionFailure?.('scenario', state, 'Trade exposure is unavailable, so this calculator cannot be loaded.');
      return null;
    } finally { if (current()) this.changed(this.snapshot); }
  }

  hydrate(countryCode: string, countryName: string, updated?: { stock?: (stock: StockIndexData & { fetchedAt: string }) => void; imf?: (bundle: ImfCountryBundle) => void }) {
    this.dispose();
    this.request = new AbortController();
    this.premiumRequest = new AbortController();
    this.snapshot = { countryCode, revision: this.snapshot.revision, sections: {} };
    const code = countryCode.toUpperCase();
    let latestStock: StockIndexData | null = null;
    const stockPromise = this.read('stock', async signal => {
      const stock = await this.source.market.getCountryStockIndex({ countryCode: code }, { signal });
      return { ...stock, price: String(stock.price), weekChangePercent: String(stock.weekChangePercent) };
    }, stock => { latestStock = stock; this.panel.updateStock(stock); updated?.stock?.(stock); });
    const imfPromise = this.read<ImfCountryBundle & { missing?: string[] }>('economic', async signal => {
      if (this.source.mode === 'website') return getImfCountryBundle(code);
      const body = await this.source.fetch('https://www.worldmonitor.app/api/bootstrap?keys=imfMacro,imfGrowth,imfLabor,imfExternal', { signal }).then(res => res.json()) as { data?: {
        imfMacro?: { countries?: Record<string, ImfMacroEntry> }; imfGrowth?: { countries?: Record<string, ImfGrowthEntry> }; imfLabor?: { countries?: Record<string, ImfLaborEntry> }; imfExternal?: { countries?: Record<string, ImfExternalEntry> };
      }; missing?: string[] };
      return { macro: body.data?.imfMacro?.countries?.[code] ?? null, growth: body.data?.imfGrowth?.countries?.[code] ?? null, labor: body.data?.imfLabor?.countries?.[code] ?? null, external: body.data?.imfExternal?.countries?.[code] ?? null, fetchedAt: 0, missing: body.missing ?? [] };
    }, bundle => { this.panel.updateEconomicIndicators?.(buildImfEconomicIndicators(bundle)); this.panel.setSectionCoverage?.('economic', bundle.missing ?? []); if (latestStock) this.panel.updateStock(latestStock); updated?.imf?.(bundle); });
    void this.read('facts', signal => this.source.intelligence.getCountryFacts({ countryCode: code }, { signal }), facts => this.panel.updateCountryFacts?.({ ...facts, population: Number(facts.population) }));
    void this.read('energy', signal => this.source.intelligence.getCountryEnergyProfile({ countryCode: code }, { signal }), energy => this.panel.updateEnergyProfile?.(energy));
    void this.read('maritime', signal => this.source.intelligence.getCountryPortActivity({ countryCode: code }, { signal }), maritime => this.panel.updateMaritimeActivity?.(maritime));
    void this.read('markets', async signal => {
      if (this.source.mode === 'website') return fetchCountryMarkets(countryName, code);
      const response = await this.source.prediction.listPredictionMarkets({ category: `country:${code}`, query: '', pageSize: 5, cursor: '' }, { signal });
      if (!response.dataAvailable) throw new Error('Country markets unavailable');
      return response.markets.map(protoToMarket).filter(m => !m.endDate || Date.parse(m.endDate) > Date.now()).slice(0, 5);
    }, markets => this.panel.updateMarkets(markets));
    if (this.source.mode === 'host' || !IS_EMBEDDED_PREVIEW) void this.read('housing', async signal => {
      const url = this.source.mode === 'host' ? 'https://www.worldmonitor.app/api/bootstrap?keys=bisDsr,bisPropertyResidential,bisPropertyCommercial' : toApiUrl('/api/bootstrap?keys=bisDsr,bisPropertyResidential,bisPropertyCommercial');
      const response = await this.source.fetch(url, { signal });
      if (!response.ok) throw new Error('Housing unavailable');
      const body = await response.json() as HousingPayload & { missing?: string[] };
      return { ...projectCountryHousing(body, code), missing: body.missing ?? [] };
    }, housing => { this.panel.updateHousingCycle?.(housing); this.panel.setSectionCoverage?.('housing', housing.missing); });
    this.refreshPremium();
    return { stockPromise, imfPromise };
  }

  refreshPremium(): void {
    this.premiumRequest.abort();
    this.premiumRequest = new AbortController();
    if (!this.source.canRequestPremium()) {
      this.panel.setSectionFailure?.('trade', 'locked', 'Upgrade to PRO for trade exposure');
      return;
    }
    const code = this.snapshot.countryCode.toUpperCase();
    if (!code) return;
    void this.read('military', signal => getCountryDefenseIndustrialBase(code, this.source.military, signal), value => this.panel.updateDefenseIndustrialBase?.(value.available ? value : null), true);
    void this.read('commodities', signal => this.source.supply.getCountryVulnerabilities({ iso2: code }, { signal }), value => this.panel.updateCommodityVulnerabilities?.(value), true);
    void this.read('products', signal => this.source.supply.getCountryProducts({ iso2: code }, { signal }), value => this.panel.updateProductImports?.(value), true);
    void this.read('trade', signal => this.source.exposure(code, signal), sectors => {
      const top = sectors[0];
      this.panel.updateTradeExposure?.(top ? { iso2: code, hs2: top.hs2, exposures: sectors.slice(0, 3).map(s => ({ chokepointId: s.primaryChokepointId, chokepointName: s.primaryChokepointName, exposureScore: s.exposureScore, coastSide: '', shockSupported: s.hs2 === '27' })), primaryChokepointId: top.primaryChokepointId, vulnerabilityIndex: top.vulnerabilityIndex, fetchedAt: top.fetchedAt ?? '' } : null, sectors);
    }, true);
    void this.read('debt', signal => this.source.economic.getNationalDebt({}, { signal }), response => {
      const entry = response.entries.find(entry => entry.iso3 === iso2ToIso3(code));
      this.panel.updateNationalDebt?.(entry ? { debtToGdp: entry.debtToGdp, debtUsd: entry.debtUsd, annualGrowth: entry.annualGrowth, source: entry.source } : null);
    }, true);
    void this.read('sanctions', signal => this.source.intelligence.getCountryRisk({ countryCode: code }, { signal }), response => {
      if (response.upstreamUnavailable) throw new Error('Sanctions unavailable');
      this.panel.updateSanctionsPressure?.({ entryCount: response.sanctionsCount, sanctionsActive: response.sanctionsActive });
    }, true);
    const reporterCode = iso2ToComtradeReporterCode(code);
    const reportingCountry = iso2ToUnCode(code);
    if (reporterCode) void this.read('flows', signal => this.source.trade.listComtradeFlows({ reporterCode, cmdCode: '', anomaliesOnly: false }, { signal }), response => this.panel.updateComtradeFlows?.(response.flows.slice().sort((a, b) => b.tradeValueUsd - a.tradeValueUsd).slice(0, 5)), true);
    else this.panel.updateComtradeFlows?.(null);
    if (reportingCountry) void this.read('tariffs', signal => this.source.trade.getTariffTrends({ reportingCountry, productSector: '', years: 10, partnerCountry: '' }, { signal }), response => {
      const points = response.datapoints;
      const latest = points[points.length - 1];
      const previous = points[points.length - 2];
      this.panel.updateTariffTrends?.(latest ? { currentRate: response.effectiveTariffRate?.tariffRate ?? latest.tariffRate, effectiveTariffRate: response.effectiveTariffRate, trend: !previous ? 'unknown' : latest.tariffRate > previous.tariffRate ? 'rising' : latest.tariffRate < previous.tariffRate ? 'falling' : 'stable', datapoints: points.map(p => ({ year: p.year, tariffRate: p.tariffRate })) } : null);
    }, true);
    else this.panel.updateTariffTrends?.(null);
  }
}

export function projectChinaCountrySummary(snapshot: ChinaDecisionSignalSnapshot): ChinaCountrySummaryData {
  return { groups: snapshot.groups.map(group => ({
    id: group.id, state: group.state, unavailableReason: group.reason ?? undefined,
    signals: group.items.map(item => {
      const translation = item.metadata.translation as { state?: unknown } | null;
      const supersession = item.metadata.supersession as { state?: unknown } | null;
      return {
        label: item.label, value: item.summary, source: `${item.sourceName} · ${item.publisherType.replace(/_/g, ' ')}`,
        sourceUrl: item.sourceUrl ?? undefined, observedAt: item.observedAt ?? undefined, publishedAt: item.publishedAt ?? undefined, effectiveAt: item.effectiveAt ?? undefined,
        status: typeof supersession?.state === 'string' ? supersession.state : undefined,
        translationState: typeof translation?.state === 'string' ? translation.state.replace(/_/g, ' ') : undefined,
        publisherType: item.publisherType, lineageId: item.lineageId, provenance: item.provenance, stale: item.stale,
      };
    }),
  })) };
}
