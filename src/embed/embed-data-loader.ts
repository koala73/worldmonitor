import type { MapComponent } from '@/components/Map';
import type { MapLayers } from '@/types';
import { fetchEarthquakes } from '@/services/earthquakes';
import { fetchNaturalEvents } from '@/services/eonet';
import { fetchProtestEvents } from '@/services/unrest';
import { fetchWeatherAlerts } from '@/services/weather';
import { ConflictServiceClient } from '@/generated/client/worldmonitor/conflict/v1/service_client';
import type { EmbedLayerId } from './embed-url';

const REFRESH_MS = 10 * 60 * 1000;
const conflictClient = new ConflictServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

export class EmbedDataLoader {
  private refreshTimer: number | null = null;

  constructor(
    private readonly map: MapComponent,
    private readonly activeLayerIds: readonly EmbedLayerId[],
  ) {}

  async start(): Promise<void> {
    await this.loadOnce();
    this.refreshTimer = window.setInterval(() => {
      void this.loadOnce();
    }, REFRESH_MS);
  }

  destroy(): void {
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
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
    }
  }

  private async loadConflicts(): Promise<void> {
    await this.withLayerState('conflicts', async () => {
      const data = await conflictClient.listAcledEvents({ country: '', start: 0, end: 0, pageSize: 0, cursor: '' });
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
