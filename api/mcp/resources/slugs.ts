// Hand-curated canonical-slug table for the
// `worldmonitor://chokepoints/{slug}/status` resource URI. The slug → matcher
// map is the STABILITY CONTRACT: callers can bookmark a slug and trust the URI
// resolves to the same chokepoint across cache refreshes / upstream renames.
// A new chokepoint requires an explicit edit here AND an update to the
// stability snapshot in tests/mcp-resources.test.mjs — that test reads this
// file's byte-for-byte contents, so a casual rename in one place will fail
// the snapshot and force the author to acknowledge the contract change.
//
// The matcher value is the case-insensitive substring passed to
// get_chokepoint_status({chokepoint: <matcher>}). Each matcher is picked to
// uniquely identify exactly ONE chokepoint within the 13-entry canonical
// registry (scripts/seed-portwatch.mjs::CHOKEPOINTS that feeds
// supply_chain:transit-summaries:v1, mirrored in
// scripts/seed-hs2-chokepoint-exposure.mjs::CHOKEPOINT_REGISTRY). Picking a
// shorter-than-id matcher is intentional: the postFilter's `ciIncludes` runs
// against the differing identifier shapes used by each sub-dataset
// (`hormuz_strait` in transit-summaries, `Strait of Hormuz` in
// chokepoint-baselines.name), so the matcher must be a substring of BOTH.
//
// Slugs are kebab-case. Underscores would conflict with the canonical-id
// convention used inside the response payload.
export const CHOKEPOINT_SLUGS: Readonly<Record<string, string>> = Object.freeze({
  'suez': 'suez',
  'strait-of-malacca': 'malacca',
  'strait-of-hormuz': 'hormuz',
  'bab-el-mandeb': 'bab',
  'panama-canal': 'panama',
  'taiwan-strait': 'taiwan',
  'cape-of-good-hope': 'cape',
  'strait-of-gibraltar': 'gibraltar',
  'bosphorus': 'bosphorus',
  'korea-strait': 'korea',
  'dover-strait': 'dover',
  'kerch-strait': 'kerch',
  'lombok-strait': 'lombok',
});
