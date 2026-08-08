// Merged military-base list (MILITARY_BASES_EXPANDED + US/Russia domestic bases),
// relocated out of geo.ts so the ~48KB bases-expanded table no longer rides the
// eager boot graph (#4478 / #4410). geo.ts stays eager for INTEL_HOTSPOTS /
// CONFLICT_ZONES, but no longer imports bases-expanded. Eager consumers
// (country-intel, related-assets, data-loader→military-surge) lazy-load this
// module via dynamic import(); lazy consumers (Map / DeckGLMap / GlobeMap /
// search-manager) import it statically and pull it only when their own chunk
// loads. Co-chunked with bases-expanded as 'military-bases-data' in vite.config.ts.
//
// NOTE: this is the static, merged base CONFIG — separate from the
// server-fetched base-cluster service of a similar name in the services layer.
import type { MilitaryBase } from '@/types';
import { MILITARY_BASES_EXPANDED } from './bases-expanded';

// US Domestic bases (not in overseas dataset - these are CONUS bases)
const US_DOMESTIC_BASES: MilitaryBase[] = [
  { id: 'norfolk', name: 'Norfolk Naval', lat: 36.95, lon: -76.31, type: 'us-nato', description: 'World largest naval base. Atlantic Fleet HQ.' },
  { id: 'fort_liberty', name: 'Fort Liberty', lat: 35.14, lon: -79.0, type: 'us-nato', description: 'Army Special Ops. XVIII Airborne Corps.' },
  { id: 'pendleton', name: 'Camp Pendleton', lat: 33.38, lon: -117.4, type: 'us-nato', description: 'USMC West Coast. 1st Marine Division.' },
  { id: 'san_diego', name: 'Naval San Diego', lat: 32.68, lon: -117.13, type: 'us-nato', description: 'Pacific Fleet. Carrier homeport.' },
  { id: 'nellis', name: 'Nellis AFB', lat: 36.24, lon: -115.03, type: 'us-nato', description: 'Air combat training. Red Flag exercises.' },
  { id: 'langley', name: 'Langley AFB', lat: 37.08, lon: -76.36, type: 'us-nato', description: 'Air Combat Command HQ. F-22 wing.' },
  { id: 'cheyenne', name: 'Cheyenne Mtn', lat: 38.74, lon: -104.85, type: 'us-nato', description: 'NORAD. Missile warning, space control.' },
  { id: 'peterson', name: 'Peterson SFB', lat: 38.82, lon: -104.71, type: 'us-nato', description: 'US Space Command HQ. Space operations.' },
  { id: 'kings_bay', name: 'Kings Bay', lat: 30.8, lon: -81.52, type: 'us-nato', description: 'Ohio-class submarine base. Atlantic deterrent.' },
  { id: 'kitsap', name: 'Naval Kitsap', lat: 47.56, lon: -122.66, type: 'us-nato', description: 'Trident submarine base. Pacific deterrent.' },
  { id: 'yokosuka', name: 'Yokosuka', lat: 35.28, lon: 139.67, type: 'us-nato', description: 'US 7th Fleet HQ. Carrier strike group homeport.' },
  { id: 'rota', name: 'Naval Rota', lat: 36.62, lon: -6.35, type: 'us-nato', description: 'US/Spanish naval base. Aegis destroyers, Atlantic access.' },
  { id: 'incirlik', name: 'Incirlik AB', lat: 37.0, lon: 35.43, type: 'us-nato', description: 'US/Turkish base. Nuclear weapons storage site.' },
  // Russian domestic bases (not overseas)
  { id: 'kaliningrad', name: 'Kaliningrad', lat: 54.71, lon: 20.51, type: 'russia', description: 'Russian exclave. Baltic Fleet, Iskander missiles.' },
  { id: 'sevastopol', name: 'Sevastopol', lat: 44.6, lon: 33.5, type: 'russia', description: 'Black Sea Fleet HQ. Crimea (occupied).' },
  { id: 'vladivostok', name: 'Vladivostok', lat: 43.12, lon: 131.9, type: 'russia', description: 'Pacific Fleet HQ. Nuclear submarines.' },
  { id: 'murmansk', name: 'Murmansk', lat: 68.97, lon: 33.09, type: 'russia', description: 'Northern Fleet. Strategic nuclear submarines.' },
];

// Merge expanded bases with domestic bases, deduplicating by proximity
function mergeAndDeduplicateBases(): MilitaryBase[] {
  const allBases = [...MILITARY_BASES_EXPANDED];
  const usedCoords = new Set<string>();

  // Index expanded bases by approximate location
  for (const base of MILITARY_BASES_EXPANDED) {
    const key = `${Math.round(base.lat * 10)}_${Math.round(base.lon * 10)}`;
    usedCoords.add(key);
  }

  // Add domestic bases if not already present (by location proximity)
  for (const base of US_DOMESTIC_BASES) {
    const key = `${Math.round(base.lat * 10)}_${Math.round(base.lon * 10)}`;
    if (!usedCoords.has(key)) {
      allBases.push(base);
      usedCoords.add(key);
    }
  }

  return allBases;
}

// Combined military bases: 210 from ASIAR dataset + unique domestic bases
// Total: ~220 bases from 9 operators (US-NATO, UK, France, Russia, China, India, Italy, UAE, Japan)
export const MILITARY_BASES: MilitaryBase[] = mergeAndDeduplicateBases();
