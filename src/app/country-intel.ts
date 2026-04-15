import type { AppContext, AppModule, CountryBriefSignals } from '@/app/app-context';
import { getRpcBaseUrl } from '@/services/rpc-client';
import type { TimelineEvent } from '@/components/CountryTimeline';
import { CountryTimeline } from '@/components/CountryTimeline';
import type {
  CountryDeepDiveEconomicIndicator,
  CountryDeepDiveMilitarySummary,
  CountryDeepDiveSignalDetails,
} from '@/components/CountryBriefPanel';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { reverseGeocode } from '@/utils/reverse-geocode';
import {
  getCountryAtCoordinates,
  getCountryCentroid,
  hasCountryGeometry,
  isCoordinateInCountry,
  ME_STRIKE_BOUNDS,
  iso3ToIso2Code,
  nameToCountryCode,
} from '@/services/country-geometry';
import { calculateCII, getCountryData, TIER1_COUNTRIES, hasIntelligenceSignalsLoaded, type CountryScore } from '@/services/country-instability';
import { getCachedScores, toCountryScore } from '@/services/cached-risk-scores';
import { signalAggregator } from '@/services/signal-aggregator';
import { dataFreshness } from '@/services/data-freshness';
import { fetchCountryMarkets } from '@/services/prediction';
import { collectStoryData } from '@/services/story-data';
import { renderStoryToCanvas } from '@/services/story-renderer';
import { openStoryModal } from '@/components/StoryModal';
import { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import { IntelligenceServiceClient } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { TradeServiceClient } from '@/generated/client/worldmonitor/trade/v1/service_client';
import { EconomicServiceClient } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { hasPremiumAccess } from '@/services/panel-gating';
import { getAuthState } from '@/services/auth-state';
import { showMapContextMenu } from '@/components/MapContextMenu';
import { BETA_MODE } from '@/config/beta';
import { MILITARY_BASES } from '@/config';
import { mlWorker } from '@/services/ml-worker';
import { isHeadlineMemoryEnabled } from '@/services/ai-flow-settings';
import { t, getCurrentLanguage } from '@/services/i18n';
import { trackCountrySelected, trackCountryBriefOpened } from '@/services/analytics';
import { toApiUrl } from '@/services/runtime';
import type { StrategicPosturePanel } from '@/components/StrategicPosturePanel';
import type { NewsItem } from '@/types';
import { getNearbyInfrastructure } from '@/services/related-assets';
import { toFlagEmoji } from '@/utils/country-flag';
import { iso2ToIso3, iso2ToComtradeReporterCode } from '@/utils/country-codes';
import { buildDependencyGraph } from '@/services/infrastructure-cascade';
import { getActiveFrameworkForPanel, subscribeFrameworkChange } from '@/services/analysis-framework-store';
import { fetchMultiSectorExposure, fetchCountryProducts, fetchMultiSectorCostShock } from '@/services/supply-chain';
import { getImfCountryBundle, buildImfEconomicIndicators, type ImfCountryBundle } from '@/services/imf-country-data';

type IntlDisplayNamesCtor = new (
  locales: string | string[],
  options: { type: 'region' }
) => { of: (code: string) => string | undefined };

type CountryStockSnapshot = {
  available: boolean;
  code: string;
  symbol: string;
  indexName: string;
  price: string;
  weekChangePercent: string;
  currency: string;
};

export class CountryIntelManager implements AppModule {
  private ctx: AppContext;
  private briefRequestToken = 0;
  private frameworkUnsubscribe: (() => void) | null = null;
  private _fwDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  init(): void {
    this.setupCountryIntel();
    this.frameworkUnsubscribe = subscribeFrameworkChange('country-brief', () => {
      const page = this.ctx.countryBriefPage;
      if (!page?.isVisible()) return;
      const code = page.getCode();
      const name = page.getName() ?? code;
      if (!code || !name) return;
      if (this._fwDebounce) clearTimeout(this._fwDebounce);
      this._fwDebounce = setTimeout(() => void this.openCountryBriefByCode(code, name), 400);
    });
  }

  destroy(): void {
    if (this._fwDebounce) { clearTimeout(this._fwDebounce); this._fwDebounce = null; }
    this.ctx.countryTimeline?.destroy();
    this.ctx.countryTimeline = null;
    this.ctx.countryBriefPage = null;
    this.frameworkUnsubscribe?.();
    this.frameworkUnsubscribe = null;
  }

  private setupCountryIntel(): void {
    if (!this.ctx.map) return;
    this.ctx.countryBriefPage = new CountryDeepDivePanel(this.ctx.map);
    this.ctx.countryBriefPage.setShareStoryHandler((code, name) => {
      this.ctx.countryBriefPage?.hide();
      this.openCountryStory(code, name);
    });
    this.ctx.countryBriefPage.setExportImageHandler(async (code, name) => {
      try {
        const signals = this.getCountrySignals(code, name);
        const cluster = signalAggregator.getCountryClusters().find(c => c.country === code);
        const regional = signalAggregator.getRegionalConvergence().filter(r => r.countries.includes(code));
        const convergence = cluster ? {
          score: cluster.convergenceScore,
          signalTypes: [...cluster.signalTypes],
          regionalDescriptions: regional.map(r => r.description),
        } : null;
        const posturePanel = this.ctx.panels['strategic-posture'] as StrategicPosturePanel | undefined;
        const postures = posturePanel?.getPostures() || [];
        const data = collectStoryData(code, name, this.ctx.latestClusters, postures, this.ctx.latestPredictions, signals, convergence);
        const canvas = await renderStoryToCanvas(data);
        const dataUrl = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `country-brief-${code.toLowerCase()}-${Date.now()}.png`;
        a.click();
      } catch (err) {
        console.error('[CountryBrief] Image export failed:', err);
      }
    });

    this.ctx.map.onCountryClicked(async (countryClick) => {
      if (countryClick.code && countryClick.name) {
        trackCountrySelected(countryClick.code, countryClick.name, 'map');
        this.openCountryBriefByCode(countryClick.code, countryClick.name);
      } else {
        this.openCountryBrief(countryClick.lat, countryClick.lon);
      }
    });

    this.ctx.map.onMapContextMenu((payload) => {
      const items = [];
      if (payload.countryCode && payload.countryName) {
        items.push({ label: t('contextMenu.openCountryBrief'), action: () => this.openCountryBriefByCode(payload.countryCode!, payload.countryName!) });
      } else {
        items.push({ label: t('contextMenu.openCountryBrief'), action: () => this.openCountryBrief(payload.lat, payload.lon) });
      }
      items.push({ label: t('contextMenu.copyCoordinates'), action: () => navigator.clipboard.writeText(`${payload.lat.toFixed(5)}, ${payload.lon.toFixed(5)}`).catch(() => {}) });
      showMapContextMenu(payload.screenX, payload.screenY, items);
    });

    this.ctx.countryBriefPage.onClose(() => {
      this.briefRequestToken++;
      this.ctx.map?.clearCountryHighlight();
      this.ctx.map?.setRenderPaused(false);
      this.ctx.countryTimeline?.destroy();
      this.ctx.countryTimeline = null;
    });
  }

  async openCountryBrief(lat: number, lon: number): Promise<void> {
    if (!this.ctx.countryBriefPage) return;
    const token = ++this.briefRequestToken;
    this.ctx.countryBriefPage.showLoading();
    this.ctx.map?.setRenderPaused(true);

    const localGeo = getCountryAtCoordinates(lat, lon);
    if (localGeo) {
      if (token !== this.briefRequestToken) return;
      this.openCountryBriefByCode(localGeo.code, localGeo.name);
      return;
    }

    const geo = await reverseGeocode(lat, lon);
    if (token !== this.briefRequestToken) return;
    if (!geo) {
      this.ctx.countryBriefPage.hide();
      this.ctx.map?.setRenderPaused(false);
      return;
    }

    this.openCountryBriefByCode(geo.code, geo.country);
  }

  async openCountryBriefByCode(code: string, country: string, opts?: { maximize?: boolean }): Promise<void> {
    if (!this.ctx.countryBriefPage) return;
    this.ctx.map?.setRenderPaused(true);
    trackCountryBriefOpened(code);

    const canonicalName = TIER1_COUNTRIES[code] || CountryIntelManager.resolveCountryName(code);
    if (canonicalName !== code) country = canonicalName;

    const scores = calculateCII();
    let score = scores.find((s) => s.code === code) ?? null;

    if (!hasIntelligenceSignalsLoaded()) {
      const cached = getCachedScores()?.cii.find((c) => c.code === code);
      if (cached) score = toCountryScore(cached);
    }

    const signals = this.getCountrySignals(code, country);

    this.ctx.countryBriefPage.show(country, code, score, signals);
    this.ctx.map?.highlightCountry(code);
    this.ctx.map?.fitCountry(code);

    if (opts?.maximize) {
      requestAnimationFrame(() => {
        const panel = this.ctx.countryBriefPage;
        if (panel?.isVisible() && panel.getCode() === code) {
          panel.maximize?.();
        }
      });
    }
    this.ctx.countryBriefPage.updateSignalDetails?.(this.buildSignalDetails(code));
    this.ctx.countryBriefPage.updateMilitaryActivity?.(this.buildMilitarySummary(code, country));
    this.ctx.countryBriefPage.updateEconomicIndicators?.(this.buildEconomicIndicators(code, score, null));

    const marketClient = new MarketServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args) });
    const stockPromise = marketClient.getCountryStockIndex({ countryCode: code })
      .then((resp) => ({
        available: resp.available,
        code: resp.code,
        symbol: resp.symbol,
        indexName: resp.indexName,
        price: String(resp.price),
        weekChangePercent: String(resp.weekChangePercent),
        currency: resp.currency,
      }))
      .catch(() => ({ available: false as const, code: '', symbol: '', indexName: '', price: '0', weekChangePercent: '0', currency: '' }));

    let latestStock: CountryStockSnapshot | null = null;
    let latestImf: ImfCountryBundle | null = null;

    stockPromise.then((stock) => {
      latestStock = stock;
      if (this.ctx.countryBriefPage?.getCode() !== code) return;
      this.ctx.countryBriefPage.updateStock(stock);
      this.ctx.countryBriefPage.updateEconomicIndicators?.(this.buildEconomicIndicators(code, score, stock, latestImf));
    });

    // IMF WEO bundle (issue #3027): macro / growth / labor / external from
    // the SDMX-3.0 seeded keys. Tolerant: missing data leaves card unchanged.
    getImfCountryBundle(code).then((bundle) => {
      latestImf = bundle;
      if (this.ctx.countryBriefPage?.getCode() !== code) return;
      this.ctx.countryBriefPage.updateEconomicIndicators?.(this.buildEconomicIndicators(code, score, latestStock, bundle));
    }).catch(() => { /* non-fatal */ });

    fetchCountryMarkets(country)
      .then((markets) => {
        if (this.ctx.countryBriefPage?.getCode() === code) this.ctx.countryBriefPage.updateMarkets(markets);
      })
      .catch(() => {
        if (this.ctx.countryBriefPage?.getCode() === code) this.ctx.countryBriefPage.updateMarkets([]);
      });

    const searchTerms = CountryIntelManager.getCountrySearchTerms(country, code);
    const otherCountryTerms = CountryIntelManager.getOtherCountryTerms(code);
    const matchingNews = this.ctx.allNews.filter((n) => {
      const t = n.title.toLowerCase();
      return searchTerms.some((term) => t.includes(term));
    });
    const filteredNews = matchingNews.filter((n) => {
      const t = n.title.toLowerCase();
      const ourPos = CountryIntelManager.firstMentionPosition(t, searchTerms);
      const otherPos = CountryIntelManager.firstMentionPosition(t, otherCountryTerms);
      return ourPos !== Infinity && (otherPos === Infinity || ourPos <= otherPos);
    }).sort((a, b) => {
      const severityDelta = this.newsSeverityRank(b) - this.newsSeverityRank(a);
      if (severityDelta !== 0) return severityDelta;
      return new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime();
    });
    this.ctx.countryBriefPage.updateNews(filteredNews.slice(0, 10));

    this.ctx.countryBriefPage.updateInfrastructure(code);

    const intelClient = new IntelligenceServiceClient(getRpcBaseUrl(), {
      fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
    });
    intelClient.getCountryFacts({ countryCode: code })
      .then((facts) => {
        if (this.ctx.countryBriefPage?.getCode() !== code) return;
        this.ctx.countryBriefPage.updateCountryFacts?.({
          headOfState: facts.headOfState,
          headOfStateTitle: facts.headOfStateTitle,
          wikipediaSummary: facts.wikipediaSummary,
          wikipediaThumbnailUrl: facts.wikipediaThumbnailUrl,
          population: Number(facts.population),
          capital: facts.capital,
          languages: facts.languages,
          currencies: facts.currencies,
          areaSqKm: facts.areaSqKm,
          countryName: facts.countryName,
        });
      })
      .catch(() => {
        if (this.ctx.countryBriefPage?.getCode() !== code) return;
        this.ctx.countryBriefPage.updateCountryFacts?.({
          headOfState: '', headOfStateTitle: '', wikipediaSummary: '',
          wikipediaThumbnailUrl: '', population: 0, capital: '',
          languages: [], currencies: [], areaSqKm: 0, countryName: '',
        });
      });

    intelClient.getCountryEnergyProfile({ countryCode: code })
      .then((profile) => {
        if (this.ctx.countryBriefPage?.getCode() !== code) return;
        this.ctx.countryBriefPage.updateEnergyProfile?.({
          mixAvailable: profile.mixAvailable,
          mixYear: profile.mixYear,
          coalShare: profile.coalShare,
          gasShare: profile.gasShare,
          oilShare: profile.oilShare,
          nuclearShare: profile.nuclearShare,
          renewShare: profile.renewShare,
          windShare: profile.windShare,
          solarShare: profile.solarShare,
          hydroShare: profile.hydroShare,
          importShare: profile.importShare,
          gasStorageAvailable: profile.gasStorageAvailable,
          gasStorageFillPct: profile.gasStorageFillPct,
          gasStorageChange1d: profile.gasStorageChange1d,
          gasStorageTrend: profile.gasStorageTrend,
          gasStorageDate: profile.gasStorageDate,
          electricityAvailable: profile.electricityAvailable,
          electricityPriceMwh: profile.electricityPriceMwh,
          electricitySource: profile.electricitySource,
          electricityDate: profile.electricityDate,
          jodiOilAvailable: profile.jodiOilAvailable,
          jodiOilDataMonth: profile.jodiOilDataMonth,
          gasolineDemandKbd: profile.gasolineDemandKbd,
          gasolineImportsKbd: profile.gasolineImportsKbd,
          dieselDemandKbd: profile.dieselDemandKbd,
          dieselImportsKbd: profile.dieselImportsKbd,
          jetDemandKbd: profile.jetDemandKbd,
          jetImportsKbd: profile.jetImportsKbd,
          lpgDemandKbd: profile.lpgDemandKbd,
          lpgImportsKbd: profile.lpgImportsKbd,
          crudeImportsKbd: profile.crudeImportsKbd,
          jodiGasAvailable: profile.jodiGasAvailable,
          jodiGasDataMonth: profile.jodiGasDataMonth,
          gasTotalDemandTj: profile.gasTotalDemandTj,
          gasLngImportsTj: profile.gasLngImportsTj,
          gasPipeImportsTj: profile.gasPipeImportsTj,
          gasLngShare: profile.gasLngShare,
          ieaStocksAvailable: profile.ieaStocksAvailable,
          ieaStocksDataMonth: profile.ieaStocksDataMonth,
          ieaDaysOfCover: profile.ieaDaysOfCover,
          ieaNetExporter: profile.ieaNetExporter,
          ieaBelowObligation: profile.ieaBelowObligation,
          emberFossilShare: profile.emberFossilShare,
          emberRenewShare: profile.emberRenewShare,
          emberNuclearShare: profile.emberNuclearShare,
          emberCoalShare: profile.emberCoalShare,
          emberGasShare: profile.emberGasShare,
          emberDemandTwh: profile.emberDemandTwh,
          emberDataMonth: profile.emberDataMonth,
          emberAvailable: profile.emberAvailable,
          sprRegime: profile.sprRegime,
          sprCapacityMb: profile.sprCapacityMb,
          sprOperator: profile.sprOperator,
          sprIeaMember: profile.sprIeaMember,
          sprStockholdingModel: profile.sprStockholdingModel,
          sprNote: profile.sprNote,
          sprSource: profile.sprSource,
          sprAsOf: profile.sprAsOf,
          sprAvailable: profile.sprAvailable,
        });
      })
      .catch(() => {
        if (this.ctx.countryBriefPage?.getCode() !== code) return;
        this.ctx.countryBriefPage.updateEnergyProfile?.({
          mixAvailable: false, mixYear: 0, coalShare: 0, gasShare: 0, oilShare: 0,
          nuclearShare: 0, renewShare: 0, windShare: 0, solarShare: 0, hydroShare: 0,
          importShare: 0, gasStorageAvailable: false, gasStorageFillPct: 0,
          gasStorageChange1d: 0, gasStorageTrend: '', gasStorageDate: '', electricityAvailable: false,
          electricityPriceMwh: 0, electricitySource: '', electricityDate: '',
          jodiOilAvailable: false, jodiOilDataMonth: '', gasolineDemandKbd: 0,
          gasolineImportsKbd: 0, dieselDemandKbd: 0, dieselImportsKbd: 0,
          jetDemandKbd: 0, jetImportsKbd: 0, lpgDemandKbd: 0, lpgImportsKbd: 0,
          crudeImportsKbd: 0, jodiGasAvailable: false, jodiGasDataMonth: '',
          gasTotalDemandTj: 0, gasLngImportsTj: 0, gasPipeImportsTj: 0,
          gasLngShare: 0, ieaStocksAvailable: false, ieaStocksDataMonth: '',
          ieaDaysOfCover: 0, ieaNetExporter: false, ieaBelowObligation: false,
          emberFossilShare: 0, emberRenewShare: 0, emberNuclearShare: 0,
          emberCoalShare: 0, emberGasShare: 0, emberDemandTwh: 0,
          emberDataMonth: '', emberAvailable: false,
          sprRegime: 'unknown', sprCapacityMb: 0, sprOperator: '', sprIeaMember: false,
          sprStockholdingModel: '', sprNote: '', sprSource: '', sprAsOf: '',
          sprAvailable: false,
        });
      });

    intelClient.getCountryPortActivity({ countryCode: code })
      .then((activity) => {
        if (this.ctx.countryBriefPage?.getCode() !== code) return;
        this.ctx.countryBriefPage.updateMaritimeActivity?.({
          available: activity.available,
          ports: (activity.ports ?? []).map((p) => ({
            portId: p.portId,
            portName: p.portName,
            lat: p.lat,
            lon: p.lon,
            tankerCalls30d: p.tankerCalls30d,
            trendDeltaPct: p.trendDeltaPct,
            importTankerDwt: p.importTankerDwt,
            exportTankerDwt: p.exportTankerDwt,
            anomalySignal: p.anomalySignal,
          })),
          fetchedAt: activity.fetchedAt,
        });
      })
      .catch(() => {
        if (this.ctx.countryBriefPage?.getCode() !== code) return;
        this.ctx.countryBriefPage.updateMaritimeActivity?.({ available: false, ports: [], fetchedAt: '' });
      });

    // Fetch multi-sector exposure (all 10 seeded HS2 codes in parallel)
    fetchMultiSectorExposure(code)
      .then((sectors) => {
        if (this.ctx.countryBriefPage?.getCode() !== code) return;
        if (sectors.length === 0) {
          this.ctx.countryBriefPage.updateTradeExposure?.(null);
          if (hasPremiumAccess(getAuthState())) this.ctx.countryBriefPage.updateMultiSectorCostShock?.(null);
          return;
        }
        // Build a synthetic compat response from sector data (no extra fetch needed)
        const top = sectors[0]!;
        const syntheticResponse = {
          iso2: code,
          hs2: top.hs2,
          exposures: sectors.slice(0, 3).map(s => ({
            chokepointId: s.primaryChokepointId,
            chokepointName: s.primaryChokepointName,
            exposureScore: s.exposureScore,
            coastSide: '',
            shockSupported: s.hs2 === '27',
          })),
          primaryChokepointId: top.primaryChokepointId,
          vulnerabilityIndex: top.vulnerabilityIndex,
          fetchedAt: new Date().toISOString(),
        };
        this.ctx.countryBriefPage.updateTradeExposure?.(syntheticResponse, sectors);

        // Trigger multi-sector cost shock calculator from the same primary chokepoint.
        if (hasPremiumAccess(getAuthState()) && top.primaryChokepointId) {
          fetchMultiSectorCostShock(code, top.primaryChokepointId, 30).then(multi => {
            if (this.ctx.countryBriefPage?.getCode() !== code) return;
            this.ctx.countryBriefPage.updateMultiSectorCostShock?.(multi);
          }).catch(() => {
            if (this.ctx.countryBriefPage?.getCode() === code) this.ctx.countryBriefPage.updateMultiSectorCostShock?.(null);
          });
        } else if (hasPremiumAccess(getAuthState())) {
          this.ctx.countryBriefPage.updateMultiSectorCostShock?.(null);
        }
      })
      .catch(() => {
        if (this.ctx.countryBriefPage?.getCode() !== code) return;
        this.ctx.countryBriefPage.updateTradeExposure?.(null);
        if (hasPremiumAccess(getAuthState())) this.ctx.countryBriefPage.updateMultiSectorCostShock?.(null);
      });

    if (hasPremiumAccess(getAuthState())) {
      this.fetchProSections(code);
    }

    this.mountCountryTimeline(code, country);

    try {
      const context: Record<string, unknown> = {};
      if (score) {
        context.score = score.score;
        context.level = score.level;
        context.trend = score.trend;
        context.components = score.components;
        context.change24h = score.change24h;
      }
      Object.assign(context, signals);

      const countryCluster = signalAggregator.getCountryClusters().find((c) => c.country === code);
      if (countryCluster) {
        context.convergenceScore = countryCluster.convergenceScore;
        context.signalTypes = [...countryCluster.signalTypes];
      }

      const convergences = signalAggregator.getRegionalConvergence()
        .filter((r) => r.countries.includes(code));
      if (convergences.length) {
        context.regionalConvergence = convergences.map((r) => r.description);
      }

      if (this.ctx.intelligenceCache.advisories) {
        const countryAdvisories = this.ctx.intelligenceCache.advisories.filter(a => a.country === code);
        if (countryAdvisories.length > 0) {
          context.travelAdvisories = countryAdvisories.map(a => ({ source: a.source, level: a.level, title: a.title }));
        }
      }

      const headlines = filteredNews.slice(0, 15).map((n) => n.title);
      if (headlines.length) context.headlines = headlines;
      const briefHeadlines = (context.headlines as string[] | undefined) || [];

      const stockData = await stockPromise;
      if (stockData.available) {
        const pct = parseFloat(stockData.weekChangePercent);
        context.stockIndex = `${stockData.indexName}: ${stockData.price} (${pct >= 0 ? '+' : ''}${stockData.weekChangePercent}% week)`;
      }

      let briefText = '';
      try {
        let contextSnapshot = this.buildBriefContextSnapshot(country, code, score, signals, context);

        if (isHeadlineMemoryEnabled() && mlWorker.isAvailable && mlWorker.isModelLoaded('embeddings') && briefHeadlines.length > 0) {
          try {
            const results = await mlWorker.vectorStoreSearch(briefHeadlines.slice(0, 3), 5, 0.3);
            if (results.length > 0) {
              const historical = results.map(r =>
                `- ${r.text} (${new Date(r.pubDate).toISOString().slice(0, 10)})`
              ).join('\n').slice(0, 350);
              contextSnapshot = contextSnapshot.slice(0, 1800)
                + `\n[BEGIN HISTORICAL DATA]\n${historical}\n[END HISTORICAL DATA]`;
            }
          } catch { /* RAG unavailable */ }
        }

        const countryFw = getActiveFrameworkForPanel('country-brief');
        briefText = await this.fetchCountryIntelBrief(code, contextSnapshot, countryFw?.systemPromptAppend ?? '');
      } catch { /* server unreachable */ }

      if (briefText) {
        this.ctx.countryBriefPage?.updateBrief({ brief: briefText, country, code });
      } else {
        let fallbackBrief = '';
        const sumModelId = BETA_MODE ? 'summarization-beta' : 'summarization';
        if (briefHeadlines.length >= 2 && mlWorker.isAvailable && mlWorker.isModelLoaded(sumModelId)) {
          try {
            const lang = getCurrentLanguage();
            const prompt = lang === 'fr'
              ? `Résumez la situation actuelle en ${country} à partir de ces titres : ${briefHeadlines.slice(0, 8).join('. ')}`
              : `Summarize the current situation in ${country} based on these headlines: ${briefHeadlines.slice(0, 8).join('. ')}`;

            const [summary] = await mlWorker.summarize([prompt], BETA_MODE ? 'summarization-beta' : undefined);
            if (summary && summary.length > 20) fallbackBrief = summary;
          } catch { /* T5 failed */ }
        }

        if (fallbackBrief) {
          this.ctx.countryBriefPage?.updateBrief({ brief: fallbackBrief, country, code, fallback: true });
        } else {
          const lines: string[] = [];
          if (score) lines.push(t('countryBrief.fallback.instabilityIndex', { score: String(score.score), level: t(`countryBrief.levels.${score.level}`), trend: t(`countryBrief.trends.${score.trend}`) }));
          if (signals.protests > 0) lines.push(t('countryBrief.fallback.protestsDetected', { count: String(signals.protests) }));
          if (signals.militaryFlights > 0) lines.push(t('countryBrief.fallback.aircraftTracked', { count: String(signals.militaryFlights) }));
          if (signals.militaryVessels > 0) lines.push(t('countryBrief.fallback.vesselsTracked', { count: String(signals.militaryVessels) }));
          if (signals.activeStrikes > 0) lines.push(t('countryBrief.fallback.activeStrikes', { count: String(signals.activeStrikes) }));
          if (signals.travelAdvisoryMaxLevel === 'do-not-travel') lines.push(`⚠️ Travel advisory: Do Not Travel (${signals.travelAdvisories} source${signals.travelAdvisories > 1 ? 's' : ''})`);
          else if (signals.travelAdvisoryMaxLevel === 'reconsider') lines.push(`⚠️ Travel advisory: Reconsider Travel (${signals.travelAdvisories} source${signals.travelAdvisories > 1 ? 's' : ''})`);
          if (signals.outages > 0) lines.push(t('countryBrief.fallback.internetOutages', { count: String(signals.outages) }));
          if (signals.criticalNews > 0) lines.push(`🚨 Critical headlines in scope: ${signals.criticalNews}`);
          if (signals.cyberThreats > 0) lines.push(`🛡️ Cyber threat indicators: ${signals.cyberThreats}`);
          if (signals.aisDisruptions > 0) lines.push(`🚢 Maritime AIS disruptions: ${signals.aisDisruptions}`);
          if (signals.satelliteFires > 0) lines.push(`🔥 Satellite fire detections: ${signals.satelliteFires}`);
          if (signals.radiationAnomalies > 0) lines.push(`☢️ Radiation anomalies: ${signals.radiationAnomalies}`);
          if (signals.temporalAnomalies > 0) lines.push(`⏱️ Temporal anomaly alerts: ${signals.temporalAnomalies}`);
          if (signals.thermalEscalations > 0) lines.push(`🌡️ Thermal escalation clusters: ${signals.thermalEscalations}`);
          if (signals.earthquakes > 0) lines.push(t('countryBrief.fallback.recentEarthquakes', { count: String(signals.earthquakes) }));
          if (signals.orefHistory24h > 0) lines.push(`🚨 Sirens in past 24h: ${signals.orefHistory24h}`);
          if (context.stockIndex) lines.push(t('countryBrief.fallback.stockIndex', { value: context.stockIndex }));
          if (lines.length > 0) {
            this.ctx.countryBriefPage?.updateBrief({ brief: lines.join('\n'), country, code, fallback: true });
          } else {
            this.ctx.countryBriefPage?.updateBrief({ brief: '', country, code, error: 'No AI service available. Configure GROQ_API_KEY in Settings for full briefs.' });
          }
        }
      }
    } catch (err) {
      console.error('[CountryBrief] fetch error:', err);
      this.ctx.countryBriefPage?.updateBrief({ brief: '', country, code, error: 'Failed to generate brief' });
    }
  }

  private fetchProSections(code: string): void {
    const rpcBase = getRpcBaseUrl();
    const fetchFn = (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args);
    const economicClient = new EconomicServiceClient(rpcBase, { fetch: fetchFn });
    const intelClientPro = new IntelligenceServiceClient(rpcBase, { fetch: fetchFn });
    const tradeClient = new TradeServiceClient(rpcBase, { fetch: fetchFn });
    const iso3 = iso2ToIso3(code);

    economicClient.getNationalDebt({}).then(resp => {
      if (this.ctx.countryBriefPage?.getCode() !== code) return;
      const entry = iso3 ? resp.entries?.find(e => e.iso3 === iso3) : null;
      this.ctx.countryBriefPage.updateNationalDebt?.(entry ? {
        debtToGdp: entry.debtToGdp,
        debtUsd: entry.debtUsd,
        annualGrowth: entry.annualGrowth,
        source: entry.source,
      } : null);
    }).catch(() => {
      if (this.ctx.countryBriefPage?.getCode() === code) this.ctx.countryBriefPage.updateNationalDebt?.(null);
    });

    intelClientPro.getCountryRisk({ countryCode: code }).then(resp => {
      if (this.ctx.countryBriefPage?.getCode() !== code) return;
      this.ctx.countryBriefPage.updateSanctionsPressure?.(resp.sanctionsCount > 0 ? {
        entryCount: resp.sanctionsCount,
        sanctionsActive: resp.sanctionsActive,
      } : null);
    }).catch(() => {
      if (this.ctx.countryBriefPage?.getCode() === code) this.ctx.countryBriefPage.updateSanctionsPressure?.(null);
    });

    const unCode = iso2ToComtradeReporterCode(code);
    if (unCode) {
      tradeClient.listComtradeFlows({ reporterCode: unCode, cmdCode: '', anomaliesOnly: false }).then(resp => {
        if (this.ctx.countryBriefPage?.getCode() !== code) return;
        const topFlows = (resp.flows || [])
          .sort((a, b) => b.tradeValueUsd - a.tradeValueUsd)
          .slice(0, 5)
          .map(f => ({ partnerName: f.partnerName, cmdDesc: f.cmdDesc, tradeValueUsd: f.tradeValueUsd, yoyChange: f.yoyChange }));
        this.ctx.countryBriefPage.updateComtradeFlows?.(topFlows.length > 0 ? topFlows : null);
      }).catch(() => {
        if (this.ctx.countryBriefPage?.getCode() === code) this.ctx.countryBriefPage.updateComtradeFlows?.(null);
      });

      tradeClient.getTariffTrends({ reportingCountry: unCode, productSector: '', years: 10, partnerCountry: '' }).then(resp => {
        if (this.ctx.countryBriefPage?.getCode() !== code) return;
        const pts = resp.datapoints || [];
        const latest = pts[pts.length - 1];
        this.ctx.countryBriefPage.updateTariffTrends?.(latest ? {
          currentRate: resp.effectiveTariffRate?.tariffRate ?? latest.tariffRate,
          trend: pts.length >= 2 && pts[pts.length - 1]!.tariffRate > pts[pts.length - 2]!.tariffRate ? 'rising' : 'falling',
          datapoints: pts.map(p => ({ year: p.year, tariffRate: p.tariffRate })),
        } : null);
      }).catch(() => {
        if (this.ctx.countryBriefPage?.getCode() === code) this.ctx.countryBriefPage.updateTariffTrends?.(null);
      });
    } else {
      this.ctx.countryBriefPage?.updateComtradeFlows?.(null);
      this.ctx.countryBriefPage?.updateTariffTrends?.(null);
    }

    fetchCountryProducts(code).then(resp => {
      if (this.ctx.countryBriefPage?.getCode() !== code) return;
      this.ctx.countryBriefPage.updateProductImports?.(resp.products.length > 0 ? resp : null);
    }).catch(() => {
      if (this.ctx.countryBriefPage?.getCode() === code) {
        this.ctx.countryBriefPage.updateProductImports?.(null);
      }
    });

    // Housing cycle tile — BIS WS_SPP (residential), WS_CPP (commercial), WS_DSR.
    // All three keys are seeded by the bis-extended cron and exposed via the
    // public bootstrap endpoint, so one scoped bootstrap call covers the tile.
    this.fetchHousingCycle(code);
  }

  private fetchHousingCycle(code: string): void {
    const page = this.ctx.countryBriefPage;
    if (!page?.updateHousingCycle) return;
    const keys = 'bisDsr,bisPropertyResidential,bisPropertyCommercial';
    fetch(toApiUrl(`/api/bootstrap?keys=${keys}`), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: page.signal,
    }).then(async resp => {
      if (!resp.ok) return null;
      return resp.json() as Promise<{ data?: {
        bisDsr?: { entries?: Array<{ countryCode: string; dsrPct: number; change: number | null; period: string }> };
        bisPropertyResidential?: { entries?: Array<{ countryCode: string; indexValue: number; qoqChange: number | null; yoyChange: number | null; period: string }> };
        bisPropertyCommercial?: { entries?: Array<{ countryCode: string; indexValue: number; qoqChange: number | null; yoyChange: number | null; period: string }> };
      } }>;
    }).then(body => {
      if (!body || this.ctx.countryBriefPage?.getCode() !== code) return;
      const pick = <T extends { countryCode: string }>(arr: T[] | undefined, cc: string): T | null =>
        arr?.find(e => e?.countryCode === cc) ?? null;
      // Euro area (XM) fallback for EU countries that BIS only publishes as a bloc aggregate.
      const EURO_AREA = new Set(['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'IE', 'PT', 'GR', 'FI', 'SK', 'SI', 'LV', 'LT', 'EE', 'CY', 'MT', 'LU', 'HR']);
      const fallbackCC = EURO_AREA.has(code) ? 'XM' : null;
      const res = pick(body.data?.bisPropertyResidential?.entries, code) ?? (fallbackCC ? pick(body.data?.bisPropertyResidential?.entries, fallbackCC) : null);
      const com = pick(body.data?.bisPropertyCommercial?.entries, code) ?? (fallbackCC ? pick(body.data?.bisPropertyCommercial?.entries, fallbackCC) : null);
      const dsr = pick(body.data?.bisDsr?.entries, code) ?? (fallbackCC ? pick(body.data?.bisDsr?.entries, fallbackCC) : null);
      this.ctx.countryBriefPage?.updateHousingCycle?.({
        residential: res ? { indexValue: res.indexValue, qoqChange: res.qoqChange, yoyChange: res.yoyChange, period: res.period } : null,
        commercial: com ? { indexValue: com.indexValue, qoqChange: com.qoqChange, yoyChange: com.yoyChange, period: com.period } : null,
        dsr: dsr ? { dsrPct: dsr.dsrPct, change: dsr.change, period: dsr.period } : null,
      });
    }).catch(() => {
      if (this.ctx.countryBriefPage?.getCode() === code) {
        this.ctx.countryBriefPage.updateHousingCycle?.(null);
      }
    });
  }


  refreshOpenBrief(): void {
    const page = this.ctx.countryBriefPage;
    if (!page?.isVisible()) return;
    const code = page.getCode();
    if (!code || code === '__loading__' || code === '__error__') return;
    const name = TIER1_COUNTRIES[code] ?? CountryIntelManager.resolveCountryName(code);
    const scores = calculateCII();
    let score = scores.find((s) => s.code === code) ?? null;
    if (!hasIntelligenceSignalsLoaded()) {
      const cached = getCachedScores()?.cii.find((c) => c.code === code);
      if (cached) score = toCountryScore(cached);
    }
    const signals = this.getCountrySignals(code, name);
    page.updateScore?.(score, signals);
  }

  private async fetchCountryIntelBrief(code: string, contextSnapshot: string, framework = ''): Promise<string> {
    const lang = getCurrentLanguage();
    const params = new URLSearchParams({ country_code: code, lang });
    const trimmed = contextSnapshot.trim();
    if (trimmed.length > 0) {
      // 3800 chars ≈ ~950 tokens; raised from 2200 to include infra context. Monitor p95 LLM latency if timeouts increase.
      params.set('context', trimmed.slice(0, 3800));
    }
    if (framework) {
      params.set('framework', framework.slice(0, 2000));
    }

    const resp = await fetch(toApiUrl(`/api/intelligence/v1/get-country-intel-brief?${params.toString()}`), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: this.ctx.countryBriefPage?.signal,
    });
    if (!resp.ok) return '';

    const body = (await resp.json()) as { brief?: string };
    return typeof body.brief === 'string' ? body.brief.trim() : '';
  }

  private buildBriefContextSnapshot(
    country: string,
    code: string,
    score: CountryScore | null,
    signals: CountryBriefSignals,
    context: Record<string, unknown>,
  ): string {
    const lines: string[] = [];
    lines.push(`Country: ${country} (${code})`);

    // Infrastructure grounding must appear early so it survives the context char limit
    const infraContext = this.buildInfrastructureContext(code);
    if (infraContext) lines.push(infraContext);

    if (score) {
      lines.push(`CII: ${score.score}/100 (${score.level}), trend=${score.trend}, 24h_change=${score.change24h}`);
      lines.push(`CII components: unrest=${Math.round(score.components.unrest)}, conflict=${Math.round(score.components.conflict)}, security=${Math.round(score.components.security)}, information=${Math.round(score.components.information)}`);
    }

    lines.push(
      `Signals: critical_news=${signals.criticalNews}, protests=${signals.protests}, active_strikes=${signals.activeStrikes}, military_flights=${signals.militaryFlights}, military_vessels=${signals.militaryVessels}, outages=${signals.outages}, aviation_disruptions=${signals.aviationDisruptions}, travel_advisories=${signals.travelAdvisories}, oref_sirens=${signals.orefSirens}, oref_24h=${signals.orefHistory24h}, gps_jamming_hexes=${signals.gpsJammingHexes}, ais_disruptions=${signals.aisDisruptions}, satellite_fires=${signals.satelliteFires}, radiation_anomalies=${signals.radiationAnomalies}, temporal_anomalies=${signals.temporalAnomalies}, cyber_threats=${signals.cyberThreats}, earthquakes=${signals.earthquakes}, conflict_events=${signals.conflictEvents}, thermal_escalations=${signals.thermalEscalations}`,
    );

    if (signals.travelAdvisoryMaxLevel) {
      lines.push(`Travel advisory max level: ${signals.travelAdvisoryMaxLevel}`);
    }

    if (signals.sanctionsDesignations > 0) {
      const newPart = signals.sanctionsNewDesignations > 0 ? `, +${signals.sanctionsNewDesignations} new` : '';
      lines.push(`Sanctions: ${signals.sanctionsDesignations} active designations${newPart}`);
    }

    if (signals.displacementOutflow > 0) {
      lines.push(`Displacement outflow: ${signals.displacementOutflow.toLocaleString()} persons`);
    }
    if (signals.climateStress > 0) {
      lines.push(`Climate stress: ${Math.round(signals.climateStress)}/100`);
    }
    if (signals.isTier1) {
      lines.push(`Major power: yes`);
    }

    const stockIndex = typeof context.stockIndex === 'string' ? context.stockIndex : '';
    if (stockIndex) lines.push(`Stock index: ${stockIndex}`);

    const convergenceScore = typeof context.convergenceScore === 'number' ? context.convergenceScore : null;
    const signalTypes = Array.isArray(context.signalTypes) ? context.signalTypes as string[] : [];
    if (convergenceScore != null || signalTypes.length > 0) {
      lines.push(`Signal convergence: score=${convergenceScore ?? 0}, types=${signalTypes.slice(0, 8).join(', ')}`);
    }

    const regionalConvergence = Array.isArray(context.regionalConvergence) ? context.regionalConvergence as string[] : [];
    if (regionalConvergence.length > 0) {
      lines.push(`Regional context: ${regionalConvergence.slice(0, 3).join(' | ')}`);
    }

    const headlines = Array.isArray(context.headlines) ? context.headlines as string[] : [];
    if (headlines.length > 0) {
      lines.push(`Headlines: ${headlines.slice(0, 6).join(' | ')}`);
    }

    return lines.join('\n');
  }

  private buildInfrastructureContext(code: string): string {
    try {
      const graph = buildDependencyGraph();
      const countryId = `country:${code}`;
      const incomingEdges = graph.incoming.get(countryId) || [];
      const parts: string[] = [];

      const cables = incomingEdges
        .filter(e => (e.type === 'serves' || e.type === 'lands_at') && e.from.startsWith('cable:'))
        .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
        .slice(0, 3)
        .map(e => {
          const node = graph.nodes.get(e.from);
          const share = e.strength ? ` (${Math.round(e.strength * 100)}% capacity)` : '';
          return node ? `${node.name}${share}` : '';
        }).filter(Boolean);
      if (cables.length) parts.push(`Cables: ${cables.join(', ')}`);

      const pipes = incomingEdges
        .filter(e => e.type === 'serves' && e.from.startsWith('pipeline:'))
        .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
        .slice(0, 3)
        .map(e => {
          const node = graph.nodes.get(e.from);
          const status = typeof node?.metadata?.status === 'string' ? node.metadata.status : undefined;
          return node ? `${node.name}${status ? ` (${status})` : ''}` : '';
        }).filter(Boolean);
      if (pipes.length) parts.push(`Pipelines: ${pipes.join(', ')}`);

      const ports = incomingEdges
        .filter(e => e.type === 'serves' && e.from.startsWith('port:'))
        .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
        .slice(0, 3)
        .map(e => {
          const node = graph.nodes.get(e.from);
          const rank = node?.metadata?.rank as number | undefined;
          const type = node?.metadata?.type as string | undefined;
          return node ? `${node.name}${rank ? ` (rank #${rank}${type ? ', ' + type : ''})` : ''}` : '';
        }).filter(Boolean);
      if (ports.length) parts.push(`Ports: ${ports.join(', ')}`);

      const chokepoints = incomingEdges
        .filter(e => e.type === 'trade_dependency' && e.from.startsWith('chokepoint:'))
        .map(e => {
          const node = graph.nodes.get(e.from);
          const reason = e.metadata?.relationship as string | undefined;
          return node ? `${node.name}${reason ? ` (${reason})` : ''}` : '';
        }).filter(Boolean)
        .slice(0, 2);
      if (chokepoints.length) parts.push(`Waterways: ${chokepoints.join(', ')}`);

      return parts.length > 0 ? `Infrastructure exposure: ${parts.join(' | ')}` : '';
    } catch {
      return '';
    }
  }

  private mountCountryTimeline(code: string, country: string): void {
    this.ctx.countryTimeline?.destroy();
    this.ctx.countryTimeline = null;

    const mount = this.ctx.countryBriefPage?.getTimelineMount();
    if (!mount) return;

    const events: TimelineEvent[] = [];
    const countryLower = country.toLowerCase();
    const hasGeoShape = hasCountryGeometry(code) || !!CountryIntelManager.COUNTRY_BOUNDS[code];
    const inCountry = (lat: number, lon: number) => hasGeoShape && this.isInCountry(lat, lon, code);
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    if (this.ctx.intelligenceCache.protests?.events) {
      for (const e of this.ctx.intelligenceCache.protests.events) {
        if (e.country?.toLowerCase() === countryLower || inCountry(e.lat, e.lon)) {
          events.push({
            timestamp: new Date(e.time).getTime(),
            lane: 'protest',
            label: e.title || `${e.eventType} in ${e.city || e.country}`,
            severity: e.severity === 'high' ? 'high' : e.severity === 'medium' ? 'medium' : 'low',
          });
        }
      }
    }

    if (this.ctx.intelligenceCache.earthquakes) {
      for (const eq of this.ctx.intelligenceCache.earthquakes) {
        if (inCountry(eq.location?.latitude ?? 0, eq.location?.longitude ?? 0) || eq.place?.toLowerCase().includes(countryLower)) {
          events.push({
            timestamp: eq.occurredAt,
            lane: 'natural',
            label: `M${eq.magnitude.toFixed(1)} ${eq.place}`,
            severity: eq.magnitude >= 6 ? 'critical' : eq.magnitude >= 5 ? 'high' : eq.magnitude >= 4 ? 'medium' : 'low',
          });
        }
      }
    }

    if (this.ctx.intelligenceCache.military) {
      for (const f of this.ctx.intelligenceCache.military.flights) {
        if (hasGeoShape ? this.isInCountry(f.lat, f.lon, code) : f.operatorCountry?.toUpperCase() === code) {
          events.push({
            timestamp: new Date(f.lastSeen).getTime(),
            lane: 'military',
            label: `${f.callsign} (${f.aircraftModel || f.aircraftType})`,
            severity: f.isInteresting ? 'high' : 'low',
          });
        }
      }
      for (const v of this.ctx.intelligenceCache.military.vessels) {
        if (hasGeoShape ? this.isInCountry(v.lat, v.lon, code) : v.operatorCountry?.toUpperCase() === code) {
          events.push({
            timestamp: new Date(v.lastAisUpdate).getTime(),
            lane: 'military',
            label: `${v.name} (${v.vesselType})`,
            severity: v.isDark ? 'high' : 'low',
          });
        }
      }
    }

    const ciiData = getCountryData(code);
    if (ciiData?.conflicts) {
      for (const c of ciiData.conflicts) {
        events.push({
          timestamp: new Date(c.time).getTime(),
          lane: 'conflict',
          label: `${c.eventType}: ${c.location || c.country}`,
          severity: c.fatalities > 0 ? 'critical' : 'high',
        });
      }
    }

    for (const e of this.getCountryStrikes(code, hasGeoShape)) {
      const rawTs = Number(e.timestamp) || 0;
      const ts = rawTs < 1e12 ? rawTs * 1000 : rawTs;
      events.push({
        timestamp: ts,
        lane: 'conflict',
        label: e.title || `Strike: ${e.locationName}`,
        severity: (e.severity.toLowerCase() === 'high' || e.severity.toLowerCase() === 'critical') ? 'critical' : 'high',
      });
    }

    this.ctx.countryTimeline = new CountryTimeline(mount);
    this.ctx.countryTimeline.render(events.filter(e => e.timestamp >= sevenDaysAgo));
  }

  getCountrySignals(code: string, country: string): CountryBriefSignals {
    const countryLower = country.toLowerCase();
    const hasGeoShape = hasCountryGeometry(code) || !!CountryIntelManager.COUNTRY_BOUNDS[code];
    const clusters = signalAggregator.getCountryClusters();
    const countryCluster = clusters.find(c => c.country === code);
    const globalCluster = clusters.find(c => c.country === 'XX');
    const signalTypeCounts = {
      aisDisruptions: 0,
      satelliteFires: 0,
      radiationAnomalies: 0,
      temporalAnomalies: 0,
    };
    if (countryCluster) {
      for (const s of countryCluster.signals) {
        if (s.type === 'ais_disruption') signalTypeCounts.aisDisruptions++;
        else if (s.type === 'satellite_fire') signalTypeCounts.satelliteFires++;
        else if (s.type === 'radiation_anomaly') signalTypeCounts.radiationAnomalies++;
        else if (s.type === 'temporal_anomaly') signalTypeCounts.temporalAnomalies++;
      }
    }
    const globalTemporalAnomalies = globalCluster
      ? globalCluster.signals.filter((s) => s.type === 'temporal_anomaly').length
      : 0;

    const searchTerms = CountryIntelManager.getCountrySearchTerms(country, code);
    const otherCountryTerms = CountryIntelManager.getOtherCountryTerms(code);
    const criticalNews = this.ctx.latestClusters.filter((cluster) => {
      const title = cluster.primaryTitle.toLowerCase();
      const ourPos = CountryIntelManager.firstMentionPosition(title, searchTerms);
      const otherPos = CountryIntelManager.firstMentionPosition(title, otherCountryTerms);
      if (ourPos === Infinity || (otherPos !== Infinity && otherPos < ourPos)) return false;
      return cluster.isAlert || cluster.threat?.level === 'critical' || cluster.threat?.level === 'high';
    }).length;

    let protests = 0;
    if (this.ctx.intelligenceCache.protests?.events) {
      protests = this.ctx.intelligenceCache.protests.events.filter((e) =>
        e.country?.toLowerCase() === countryLower || (hasGeoShape && this.isInCountry(e.lat, e.lon, code))
      ).length;
    }

    let militaryFlights = 0;
    let militaryVessels = 0;
    let militaryFlightsInCountry = 0;
    let militaryVesselsInCountry = 0;
    if (this.ctx.intelligenceCache.military) {
      militaryFlights = this.ctx.intelligenceCache.military.flights.filter((f) =>
        hasGeoShape ? this.isNearCountry(f.lat, f.lon, code) : f.operatorCountry?.toUpperCase() === code
      ).length;
      militaryVessels = this.ctx.intelligenceCache.military.vessels.filter((v) =>
        hasGeoShape ? this.isNearCountry(v.lat, v.lon, code) : v.operatorCountry?.toUpperCase() === code
      ).length;
      militaryFlightsInCountry = this.ctx.intelligenceCache.military.flights.filter((f) =>
        hasGeoShape ? this.isInCountry(f.lat, f.lon, code) : f.operatorCountry?.toUpperCase() === code
      ).length;
      militaryVesselsInCountry = this.ctx.intelligenceCache.military.vessels.filter((v) =>
        hasGeoShape ? this.isInCountry(v.lat, v.lon, code) : v.operatorCountry?.toUpperCase() === code
      ).length;
    }

    let outages = 0;
    if (this.ctx.intelligenceCache.outages) {
      outages = this.ctx.intelligenceCache.outages.filter((o) =>
        o.country?.toLowerCase() === countryLower || (hasGeoShape && this.isInCountry(o.lat, o.lon, code))
      ).length;
    }

    let earthquakes = 0;
    if (this.ctx.intelligenceCache.earthquakes) {
      earthquakes = this.ctx.intelligenceCache.earthquakes.filter((eq) => {
        if (hasGeoShape) return this.isInCountry(eq.location?.latitude ?? 0, eq.location?.longitude ?? 0, code);
        return eq.place?.toLowerCase().includes(countryLower);
      }).length;
    }

    const activeStrikes = this.getCountryStrikes(code, hasGeoShape).length;

    let aviationDisruptions = 0;
    if (this.ctx.intelligenceCache.flightDelays) {
      aviationDisruptions = this.ctx.intelligenceCache.flightDelays.filter(d =>
        (d.severity === 'major' || d.severity === 'severe' || d.delayType === 'closure') &&
        (hasGeoShape ? this.isInCountry(d.lat, d.lon, code) : d.country?.toLowerCase() === countryLower)
      ).length;
    }

    const ciiData = getCountryData(code);
    const isTier1 = !!TIER1_COUNTRIES[code];

    let orefSirens = 0;
    let orefHistory24h = 0;
    if (code === 'IL' && this.ctx.intelligenceCache.orefAlerts) {
      orefSirens = this.ctx.intelligenceCache.orefAlerts.alertCount;
      orefHistory24h = this.ctx.intelligenceCache.orefAlerts.historyCount24h;
    }

    let travelAdvisories = 0;
    let travelAdvisoryMaxLevel: string | null = null;
    const advisoryLevelRank: Record<string, number> = { 'do-not-travel': 4, 'reconsider': 3, 'caution': 2, 'normal': 1, 'info': 0 };
    if (this.ctx.intelligenceCache.advisories) {
      const countryAdvisories = this.ctx.intelligenceCache.advisories.filter(a => a.country === code);
      travelAdvisories = countryAdvisories.length;
      for (const a of countryAdvisories) {
        if (a.level && (advisoryLevelRank[a.level] || 0) > (advisoryLevelRank[travelAdvisoryMaxLevel || ''] || 0)) {
          travelAdvisoryMaxLevel = a.level;
        }
      }
    }

    let cyberThreats = 0;
    if (this.ctx.cyberThreatsCache) {
      cyberThreats = this.ctx.cyberThreatsCache.filter((threat) => {
        if (threat.country && threat.country.length === 2) return threat.country.toUpperCase() === code;
        return hasGeoShape && this.isInCountry(threat.lat, threat.lon, code);
      }).length;
    }

    let thermalEscalations = 0;
    if (this.ctx.intelligenceCache.thermalEscalation) {
      thermalEscalations = this.ctx.intelligenceCache.thermalEscalation.clusters.filter(
        (c) => c.countryCode.toUpperCase() === code && c.status !== 'normal',
      ).length;
    }

    const sanctionsCountry = this.ctx.intelligenceCache.sanctions?.countries.find(
      (c) => c.countryCode.toUpperCase() === code,
    );
    const sanctionsDesignations = sanctionsCountry?.entryCount ?? 0;
    const sanctionsNewDesignations = sanctionsCountry?.newEntryCount ?? 0;

    return {
      criticalNews,
      protests,
      militaryFlights,
      militaryVessels,
      militaryFlightsInCountry,
      militaryVesselsInCountry,
      outages,
      aisDisruptions: signalTypeCounts.aisDisruptions,
      satelliteFires: signalTypeCounts.satelliteFires,
      radiationAnomalies: signalTypeCounts.radiationAnomalies,
      temporalAnomalies: signalTypeCounts.temporalAnomalies > 0 ? signalTypeCounts.temporalAnomalies : globalTemporalAnomalies,
      cyberThreats,
      earthquakes,
      displacementOutflow: ciiData?.displacementOutflow ?? 0,
      climateStress: ciiData?.climateStress ?? 0,
      conflictEvents: ciiData?.conflicts?.length ?? 0,
      activeStrikes,
      orefSirens,
      orefHistory24h,
      aviationDisruptions,
      travelAdvisories,
      travelAdvisoryMaxLevel,
      gpsJammingHexes: (ciiData?.gpsJammingHighCount ?? 0) + (ciiData?.gpsJammingMediumCount ?? 0),
      isTier1,
      thermalEscalations,
      sanctionsDesignations,
      sanctionsNewDesignations,
    };
  }

  private newsSeverityRank(item: NewsItem): number {
    const level = item.threat?.level;
    if (level === 'critical') return 5;
    if (level === 'high') return 4;
    if (level === 'medium') return 3;
    if (level === 'low') return 2;
    if (item.isAlert) return 4;
    return 1;
  }

  private buildSignalDetails(code: string): CountryDeepDiveSignalDetails {
    const cluster = signalAggregator.getCountryClusters().find((entry) => entry.country === code);
    if (!cluster) {
      return { critical: 0, high: 0, medium: 0, low: 0, recentHigh: [] };
    }

    const details: CountryDeepDiveSignalDetails = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      recentHigh: [],
    };

    const rankedSignals = [...cluster.signals]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    for (const signal of rankedSignals) {
      const severity = this.normalizeSignalSeverity(signal.type, signal.severity);
      if (severity === 'critical') details.critical += 1;
      else if (severity === 'high') details.high += 1;
      else if (severity === 'medium') details.medium += 1;
      else details.low += 1;
    }

    details.recentHigh = rankedSignals
      .map((signal) => ({
        type: this.mapSignalType(signal.type),
        severity: this.normalizeSignalSeverity(signal.type, signal.severity),
        description: signal.title,
        timestamp: signal.timestamp,
      }))
      .filter((signal) => signal.severity === 'critical' || signal.severity === 'high')
      .slice(0, 3);

    return details;
  }

  private buildMilitarySummary(code: string, country: string): CountryDeepDiveMilitarySummary {
    const hasGeoShape = hasCountryGeometry(code) || !!CountryIntelManager.COUNTRY_BOUNDS[code];
    const flights = this.ctx.intelligenceCache.military?.flights ?? [];
    const vessels = this.ctx.intelligenceCache.military?.vessels ?? [];

    const flightsInCountry = flights.filter((flight) =>
      hasGeoShape ? this.isInCountry(flight.lat, flight.lon, code) : this.sameCountry(code, country, flight.operatorCountry)
    );
    const ownFlights = flightsInCountry.filter((flight) => this.sameCountry(code, country, flight.operatorCountry)).length;
    const foreignFlights = Math.max(0, flightsInCountry.length - ownFlights);

    const vesselsInCountry = vessels.filter((vessel) =>
      hasGeoShape ? this.isInCountry(vessel.lat, vessel.lon, code) : this.sameCountry(code, country, vessel.operatorCountry)
    );
    const foreignVessels = vesselsInCountry.filter((vessel) => !this.sameCountry(code, country, vessel.operatorCountry)).length;

    const centroid = getCountryCentroid(code, CountryIntelManager.COUNTRY_BOUNDS);
    const nearbyBases = centroid
      ? getNearbyInfrastructure(centroid.lat, centroid.lon, ['base']).slice(0, 3).map((base) => ({
        id: base.id,
        name: base.name,
        distanceKm: base.distanceKm,
        country: MILITARY_BASES.find((entry) => entry.id === base.id)?.country,
      }))
      : [];

    return {
      ownFlights,
      foreignFlights,
      nearbyVessels: vesselsInCountry.length,
      nearestBases: nearbyBases,
      foreignPresence: foreignFlights > 0 || foreignVessels > 0,
    };
  }

  private buildEconomicIndicators(
    code: string,
    score: CountryScore | null,
    stock: CountryStockSnapshot | null,
    imfBundle?: ImfCountryBundle | null,
  ): CountryDeepDiveEconomicIndicator[] {
    const indicators: CountryDeepDiveEconomicIndicator[] = [];

    if (stock?.available) {
      const weekly = Number.parseFloat(stock.weekChangePercent);
      const weeklyTrend = Number.isFinite(weekly)
        ? weekly > 0 ? 'up' : weekly < 0 ? 'down' : 'flat'
        : 'flat';
      indicators.push({
        label: 'Stock Index',
        value: `${stock.indexName}: ${stock.price} ${stock.currency}`,
        trend: weeklyTrend,
        source: 'Market Service',
      });
      indicators.push({
        label: 'Weekly Momentum',
        value: `${weekly >= 0 ? '+' : ''}${stock.weekChangePercent}%`,
        trend: weeklyTrend,
      });
    }

    if (score) {
      const trend = score.trend === 'rising'
        ? 'up'
        : score.trend === 'falling'
          ? 'down'
          : 'flat';
      indicators.push({
        label: 'Instability Regime',
        value: `${score.score}/100 (${score.level})`,
        trend,
        source: 'CII',
      });
    }

    const countryData = getCountryData(code);
    if (countryData?.displacementOutflow && countryData.displacementOutflow > 0) {
      const displaced = countryData.displacementOutflow >= 1_000_000
        ? `${(countryData.displacementOutflow / 1_000_000).toFixed(1)}M`
        : `${Math.round(countryData.displacementOutflow / 1000)}K`;
      indicators.push({
        label: 'Displacement Outflow',
        value: displaced,
        trend: 'up',
        source: 'UN-style displacement feed',
      });
    }

    // IMF WEO indicators (issue #3027): real GDP growth, inflation,
    // unemployment, GDP/capita. Appended after the live signals so that
    // markets-driven rows take priority on the limited card surface.
    if (imfBundle) {
      for (const ind of buildImfEconomicIndicators(imfBundle)) {
        indicators.push(ind);
      }
    }

    return indicators.slice(0, 6);
  }

  private sameCountry(code: string, country: string, raw: string | undefined): boolean {
    if (!raw) return false;
    const normalized = raw.trim();
    if (!normalized) return false;

    const upper = normalized.toUpperCase();
    if (upper === code) return true;
    if (upper.length === 3) {
      const iso2 = iso3ToIso2Code(upper);
      if (iso2 === code) return true;
    }

    const fromName = nameToCountryCode(normalized.toLowerCase());
    if (fromName === code) return true;

    const countryLower = country.toLowerCase();
    const rawLower = normalized.toLowerCase();
    return rawLower === countryLower || rawLower.includes(countryLower);
  }

  private mapSignalType(type: string): CountryDeepDiveSignalDetails['recentHigh'][number]['type'] {
    if (type === 'military_flight' || type === 'military_vessel') return 'MILITARY';
    if (type === 'protest') return 'PROTEST';
    if (type === 'internet_outage') return 'OUTAGE';
    if (type === 'satellite_fire') return 'DISASTER';
    if (type === 'radiation_anomaly') return 'DISASTER';
    if (type === 'ais_disruption') return 'OUTAGE';
    if (type === 'active_strike') return 'MILITARY';
    if (type === 'temporal_anomaly') return 'CYBER';
    return 'OTHER';
  }

  private normalizeSignalSeverity(
    type: string,
    severity: 'low' | 'medium' | 'high',
  ): CountryDeepDiveSignalDetails['recentHigh'][number]['severity'] {
    if (type === 'active_strike' && severity === 'high') return 'critical';
    if (type === 'radiation_anomaly' && severity === 'high') return 'critical';
    if (severity === 'high') return 'high';
    if (severity === 'medium') return 'medium';
    return 'low';
  }

  openCountryStory(code: string, name: string): void {
    if (!dataFreshness.hasSufficientData() || this.ctx.latestClusters.length === 0) {
      this.showToast('Data still loading — try again in a moment');
      return;
    }
    const posturePanel = this.ctx.panels['strategic-posture'] as StrategicPosturePanel | undefined;
    const postures = posturePanel?.getPostures() || [];
    const signals = this.getCountrySignals(code, name);
    const cluster = signalAggregator.getCountryClusters().find(c => c.country === code);
    const regional = signalAggregator.getRegionalConvergence().filter(r => r.countries.includes(code));
    const convergence = cluster ? {
      score: cluster.convergenceScore,
      signalTypes: [...cluster.signalTypes],
      regionalDescriptions: regional.map(r => r.description),
    } : null;
    const data = collectStoryData(code, name, this.ctx.latestClusters, postures, this.ctx.latestPredictions, signals, convergence);
    openStoryModal(data);
  }

  showToast(msg: string): void {
    document.querySelector('.toast-notification')?.remove();
    const el = document.createElement('div');
    el.className = 'toast-notification';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 300); }, 3000);
  }

  private getCountryStrikes(code: string, hasGeoShape: boolean): typeof this.ctx.intelligenceCache.iranEvents & object {
    if (!this.ctx.intelligenceCache.iranEvents) return [];
    const seen = new Set<string>();
    return this.ctx.intelligenceCache.iranEvents.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return hasGeoShape && this.isInCountry(e.latitude, e.longitude, code);
    });
  }

  private isInCountry(lat: number, lon: number, code: string): boolean {
    const precise = isCoordinateInCountry(lat, lon, code);
    if (precise === true) return true;
    // When precise geometry returns false (coastal/polygon precision) or null (not loaded),
    // fall through to bounding box — matches CII's coordsToBoundsCountry fallback
    const b = CountryIntelManager.COUNTRY_BOUNDS[code];
    if (!b) return false;
    return lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;
  }

  // Near = bounding-box padded by ~2° (~220 km). Captures vessels/aircraft in
  // adjacent waters/airspace so the risk chip reflects proximity, not just
  // strict territory. See issue #2972 bug 2.
  private static readonly NEAR_BUFFER_DEG = 2;
  private isNearCountry(lat: number, lon: number, code: string): boolean {
    if (this.isInCountry(lat, lon, code)) return true;
    const b = CountryIntelManager.COUNTRY_BOUNDS[code];
    if (!b) return false;
    const pad = CountryIntelManager.NEAR_BUFFER_DEG;
    return lat >= b.s - pad && lat <= b.n + pad && lon >= b.w - pad && lon <= b.e + pad;
  }

  static COUNTRY_BOUNDS: Record<string, { n: number; s: number; e: number; w: number }> = {
    ...ME_STRIKE_BOUNDS,
    CN: { n: 53.6, s: 18.2, e: 134.8, w: 73.5 }, TW: { n: 25.3, s: 21.9, e: 122, w: 120 },
    JP: { n: 45.5, s: 24.2, e: 153.9, w: 122.9 }, KR: { n: 38.6, s: 33.1, e: 131.9, w: 124.6 },
    KP: { n: 43.0, s: 37.7, e: 130.7, w: 124.2 }, IN: { n: 35.5, s: 6.7, e: 97.4, w: 68.2 },
    PK: { n: 37, s: 24, e: 77, w: 61 }, AF: { n: 38.5, s: 29.4, e: 74.9, w: 60.5 },
    UA: { n: 52.4, s: 44.4, e: 40.2, w: 22.1 }, RU: { n: 82, s: 41.2, e: 180, w: 19.6 },
    BY: { n: 56.2, s: 51.3, e: 32.8, w: 23.2 }, PL: { n: 54.8, s: 49, e: 24.1, w: 14.1 },
    EG: { n: 31.7, s: 22, e: 36.9, w: 25 }, LY: { n: 33, s: 19.5, e: 25, w: 9.4 },
    SD: { n: 22, s: 8.7, e: 38.6, w: 21.8 }, US: { n: 49, s: 24.5, e: -66.9, w: -125 },
    GB: { n: 58.7, s: 49.9, e: 1.8, w: -8.2 }, DE: { n: 55.1, s: 47.3, e: 15.0, w: 5.9 },
    FR: { n: 51.1, s: 41.3, e: 9.6, w: -5.1 }, TR: { n: 42.1, s: 36, e: 44.8, w: 26 },
    BR: { n: 5.3, s: -33.8, e: -34.8, w: -73.9 },
  };

  static COUNTRY_ALIASES: Record<string, string[]> = {
    IL: ['israel', 'israeli', 'gaza', 'hamas', 'hezbollah', 'netanyahu', 'idf', 'west bank', 'tel aviv', 'jerusalem'],
    IR: ['iran', 'iranian', 'tehran', 'persian', 'irgc', 'khamenei'],
    RU: ['russia', 'russian', 'moscow', 'kremlin', 'putin', 'ukraine war'],
    UA: ['ukraine', 'ukrainian', 'kyiv', 'zelensky', 'zelenskyy'],
    CN: ['china', 'chinese', 'beijing', 'taiwan strait', 'south china sea', 'xi jinping'],
    TW: ['taiwan', 'taiwanese', 'taipei'],
    KP: ['north korea', 'pyongyang', 'kim jong'],
    KR: ['south korea', 'seoul'],
    SA: ['saudi', 'riyadh', 'mbs'],
    SY: ['syria', 'syrian', 'damascus', 'assad'],
    YE: ['yemen', 'houthi', 'sanaa'],
    IQ: ['iraq', 'iraqi', 'baghdad'],
    AF: ['afghanistan', 'afghan', 'kabul', 'taliban'],
    PK: ['pakistan', 'pakistani', 'islamabad'],
    IN: ['india', 'indian', 'new delhi', 'modi'],
    EG: ['egypt', 'egyptian', 'cairo', 'suez'],
    LB: ['lebanon', 'lebanese', 'beirut'],
    TR: ['turkey', 'turkish', 'ankara', 'erdogan', 'türkiye'],
    US: ['united states', 'american', 'washington', 'pentagon', 'white house'],
    GB: ['united kingdom', 'british', 'london', 'uk '],
    BR: ['brazil', 'brazilian', 'brasilia', 'lula', 'bolsonaro'],
    AE: ['united arab emirates', 'uae', 'emirati', 'dubai', 'abu dhabi'],
  };

  private static otherCountryTermsCache: Map<string, string[]> = new Map();

  static firstMentionPosition(text: string, terms: string[]): number {
    let earliest = Infinity;
    for (const term of terms) {
      const idx = text.indexOf(term);
      if (idx !== -1 && idx < earliest) earliest = idx;
    }
    return earliest;
  }

  static getOtherCountryTerms(code: string): string[] {
    const cached = CountryIntelManager.otherCountryTermsCache.get(code);
    if (cached) return cached;

    const dedup = new Set<string>();
    Object.entries(CountryIntelManager.COUNTRY_ALIASES).forEach(([countryCode, aliases]) => {
      if (countryCode === code) return;
      aliases.forEach((alias) => {
        const normalized = alias.toLowerCase();
        if (normalized.trim().length > 0) dedup.add(normalized);
      });
    });

    const terms = [...dedup];
    CountryIntelManager.otherCountryTermsCache.set(code, terms);
    return terms;
  }

  static resolveCountryName(code: string): string {
    if (TIER1_COUNTRIES[code]) return TIER1_COUNTRIES[code];

    try {
      const displayNamesCtor = (Intl as unknown as { DisplayNames?: IntlDisplayNamesCtor }).DisplayNames;
      if (!displayNamesCtor) return code;
      const displayNames = new displayNamesCtor(['en'], { type: 'region' });
      const resolved = displayNames.of(code);
      if (resolved && resolved.toUpperCase() !== code) return resolved;
    } catch {
      // Intl.DisplayNames unavailable in older runtimes.
    }

    return code;
  }

  static getCountrySearchTerms(country: string, code: string): string[] {
    const aliases = CountryIntelManager.COUNTRY_ALIASES[code];
    if (aliases) return aliases;
    if (/^[A-Z]{2}$/i.test(country.trim())) return [];
    return [country.toLowerCase()];
  }

  static toFlagEmoji(code: string): string {
    return toFlagEmoji(code, '🏳️');
  }
}
