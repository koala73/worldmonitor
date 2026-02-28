import type { AppContext, AppModule, CountryBriefSignals } from '@/app/app-context';
import type { TimelineEvent } from '@/components/CountryTimeline';
import { CountryTimeline } from '@/components/CountryTimeline';
import { CountryBriefPage } from '@/components/CountryBriefPage';
import { reverseGeocode } from '@/utils/reverse-geocode';
import { getCountryAtCoordinates, hasCountryGeometry, isCoordinateInCountry } from '@/services/country-geometry';
import { calculateCII, getCountryData, TIER1_COUNTRIES } from '@/services/country-instability';
import { signalAggregator } from '@/services/signal-aggregator';
import { dataFreshness } from '@/services/data-freshness';
import { fetchCountryMarkets } from '@/services/prediction';
import { collectStoryData } from '@/services/story-data';
import { renderStoryToCanvas } from '@/services/story-renderer';
import { openStoryModal } from '@/components/StoryModal';
import { MarketServiceClient } from '@/generated/client/worldmonitor/market/v1/service_client';
import { IntelligenceServiceClient } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { BETA_MODE } from '@/config/beta';
import { mlWorker } from '@/services/ml-worker';
import { t } from '@/services/i18n';
import { trackCountrySelected, trackCountryBriefOpened } from '@/services/analytics';
import type { StrategicPosturePanel } from '@/components/StrategicPosturePanel';

type IntlDisplayNamesCtor = new (
  locales: string | string[],
  options: { type: 'region' }
) => { of: (code: string) => string | undefined };

export class CountryIntelManager implements AppModule {
  private ctx: AppContext;
  private briefRequestToken = 0;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  init(): void {
    this.setupCountryIntel();
  }

  destroy(): void {
    this.ctx.countryTimeline?.destroy();
    this.ctx.countryTimeline = null;
    this.ctx.countryBriefPage = null;
  }

