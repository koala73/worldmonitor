import type { IntelligenceCache } from '@/app/app-context';
import type { MapLayers } from '@/types';
import { buildSensorFusionSnapshot, type SensorFusionLayer, type SensorFusionStatus } from '@/services/sensor-fusion';
import { h, replaceChildren } from '@/utils/dom-utils';
import { Panel } from './Panel';

type SnapshotProvider = () => {
  cache: IntelligenceCache;
  mapLayers: Partial<MapLayers>;
};

const STATUS_LABELS: Record<SensorFusionStatus, string> = {
  live: 'LIVE',
  ready: 'READY',
  available: 'DATA',
  planned: 'ROADMAP',
};

export class SensorFusionPanel extends Panel {
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly getSnapshotInput: SnapshotProvider) {
    super({
      id: 'sensor-fusion',
      title: 'Sensor Fusion Deck',
      showCount: true,
      infoTooltip: 'WorldView-inspired overview of which public, attribution-friendly geospatial streams are currently fused into the dashboard, and which 3D reconstruction lanes remain roadmap-only.',
    });
    this.element.classList.add('sensor-fusion-panel');
    this.render();
    this.refreshTimer = setInterval(() => this.refresh(), 30_000);
  }

  public refresh(): void {
    if (!this.element?.isConnected) return;
    this.render();
  }

  public override destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    super.destroy();
  }

  protected render(): void {
    const { cache, mapLayers } = this.getSnapshotInput();
    const snapshot = buildSensorFusionSnapshot(cache, mapLayers);
    this.setCount(snapshot.liveLayers);
    this.setDataBadge(snapshot.liveLayers > 0 ? 'live' : 'cached', `${snapshot.liveLayers}/${snapshot.layers.length} live`);

    replaceChildren(this.content,
      h('div', { className: 'sensor-fusion-summary' },
        this.metric('Live layers', String(snapshot.liveLayers)),
        this.metric('Available', String(snapshot.availableLayers)),
        this.metric('Tracked objects', snapshot.trackedObjects.toLocaleString()),
      ),
      h('div', { className: 'sensor-fusion-grid' },
        ...snapshot.layers.map(layer => this.layerCard(layer)),
      ),
      h('div', { className: 'sensor-fusion-guardrail' },
        h('strong', null, 'Guardrail: '),
        'prioritize public, consent-aware, attributable feeds. Sparse 3D reconstruction stays a research/asset-review lane until provenance and privacy rules are explicit.',
      ),
    );
  }

  private metric(label: string, value: string): HTMLElement {
    return h('div', { className: 'sensor-fusion-metric' },
      h('span', { className: 'sensor-fusion-metric-value' }, value),
      h('span', { className: 'sensor-fusion-metric-label' }, label),
    );
  }

  private layerCard(layer: SensorFusionLayer): HTMLElement {
    const count = layer.count === null ? '—' : layer.count.toLocaleString();
    return h('div', { className: `sensor-fusion-layer ${layer.status}` },
      h('div', { className: 'sensor-fusion-layer-head' },
        h('span', { className: 'sensor-fusion-layer-label' }, layer.label),
        h('span', { className: `sensor-fusion-status ${layer.status}` }, STATUS_LABELS[layer.status]),
      ),
      h('div', { className: 'sensor-fusion-source' }, layer.source),
      h('div', { className: 'sensor-fusion-layer-count' }, count),
      h('p', { className: 'sensor-fusion-note' }, layer.note),
    );
  }
}
