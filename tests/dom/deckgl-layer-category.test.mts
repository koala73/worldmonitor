/**
 * #10139: DeckGL markers carry their Layers-menu category. Hover tooltips name
 * the owning layer, the bottom legend lists only active status scales and hides
 * when none apply, and category glyph layers follow the built marker layers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScatterplotLayer } from '@deck.gl/layers';

import { DeckGLMap } from '@/components/DeckGLMap';
import type { MapLayers } from '@/types';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);
// jsdom has no 2D canvas; the glyph atlas only needs one to draw into.
const realGetContext = HTMLCanvasElement.prototype.getContext;
const realToDataURL = HTMLCanvasElement.prototype.toDataURL;
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
  HTMLCanvasElement.prototype.toDataURL = realToDataURL;
});
beforeAll(() => {
  const noop = () => {};
  const ctx = { beginPath: noop, arc: noop, fill: noop, stroke: noop, fillText: noop } as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
});

type Host = {
  getCategorizedTooltip(info: unknown): { html: string } | null;
  updateLegend(): void;
  withCategoryGlyphs(built: unknown[]): Array<{ id: string; props: Record<string, unknown> }>;
  getTooltip(info: unknown): { html: string } | null;
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

  it('prepends the label when the body is not a deckgl-tooltip box', () => {
    const map = host();
    map.getTooltip = () => ({ html: '<span>bare</span>' });
    const tip = map.getCategorizedTooltip({ layer: { id: 'fires-layer' }, object: {} });
    expect(tip?.html.startsWith('<div class="deckgl-tooltip-category">')).toBe(true);
    expect(tip?.html.endsWith('<span>bare</span>')).toBe(true);
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

  it('counts the instability and industrial-activity scales as entries', () => {
    for (const key of ['ciiChoropleth', 'no2Activity'] as const) {
      const map = legendHost({ hotspots: false, [key]: true });
      map.updateLegend();
      expect(map.container.querySelector<HTMLElement>('.deckgl-legend')!.hidden, key).toBe(false);
    }
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

  const withGlyphs = (zoom: number, built: unknown[]) => {
    const map = host();
    map.maplibreMap = { getZoom: () => zoom };
    return map.withCategoryGlyphs(built);
  };
  const glyphIds = (zoom: number, built: unknown[]) =>
    withGlyphs(zoom, built).map((l) => l.id).filter((id) => id.endsWith('-category-glyph'));

  it('puts each glyph layer right after its marker layer, sharing its data', () => {
    const fires = marker('fires-layer', 5);
    const out = withGlyphs(4, [fires, marker('cables-layer', 5), marker('outages-layer', 2)]);
    expect(out.map((l) => l.id)).toEqual([
      'fires-layer', 'fires-layer-category-glyph', 'cables-layer', 'outages-layer', 'outages-layer-category-glyph',
    ]);
    expect(out[1]!.props.data).toBe(fires.props.data);
    expect(out[1]!.props.pickable).toBe(false);
  });

  it('places the glyph outside the marker radius', () => {
    const big = new ScatterplotLayer<{ p: [number, number] }>({ id: 'hotspots-layer', data: [{ p: [0, 0] }], getPosition: (d) => d.p, radiusMaxPixels: 20 });
    const small = new ScatterplotLayer<{ p: [number, number] }>({ id: 'fires-layer', data: [{ p: [0, 0] }], getPosition: (d) => d.p, radiusMaxPixels: 3 });
    const offsetOf = (layer: unknown) => (withGlyphs(4, [layer])[1]!.props.getPixelOffset as [number, number])[0];
    // 16px glyph at zoom 4: half-width 8, so it must start beyond the clamped radius.
    expect(offsetOf(big)).toBe(12 + 8 + 1);
    expect(offsetOf(small)).toBe(4 + 8 + 1);
  });

  it('draws nothing for hidden, empty or ghost layers', () => {
    expect(glyphIds(4, [marker('fires-layer', 5, false), marker('outages-layer', 0), marker('outages-layer-ghost', 3)])).toEqual([]);
  });

  it('drops dense layers at world zoom but keeps sparse ones', () => {
    expect(glyphIds(1.5, [marker('fires-layer', 5000), marker('bases-layer', 40)])).toEqual(['bases-layer-category-glyph']);
  });
});
