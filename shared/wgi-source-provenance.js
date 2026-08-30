const WORLD_BANK_WGI_API_PREFIX = 'https://api.worldbank.org/v2/country/all/indicator/';

/**
 * Convert the stored bare WGI key into the upstream series requested by the
 * resilience seeder. This producer-owned mapping is independent from the raw
 * redistribution policy that audits the resulting observation provenance.
 */
export function wgiUpstreamIndicatorId(storedKey) {
  return `GOV_WGI_${storedKey}`;
}

export function wgiObservationSource(storedKey) {
  return {
    providerName: 'World Bank Open Data',
    sourceUrl: `${WORLD_BANK_WGI_API_PREFIX}${wgiUpstreamIndicatorId(storedKey)}`,
  };
}
