import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { __testing__ as healthTesting } from '../api/health.js';
import { gtfsRtHeaderContentMeta } from '../scripts/lib/gtfsrt.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const SEEDER = read('scripts/seed-ttc-alerts.mjs');
const ADAPTER = read('scripts/lib/gtfsrt.mjs');
// Parsed, not imported: importing the seeder executes runSeed() at module scope.
const TTC_ALERTS_MAX_CONTENT_AGE_MIN = Number(
  /TTC_ALERTS_MAX_CONTENT_AGE_MIN = (\d+)/.exec(SEEDER)[1],
);
const DEAD_URL = 'https://alerts.ttc.ca/api/alerts/live';
const LIVE_URL = 'https://gtfsrt.ttc.ca/alerts/all?format=binary';

describe('TTC service-alerts production registration (#6623)', () => {
  it('health probes the seed-meta key runSeed actually writes', () => {
    // runSeed derives seed-meta as `seed-meta:${domain}:${resource}` — it is NOT
    // the canonical key with :v1 stripped. TTC's canonical key is
    // transit:ttc:alerts:v1 but its resource is 'ttc-alerts', so the meta key
    // takes a HYPHEN where the canonical key has a colon. Probing the colon form
    // watches a key that is never written: the seed reads absent forever,
    // however healthy the seeder is. VIA Rail gets this right; TTC did not.
    const call = SEEDER.match(/runSeed\(\s*'([^']+)'\s*,\s*'([^']+)'/);
    assert.ok(call, 'seeder must call runSeed with literal domain and resource');
    const [, domain, resource] = call;
    const written = `seed-meta:${domain}:${resource}`;

    assert.equal(healthTesting.SEED_META.ttcAlerts.key, written);

    // ttcAlerts publishes now (seed-bundle-canada is provisioned), so its
    // expiring-ack was removed as satisfied and is no longer REQUIRED. The
    // invariant that survives is directional: IF an acknowledgement exists it
    // must watch the key runSeed actually writes, or it is anchored to a probe
    // that can never clear. Requiring the ack outright would force a satisfied
    // suppression to be reinstated just to keep this test green.
    const baseline = JSON.parse(read('scripts/seed-freshness-baseline.json'));
    const ack = baseline.acknowledged.find((row) => row.name === 'ttcAlerts');
    if (ack) assert.equal(ack.cutover.probeKey, written);
  });

  it('does not ship the 404 alerts.ttc.ca/api/alerts/live URL', () => {
    assert.equal(SEEDER.includes(DEAD_URL), false);
    assert.equal(ADAPTER.includes(DEAD_URL), false);
    assert.equal(SEEDER.includes('alerts.ttc.ca/api/alerts/live'), false);
  });

  it('ingests the verified GTFS-RT protobuf feed via gtfsrtAdapter(feedUrl)', () => {
    assert.match(SEEDER, /gtfsrtAdapter\(TTC_GTFS_RT_ALERTS_URL/);
    assert.match(SEEDER, /allowedHosts:\s*\[TTC_GTFS_RT_HOST\]/);
    assert.match(SEEDER, /https:\/\/gtfsrt\.ttc\.ca\/alerts\/all\?format=binary/);
    assert.match(ADAPTER, /export async function gtfsrtAdapter\(feedUrl/);
    assert.match(ADAPTER, /redirect:\s*'error'/);
    assert.match(ADAPTER, /CHROME_UA/);
    assert.equal(ADAPTER.includes('fetch.bind'), false);
    assert.equal(SEEDER.includes('fetch.bind'), false);
  });

  it('publishes a standalone transit:ttc:alerts:v1 key with zeroIsValid', () => {
    assert.match(SEEDER, /transit:ttc:alerts:v1/);
    assert.match(SEEDER, /zeroIsValid:\s*true/);
    assert.match(SEEDER, /ttlSeconds:\s*TTC_ALERTS_TTL_SECONDS/);
    assert.match(SEEDER, /maxStaleMin:\s*TTC_ALERTS_MAX_STALE_MIN/);
    assert.equal(healthTesting.STANDALONE_KEYS.ttcAlerts, 'transit:ttc:alerts:v1');
    // Hyphen, not colon — this literal previously pinned the mismatched key and
    // is why the bug shipped green. The derivation test above is the real guard.
    assert.equal(healthTesting.SEED_META.ttcAlerts.key, 'seed-meta:transit:ttc-alerts');
    assert.equal(healthTesting.SEED_META.ttcAlerts.maxStaleMin, 30);
    assert.equal(healthTesting.SEED_META.ttcAlerts.cutover?.mode, 'expiring-ack');
    assert.equal(healthTesting.SEED_META.ttcAlerts.cutover?.issue, 6623);
    assert.equal(healthTesting.ZERO_RECORD_DATA_OK_KEYS.has('ttcAlerts'), true);
    assert.equal(healthTesting.ON_DEMAND_KEYS.has('ttcAlerts'), false);
    assert.equal(healthTesting.BOOTSTRAP_KEYS.ttcAlerts, undefined);
  });

  it('runs as a bundle member, not its own Railway service', () => {
    // TTC is one of six Canada seeders. Six services against a fleet whose
    // runbook targets 65 is the wrong trade for ~1s of tick work, so this
    // seeder has NO standalone row: seed-bundle-canada (#6711) owns it and
    // gates it on a per-member intervalMs of 5 minutes.
    const railway = JSON.parse(read('scripts/railway-services.json'));
    assert.equal(
      railway.some((entry) => entry.service === 'seed-ttc-alerts'),
      false,
      'a standalone row here would claim a Railway slot the bundle already covers',
    );
  });

  it('probes the same seed-meta key from every health surface', () => {
    // Three carriers, and all three had the colon form. A probe on an unwritten
    // key is invisible, not loud — so pin them together rather than one by one.
    assert.match(
      read('api/seed-health.js'),
      /'transit:ttc:alerts':\s*\{ key: 'seed-meta:transit:ttc-alerts',\s*intervalMin:\s*15/,
    );
    assert.equal(healthTesting.SEED_META.ttcAlerts.key, 'seed-meta:transit:ttc-alerts');
    // The baseline was the third carrier of the colon form. Its ack is gone now
    // that the probe publishes, so this checks it directionally: present or
    // absent is fine, wrong key is not.
    const baseline = JSON.parse(read('scripts/seed-freshness-baseline.json'));
    const ack = baseline.acknowledged.find((row) => row.name === 'ttcAlerts');
    if (ack) assert.equal(ack.cutover.probeKey, 'seed-meta:transit:ttc-alerts');
  });

  it('does not overload VIA or 511 adapters', () => {
    assert.equal(/viarail|via-rail|ontario-511|open511|alberta-511/i.test(SEEDER), false);
    assert.equal(/seed-via|seed-.*511/i.test(SEEDER), false);
  });
});

describe('TTC alerts health classifier (#6623)', () => {
  const NOW = 1_700_000_000_000;
  const { classifyKey, STANDALONE_KEYS, SEED_META, STATUS_COUNTS } = healthTesting;
  const dataKey = STANDALONE_KEYS.ttcAlerts;
  const metaKey = SEED_META.ttcAlerts.key;

  function ctx({ stren, fetchedAt = NOW - 60_000, recordCount = 12 } = {}) {
    return {
      keyStrens: stren == null ? new Map() : new Map([[dataKey, stren]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[metaKey, JSON.stringify({ fetchedAt, recordCount })]]),
      keyMetaErrors: new Map(),
      now: NOW,
    };
  }

  it('treats a present payload with zero alerts as OK', () => {
    const entry = classifyKey('ttcAlerts', dataKey, { allowOnDemand: true }, ctx({
      stren: 128,
      recordCount: 0,
    }));
    assert.equal(entry.status, 'OK');
    assert.equal(STATUS_COUNTS[entry.status], 'ok');
  });

  it('treats a missing payload as EMPTY even with fresh zero-record meta', () => {
    const entry = classifyKey('ttcAlerts', dataKey, { allowOnDemand: true }, ctx({
      recordCount: 0,
    }));
    assert.equal(entry.status, 'EMPTY');
    assert.equal(STATUS_COUNTS[entry.status], 'crit');
  });

  it('does not classify a headerless/malformed ingest as health-green empty', () => {
    // Malformed bodies must fail ingest (no published payload). Green-empty
    // is only for a present payload from a valid zero-entity feed.
    assert.match(ADAPTER, /missing FeedHeader\.gtfs_realtime_version/);
    assert.match(SEEDER, /header\?\.gtfsRealtimeVersion/);
    const failedIngest = classifyKey('ttcAlerts', dataKey, { allowOnDemand: true }, ctx({
      recordCount: 0,
    }));
    assert.equal(failedIngest.status, 'EMPTY');
    assert.equal(STATUS_COUNTS[failedIngest.status], 'crit');
    const validEmpty = classifyKey('ttcAlerts', dataKey, { allowOnDemand: true }, ctx({
      stren: 128,
      recordCount: 0,
    }));
    assert.equal(validEmpty.status, 'OK');
  });
});

describe('a frozen GTFS-RT feed must not read fresh (#6623)', () => {
  // A frozen feed still serves 200s with well-formed protobuf, so every
  // fetch-time signal keeps saying healthy: the request succeeds, the snapshot
  // validates, fetchedAt is always now. zeroIsValid makes it sharper — an empty
  // alerts array is a legitimate quiet period, so record count can never
  // separate "no disruptions" from "the producer died three days ago".
  const NOW = Date.parse('2026-08-15T12:00:00Z');

  it('derives the content clock from header.timestamp, not from fetch time', () => {
    const fresh = gtfsRtHeaderContentMeta(
      { header: { timestamp: new Date(NOW - 5 * 60_000).toISOString() } },
      NOW,
    );
    assert.equal(fresh.newestItemAt, NOW - 5 * 60_000);

    // The frozen case: fetched now, but the producer's own stamp is 3 days old.
    const frozen = gtfsRtHeaderContentMeta(
      { header: { timestamp: new Date(NOW - 3 * 24 * 60 * 60_000).toISOString() } },
      NOW,
    );
    assert.equal(frozen.newestItemAt, NOW - 3 * 24 * 60 * 60_000);
    assert.ok(
      NOW - frozen.newestItemAt > TTC_ALERTS_MAX_CONTENT_AGE_MIN * 60_000,
      'a 3-day-old header must exceed the content-age budget',
    );
  });

  it('returns null rather than substituting now() when the stamp is missing', () => {
    // Substituting a clock reading for a missing stamp is exactly what makes a
    // frozen feed look fresh, so absence must mean "no content clock".
    assert.equal(gtfsRtHeaderContentMeta({ header: {} }, NOW), null);
    assert.equal(gtfsRtHeaderContentMeta({}, NOW), null);
    assert.equal(gtfsRtHeaderContentMeta({ header: { timestamp: 'not-a-date' } }, NOW), null);
    assert.equal(gtfsRtHeaderContentMeta({ header: { timestamp: null } }, NOW), null);
  });

  it('ignores a future stamp beyond clock skew instead of trusting it', () => {
    // A feed stamped ahead cannot bound staleness; trusting it would let a
    // producer mask a freeze by stamping the future.
    assert.equal(
      gtfsRtHeaderContentMeta({ header: { timestamp: new Date(NOW + 2 * 60 * 60_000).toISOString() } }, NOW),
      null,
    );
    // Within an hour of skew is still accepted.
    assert.ok(gtfsRtHeaderContentMeta({ header: { timestamp: new Date(NOW + 60_000).toISOString() } }, NOW));
  });

  it('the snapshot actually carries header.timestamp for the clock to read', () => {
    // buildTtcAlertsSnapshot feeds contentMeta. If it dropped the stamp the
    // clock would be permanently null and the guard silently inert. Asserted on
    // source because importing the seeder executes runSeed().
    assert.match(SEEDER, /timestamp:\s*unixSecondsToIso\(feed\?\.header\?\.timestamp\)/);
  });

  it('registers the content clock with runSeed, or it is never evaluated', () => {
    // contentMeta without maxContentAgeMin is inert — maxContentAgeMin is the
    // opt-in signal runSeed checks before consulting the clock at all.
    assert.match(SEEDER, /contentMeta:\s*gtfsRtHeaderContentMeta/);
    assert.match(SEEDER, /maxContentAgeMin:\s*TTC_ALERTS_MAX_CONTENT_AGE_MIN/);
  });
});
