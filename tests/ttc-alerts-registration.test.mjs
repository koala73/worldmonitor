import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { __testing__ as healthTesting } from '../api/health.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const SEEDER = read('scripts/seed-ttc-alerts.mjs');
const ADAPTER = read('scripts/lib/gtfsrt.mjs');
const DEAD_URL = 'https://alerts.ttc.ca/api/alerts/live';
const LIVE_URL = 'https://gtfsrt.ttc.ca/alerts/all?format=binary';

describe('TTC service-alerts production registration (#6623)', () => {
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
    assert.equal(healthTesting.SEED_META.ttcAlerts.key, 'seed-meta:transit:ttc:alerts');
    assert.equal(healthTesting.SEED_META.ttcAlerts.maxStaleMin, 30);
    assert.equal(healthTesting.SEED_META.ttcAlerts.cutover?.mode, 'expiring-ack');
    assert.equal(healthTesting.SEED_META.ttcAlerts.cutover?.issue, 6623);
    assert.equal(healthTesting.ZERO_RECORD_DATA_OK_KEYS.has('ttcAlerts'), true);
    assert.equal(healthTesting.ON_DEMAND_KEYS.has('ttcAlerts'), false);
    assert.equal(healthTesting.BOOTSTRAP_KEYS.ttcAlerts, undefined);
  });

  it('registers Railway cron and seed-health on the same freshness budget', () => {
    const railway = JSON.parse(read('scripts/railway-services.json'));
    const service = railway.find((entry) => entry.service === 'seed-ttc-alerts');
    assert.equal(service?.entry, 'scripts/seed-ttc-alerts.mjs');
    assert.equal(service?.deployMode, 'nixpacks-root-scripts');
    assert.equal(service?.cronSchedule, '*/5 * * * *');
    assert.ok(service?.watchPatterns.includes('scripts/lib/gtfsrt.mjs'));
    assert.ok(service?.watchPatterns.includes('scripts/seed-ttc-alerts.mjs'));
    assert.match(
      read('api/seed-health.js'),
      /'transit:ttc:alerts':\s*\{ key: 'seed-meta:transit:ttc:alerts',\s*intervalMin:\s*15/,
    );
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
});
