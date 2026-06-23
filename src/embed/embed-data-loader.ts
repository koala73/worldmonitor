import type { MapContainer } from '@/components/MapContainer';
import type { MapLayers } from '@/types';
import { fetchEarthquakes } from '@/services/earthquakes';
import { fetchNaturalEvents } from '@/services/eonet';
import { fetchProtestEvents } from '@/services/unrest';
import { fetchWeatherAlerts } from '@/services/weather';
import { ConflictServiceClient } from '@/generated/client/worldmonitor/conflict/v1/service_client';
import { startSmartPollLoop, type SmartPollLoopHandle } from '@/services/smart-poll-loop';
import type { EmbedLayerId } from './embed-url';

const REFRESH_MS = 10 * 60 * 1000;
const CONFLICT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const conflictClient = new ConflictServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const STATIC_LAYER_READY_BY_EMBED_ID: Partial<Record<EmbedLayerId, keyof MapLayers>> = {
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

export class EmbedDataLoader {
  private refreshLoop: SmartPollLoopHandle | null = null;

  constructor(
    private readonly map: MapContainer,
    private readonly activeLayerIds: readonly EmbedLayerId[],
  ) {}

  async start(): Promise<void> {
    await this.loadOnce();
    this.refreshLoop = startSmartPollLoop(() => this.loadOnce(), {
      intervalMs: REFRESH_MS,
      pauseWhenHidden: true,
      refreshOnVisible: true,
      runImmediately: false,
    });
  }

  destroy(): void {
    if (this.refreshLoop !== null) {
      this.refreshLoop.stop();
      this.refreshLoop = null;
    }
  }

  async loadOnce(): Promise<void> {
    await Promise.all(this.activeLayerIds.map((id) => this.loadLayer(id)));
  }

  private async loadLayer(id: EmbedLayerId): Promise<void> {
    switch (id) {
      case 'conflicts':
        await this.loadConflicts();
        return;
      case 'earthquakes':
        await this.loadEarthquakes();
        return;
      case 'protests':
        await this.loadProtests();
        return;
      case 'weather':
        await this.loadWeather();
        return;
      default:
        this.markStaticLayerReady(id);
        return;
    }
  }

  private markStaticLayerReady(id: EmbedLayerId): void {
    const layer = STATIC_LAYER_READY_BY_EMBED_ID[id];
    if (layer) this.map.setLayerReady(layer, true);
  }

  private async loadConflicts(): Promise<void> {
    if (!this.map.supportsLiveConflictEvents()) {
      this.map.setLayerReady('conflicts', true);
      return;
    }

    await this.withLayerState('conflicts', async () => {
      const end = Date.now();
      const start = end - CONFLICT_WINDOW_MS;
      const data = await conflictClient.listAcledEvents({ country: '', start, end, pageSize: 0, cursor: '' });
      this.map.setConflictEvents(data.events);
      return data.events.length > 0;
    });
  }

  private async loadEarthquakes(): Promise<void> {
    await this.withLayerState('natural', async () => {
      const [earthquakesResult, naturalEventsResult] = await Promise.allSettled([
        fetchEarthquakes(),
        fetchNaturalEvents(30),
      ]);
      if (earthquakesResult.status === 'fulfilled') {
        this.map.setEarthquakes(earthquakesResult.value);
      }
      if (naturalEventsResult.status === 'fulfilled') {
        this.map.setNaturalEvents(naturalEventsResult.value);
      }
      return earthquakesResult.status === 'fulfilled' || naturalEventsResult.status === 'fulfilled';
    });
  }

  private async loadProtests(): Promise<void> {
    await this.withLayerState('protests', async () => {
      const data = await fetchProtestEvents();
      this.map.setProtests(data.events);
      return true;
    });
  }

  private async loadWeather(): Promise<void> {
    await this.withLayerState('weather', async () => {
      const alerts = await fetchWeatherAlerts();
      this.map.setWeatherAlerts(alerts);
      return true;
    });
  }

  private async withLayerState(layer: keyof MapLayers, load: () => Promise<boolean>): Promise<void> {
    this.map.setLayerLoading(layer, true);
    try {
      const hasData = await load();
      this.map.setLayerReady(layer, hasData);
    } catch (error) {
      console.warn(`[embed] Failed to load ${layer}:`, error);
      this.map.setLayerReady(layer, false);
    } finally {
      this.map.setLayerLoading(layer, false);
    }
  }
}
