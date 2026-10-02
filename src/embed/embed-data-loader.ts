import type { MapLayers, NaturalEvent, SocialUnrestEvent } from '@/types';
// The map consumes the seismology service's Earthquake, which carries fields
// the `@/types` one does not — importing the wrong one silently narrows it.
import type { Earthquake } from '@/services/earthquakes';
import type { AcledConflictEvent } from '@/generated/client/worldmonitor/conflict/v1/service_client';
import type { WeatherAlert } from '@/services/weather';
import { mapAlert } from '@/services/weather';
import { toNaturalEvent } from '@/services/eonet';
import { toSocialUnrestEvent } from '@/services/unrest';

import { startSmartPollLoop, type SmartPollLoopHandle } from '@/services/smart-poll-loop';
import {
  EmbedMapFrameUnavailableError,
  fetchEmbedMapFrame,
  isEmbedGrantExpiring,
  type EmbedGrant,
  type EmbedGrantResult,
} from './embed-fetch';
import { EMBED_FREE_REFRESH_MS, type EmbedLayerId } from '../../shared/embed-panels';
import type { EmbedMapFrameLayerState, EmbedMapFrameResponse } from '../../shared/embed-map-frame';

/**
 * The slice of `MapContainer` the frame drives. Narrowed to what is actually
 * called so the loader can be exercised without a DOM.
 */
export interface EmbedMapSurface {
  supportsLiveConflictEvents(): boolean;
  setConflictEvents(events: AcledConflictEvent[]): void;
  setEarthquakes(earthquakes: Earthquake[]): void;
  setNaturalEvents(events: NaturalEvent[]): void;
  setProtests(events: SocialUnrestEvent[]): void;
  setWeatherAlerts(alerts: WeatherAlert[]): void;
  setLayerLoading(layer: keyof MapLayers, loading: boolean): void;
  setLayerReady(layer: keyof MapLayers, ready: boolean): void;
  getState(): { layers: MapLayers };
  setLayers(layers: MapLayers, options?: { bypassEntitlementSanitization?: boolean }): void;
}

/** Every embeddable layer's corresponding map layer. */
const MAP_LAYER_BY_EMBED_ID: Record<EmbedLayerId, keyof MapLayers> = {
  conflicts: 'conflicts',
  earthquakes: 'natural',
  protests: 'protests',
  weather: 'weather',
  cables: 'cables',
  pipelines: 'pipelines',
  waterways: 'waterways',
  tradeRoutes: 'tradeRoutes',
  economic: 'economic',
  stockExchanges: 'stockExchanges',
  financialCenters: 'financialCenters',
  centralBanks: 'centralBanks',
  commodityHubs: 'commodityHubs',
  gulfInvestments: 'gulfInvestments',
};

export type EmbedFrameFetcher = (
  layerIds: readonly EmbedLayerId[],
  grant: EmbedGrant | null,
) => Promise<EmbedMapFrameResponse>;

export interface EmbedDataLoaderOptions {
  fetchFrame?: EmbedFrameFetcher;
  /** Re-runs the key → grant exchange when the current grant nears expiry. */
  renewGrant?: () => Promise<EmbedGrantResult>;
  now?: () => number;
}

/**
 * Drives the partner map frame from the single composed endpoint.
 *
 * Keyless boots first and upgrades in place: the free tier is a growth
 * surface, so it must paint immediately rather than wait out the parent's
 * credential handshake. {@link upgrade} swaps in a grant, reloads, and
 * restarts the poll loop at the keyed cadence.
 *
 * The cadence itself is never a constant here — it comes back on every
 * response, so the tiering policy has exactly one owner.
 */
export class EmbedDataLoader {
  private refreshLoop: SmartPollLoopHandle | null = null;
  private grant: EmbedGrant | null = null;
  private refreshMs = EMBED_FREE_REFRESH_MS;
  private grantRetryNotBefore = 0;
  private grantRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private frameRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly fetchFrame: EmbedFrameFetcher;
  private readonly renewGrant: (() => Promise<EmbedGrantResult>) | null;
  private readonly now: () => number;

