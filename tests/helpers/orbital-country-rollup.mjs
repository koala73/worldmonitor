// Country rollups built by the real site seeder from flag records folded by the real change
// lifecycle, so readers are tested against what the seeder publishes.
import { buildCountryRollup, buildSiteRecord, countryKey, evaluateSites, ORBITAL_SITES_KEY, planPublication, SITES_SCHEMA } from '../../scripts/_orbital-sites.mjs';
import { advanceTrack, FLAG_SCHEMA, FLAG_WORDING, geometryKey, newTrack, siteFlagState } from '../../scripts/shared/orbital/flag-record.js';

const GEOMETRY = { constellation: 'sentinel-1', relativeOrbit: 28, orbitState: 'descending', mode: 'IW', polarizations: ['VH', 'VV'] };
const DAY_MS = 86_400_000;
const EMPTY_CATALOG = { fetchedAt: 0, satellites: [], ring: [] };

const scene = (nowMs, daysAgo, vv, platform) => ({
  itemId: `S1_${platform}_${daysAgo}`, datetime: new Date(nowMs - daysAgo * DAY_MS).toISOString(), platform, values: { vv_median: vv, vh_median: vv - 6 },
});

/** A site's flag record after a stable baseline and then the given scenes, one per 12 days. */
export function flagAfter(siteId, nowMs, tail) {
  let track = newTrack(GEOMETRY);
  const events = [];
  const scenes = [...[40, 40.2, 39.9, 40.1, 39.8, 40].map((vv, i) => scene(nowMs, 12 * (6 + tail.length - i), vv, 'Sentinel-1A')),
    ...tail.map(([vv, platform], i) => scene(nowMs, 12 * (tail.length - i), vv, platform))];
  for (const observation of scenes) {
    const next = advanceTrack(track, observation);
    track = next.track;
    if (next.event) events.push(next.event);
  }
  const tracks = { [geometryKey(GEOMETRY)]: track };
  return {
    schema: FLAG_SCHEMA, siteId, wording: FLAG_WORDING, footprint: { lat: 0, lon: 0, halfSizeDeg: 0.01 },
    state: siteFlagState(tracks), tracks, events, backfilledAt: null, updatedAt: nowMs,
  };
}

export const CONFIRMED = [[43, 'Sentinel-1A'], [43.1, 'Sentinel-1C']];
export const RAISED = [[43, 'Sentinel-1A']];

export function siteOf(id, name, countryCode = 'IR') {
  return { id, name, lat: 33.72, lon: 51.73, countryCode, surface: 'land', origins: [{ list: 'nuclear', id }] };
}

/** One site record per entry; `flag` is a flag record or null (shadowed or unscored). */
export function rollupOf(countryCode, nowMs, entries, { evaluatedAt = nowMs } = {}) {
  const acquisitions = [{ itemId: 'S2B_RECENT', collection: 'sentinel-2-l2a', profileId: 'sentinel-2', platform: 'Sentinel-2B', datetime: new Date(nowMs - DAY_MS).toISOString(), cloudCover: 4 }];
  const records = entries.map(({ site, flag }) => ({
    ...buildSiteRecord({ site, catalog: EMPTY_CATALOG, acquisitions, previous: null, nowMs, flag }),
    evaluatedAt,
  }));
  return buildCountryRollup(countryCode, records);
}

/** The sites index the seeder publishes beside these rollups, naming each one's revision. */
export function indexFor(...rollups) {
  return {
    schema: SITES_SCHEMA,
    countries: Object.fromEntries(rollups.map((r) => [r.countryCode, { revision: r.revision, asOf: r.asOf, siteCount: r.sites.length }])),
  };
}

/** What a reader gets for one country: its rollup and the index that names it. */
export const watchedRead = (rollup) => ({ rollup, index: rollup ? indexFor(rollup) : null });

/** The Redis rows for these rollups and their index. */
export const watchedKeys = (...rollups) => ({
  [ORBITAL_SITES_KEY]: indexFor(...rollups),
  ...Object.fromEntries(rollups.map((r) => [countryKey(r.countryCode), r])),
});

/** The rollup the seeder publishes when change scoring runs in shadow and confirms a flag. */
export async function shadowedRollup(countryCode, nowMs, sites) {
  const evaluation = await evaluateSites({
    sites, catalog: EMPTY_CATALOG, previousRecords: new Map(), cursor: null, nowMs, deadlineMs: Infinity,
    searchArchive: async () => [],
    change: {
      shadow: true, previousFlags: new Map(),
      score: async ({ site }) => flagAfter(site.id, nowMs, CONFIRMED),
      summary: () => ({ shadow: true }),
    },
  });
  const plan = planPublication({ sites, registryVersion: 'test', previousIndex: null, previousRecords: new Map(), evaluation, nowMs });
  return { rollup: plan.rollupWrites.find((rollup) => rollup.countryCode === countryCode), shadowFlags: plan.flagWrites };
}
