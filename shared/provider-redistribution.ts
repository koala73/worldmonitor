export function isOpenSkyProvider(source: unknown): boolean {
  return typeof source === 'string' && /^opensky(?:$|[\s\-_:])/i.test(source.trim());
}

/**
 * Derived snapshots must name the provider that produced them before they can
 * cross a redistribution boundary. Missing attribution fails closed because
 * the value may have been built from a retained OpenSky fallback snapshot.
 */
export function hasRedistributableProviderAttribution(source: unknown): boolean {
  return typeof source === 'string' && source.trim().length > 0 && !isOpenSkyProvider(source);
}
