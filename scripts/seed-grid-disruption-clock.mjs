#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { getRedisCredentials, loadEnvFile, readCanonicalValue, redisCommand, runSeed } from './_seed-utils.mjs';
import { fetchGridClockSources } from './lib/grid-clock-sources.mjs';
import { GRID_CLOCK_REGIONS, isGridClockSnapshot } from './shared/grid-disruption-clock.js';

const KEY = 'infra:grid-disruption-clock:v1';
export const GRID_CLOCK_ACTIVATION_KEY = 'seed-activated:infra:grid-disruption-clock';
const DAY = 24 * 60 * 60_000;
const MAX_HISTORY = 144;

// Keep the published source times. Retries and repeated upstream snapshots do
// not become additional measurements or reset the time on an old observation.
export function buildGridClockSnapshot(regions, previous, now) {
  return {
    regions: regions.map(region => {
      const prior = previous?.regions?.find(item => item.code === region.code);
      const points = new Map();
      for (const point of [...(prior?.history ?? []), prior?.current]) {
        if (point && point.observedAt >= now - DAY && point.observedAt <= now) {
          points.set(point.observedAt, point);
        }
      }
      const history = [...points.values()].sort((a, b) => a.observedAt - b.observedAt);
      const latestTime = history.at(-1)?.observedAt ?? 0;
      const incoming = region.current;
      const current = incoming && incoming.observedAt >= latestTime && incoming.observedAt <= now
        ? incoming : null;
      if (current && current.observedAt === latestTime) history.pop();
      const lastImpactGapAt = current ? prior?.lastImpactGapAt : now;

      // Only remember notices that fell out of the current list. A fetch
      // failure also moves a prior notice here, without claiming cancellation.
      const warningId = w => JSON.stringify([w.sourceName, w.kind, w.sourceUrl, w.issuedAt, w.title]);
      const previousNotices = new Map();
      for (const warning of [...(prior?.recentWarnings ?? []), ...(prior?.warnings ?? [])]) {
        if (warning.expiresAt >= now - DAY) previousNotices.set(warningId(warning), warning);
      }
      for (const warning of region.warnings) previousNotices.delete(warningId(warning));
      const recentWarnings = [...previousNotices.values()].sort((a, b) => b.issuedAt - a.issuedAt).slice(0, 16);

      return {
        ...region, current, history: history.slice(-MAX_HISTORY), recentWarnings,
        ...(lastImpactGapAt >= now - DAY ? { lastImpactGapAt } : {}),
      };
    }),
  };
}

export function gridClockHealth(snapshot, now) {
  const failed = snapshot.regions.filter(region => !region.current || region.current.partial
    || now - region.current.observedAt > 60 * 60_000
    || region.warningSources.some(source => source.status === 'unavailable'));
  return failed.length ? { freshnessMetaPatch: {
    sourceState: 'degraded', errorCode: 'GRID_CLOCK_PARTIAL',
    errorDetail: `Partial or stale coverage: ${failed.map(region => region.code).join(', ')}`,
  } } : undefined;
}

export async function afterGridClockPublish(snapshot, {
  now = Date.now(), credentials = getRedisCredentials, command = redisCommand,
} = {}) {
  // An all-unavailable snapshot describes a successful worker run but cannot
  // establish that a single live input has ever reached this new deployment.
  if (snapshot.regions.some(region => region.current
    || region.warningSources.some(source => source.status === 'available'))) {
    const { url, token } = credentials();
    await command(url, token, ['SET', GRID_CLOCK_ACTIVATION_KEY, '1', 'NX']);
  }
  return gridClockHealth(snapshot, now);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile(import.meta.url);
  runSeed('infra', 'grid-disruption-clock', KEY, async () => {
    const [regions, previous] = await Promise.all([
      fetchGridClockSources(),
      readCanonicalValue(KEY, { strict: true }),
    ]);
    return buildGridClockSnapshot(regions, previous, Date.now());
  }, {
    // Retain a full day for comparison even through missed ten-minute runs.
    ttlSeconds: 2 * DAY / 1000,
    sourceVersion: 'grid-disruption-clock-v1',
    schemaVersion: 1,
    maxStaleMin: 30,
    validateFn: data => isGridClockSnapshot(data) && data.regions.length === Object.keys(GRID_CLOCK_REGIONS).length,
    declareRecords: data => data.regions.length,
    recordCount: data => data.regions.length,
    afterPublish: data => afterGridClockPublish(data),
  }).catch(error => {
    console.error('Grid disruption clock seed failed:', error.message);
    process.exitCode = 1;
  });
}
