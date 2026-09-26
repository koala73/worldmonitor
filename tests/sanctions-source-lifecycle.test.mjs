import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mergeSanctionEntries, SEMA_SOURCE, sanctionsListContentMeta } from '../scripts/_sema-sanctions.mjs';
import { __testing__ as health } from '../api/health.js';
import { readSeedSnapshot, verifySeedKey, runSeed, writeExtraKeyWithMeta } from '../scripts/_seed-utils.mjs';

const source = readFileSync('scripts/seed-sanctions-pressure.mjs', 'utf8');
const pure = source.replace(/^import\s.*$/gm, '').replace(/loadEnvFile\([^)]+\);/, '').split('async function fetchSource')[0];
const tail = source.slice(source.indexOf('async function fetchSanctionsPressure()')).replace(/^export /gm, '');
const normalize = value => JSON.parse(JSON.stringify(value));
const now = Date.UTC(2026, 8, 25);
const row = (source, i) => ({
  id: source === SEMA_SOURCE ? `sema-ca:iran:1-part-2:${i}` : `${source}:${i}`,
  name: `${source} Person ${i}`, sourceLists: [source], countryCodes: [], countryNames: [],
  programs: ['TEST'], entityType: 'SANCTIONS_ENTITY_TYPE_INDIVIDUAL', effectiveAt: '0',
  isNew: false, _aliases: [`Alias ${source} ${i}`], _identifiers: [],
});
const canadian = Array.from({ length: 80 }, (_, i) => row(SEMA_SOURCE, i + 1));

async function publish({ successes = ['SDN', 'CONSOLIDATED', SEMA_SOURCE], stored = null, preview = [], clock = now, writeError = false, readError = false, semaRecords = canadian, semaQuarantined = [], io = {} } = {}) {
  const writes = [];
  let options;
  const context = vm.createContext({
    console: { log() {}, warn() {} }, Buffer, gzipSync, gunzipSync,
    Date: class extends Date { static now() { return clock; } },
    SEMA_SOURCE, mergeSanctionEntries, sanctionsListContentMeta,
    SANCTIONS_SOURCE_VERSION: 'test', SANCTIONS_MAX_CONTENT_AGE_MIN: 43200,
    readSeedSnapshot: async () => {
      if (readError) throw new Error('synthetic cache read failure');
      return stored;
    },
    verifySeedKey: async key => key === 'sanctions:pressure:v1' ? { entries: preview } : null,
    fetchSource: async ({ label }) => {
      if (!successes.includes(label)) throw new Error('synthetic source timeout');
      return { entries: [row(label, 1)], datasetDate: now - 86400000 };
    },
    ingestSemaEntries: async () => successes.includes(SEMA_SOURCE)
      ? { records: semaRecords, quarantined: semaQuarantined, publishedAtMs: now - 2 * 86400000, error: null }
      : { records: [], publishedAtMs: 0, error: 'SEMA_INVALID_RECORD' },
    writeExtraKeyWithMeta: async (...args) => {
      if (writeError) throw new Error('synthetic cache write failure');
      writes.push(normalize(args));
    },
    runSeed: (_d, _r, _k, _f, opts) => { options = opts; },
    ...io,
  });
  vm.runInContext(`${pure}\n${tail}`, context);
  const data = await context.fetchSanctionsPressure();
  return { data, options, writes, context };
}

async function save(fresh) {
  await fresh.options.beforePublish(fresh.data, {});
  return fresh.writes.find(([key]) => key === 'sanctions:source-snapshots:v1')[1];
}

