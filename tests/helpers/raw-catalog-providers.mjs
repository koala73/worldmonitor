import assert from 'node:assert/strict';

// Deliberately independent of the production catalog-provider predicate.
// Keep this oracle expressed only in raw manifest fields so a predicate
// mutation cannot change both the implementation and the expected membership.
export function rawManifestActiveEntries(manifest) {
  assert.ok(Array.isArray(manifest?.entries), 'the attribution manifest must contain an entries array');
  return manifest.entries.filter(
    (entry) => entry?.observed === true
      && entry.catalogActive !== false
      && (entry.status === 'reviewed' || entry.status === 'terms-review'),
  );
}

const SYNDICATION_TRANSPORT_HOSTS = new Set([
  'feeds.feedburner.com',
  'feedburner.com',
  'news.google.com',
]);

export function rawCatalogProviderNames(manifest) {
  const names = new Set(
    rawManifestActiveEntries(manifest)
      .filter((entry) => entry.role !== 'transport' && !SYNDICATION_TRANSPORT_HOSTS.has(entry.host))
      .map((entry) => entry.provider),
  );
  for (const logical of manifest.logicalProviders || []) {
    if (typeof logical?.provider === 'string' && logical.provider) names.add(logical.provider);
  }
  return names;
}
