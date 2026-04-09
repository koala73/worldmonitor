export interface CanonicalChokepoint {
  id: string;
  relayName: string;
  portwatchName: string;
  corridorRiskName: string | null;
  /** EIA chokepoint baseline ID (energy:chokepoint-baselines:v1). Null = no EIA baseline. */
  baselineId: string | null;
}

export const CANONICAL_CHOKEPOINTS: readonly CanonicalChokepoint[] = [
  { id: 'suez',             relayName: 'Suez Canal',           portwatchName: 'Suez Canal',           corridorRiskName: 'Suez',             baselineId: 'suez'    },
  { id: 'malacca_strait',   relayName: 'Malacca Strait',       portwatchName: 'Malacca Strait',       corridorRiskName: 'Malacca',          baselineId: 'malacca' },
  { id: 'hormuz_strait',    relayName: 'Strait of Hormuz',     portwatchName: 'Strait of Hormuz',     corridorRiskName: 'Hormuz',           baselineId: 'hormuz'  },
  { id: 'bab_el_mandeb',    relayName: 'Bab el-Mandeb Strait', portwatchName: 'Bab el-Mandeb Strait', corridorRiskName: 'Bab el-Mandeb',    baselineId: 'babelm'  },
  { id: 'panama',           relayName: 'Panama Canal',         portwatchName: 'Panama Canal',         corridorRiskName: 'Panama',           baselineId: 'panama'  },
  { id: 'taiwan_strait',    relayName: 'Taiwan Strait',        portwatchName: 'Taiwan Strait',        corridorRiskName: 'Taiwan',           baselineId: null      },
  { id: 'cape_of_good_hope',relayName: 'Cape of Good Hope',    portwatchName: 'Cape of Good Hope',    corridorRiskName: 'Cape of Good Hope',baselineId: null      },
  { id: 'gibraltar',        relayName: 'Gibraltar Strait',     portwatchName: 'Gibraltar Strait',     corridorRiskName: null,               baselineId: null      },
  { id: 'bosphorus',        relayName: 'Bosporus Strait',      portwatchName: 'Bosporus Strait',      corridorRiskName: null,               baselineId: 'turkish' },
  { id: 'korea_strait',     relayName: 'Korea Strait',         portwatchName: 'Korea Strait',         corridorRiskName: null,               baselineId: null      },
  { id: 'dover_strait',     relayName: 'Dover Strait',         portwatchName: 'Dover Strait',         corridorRiskName: null,               baselineId: 'danish'  },
  { id: 'kerch_strait',     relayName: 'Kerch Strait',         portwatchName: 'Kerch Strait',         corridorRiskName: null,               baselineId: null      },
  { id: 'lombok_strait',    relayName: 'Lombok Strait',        portwatchName: 'Lombok Strait',        corridorRiskName: null,               baselineId: null      },
];

export function relayNameToId(relayName: string): string | undefined {
  return CANONICAL_CHOKEPOINTS.find(c => c.relayName === relayName)?.id;
}

export function portwatchNameToId(portwatchName: string): string | undefined {
  if (!portwatchName) return undefined;
  return CANONICAL_CHOKEPOINTS.find(c => c.portwatchName && c.portwatchName.toLowerCase() === portwatchName.toLowerCase())?.id;
}

export function corridorRiskNameToId(crName: string): string | undefined {
  return CANONICAL_CHOKEPOINTS.find(c => c.corridorRiskName?.toLowerCase() === crName.toLowerCase())?.id;
}
