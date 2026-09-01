// Committed EIA 2023 World Oil Transit Chokepoints rows. Shared by the
// Redis seeder and crawlable /chokepoints pages so the two cannot drift.

export const EIA_OIL_TRANSIT_SOURCE = 'EIA World Oil Transit Chokepoints';
export const EIA_OIL_TRANSIT_REFERENCE_YEAR = 2023;

export const EIA_OIL_TRANSIT_CHOKEPOINTS = [
  { id: 'hormuz',  relayId: 'hormuz_strait',  name: 'Strait of Hormuz',   mbd: 21.0, lat: 26.6, lon: 56.3  },
  { id: 'malacca', relayId: 'malacca_strait', name: 'Strait of Malacca',  mbd: 17.2, lat: 1.3,  lon: 103.8 },
  { id: 'suez',    relayId: 'suez',           name: 'Suez Canal / SUMED', mbd: 7.6,  lat: 30.7, lon: 32.3  },
  { id: 'babelm',  relayId: 'bab_el_mandeb',  name: 'Bab el-Mandeb',      mbd: 6.2,  lat: 12.6, lon: 43.4  },
  { id: 'danish',  relayId: 'dover_strait',   name: 'Danish Straits',      mbd: 3.0,  lat: 57.5, lon: 10.5  },
  { id: 'turkish', relayId: 'bosphorus',      name: 'Turkish Straits',     mbd: 2.9,  lat: 41.1, lon: 29.0  },
  { id: 'panama',  relayId: 'panama',         name: 'Panama Canal',        mbd: 0.9,  lat: 9.1,  lon: -79.7 },
];

export function buildEiaOilTransitBaselines(chokepoints = EIA_OIL_TRANSIT_CHOKEPOINTS) {
  return Object.freeze({
    source: EIA_OIL_TRANSIT_SOURCE,
    referenceYear: EIA_OIL_TRANSIT_REFERENCE_YEAR,
    byRegistryId: Object.freeze(
      Object.fromEntries(
        chokepoints.map((cp) => [cp.relayId, Object.freeze({ mbd: cp.mbd, eiaName: cp.name })]),
      ),
    ),
  });
}
