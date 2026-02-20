import type { MapLayers } from '@/types';
import { REFRESH_INTERVALS, SITE_VARIANT } from '@/config';

interface RefreshSchedulerDeps {
  isDestroyed: () => boolean;
  mapLayers: () => MapLayers;
  isInFlight: (name: string) => boolean;
  markInFlight: (name: string) => void;
  clearInFlight: (name: string) => void;
  shouldRefreshCyberThreats: () => boolean;
  loadNews: () => Promise<void>;
  loadMarkets: () => Promise<void>;
  loadPredictions: () => Promise<void>;
  loadPizzInt: () => Promise<void>;
  loadNatural: () => Promise<void>;
  loadWeatherAlerts: () => Promise<void>;
  loadFredData: () => Promise<void>;
  loadOilAnalytics: () => Promise<void>;
  loadGovernmentSpending: () => Promise<void>;
  refreshIntelligence: () => Promise<void>;
  loadFirmsData: () => Promise<void>;
  loadAisSignals: () => Promise<void>;
  loadCableActivity: () => Promise<void>;
  loadFlightDelays: () => Promise<void>;
  loadCyberThreats: () => Promise<void>;
}

export class RefreshScheduler {
  private readonly timeoutIds = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: RefreshSchedulerDeps) {}

  public teardown(): void {
    for (const timeoutId of this.timeoutIds.values()) clearTimeout(timeoutId);
    this.timeoutIds.clear();
  }

  public setupIntervals(): void {
    this.scheduleRefresh('news', () => this.deps.loadNews(), REFRESH_INTERVALS.feeds);
    this.scheduleRefresh('markets', () => this.deps.loadMarkets(), REFRESH_INTERVALS.markets);
    this.scheduleRefresh('predictions', () => this.deps.loadPredictions(), REFRESH_INTERVALS.predictions);
    this.scheduleRefresh('pizzint', () => this.deps.loadPizzInt(), 10 * 60 * 1000);

    this.scheduleRefresh('natural', () => this.deps.loadNatural(), 5 * 60 * 1000, () => this.deps.mapLayers().natural);
    this.scheduleRefresh('weather', () => this.deps.loadWeatherAlerts(), 10 * 60 * 1000, () => this.deps.mapLayers().weather);
    this.scheduleRefresh('fred', () => this.deps.loadFredData(), 30 * 60 * 1000);
    this.scheduleRefresh('oil', () => this.deps.loadOilAnalytics(), 30 * 60 * 1000);
    this.scheduleRefresh('spending', () => this.deps.loadGovernmentSpending(), 60 * 60 * 1000);

    if (SITE_VARIANT === 'full') {
      this.scheduleRefresh('intelligence', () => this.deps.refreshIntelligence(), 5 * 60 * 1000);
    }

    this.scheduleRefresh('firms', () => this.deps.loadFirmsData(), 30 * 60 * 1000);
    this.scheduleRefresh('ais', () => this.deps.loadAisSignals(), REFRESH_INTERVALS.ais, () => this.deps.mapLayers().ais);
    this.scheduleRefresh('cables', () => this.deps.loadCableActivity(), 30 * 60 * 1000, () => this.deps.mapLayers().cables);
    this.scheduleRefresh('flights', () => this.deps.loadFlightDelays(), 10 * 60 * 1000, () => this.deps.mapLayers().flights);
    this.scheduleRefresh('cyberThreats', () => this.deps.loadCyberThreats(), 10 * 60 * 1000, () => this.deps.shouldRefreshCyberThreats() && this.deps.mapLayers().cyberThreats);
  }

  private scheduleRefresh(name: string, fn: () => Promise<void>, intervalMs: number, condition?: () => boolean): void {
    const HIDDEN_REFRESH_MULTIPLIER = 4;
    const JITTER_FRACTION = 0.1;
    const MIN_REFRESH_MS = 1000;
    const computeDelay = (baseMs: number, isHidden: boolean) => {
      const adjusted = baseMs * (isHidden ? HIDDEN_REFRESH_MULTIPLIER : 1);
      const jitterRange = adjusted * JITTER_FRACTION;
      const jittered = adjusted + (Math.random() * 2 - 1) * jitterRange;
      return Math.max(MIN_REFRESH_MS, Math.round(jittered));
    };
    const scheduleNext = (delay: number) => {
      if (this.deps.isDestroyed()) return;
      const timeoutId = setTimeout(run, delay);
      this.timeoutIds.set(name, timeoutId);
    };
    const run = async () => {
      if (this.deps.isDestroyed()) return;
      const isHidden = document.visibilityState === 'hidden';
      if (isHidden) return scheduleNext(computeDelay(intervalMs, true));
      if (condition && !condition()) return scheduleNext(computeDelay(intervalMs, false));
      if (this.deps.isInFlight(name)) return scheduleNext(computeDelay(intervalMs, false));

      this.deps.markInFlight(name);
      try {
        await fn();
      } catch (e) {
        console.error(`[App] Refresh ${name} failed:`, e);
      } finally {
        this.deps.clearInFlight(name);
        scheduleNext(computeDelay(intervalMs, false));
      }
    };
    scheduleNext(computeDelay(intervalMs, document.visibilityState === 'hidden'));
  }
}
