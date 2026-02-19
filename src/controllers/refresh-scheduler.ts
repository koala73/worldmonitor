/**
 * RefreshScheduler — manages periodic data refresh intervals, snapshot saving,
 * and timer cleanup.
 *
 * Extracted from App.ts to isolate scheduling concerns.  Receives an
 * {@link AppContext} for shared state and a {@link RefreshCallbacks} object so
 * it never imports DataLoader directly.
 */

import type { AppContext } from './app-context';
import { REFRESH_INTERVALS, SITE_VARIANT } from '@/config';
import { saveSnapshot } from '@/services/storage';

const CYBER_LAYER_ENABLED = import.meta.env.VITE_ENABLE_CYBER_LAYER === 'true';

/* ------------------------------------------------------------------ */
/*  Callback interface                                                 */
/* ------------------------------------------------------------------ */

/**
 * Callbacks from DataLoader that RefreshScheduler invokes periodically.
 */
export interface RefreshCallbacks {
  loadNews: () => Promise<void>;
  loadMarkets: () => Promise<void>;
  loadPredictions: () => Promise<void>;
  loadPizzInt: () => Promise<void>;
  loadNatural: () => Promise<void>;
  loadWeatherAlerts: () => Promise<void>;
  loadFredData: () => Promise<void>;
  loadOilAnalytics: () => Promise<void>;
  loadGovernmentSpending: () => Promise<void>;
  loadIntelligenceSignals: () => Promise<void>;
  loadFirmsData: () => Promise<void>;
  loadAisSignals: () => Promise<void>;
  loadCableActivity: () => Promise<void>;
  loadFlightDelays: () => Promise<void>;
  loadCyberThreats: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  RefreshScheduler                                                   */
/* ------------------------------------------------------------------ */

export class RefreshScheduler {
  constructor(private ctx: AppContext) {}

  /* ---------------------------------------------------------------- */
  /*  scheduleRefresh                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Schedule a named refresh task that runs periodically with jitter.
   *
   * When the page is hidden the interval is multiplied by
   * `HIDDEN_REFRESH_MULTIPLIER` to conserve resources.  An optional
   * `condition` callback can gate execution (e.g. only refresh a layer
   * when it is enabled).
   */
  scheduleRefresh(
    name: string,
    fn: () => Promise<void>,
    intervalMs: number,
    condition?: () => boolean,
  ): void {
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
      if (this.ctx.isDestroyed) return;
      const timeoutId = setTimeout(run, delay);
      this.ctx.refreshTimeoutIds.set(name, timeoutId);
    };

    const run = async () => {
      if (this.ctx.isDestroyed) return;

      const isHidden = document.visibilityState === 'hidden';
      if (isHidden) {
        scheduleNext(computeDelay(intervalMs, true));
        return;
      }
      if (condition && !condition()) {
        scheduleNext(computeDelay(intervalMs, false));
        return;
      }
      if (this.ctx.inFlight.has(name)) {
        scheduleNext(computeDelay(intervalMs, false));
        return;
      }

      this.ctx.inFlight.add(name);
      try {
        await fn();
      } catch (e) {
        console.error(`[RefreshScheduler] Refresh ${name} failed:`, e);
      } finally {
        this.ctx.inFlight.delete(name);
        scheduleNext(computeDelay(intervalMs, false));
      }
    };

    scheduleNext(computeDelay(intervalMs, document.visibilityState === 'hidden'));
  }