describe('sanctions source lifecycle', () => {
  it('reports each failed OFAC source while Canada succeeds', async () => {
    for (const successes of [[SEMA_SOURCE], ['SDN', SEMA_SOURCE], ['CONSOLIDATED', SEMA_SOURCE]]) {
      const { data, options } = await publish({ successes });
      const result = await options.afterPublish(data, {});
      assert.equal(result.freshnessMetaPatch.sourceState, 'error');
      assert.deepEqual(normalize(result.freshnessMetaPatch.failedSources), ['SDN', 'CONSOLIDATED'].filter(s => !successes.includes(s)));
      assert.equal(result.completionState, 'DEGRADED');
      const key = health.BOOTSTRAP_KEYS.sanctionsPressure;
      const meta = { fetchedAt: now, recordCount: data.totalCount, ...result.freshnessMetaPatch };
      const verdict = health.classifyKey('sanctionsPressure', key, { allowOnDemand: false }, {
        now, containmentEvidenceByName: new Map(), keyStrens: new Map([[key, 1024]]), keyErrors: new Map(),
        keyMetaValues: new Map([[health.SEED_META.sanctionsPressure.key, JSON.stringify(meta)]]), keyMetaErrors: new Map(),
      });
      assert.equal(verdict.status, 'SEED_ERROR');
      assert.equal(verdict.errorCode, 'OFAC_INGEST_FAILED');
    }
  });

  it('keeps health OK and names the quarantined Canadian rows in source health', async () => {
    const quarantined = ['116', '117', '118', '119', '120'].map(item => ({ id: `sema-ca:iran:1-part-2:${item}`, reason: 'INVALID_IMO' }));
    const { data, options } = await publish({ semaQuarantined: quarantined });
    assert.equal(data.semaCount, 80);
    const result = await options.afterPublish(data, {});
    assert.equal(result.freshnessMetaPatch.sourceState, 'ok');
    assert.equal(result.completionState, 'OK');
    assert.deepEqual(normalize(result.freshnessMetaPatch.sourceHealth[SEMA_SOURCE].quarantined), quarantined);
    assert.equal(result.freshnessMetaPatch.sourceHealth.SDN.quarantined, undefined);
    const key = health.BOOTSTRAP_KEYS.sanctionsPressure;
    const meta = { fetchedAt: now, recordCount: data.totalCount, ...result.freshnessMetaPatch };
    const verdict = health.classifyKey('sanctionsPressure', key, { allowOnDemand: false }, {
      now, containmentEvidenceByName: new Map(), keyStrens: new Map([[key, 1024]]), keyErrors: new Map(),
      keyMetaValues: new Map([[health.SEED_META.sanctionsPressure.key, JSON.stringify(meta)]]), keyMetaErrors: new Map(),
    });
    assert.equal(verdict.status, 'OK');
  });

  it('retains all 80 Canadian records and both OFAC cohorts with their original clocks and aliases', async () => {
    const fresh = await publish();
    const stored = await save(fresh);
    const failed = await publish({ successes: [], stored, clock: now + 6 * 3600000 });
    assert.equal(failed.data.totalCount, 82);
    assert.equal(failed.data.semaCount, 80);
    assert.equal(failed.data.sdnCount, 1);
    assert.equal(failed.data.consolidatedCount, 1);
    const snapshot = failed.data._sourceSnapshots[SEMA_SOURCE];
    assert.deepEqual(normalize(snapshot.records[79]._aliases), ['Alias sema-ca 80']);
    assert.equal(snapshot.fetchedAt, now);
    assert.equal(snapshot.retainedUntil, now + 12 * 3600000);
    assert.equal(failed.data.datasetDate, fresh.data.datasetDate);
    const retried = await publish({ successes: [], stored: await save(failed), clock: now + 11 * 3600000 });
    assert.equal(retried.data._sourceSnapshots[SEMA_SOURCE].retainedUntil, snapshot.retainedUntil);
    assert.equal(retried.data._sourceSnapshots[SEMA_SOURCE].publishedAt, snapshot.publishedAt);
  });

  it('never promotes the legacy preview to a complete Canadian source', async () => {
    const { data } = await publish({ successes: ['SDN'], preview: canadian.slice(0, 60) });
    assert.equal(data.semaCount, 0);
  });

  it('publishes an explicit empty error once every fixed source deadline expires', async () => {
    const stored = await save(await publish());
    const { data, options } = await publish({ successes: [], stored, clock: now + 12 * 3600000 });
    assert.equal(data.totalCount, 0);
    assert.equal(options.zeroIsValid, true);
    assert.equal(options.validateFn(data), true);
    const result = await options.afterPublish(data, {});
    assert.equal(result.freshnessMetaPatch.sourceState, 'error');
    assert.equal(result.freshnessMetaPatch.sourceHealth[SEMA_SOURCE].status, 'unavailable');
    assert.equal(result.freshnessMetaPatch.sourceHealth[SEMA_SOURCE].retainedUntil, null);
  });

  it('strips private snapshots and source health from public data and stops on a snapshot write failure', async () => {
    const { data, options } = await publish({ writeError: true });
    const publicData = options.publishTransform(data);
    assert.ok(!('_sourceSnapshots' in publicData));
    assert.ok(!('_sourceHealth' in publicData));
    await assert.rejects(options.beforePublish(data, {}), /synthetic cache write failure/);
  });

  it('clears source failure metadata on complete recovery', async () => {
    const { data, options } = await publish();
    const result = await options.afterPublish(data, {});
    assert.equal(result.freshnessMetaPatch.sourceState, 'ok');
    assert.equal(result.freshnessMetaPatch.errorCode, null);
    assert.deepEqual(normalize(result.freshnessMetaPatch.failedSources), []);
  });

  it('replaces the recovered source cohort so removed designations do not return', async () => {
    const stored = await save(await publish());
    const recovered = await publish({ stored, clock: now + 3600000, semaRecords: canadian.slice(1) });
    assert.equal(recovered.data.semaCount, 79);
    assert.ok(!recovered.data._entityIndex.some(entry => entry.id === canadian[0].id));
    assert.equal(recovered.data._sourceSnapshots[SEMA_SOURCE].fetchedAt, now + 3600000);
  });

  it('does not replace an unknown last-good cohort when its cache read fails', async () => {
    await assert.rejects(publish({ readError: true }), /synthetic cache read failure/);
  });

  it('rejects malformed, future-dated, extended-deadline, duplicate and cross-source snapshots', async () => {
    const original = (await publish()).data._sourceSnapshots;
    const mutate = [
      snapshot => { snapshot.records[0].id = 'sema-ca:unspecified:unspecified:0'; },
      snapshot => { snapshot.fetchedAt = now + 2 * 3600000; snapshot.retainedUntil = snapshot.fetchedAt + 720 * 60000; },
      snapshot => { snapshot.retainedUntil += 1; },
      snapshot => { snapshot.records.push(snapshot.records[0]); },
      snapshot => { snapshot.records[0].sourceLists = ['SDN']; },
    ];
    for (const change of mutate) {
      const snapshots = normalize(original);
      change(snapshots[SEMA_SOURCE]);
      const stored = { version: 1, encoding: 'gzip-base64', data: gzipSync(JSON.stringify(snapshots)).toString('base64') };
      const { data } = await publish({ successes: ['SDN'], stored, clock: now + 3600000 });
      assert.equal(data.semaCount, 0);
      assert.equal(data._sourceHealth[SEMA_SOURCE].status, 'unavailable');
    }
  });

  it('bounds decoding and rejects invalid compressed snapshots without losing a healthy sibling', async () => {
    for (const stored of [
      { version: 1, encoding: 'gzip-base64', data: 'not a gzip stream' },
      { version: 1, encoding: 'gzip-base64', data: gzipSync(' '.repeat(32 * 1024 * 1024 + 1)).toString('base64') },
    ]) {
      const { data } = await publish({ successes: ['SDN'], stored });
      assert.equal(data.sdnCount, 1);
      assert.equal(data.semaCount, 0);
    }
  });

  it('writes complete selected companions, including empty companions after expiry', async () => {
    const stored = await save(await publish());
    for (const clock of [now + 3600000, now + 720 * 60000]) {
      const { data, options, writes } = await publish({ successes: [], stored, clock });
      const count = clock < now + 720 * 60000 ? 82 : 0;
      assert.equal(options.publishTransform(data).totalCount, count);
      assert.equal(options.validateFn(options.publishTransform(data)), true);
      assert.equal(options.declareRecords(options.publishTransform(data)), count);
      assert.equal(options.extraKeys[0].transform(data).entryIds.length, count);
      await options.afterPublish(data, {});
      assert.equal(writes.find(([key]) => key === 'sanctions:entities:v1')[1].length, count);
      assert.equal(writes.find(([key]) => key === 'sanctions:entities:v1')[3], count);
      assert.deepEqual(writes.find(([key]) => key === 'sanctions:country-counts:v1')[1], {});
    }
  });
});

