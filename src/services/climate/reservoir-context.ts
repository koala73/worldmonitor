import registry from '../../../scripts/data/strategic-reservoirs.json';
import type { ReservoirExtent, ReservoirPassSite } from '@/services/orbital/reservoir-next-pass';

export interface StrategicReservoirSite extends ReservoirPassSite {
  name: string;
  country: string;
  tags: readonly string[];
}

export const STRATEGIC_RESERVOIR_SITES: readonly StrategicReservoirSite[] = (registry.reservoirs as Array<{ id: string; name: string; country: string; tags: string[]; core: number[] }>)
  .filter(r => r.core.length === 4)
  .map(r => ({ id: r.id, name: r.name, country: r.country, tags: r.tags, core: r.core as unknown as ReservoirExtent }));

const SITE_MARGIN_KM = 10;
const DAM_TERMS = /\b(dams?|reservoirs?|barrages?|spillways?|hydro(?:electric|power)?|floodgates?|sluices?)\b/i;

/** True when an event's own text says it is about a dam or its reservoir. */
export function isDamRelated(text: string): boolean {
  return DAM_TERMS.test(text);
}

/**
 * The strategic reservoir a dam-related event sits at: the event must name a dam or
 * reservoir and fall inside the lake extent or within SITE_MARGIN_KM of it.
 */
export function reservoirAtSite(lat: number, lon: number, text: string): StrategicReservoirSite | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !isDamRelated(text)) return null;
  const dLat = SITE_MARGIN_KM / 111.32;
  for (const site of STRATEGIC_RESERVOIR_SITES) {
    const [w, s, e, n] = site.core;
    const dLon = dLat / Math.max(0.05, Math.cos(((s + n) / 2) * Math.PI / 180));
    if (lat >= s - dLat && lat <= n + dLat && lon >= w - dLon && lon <= e + dLon) return site;
  }
  return null;
}