  /* ---------------------------------------------------------------- */
  /*  setupRefreshIntervals                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Wire all periodic data refreshes using the supplied callbacks.
   */
  setupRefreshIntervals(cb: RefreshCallbacks): void {
    // Always refresh news, markets, predictions, pizzint
    this.scheduleRefresh('news', () => cb.loadNews(), REFRESH_INTERVALS.feeds);
    this.scheduleRefresh('markets', () => cb.loadMarkets(), REFRESH_INTERVALS.markets);
    this.scheduleRefresh('predictions', () => cb.loadPredictions(), REFRESH_INTERVALS.predictions);
    this.scheduleRefresh('pizzint', () => cb.loadPizzInt(), 10 * 60 * 1000);

    // Only refresh layer data if layer is enabled
    this.scheduleRefresh('natural', () => cb.loadNatural(), 5 * 60 * 1000, () => this.ctx.mapLayers.natural);
    this.scheduleRefresh('weather', () => cb.loadWeatherAlerts(), 10 * 60 * 1000, () => this.ctx.mapLayers.weather);
    this.scheduleRefresh('fred', () => cb.loadFredData(), 30 * 60 * 1000);
    this.scheduleRefresh('oil', () => cb.loadOilAnalytics(), 30 * 60 * 1000);
    this.scheduleRefresh('spending', () => cb.loadGovernmentSpending(), 60 * 60 * 1000);

    // Refresh intelligence signals for CII (geopolitical variant only)
    if (SITE_VARIANT === 'full') {
      this.scheduleRefresh('intelligence', () => {
        this.ctx.intelligenceCache = {};
        return cb.loadIntelligenceSignals();
      }, 5 * 60 * 1000);
    }

    // Non-intelligence layer refreshes only
    this.scheduleRefresh('firms', () => cb.loadFirmsData(), 30 * 60 * 1000);
    this.scheduleRefresh('ais', () => cb.loadAisSignals(), REFRESH_INTERVALS.ais, () => this.ctx.mapLayers.ais);
    this.scheduleRefresh('cables', () => cb.loadCableActivity(), 30 * 60 * 1000, () => this.ctx.mapLayers.cables);
    this.scheduleRefresh('flights', () => cb.loadFlightDelays(), 10 * 60 * 1000, () => this.ctx.mapLayers.flights);
    this.scheduleRefresh('cyberThreats', () => {
      this.ctx.cyberThreatsCache = null;
      return cb.loadCyberThreats();
    }, 10 * 60 * 1000, () => CYBER_LAYER_ENABLED && this.ctx.mapLayers.cyberThreats);
  }

  /* ---------------------------------------------------------------- */
  /*  setupSnapshotSaving                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Immediately save a dashboard snapshot and then continue saving every
   * 15 minutes.
   */
  setupSnapshotSaving(): void {
    const saveCurrentSnapshot = async () => {
      if (this.ctx.isPlaybackMode || this.ctx.isDestroyed) return;

      const marketPrices: Record<string, number> = {};
      this.ctx.latestMarkets.forEach(m => {
        if (m.price !== null) marketPrices[m.symbol] = m.price;
      });

      await saveSnapshot({
        timestamp: Date.now(),
        events: this.ctx.latestClusters,
        marketPrices,
        predictions: this.ctx.latestPredictions.map(p => ({
          title: p.title,
          yesPrice: p.yesPrice,
        })),
        hotspotLevels: this.ctx.map?.getHotspotLevels() ?? {},
      });
    };

    void saveCurrentSnapshot().catch((e) =>
      console.warn('[Snapshot] save failed:', e),
    );

    this.ctx.snapshotIntervalId = setInterval(
      () => void saveCurrentSnapshot().catch((e) =>
        console.warn('[Snapshot] save failed:', e),
      ),
      15 * 60 * 1000,
    );
  }

  /* ---------------------------------------------------------------- */
  /*  clearAll                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Clear every scheduled refresh timeout and the snapshot interval.
   * Safe to call multiple times.
   */
  clearAll(): void {
    for (const id of this.ctx.refreshTimeoutIds.values()) {
      clearTimeout(id);
    }
    this.ctx.refreshTimeoutIds.clear();

    if (this.ctx.snapshotIntervalId !== null) {
      clearInterval(this.ctx.snapshotIntervalId);
      this.ctx.snapshotIntervalId = null;
    }
  }
}