  private setupCountryIntel(): void {
    if (!this.ctx.map) return;
    this.ctx.countryBriefPage = new CountryBriefPage();
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

  async openCountryBriefByCode(code: string, country: string): Promise<void> {
    if (!this.ctx.countryBriefPage) return;
    this.ctx.map?.setRenderPaused(true);
    trackCountryBriefOpened(code);

    const canonicalName = TIER1_COUNTRIES[code] || CountryIntelManager.resolveCountryName(code);
    if (canonicalName !== code) country = canonicalName;

    const scores = calculateCII();
    const score = scores.find((s) => s.code === code) ?? null;
    const signals = this.getCountrySignals(code, country);

    this.ctx.countryBriefPage.show(country, code, score, signals);
    this.ctx.map?.highlightCountry(code);

    const marketClient = new MarketServiceClient('', { fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args) });
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

    stockPromise.then((stock) => {
      if (this.ctx.countryBriefPage?.getCode() === code) this.ctx.countryBriefPage.updateStock(stock);
    });

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
    });
    if (filteredNews.length > 0) {
      this.ctx.countryBriefPage.updateNews(filteredNews.slice(0, 8));
    }

    this.ctx.countryBriefPage.updateInfrastructure(code);

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

      const headlines = filteredNews.slice(0, 15).map((n) => n.title);
      if (headlines.length) context.headlines = headlines;

      const stockData = await stockPromise;
      if (stockData.available) {
        const pct = parseFloat(stockData.weekChangePercent);
        context.stockIndex = `${stockData.indexName}: ${stockData.price} (${pct >= 0 ? '+' : ''}${stockData.weekChangePercent}% week)`;
      }

      let briefText = '';
      try {
        const intelClient = new IntelligenceServiceClient('', { fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args) });
        const resp = await intelClient.getCountryIntelBrief({ countryCode: code });
        briefText = resp.brief;
      } catch { /* server unreachable */ }

      if (briefText) {
        this.ctx.countryBriefPage!.updateBrief({ brief: briefText, country, code });
      } else {
        const briefHeadlines = (context.headlines as string[] | undefined) || [];
        let fallbackBrief = '';
        const sumModelId = BETA_MODE ? 'summarization-beta' : 'summarization';
        if (briefHeadlines.length >= 2 && mlWorker.isAvailable && mlWorker.isModelLoaded(sumModelId)) {
          try {
            const prompt = `Summarize the current situation in ${country} based on these headlines: ${briefHeadlines.slice(0, 8).join('. ')}`;
            const [summary] = await mlWorker.summarize([prompt], BETA_MODE ? 'summarization-beta' : undefined);
            if (summary && summary.length > 20) fallbackBrief = summary;
          } catch { /* T5 failed */ }
        }

        if (fallbackBrief) {
          this.ctx.countryBriefPage!.updateBrief({ brief: fallbackBrief, country, code, fallback: true });
        } else {
          const lines: string[] = [];
          if (score) lines.push(t('countryBrief.fallback.instabilityIndex', { score: String(score.score), level: t(`countryBrief.levels.${score.level}`), trend: t(`countryBrief.trends.${score.trend}`) }));
          if (signals.protests > 0) lines.push(t('countryBrief.fallback.protestsDetected', { count: String(signals.protests) }));
          if (signals.militaryFlights > 0) lines.push(t('countryBrief.fallback.aircraftTracked', { count: String(signals.militaryFlights) }));
          if (signals.militaryVessels > 0) lines.push(t('countryBrief.fallback.vesselsTracked', { count: String(signals.militaryVessels) }));
          if (signals.activeStrikes > 0) lines.push(t('countryBrief.fallback.activeStrikes', { count: String(signals.activeStrikes) }));
          if (signals.outages > 0) lines.push(t('countryBrief.fallback.internetOutages', { count: String(signals.outages) }));
          if (signals.earthquakes > 0) lines.push(t('countryBrief.fallback.recentEarthquakes', { count: String(signals.earthquakes) }));
          if (context.stockIndex) lines.push(t('countryBrief.fallback.stockIndex', { value: context.stockIndex }));
          if (briefHeadlines.length > 0) {
            lines.push('', t('countryBrief.fallback.recentHeadlines'));
            briefHeadlines.slice(0, 5).forEach(h => lines.push(`• ${h}`));
          }
          if (lines.length > 0) {
            this.ctx.countryBriefPage!.updateBrief({ brief: lines.join('\n'), country, code, fallback: true });
          } else {
            this.ctx.countryBriefPage!.updateBrief({ brief: '', country, code, error: 'No AI service available. Configure GROQ_API_KEY in Settings for full briefs.' });
          }
        }
      }
    } catch (err) {
      console.error('[CountryBrief] fetch error:', err);
      this.ctx.countryBriefPage!.updateBrief({ brief: '', country, code, error: 'Failed to generate brief' });
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
      const ts = e.timestamp < 1e12 ? e.timestamp * 1000 : e.timestamp;
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

    let protests = 0;
    if (this.ctx.intelligenceCache.protests?.events) {
      protests = this.ctx.intelligenceCache.protests.events.filter((e) =>
        e.country?.toLowerCase() === countryLower || (hasGeoShape && this.isInCountry(e.lat, e.lon, code))
      ).length;
    }

    let militaryFlights = 0;
    let militaryVessels = 0;
    if (this.ctx.intelligenceCache.military) {
      militaryFlights = this.ctx.intelligenceCache.military.flights.filter((f) =>
        hasGeoShape ? this.isInCountry(f.lat, f.lon, code) : f.operatorCountry?.toUpperCase() === code
      ).length;
      militaryVessels = this.ctx.intelligenceCache.military.vessels.filter((v) =>
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

    const ciiData = getCountryData(code);
    const isTier1 = !!TIER1_COUNTRIES[code];

    return {
      protests,
      militaryFlights,
      militaryVessels,
      outages,
      earthquakes,
      displacementOutflow: ciiData?.displacementOutflow ?? 0,
      climateStress: ciiData?.climateStress ?? 0,
      conflictEvents: ciiData?.conflicts?.length ?? 0,
      activeStrikes,
      isTier1,
    };
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
    if (precise != null) return precise;
    const b = CountryIntelManager.COUNTRY_BOUNDS[code];
    if (!b) return false;
    return lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;
  }

  static COUNTRY_BOUNDS: Record<string, { n: number; s: number; e: number; w: number }> = {
    IR: { n: 40, s: 25, e: 63, w: 44 }, IL: { n: 33.3, s: 29.5, e: 35.9, w: 34.3 },
    SA: { n: 32, s: 16, e: 55, w: 35 }, AE: { n: 26.1, s: 22.6, e: 56.4, w: 51.6 },
    IQ: { n: 37.4, s: 29.1, e: 48.6, w: 38.8 }, SY: { n: 37.3, s: 32.3, e: 42.4, w: 35.7 },
    YE: { n: 19, s: 12, e: 54.5, w: 42 }, LB: { n: 34.7, s: 33.1, e: 36.6, w: 35.1 },
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
    const upperCode = code.toUpperCase();
    if (!/^[A-Z]{2}$/.test(upperCode)) return '🏳️';
    return upperCode
      .split('')
      .map((char) => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65))
      .join('');
  }
}
