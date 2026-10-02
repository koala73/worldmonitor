export const GDELT_INTEL_KEY = 'intelligence:gdelt-intel:v1';
export const GDELT_BULK_STATE_KEY = 'gdelt:bulk:materializer-state:v1';
export const GDELT_BULK_DYAD_KEY = 'gdelt:bulk:dyad-tension:v1';
export const GDELT_BULK_CONFLICT_KEY = 'gdelt:bulk:conflict-events:v1';
export const GDELT_BULK_UNREST_KEY = 'gdelt:bulk:unrest-events:v1';
export const GDELT_BULK_ARTICLES_KEY = 'gdelt:bulk:articles:v1';
// Rolling per-country article index off GKG V1LOCATIONS (#7748), read by
// server/worldmonitor/intelligence/v1/search-gdelt-documents.ts for the
// `country:<ISO2>` query form. Keep the literal in that handler in sync.
export const GDELT_BULK_COUNTRY_ARTICLES_KEY = 'gdelt:bulk:country-articles:v1';
export const POSITIVE_EVENTS_RPC_KEY = 'positive-events:geo:v1';
export const POSITIVE_EVENTS_BOOTSTRAP_KEY = 'positive_events:geo-bootstrap:v1';
