// maplibre-, pmtiles-, @protomaps/basemaps-using parts of basemap.ts.
// Split out so `preferences-content.ts` (which only needs the preference
// getters/setters) does NOT pull maplibre into the main bundle. Only
// imported by `DeckGLMap.ts`, which is itself dynamically imported when
// the map panel mounts — so maplibre + deck.gl now load lazily.
import { Protocol } from 'pmtiles';
import maplibregl from 'maplibre-gl';
import { layers, namedFlavor } from '@protomaps/basemaps';
import type { StyleSpecification } from 'maplibre-gl';
import {
  R2_BASE,
  hasPMTilesUrl,
  isLightMapTheme,
  asPMTilesTheme,
  FALLBACK_DARK_STYLE,
  FALLBACK_LIGHT_STYLE,
  type PMTilesTheme,
  type MapProvider,
} from '@/config/basemap';

let registered = false;

export function registerPMTilesProtocol(): void {
  if (registered) return;
  registered = true;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
}

export function buildPMTilesStyle(flavor: PMTilesTheme): StyleSpecification | null {
  if (!hasPMTilesUrl) return null;
  const spriteName = ['light', 'white'].includes(flavor) ? 'light' : 'dark';
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${spriteName}`,
    sources: {
      basemap: {
        type: 'vector',
        url: `pmtiles://${R2_BASE}`,
        attribution: '<a href="https://protomaps.com">Protomaps</a> | <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    layers: layers('basemap', namedFlavor(flavor), { lang: 'en' }) as StyleSpecification['layers'],
  };
}

const CARTO_DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const CARTO_VOYAGER = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
const CARTO_POSITRON = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

const CARTO_STYLES: Record<string, string> = {
  'dark-matter': CARTO_DARK,
  'voyager': CARTO_VOYAGER,
  'positron': CARTO_POSITRON,
};

export function getStyleForProvider(provider: MapProvider, mapTheme: string): StyleSpecification | string {
  const lightFallback = isLightMapTheme(mapTheme);
  switch (provider) {
    case 'pmtiles': {
      const style = buildPMTilesStyle(asPMTilesTheme(mapTheme));
      if (style) return style;
      return lightFallback ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE;
    }
    case 'openfreemap':
      return mapTheme === 'positron' ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE;
    case 'carto':
      return CARTO_STYLES[mapTheme] ?? CARTO_DARK;
    default: {
      const pmtiles = buildPMTilesStyle(asPMTilesTheme(mapTheme));
      return pmtiles ?? (lightFallback ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE);
    }
  }
}
