import { describe, expect, it, vi } from 'vitest';
import { MapContainer } from '@/components/MapContainer';
import { DeckGLMap } from '@/components/DeckGLMap';
import { GlobeMap } from '@/components/GlobeMap';

const marker = { lat: 35, lon: 139, title: 'Same headline (approximate location: Tokyo)', threatLevel: 'info', article: { link: 'https://example.com/second', title: 'Same headline', source: 'Second publisher' } };

describe('loaded news selection callbacks', () => {
  it('dispatches the original picked Deck marker without a popup or country action', () => {
    const clicked = vi.fn();
    const map = Object.assign(Object.create(DeckGLMap.prototype), { onCountryClick: vi.fn(), popup: { show: vi.fn() } });
    map.setOnNewsClick(clicked);
    map.handleClick({ layer: { id: 'news-locations-layer' }, object: marker, x: 10, y: 10 });
    expect(clicked).toHaveBeenCalledExactlyOnceWith(marker);
    expect(map.popup.show).not.toHaveBeenCalled();
    expect(map.onCountryClick).not.toHaveBeenCalled();
  });

  it('preserves the original article descriptor through Globe marker projection and click', () => {
    const clicked = vi.fn();
    const map = Object.assign(Object.create(GlobeMap.prototype), { flushMarkers: vi.fn(), showMarkerTooltip: vi.fn() });
    map.setOnNewsClick(clicked);
    map.setNewsLocations([marker]);
    const projected = map.newsLocationMarkers[0];
    expect(projected.article).toBe(marker.article);
    map.handleMarkerClick(projected, document.createElement('div'));
    expect(clicked).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ article: marker.article, title: marker.title }));
    expect(map.showMarkerTooltip).toHaveBeenCalledExactlyOnceWith(projected, expect.any(HTMLElement));
  });

  it('rewires one cached callback through each active renderer after a switch', () => {
    const callback = vi.fn();
    const flat = { setOnNewsClick: vi.fn() };
    const deck = { setOnNewsClick: vi.fn() };
    const globe = { setOnNewsClick: vi.fn() };
    const map = Object.assign(Object.create(MapContainer.prototype), { useDeckGL: false, useGlobe: false, svgMap: flat, deckGLMap: deck, globeMap: globe, layerLoadingState: new Map(), layerReadyState: new Map(), hiddenLayerToggles: new Set() });
    map.onNewsClicked(callback);
    expect(flat.setOnNewsClick).toHaveBeenCalledExactlyOnceWith(callback);
    map.useDeckGL = true;
    map.rehydrateActiveMap();
    expect(deck.setOnNewsClick).toHaveBeenCalledExactlyOnceWith(callback);
    map.useGlobe = true;
    map.rehydrateActiveMap();
    expect(globe.setOnNewsClick).toHaveBeenCalledExactlyOnceWith(callback);
  });
});
