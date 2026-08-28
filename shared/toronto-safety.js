/**
 * Shared Toronto public-safety contract (#7012).
 *
 * Keep the three semantics separate. GTA Update reuse permission is held, but
 * production remains disabled pending upstream provenance and product
 * activation. TPS datasets are official, retrospective, and available only
 * through bounded on-demand reads.
 */

export const TORONTO_SAFETY_SEMANTICS = Object.freeze({
  liveDispatch: 'live_dispatch',
  reportedOccurrence: 'reported_occurrence',
  annualAggregate: 'annual_aggregate',
});

export const TORONTO_SAFETY_SOURCES = Object.freeze([
  Object.freeze({
    id: 'gta-update-police',
    semantic: TORONTO_SAFETY_SEMANTICS.liveDispatch,
    canonicalKey: 'safety:toronto:gta-update:police:v1',
    seedMetaKey: 'seed-meta:safety:gta-update-police',
    label: 'GTA Update police (unofficial live dispatch)',
    disclaimer: 'Unofficial third-party TPS dispatch mirror. Delayed, incomplete, not official, not verified. Permission held; production disabled pending upstream provenance and product activation.',
    attribution: 'GTA Update. Used with permission.',
    sourceUrl: 'https://gtaupdate.com/',
    productionWriter: 'disabled',
    bootstrap: 'none',
    geocode: false,
  }),
  Object.freeze({
    id: 'gta-update-fire',
    semantic: TORONTO_SAFETY_SEMANTICS.liveDispatch,
    canonicalKey: 'safety:toronto:gta-update:fire:v1',
    seedMetaKey: 'seed-meta:safety:gta-update-fire',
    label: 'GTA Update fire (unofficial live dispatch)',
    disclaimer: 'Unofficial third-party TFS dispatch mirror. Delayed, incomplete, not official, not verified. Permission held; production disabled pending upstream provenance and product activation.',
    attribution: 'GTA Update. Used with permission.',
    sourceUrl: 'https://gtaupdate.com/',
    productionWriter: 'disabled',
    bootstrap: 'none',
    geocode: false,
  }),
  Object.freeze({
    id: 'tps-mci',
    semantic: TORONTO_SAFETY_SEMANTICS.reportedOccurrence,
    canonicalKey: 'safety:toronto:tps-mci:v1',
    seedMetaKey: 'seed-meta:safety:tps-mci',
    label: 'TPS Major Crime Indicators (reported occurrence)',
    disclaimer: 'Retrospective offence/victim rows. Coordinates are deliberately offset. Not a live dispatch feed.',
    attribution: 'Contains information licensed under the Open Government Licence - Ontario.',
    sourceUrl: 'https://data.tps.ca/pages/major-crime-indicators',
    productionWriter: 'on-demand',
    bootstrap: 'none',
    geocode: false,
  }),
  Object.freeze({
    id: 'tps-calls-attended',
    semantic: TORONTO_SAFETY_SEMANTICS.annualAggregate,
    canonicalKey: 'safety:toronto:tps-calls-attended:v1',
    seedMetaKey: 'seed-meta:safety:tps-calls-attended',
    label: 'TPS Calls for Service Attended (annual aggregate)',
    disclaimer: 'Annual counts by division and neighbourhood. These are not incident points.',
    attribution: 'Contains information licensed under the Open Government Licence - Ontario.',
    sourceUrl: 'https://data.tps.ca/pages/calls-for-service',
    productionWriter: 'on-demand',
    bootstrap: 'none',
    geocode: false,
  }),
]);

export const TORONTO_SAFETY_CANONICAL_KEYS = Object.freeze(
  Object.fromEntries(TORONTO_SAFETY_SOURCES.map((source) => [source.id, source.canonicalKey])),
);

export function torontoSafetySourceById(id) {
  return TORONTO_SAFETY_SOURCES.find((source) => source.id === id);
}

export function torontoSafetySourcesForSemantic(semantic) {
  return TORONTO_SAFETY_SOURCES.filter((source) => source.semantic === semantic);
}