async function withLocalRedis(run) {
  const original = { fetch: globalThis.fetch, exit: process.exit, log: console.log, warn: console.warn };
  const listeners = new Set(process.rawListeners('SIGTERM'));
  const env = Object.fromEntries(['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'WM_SEED_RETRY_DELAY_MS'].map(key => [key, process.env[key]]));
  const store = new Map();
  const logs = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://sanctions-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  process.env.WM_SEED_RETRY_DELAY_MS = '0';
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
  process.exit = code => { throw Object.assign(new Error('fixture exit'), { exitCode: code }); };
  function command([op, key, value]) {
    if (op === 'SET') { store.set(key, value); return 'OK'; }
    if (op === 'GET') return store.get(key) ?? null;
    if (op === 'DEL') return Number(store.delete(key));
    if (op === 'EXPIRE' || op === 'EVAL') return 1;
    throw new Error(`unexpected fixture command ${op}`);
  }
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(new URL(url).hostname, 'sanctions-redis.test', 'no real network allowed');
    const match = String(url).match(/\/get\/([^/?#]+)$/);
    if (match) return Response.json({ result: store.get(decodeURIComponent(match[1])) ?? null });
    const body = JSON.parse(init.body);
    return Response.json(Array.isArray(body[0]) ? body.map(c => ({ result: command(c) })) : { result: command(body) });
  };
  try { return await run({ store, logs }); }
  finally {
    globalThis.fetch = original.fetch;
    process.exit = original.exit;
    console.log = original.log;
    console.warn = original.warn;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const listener of process.rawListeners('SIGTERM')) if (!listeners.has(listener)) process.removeListener('SIGTERM', listener);
  }
}

it('uses the real strict Redis reader to distinguish missing snapshots from HTTP errors', async () => {
  await withLocalRedis(async () => {
    const firstRun = await publish({ io: { readSeedSnapshot } });
    assert.equal(firstRun.data.totalCount, 82);
    for (const status of [401, 503]) {
      globalThis.fetch = async () => new Response('fixture read failure', { status });
      assert.equal(await verifySeedKey('sanctions:source-snapshots:v1'), null, 'legacy helper degrades HTTP failures');
      await assert.rejects(publish({ io: { readSeedSnapshot } }), new RegExp(`HTTP ${status}`));
    }
    for (const body of [{ error: 'ERR fixture read error' }, {}, { result: '' }]) {
      globalThis.fetch = async () => Response.json(body);
      await assert.rejects(publish({ io: { readSeedSnapshot } }), /Redis snapshot read/);
    }
  });
});

it('publishes all-source expiry through real runSeed with empty companions and persisted error metadata', async () => {
  await withLocalRedis(async ({ store, logs }) => {
    const stored = await save(await publish());
    const { data, options } = await publish({ successes: [], stored, clock: now + 720 * 60000, io: { writeExtraKeyWithMeta } });
    await assert.rejects(runSeed('sanctions', 'pressure', 'sanctions:pressure:v1', async () => data, options), error => error.exitCode === 0);
    const canonical = JSON.parse(store.get('sanctions:pressure:v1'));
    assert.equal(canonical.data.totalCount, 0);
    assert.deepEqual(canonical.data.entries, []);
    assert.equal(canonical._seed.state, 'OK_ZERO', 'envelope state describes successful empty publication, not source health');
    assert.deepEqual(JSON.parse(store.get('sanctions:entities:v1')), []);
    assert.deepEqual(JSON.parse(store.get('sanctions:country-counts:v1')), {});
    const meta = JSON.parse(store.get('seed-meta:sanctions:pressure'));
    assert.equal(meta.sourceState, 'error');
    assert.equal(meta.errorCode, 'SEMA_INGEST_FAILED');
    assert.deepEqual(meta.failedSources, ['SDN', 'CONSOLIDATED', SEMA_SOURCE]);
    assert.equal(meta.recordCount, 0);
    assert.ok(logs.some(line => line.includes('DEGRADED')));
    const key = health.BOOTSTRAP_KEYS.sanctionsPressure;
    const verdict = health.classifyKey('sanctionsPressure', key, { allowOnDemand: false }, {
      now: Date.now(), containmentEvidenceByName: new Map(), keyStrens: new Map([[key, store.get(key).length]]), keyErrors: new Map(),
      keyMetaValues: new Map([[health.SEED_META.sanctionsPressure.key, JSON.stringify(meta)]]), keyMetaErrors: new Map(),
    });
    assert.equal(verdict.status, 'SEED_ERROR');
  });
});

it('fails without claiming completed freshness if a companion write fails after canonical publication', async () => {
  await withLocalRedis(async ({ store, logs }) => {
    const oldMeta = JSON.stringify({ fetchedAt: now, sourceState: 'error', recordCount: 82 });
    store.set('seed-meta:sanctions:pressure', oldMeta);
    const { data, options } = await publish({ successes: [], io: {
      writeExtraKeyWithMeta: async (...args) => {
        if (args[0] === 'sanctions:country-counts:v1') throw new Error('fixture companion write failure');
        return writeExtraKeyWithMeta(...args);
      },
    } });
    await assert.rejects(runSeed('sanctions', 'pressure', 'sanctions:pressure:v1', async () => data, options), /fixture companion write failure/);
    assert.equal(JSON.parse(store.get('sanctions:pressure:v1')).data.totalCount, 0);
    assert.equal(store.get('seed-meta:sanctions:pressure'), oldMeta, 'a partial publication must not claim completed freshness');
    assert.ok(!logs.some(line => line.includes('DEGRADED')));
  });
});