  constructor(
    private readonly map: EmbedMapSurface,
    private readonly activeLayerIds: readonly EmbedLayerId[],
    options: EmbedDataLoaderOptions = {},
  ) {
    this.fetchFrame = options.fetchFrame ?? fetchEmbedMapFrame;
    this.renewGrant = options.renewGrant ?? null;
    this.now = options.now ?? (() => Date.now());
  }

  async start(): Promise<void> {
    await this.loadOnce();
    this.startLoop();
  }

  /**
   * Adopt a grant and re-render at the keyed tier.
   *
   * Called after the parent posts a credential and the exchange succeeds, and
   * again whenever the frame re-mints an expired grant.
   */
  async upgrade(grant: EmbedGrant): Promise<void> {
    if (this.destroyed) return;
    this.grant = grant;
    await this.loadOnce();
    this.startLoop();
  }

  /** The grant this loader is polling with, so the caller can see it expire. */
  currentGrant(): EmbedGrant | null {
    return this.grant;
  }

  destroy(): void {
    this.destroyed = true;
    this.stopLoop();
    if (this.grantRetryTimer !== null) clearTimeout(this.grantRetryTimer);
    if (this.frameRetryTimer !== null) clearTimeout(this.frameRetryTimer);
  }

  /** Exchange the embedding key after a free-tier boot, retrying transient failures. */
  async requestGrant(): Promise<void> {
    if (this.destroyed || !this.renewGrant) return;
    const result = await this.renewGrant();
    if (this.destroyed) return;
    if (result.status === 'granted') {
      this.grantRetryNotBefore = 0;
      await this.upgrade(result.grant);
      return;
    }
    if (result.status === 'unavailable') this.scheduleGrantRetry(result.retryAfterMs);
  }

  async loadOnce(): Promise<void> {
    if (await this.renewIfExpiring() === 'hold') return;

    const live = this.activeLayerIds.filter((id) => isLiveLayer(id));
    for (const id of live) this.map.setLayerLoading(MAP_LAYER_BY_EMBED_ID[id], true);

    try {
      const frame = await this.fetchFrame(this.activeLayerIds, this.grant);
      const nextRefreshMs = frame.refreshMs > 0 ? frame.refreshMs : this.refreshMs;
      const cadenceChanged = nextRefreshMs !== this.refreshMs;
      this.refreshMs = nextRefreshMs;
      if (this.frameRetryTimer !== null) {
        clearTimeout(this.frameRetryTimer);
        this.frameRetryTimer = null;
      }
      this.applyFrame(frame);
      // A tier change (an upgrade, or a lapse dropping us back to free) moves
      // the cadence, and the running timer is still on the old one.
      if (cadenceChanged && this.refreshLoop !== null) this.startLoop();
    } catch (error) {
      // A failed poll leaves the previous frame on screen — the map keeps
      // whatever it was already showing, and only the loading flag clears.
      console.warn('[embed] map frame request failed:', error);
      if (error instanceof EmbedMapFrameUnavailableError) {
        this.scheduleFrameRetry(error.retryAfterMs);
      }
      for (const id of live) this.map.setLayerLoading(MAP_LAYER_BY_EMBED_ID[id], false);
      return;
    }

    for (const id of live) this.map.setLayerLoading(MAP_LAYER_BY_EMBED_ID[id], false);
  }

  /**
   * Refresh the grant before it lapses, and decide whether this poll may run.
   *
   * `hold` means the grant is gone and we could not find out whether the
   * account is still entitled. Polling anyway would return the free tier and
   * silently strip eleven layers off a paying customer's display over a
   * transient billing lookup — so the poll is skipped and the last frame
   * stays up until the next cycle answers.
   */
  private async renewIfExpiring(): Promise<'go' | 'hold'> {
    const grant = this.grant;
    const now = this.now();
    if (!grant || !this.renewGrant || !isEmbedGrantExpiring(grant, now)) return 'go';
    if (now < this.grantRetryNotBefore) return grant.expiresAt <= now ? 'hold' : 'go';

    const renewed = await this.renewGrant();
    if (renewed.status === 'granted') {
      this.grant = renewed.grant;
      this.grantRetryNotBefore = 0;
      return 'go';
    }
    if (renewed.status === 'denied') {
      // Terminal: the account genuinely cannot embed any more. Fall back to
      // the free tier rather than freezing on a stale paid frame.
      this.grant = null;
      this.grantRetryNotBefore = 0;
      return 'go';
    }
    this.grantRetryNotBefore = now + renewed.retryAfterMs;
    return grant.expiresAt <= now ? 'hold' : 'go';
  }

