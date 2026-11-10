interface AttributionCounts {
  entryCount: number;
  vesselCount: number;
  aircraftCount: number;
}

// Older seeds placed unattributed records in the truncated country ranking.
// If the row was omitted, its count cannot be recovered from that snapshot.
export function splitSanctionsAttribution<Country extends AttributionCounts & { countryCode: string }>(
  countries: Country[],
  unattributed?: AttributionCounts,
): { countries: Country[]; unattributed?: AttributionCounts } {
  const unknown = countries.find(row => row.countryCode === 'XX');
  if (!unknown) return { countries, ...(unattributed ? { unattributed } : {}) };

  const { entryCount, vesselCount, aircraftCount } = unknown;
  return {
    countries: countries.filter(row => row.countryCode !== 'XX'),
    unattributed: unattributed ?? { entryCount, vesselCount, aircraftCount },
  };
}
