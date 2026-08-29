/**
 * World Monitor's built-in site layers, for the God's Eye View globe.
 *
 * These eight layers are not pushed from App.ts like the trackers are — they
 * are static catalogues compiled into the bundle (military bases, nuclear
 * facilities, gamma irradiators, spaceports, economic centres, AI data
 * centres, strategic waterways, critical-mineral projects). GlobeMap built
 * them on demand in `ensureStaticDataForLayer`, keyed off the layer toggle,
 * and that lazy shape is kept here: the catalogues are large, and a user who
 * never opens the Nuclear Sites layer should never pay to materialise it.
 *
 * The imports are static so the bundler can tree-shake and so a renamed
 * export fails the build rather than the layer. What is lazy is the *marker
 * construction*, memoised per layer on first use.
 */

import {
  MILITARY_BASES,
  NUCLEAR_FACILITIES,
  SPACEPORTS,
  ECONOMIC_CENTERS,
  STRATEGIC_WATERWAYS,
  CRITICAL_MINERALS,
} from '@/config/geo';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import type { MapLayers } from '@/types';
import type { BridgeMarker, MarkerStyle } from './types';

const glyph = (g: string, color: string, size = 11): MarkerStyle => ({ glyph: g, color, size });

/** Base marker colour by alliance, verbatim from GlobeMap. */
const BASE_TYPE_COLORS: Record<string, string> = {
  'us-nato': '#4488ff', uk: '#4488ff', france: '#4488ff',
  russia: '#ff4444', china: '#ff8844', india: '#ff8844',
  other: '#aaaaaa',
};

const ECONOMIC_TYPE_COLORS: Record<string, string> = {
  exchange: '#ffd700', 'central-bank': '#4488ff',
};

type Builder = () => BridgeMarker[];

const BUILDERS: Partial<Record<keyof MapLayers, Builder>> = {
  bases: () => (MILITARY_BASES as any[]).map((b, i) => ({
    id: String(b.id ?? `base-${i}`),
    kind: 'milbase',
    lat: b.lat, lon: b.lon,
    title: `${b.name ?? ''}${b.country ? ` · ${b.country}` : ''}`,
    // A triangle on the old globe; the alliance colour is the signal.
    style: { color: BASE_TYPE_COLORS[String(b.type ?? 'other')] ?? '#aaaaaa', size: 9 },
    row: b,
  })),

  nuclear: () => (NUCLEAR_FACILITIES as any[])
    .filter((f) => f.status !== 'decommissioned')
    .map((f, i) => ({
      id: String(f.id ?? `nuclear-${i}`),
      kind: 'nuclearSite',
      lat: f.lat, lon: f.lon,
      title: `${f.name ?? ''} (${f.type ?? ''})`,
      style: glyph('☢', '#ffd700'),
      row: f,
    })),

  irradiators: () => (GAMMA_IRRADIATORS as any[]).map((g, i) => ({
    id: String(g.id ?? `irradiator-${i}`),
    kind: 'irradiator',
    lat: g.lat, lon: g.lon,
    title: `${g.city ?? ''}, ${g.country ?? ''}`,
    style: glyph('⚠', '#ff8800', 10),
    row: g,
  })),

  spaceports: () => (SPACEPORTS as any[])
    .filter((s) => s.status === 'active')
    .map((s, i) => ({
      id: String(s.id ?? `spaceport-${i}`),
      kind: 'spaceport',
      lat: s.lat, lon: s.lon,
      title: `${s.name ?? ''} (${s.operator ?? ''})`,
      style: glyph('\u{1F680}', '#88ddff'),
      row: s,
    })),

  economic: () => (ECONOMIC_CENTERS as any[]).map((c, i) => ({
    id: String(c.id ?? `econ-${i}`),
    kind: 'economic',
    lat: c.lat, lon: c.lon,
    title: `${c.name ?? ''} · ${c.country ?? ''}`,
    style: glyph('\u{1F4B0}', ECONOMIC_TYPE_COLORS[String(c.type ?? '')] ?? '#44cc88'),
    row: c,
  })),

  datacenters: () => (AI_DATA_CENTERS as any[])
    .filter((d) => d.status !== 'decommissioned')
    .map((d, i) => ({
      id: String(d.id ?? `dc-${i}`),
      kind: 'datacenter',
      lat: d.lat, lon: d.lon,
      title: `${d.name ?? ''} (${d.owner ?? ''})`,
      style: glyph('\u{1F5A5}', '#88aaff', 10),
      row: d,
    })),

  waterways: () => (STRATEGIC_WATERWAYS as any[]).map((w, i) => ({
    id: String(w.id ?? `waterway-${i}`),
    kind: 'waterway',
    lat: w.lat, lon: w.lon,
    title: String(w.name ?? ''),
    style: glyph('⚓', '#44aadd', 10),
    row: w,
  })),

  minerals: () => (CRITICAL_MINERALS as any[])
    .filter((m) => m.status === 'producing' || m.status === 'development')
    .map((m, i) => ({
      id: String(m.id ?? `mineral-${i}`),
      kind: 'mineral',
      lat: m.lat, lon: m.lon,
      title: `${m.mineral ?? ''} — ${m.name ?? ''}`,
      style: glyph('\u{1F48E}', '#cc88ff', 10),
      row: m,
    })),
};

/** Layers this module can supply. */
export const STATIC_LAYER_KEYS = Object.keys(BUILDERS) as Array<keyof MapLayers>;

const memo = new Map<keyof MapLayers, BridgeMarker[]>();

/**
 * Markers for a built-in site layer, or null if this layer is not one.
 * Built once per layer per session and cached — the catalogues never change.
 */
export function staticMarkersFor(layer: keyof MapLayers): BridgeMarker[] | null {
  const cached = memo.get(layer);
  if (cached) return cached;
  const build = BUILDERS[layer];
  if (!build) return null;
  const markers = build().filter((m) => m.lat != null && m.lon != null);
  memo.set(layer, markers);
  return markers;
}