  private applyFrame(frame: EmbedMapFrameResponse): void {
    const data = frame.data;
    if (data.conflicts && isLayerRendered(frame.layers.conflicts) && this.map.supportsLiveConflictEvents()) {
      this.map.setConflictEvents(data.conflicts as AcledConflictEvent[]);
    }
    if (data.earthquakes && isLayerRendered(frame.layers.earthquakes)) {
      this.map.setEarthquakes(data.earthquakes as Earthquake[]);
    }
    if (data.naturalEvents && isLayerRendered(frame.layers.earthquakes)) {
      this.map.setNaturalEvents(
        (data.naturalEvents as Parameters<typeof toNaturalEvent>[0][]).map(toNaturalEvent),
      );
    }
    if (data.protests && isLayerRendered(frame.layers.protests)) {
      this.map.setProtests(
        (data.protests as Parameters<typeof toSocialUnrestEvent>[0][]).map(toSocialUnrestEvent),
      );
    }
    if (data.weatherAlerts && isLayerRendered(frame.layers.weather)) {
      this.map.setWeatherAlerts(
        (data.weatherAlerts as Parameters<typeof mapAlert>[0][]).map(mapAlert),
      );
    }

    const nextLayers = { ...this.map.getState().layers };
    const rejected: EmbedLayerId[] = [];
    for (const id of this.activeLayerIds) {
      const layer = MAP_LAYER_BY_EMBED_ID[id];
      const rendered = isLayerRendered(frame.layers[id]);
      if (!rendered) rejected.push(id);
      nextLayers[layer] = rendered;
      this.map.setLayerReady(layer, rendered);
    }
    this.map.setLayers(nextLayers, { bypassEntitlementSanitization: true });
    for (const id of rejected) this.clearLayerData(id);
  }

  private clearLayerData(id: EmbedLayerId): void {
    if (id === 'conflicts') this.map.setConflictEvents([]);
    if (id === 'earthquakes') {
      this.map.setEarthquakes([]);
      this.map.setNaturalEvents([]);
    }
    if (id === 'protests') this.map.setProtests([]);
    if (id === 'weather') this.map.setWeatherAlerts([]);
  }

  private scheduleGrantRetry(retryAfterMs: number): void {
    if (this.grantRetryTimer !== null) clearTimeout(this.grantRetryTimer);
    this.grantRetryTimer = setTimeout(() => {
      this.grantRetryTimer = null;
      void this.requestGrant();
    }, retryAfterMs);
  }

  private scheduleFrameRetry(retryAfterMs: number): void {
    if (this.frameRetryTimer !== null) clearTimeout(this.frameRetryTimer);
    this.frameRetryTimer = setTimeout(() => {
      this.frameRetryTimer = null;
      if (!this.destroyed) void this.loadOnce();
    }, retryAfterMs);
  }

  private startLoop(): void {
    this.stopLoop();
    if (this.destroyed) return;
    this.refreshLoop = startSmartPollLoop(() => this.loadOnce(), {
      intervalMs: this.refreshMs,
      pauseWhenHidden: true,
      refreshOnVisible: true,
      runImmediately: false,
    });
  }

  private stopLoop(): void {
    if (this.refreshLoop !== null) {
      this.refreshLoop.stop();
      this.refreshLoop = null;
    }
  }
}

/** Layers backed by an upstream read; the rest ship with the client. */
function isLiveLayer(id: EmbedLayerId): boolean {
  return id === 'conflicts' || id === 'earthquakes' || id === 'protests' || id === 'weather';
}

/**
 * `partial` counts as rendered: one of the layer's two upstreams answered, so
 * there is something on the map and marking it un-ready would hide it.
 */
function isLayerRendered(state: EmbedMapFrameLayerState | undefined): boolean {
  return state === 'ok' || state === 'partial';
}
