/**
 * #10139: DeckGL markers carry their Layers-menu category. Hover tooltips name
 * the owning layer, the bottom legend lists only active status scales and hides
 * when none apply, and category glyph layers follow the built marker layers.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ScatterplotLayer } from '@deck.gl/layers';

import { DeckGLMap } from '@/components/DeckGLMap';
import type { MapLayers } from '@/types';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);
// jsdom has no 2D canvas; the glyph atlas only needs one to draw into.
beforeAll(() => {
  const noop = () => {};
  const ctx = { beginPath: noop, arc: noop, fill: noop, stroke: noop, fillText: noop } as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
});

type Host = {
  getCategorizedTooltip(info: unknown): { html: string } | null;
  updateLegend(): void;
  createCategoryGlyphLayers(built: unknown[]): Array<{ id: string; props: Record<string, unknown> }>;
  container: HTMLElement;
  state: { layers: Partial<MapLayers> };
  maplibreMap: { getZoom(): number } | null;
  no2Activity: null;
};

const host = (): Host => Object.create(DeckGLMap.prototype) as Host;

describe('categorized tooltip', () => {
  it('names the owning layer above the object', () => {
    const map = host();
    const tip = map.getCategorizedTooltip({ layer: { id: 'datacenters-layer' }, object: { name: 'Site A', owner: 'Owner B' } });
    const el = document.createElement('div');
    el.innerHTML = tip!.html;
    const box = el.querySelector('.deckgl-tooltip')!;
    expect(box.firstElementChild?.className).toBe('deckgl-tooltip-category');
    expect(box.querySelector('.deckgl-tooltip-category')?.textContent).toContain('AI Data Centers');
    expect(box.querySelector('strong')?.textContent).toBe('Site A');
  });

  it('maps ghost pick layers to the same category', () => {
    const tip = host().getCategorizedTooltip({ layer: { id: 'outages-layer-ghost' }, object: { title: 'Outage', country: 'X', severity: 'major' } });
    expect(tip?.html).toContain('deckgl-tooltip-category');
  });

  it('leaves unmapped layers unchanged', () => {
    const tip = host().getCategorizedTooltip({ layer: { id: 'cables-layer' }, object: { name: 'Cable' } });
    expect(tip?.html).not.toContain('deckgl-tooltip-category');
  });

  it('returns null when nothing is picked', () => {
    expect(host().getCategorizedTooltip({ layer: { id: 'fires-layer' }, object: null })).toBeNull();
  });
});

describe('legend', () => {
  const legendHost = (layers: Partial<MapLayers>): Host => {
    const map = host();
    map.container = document.createElement('div');
    map.container.innerHTML = '<div class="map-legend deckgl-legend"><span class="legend-item" data-layer="hotspots"></span></div>';
    map.state = { layers };
    map.no2Activity = null;
    return map;
  };

  it('hides itself when no active layer has an entry', () => {
    const map = legendHost({ hotspots: false, datacenters: true });
    map.updateLegend();
    expect(map.container.querySelector<HTMLElement>('.deckgl-legend')!.hidden).toBe(true);
  });

  it('shows when an active layer has an entry', () => {
    const map = legendHost({ hotspots: true });
    map.updateLegend();
    expect(map.container.querySelector<HTMLElement>('.deckgl-legend')!.hidden).toBe(false);
  });
});

describe('category glyph layers', () => {
  const marker = (id: string, count: number, visible = true) => new ScatterplotLayer<{ p: [number, number] }>({
    id,
    data: Array.from({ length: count }, (_, i) => ({ p: [i, i] as [number, number] })),
    getPosition: (d) => d.p,
    visible,
  });

  const glyphs = (zoom: number, built: unknown[]) => {
    const map = host();
    map.maplibreMap = { getZoom: () => zoom };
    return map.createCategoryGlyphLayers(built);
  };

  it('adds one glyph layer per built point layer, sharing its data', () => {
    const fires = marker('fires-layer', 5);
    const out = glyphs(4, [fires, marker('cables-layer', 5)]);
    expect(out.map((l) => l.id)).toEqual(['fires-layer-category-glyph']);
    expect(out[0]!.props.data).toBe(fires.props.data);
    expect(out[0]!.props.pickable).toBe(false);
  });

  it('draws nothing for hidden, empty or ghost layers', () => {
    expect(glyphs(4, [marker('fires-layer', 5, false), marker('outages-layer', 0), marker('outages-layer-ghost', 3)])).toEqual([]);
  });

  it('drops dense layers at world zoom but keeps sparse ones', () => {
    expect(glyphs(1.5, [marker('fires-layer', 5000), marker('bases-layer', 40)]).map((l) => l.id)).toEqual(['bases-layer-category-glyph']);
  });
});
