import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mergeSanctionEntries, SEMA_SOURCE, SANCTIONS_SOURCE_VERSION, sanctionsListContentMeta } from '../scripts/_sema-sanctions.mjs';
import { projectCountrySanctions } from '../shared/country-sanctions-signals.mjs';
import { __testing__ as health } from '../api/health.js';
import { readSeedSnapshot, verifySeedKey, runSeed, writeExtraKeyWithMeta } from '../scripts/_seed-utils.mjs';
import { buildEnvelope } from '../scripts/_seed-envelope-source.mjs';

const source = readFileSync('scripts/seed-sanctions-pressure.mjs', 'utf8');
const pure = source.replace(/^import\s.*$/gm, '').replace(/loadEnvFile\([^)]+\);/, '').split('async function fetchSource')[0];
const tail = source.slice(source.indexOf('async function fetchSanctionsPressure()')).replace(/^export /gm, '');
const normalize = value => JSON.parse(JSON.stringify(value));
const now = Date.UTC(2026, 8, 25);
// OFAC's lists change slowly; a Railway container that loses egress for two 6h
// runs must not drop ~20k OFAC entities (2026-09-27: 12h retention published 0 SDN).
const RETAIN_MS = 48 * 3600000;
const row = (source, i) => ({
  id: source === SEMA_SOURCE ? `sema-ca:iran:1-part-2:${i}` : `${source}:${i}`,
  name: `${source} Person ${i}`, sourceLists: [source], countryCodes: [], countryNames: [],
  programs: ['TEST'], entityType: 'SANCTIONS_ENTITY_TYPE_INDIVIDUAL', effectiveAt: '0',
  isNew: false, _aliases: [`Alias ${source} ${i}`], _identifiers: [],
});
const canadian = Array.from({ length: 80 }, (_, i) => row(SEMA_SOURCE, i + 1));

async function publish({ successes = ['SDN', 'CONSOLIDATED', SEMA_SOURCE], stored = null, preview = [], previousState = null, clock = now, writeError = false, readError = false, semaRecords = canadian, semaQuarantined = [], io = {} } = {}) {
  const writes = [];
  let options;
  const context = vm.createContext({
    console: { log() {}, warn() {} }, Buffer, gzipSync, gunzipSync,
    Date: class extends Date { static now() { return clock; } },
    SEMA_SOURCE, mergeSanctionEntries, sanctionsListContentMeta, projectCountrySanctions,
    SANCTIONS_SOURCE_VERSION, SANCTIONS_MAX_CONTENT_AGE_MIN: 43200,
    readSeedSnapshot: async () => {
      if (readError) throw new Error('synthetic cache read failure');
      return stored;
    },
    verifySeedKey: async key => key === 'sanctions:pressure:v1' ? { entries: preview } : previousState,
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
  it('captures the actual preceding state clock and keeps expired or legacy baselines unknown', async () => {
    for (const previousState of [null, { entryIds: ['SDN:1'] },
      { entryIds: ['SDN:1'], observedAt: String(now - 7 * 3600000) }]) {
      const { data, options } = await publish({ previousState });
      const canonical = options.publishTransform(data);
      assert.equal(data._state.observedAt, String(now));
      assert.equal(canonical._state.comparison.to, String(now));
      assert.equal(canonical._state.comparison.from, previousState?.observedAt ?? null);
      assert.equal(canonical._state.comparison.kind, !previousState
        ? 'baseline-unavailable' : previousState.observedAt ? 'id-set-difference' : 'window-unavailable');
      assert.ok(Buffer.byteLength(JSON.stringify(canonical._state)) <= 4096);
    }
  });

  it('preserves quarantine counts on retained cohorts without exposing private lists', async () => {
    const semaQuarantined = [{ id: 'private-id', reason: 'INVALID_IMO' }];
    const fresh = await publish({ semaQuarantined });
    const stored = await save(fresh);
    const retained = await publish({ successes: [], stored, clock: now + RETAIN_MS - 1 });
    const meta = retained.options.publishTransform(retained.data)._state;
    assert.equal(meta.sourceHealth[SEMA_SOURCE].quarantinedCount, 1);
    assert.equal(meta.sourceHealth[SEMA_SOURCE].lastSuccessAt, now);
    assert.equal(meta.sourceHealth[SEMA_SOURCE].lastAttemptAt, now + RETAIN_MS - 1);
    assert.equal(meta.sourceHealth[SEMA_SOURCE].retainedUntil, now + RETAIN_MS);
    assert.equal(JSON.stringify(meta).includes('private-id'), false);
    const expired = await publish({ successes: [], stored, clock: now + RETAIN_MS });
    const expiry = expired.options.publishTransform(expired.data)._state;
    assert.equal(expiry.cohort.computationAt, String(now + RETAIN_MS));
    assert.equal(expiry.sourceHealth[SEMA_SOURCE].status, 'unavailable');
    assert.equal(expiry.sourceHealth[SEMA_SOURCE].quarantinedCount, null);
    assert.equal(expiry.sourceHealth[SEMA_SOURCE].lastSuccessAt, null);
    assert.equal(expiry.sourceHealth[SEMA_SOURCE].retainedUntil, null);
  });

  it('does not invent quarantine zero for retained snapshots written before the compact schema', async () => {
    const snapshots = normalize((await publish()).data._sourceSnapshots);
    for (const snapshot of Object.values(snapshots)) delete snapshot.quarantinedCount;
    const stored = { version: 1, encoding: 'gzip-base64', data: gzipSync(JSON.stringify(snapshots)).toString('base64') };
    const retained = await publish({ successes: [], stored, clock: now + 6 * 3600000 });
    const canonical = retained.options.publishTransform(retained.data);
    for (const source of ['SDN', 'CONSOLIDATED', SEMA_SOURCE]) {
      assert.equal(canonical._state.sourceHealth[source].quarantinedCount, null);
      assert.equal(canonical._state.sourceHealth[source].lastSuccessAt, now);
    }
  });

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
    assert.equal(snapshot.retainedUntil, now + RETAIN_MS);
    assert.equal(failed.data.datasetDate, fresh.data.datasetDate);
    const retried = await publish({ successes: [], stored: await save(failed), clock: now + 12 * 3600000 });
    assert.equal(retried.data.totalCount, 82, 'two missed 6h runs keep every retained source');
    assert.equal(retried.data._sourceSnapshots[SEMA_SOURCE].retainedUntil, snapshot.retainedUntil);
    assert.equal(retried.data._sourceSnapshots[SEMA_SOURCE].publishedAt, snapshot.publishedAt);
  });

  it('never promotes the legacy preview to a complete Canadian source', async () => {
    const { data } = await publish({ successes: ['SDN'], preview: canadian.slice(0, 60) });
    assert.equal(data.semaCount, 0);
  });

  it('publishes an explicit empty error once every fixed source deadline expires', async () => {
    const stored = await save(await publish());
    const { data, options } = await publish({ successes: [], stored, clock: now + RETAIN_MS });
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
      snapshot => { snapshot.fetchedAt = now + 2 * 3600000; snapshot.retainedUntil = snapshot.fetchedAt + RETAIN_MS; },
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

  // A snapshot written by the 12h build must survive the deploy that introduces
  // 48h, or the first failed run after deploy drops a still-live cohort.
  it('accepts a 12h-era snapshot and moves its deadline to 48h from its original fetch', async () => {
    const legacy = normalize((await publish()).data._sourceSnapshots);
    for (const snapshot of Object.values(legacy)) snapshot.retainedUntil = snapshot.fetchedAt + 12 * 3600000;
    const stored = { version: 1, encoding: 'gzip-base64', data: gzipSync(JSON.stringify(legacy)).toString('base64') };
    for (const clock of [now + 6 * 3600000, now + 30 * 3600000]) {
      const { data } = await publish({ successes: [], stored, clock });
      assert.equal(data.totalCount, 82, `retained at +${(clock - now) / 3600000}h`);
      for (const snapshot of Object.values(data._sourceSnapshots)) {
        assert.equal(snapshot.fetchedAt, now);
        assert.equal(snapshot.retainedUntil, now + RETAIN_MS);
      }
    }
    const expired = await publish({ successes: [], stored, clock: now + RETAIN_MS });
    assert.equal(expired.data.totalCount, 0);
  });

  it('preserves the private snapshot key at its own TTL when a whole run fails', async () => {
    const { options } = await publish();
    const ttls = Object.fromEntries(options.preserveKeyTtls.map(({ key, ttlSeconds }) => [key, ttlSeconds]));
    for (const key of ['sanctions:source-snapshots:v1', 'seed-meta:sanctions:source-snapshots']) {
      assert.ok(ttls[key] * 1000 > RETAIN_MS, `${key} must outlive the retention deadline`);
      assert.ok(!options.preserveKeys.includes(key), `${key} must not also sit in the canonical-TTL cohort`);
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
    for (const clock of [now + 3600000, now + RETAIN_MS]) {
      const { data, options, writes } = await publish({ successes: [], stored, clock });
      const count = clock < now + RETAIN_MS ? 82 : 0;
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
    const { data, options } = await publish({ successes: [], stored, clock: now + RETAIN_MS, io: { writeExtraKeyWithMeta } });
    await assert.rejects(runSeed('sanctions', 'pressure', 'sanctions:pressure:v1', async () => data, options), error => error.exitCode === 0);
    const canonical = JSON.parse(store.get('sanctions:pressure:v1'));
    assert.equal(canonical.data.totalCount, 0);
    assert.equal(canonical.data._state.cohort.computationAt, String(now + RETAIN_MS));
    assert.equal(canonical.data._state.sourceHealth.SDN.status, 'unavailable');
    assert.equal(canonical.data._state.sourceHealth.SDN.lastSuccessAt, null);
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
    assert.equal(JSON.parse(store.get('sanctions:pressure:v1')).data._state.cohort.computationAt, String(now));
    assert.equal(store.get('seed-meta:sanctions:pressure'), oldMeta, 'a partial publication must not claim completed freshness');
    assert.ok(!logs.some(line => line.includes('DEGRADED')));
  });
});

it('keeps the preceding canonical cohort and private baseline when the publication guard rejects a contradiction', async () => {
  await withLocalRedis(async ({ store }) => {
    const { data, options } = await publish({ io: { writeExtraKeyWithMeta } });
    const priorCanonical = JSON.stringify(buildEnvelope({ fetchedAt: now - 1, recordCount: 1,
      sourceVersion: SANCTIONS_SOURCE_VERSION, schemaVersion: 1, state: 'OK', data: { marker: 'prior canonical' } }));
    const priorState = JSON.stringify({ entryIds: ['SDN:1'], observedAt: String(now - 1) });
    store.set('sanctions:pressure:v1', priorCanonical);
    store.set('sanctions:pressure:state:v1', priorState);
    data.datasetDate = String(now);
    data.pressureMetadata.cohort.datasetDate = String(now);
    await assert.rejects(runSeed('sanctions', 'pressure', 'sanctions:pressure:v1', async () => data, options),
      /Invalid canonical sanctions publication: Contradictory source cohort/);
    assert.equal(store.get('sanctions:pressure:v1'), priorCanonical);
    assert.equal(store.get('sanctions:pressure:state:v1'), priorState);
    assert.equal(store.has('sanctions:source-snapshots:v1'), false);
    assert.equal(store.has('seed-meta:sanctions:pressure'), false);
  });
});

it('preserves the published comparison cohort on a before-publish failure and does not advance the saved state', async () => {
  await withLocalRedis(async ({ store }) => {
    const priorAt = now - 7 * 3600000;
    const first = await publish({ previousState: { entryIds: ['SDN:1'], observedAt: String(priorAt) },
      io: { writeExtraKeyWithMeta } });
    await assert.rejects(runSeed('sanctions', 'pressure', 'sanctions:pressure:v1', async () => first.data, first.options),
      error => error.exitCode === 0);
    const previousCanonical = store.get('sanctions:pressure:v1');
    const previousState = store.get('sanctions:pressure:state:v1');
    const failed = await publish({ clock: now + 6 * 3600000, io: {
      verifySeedKey,
      writeExtraKeyWithMeta: async () => { throw new Error('fixture publication failure'); },
    } });
    assert.equal(failed.data.pressureMetadata.comparison.from, String(now));
    await assert.rejects(runSeed('sanctions', 'pressure', 'sanctions:pressure:v1', async () => failed.data, failed.options),
      /fixture publication failure/);
    assert.equal(store.get('sanctions:pressure:v1'), previousCanonical);
    assert.equal(store.get('sanctions:pressure:state:v1'), previousState);
    const canonical = JSON.parse(previousCanonical).data;
    assert.equal(canonical._state.comparison.from, String(priorAt));
    assert.equal(canonical._state.cohort.computationAt, String(now));
  });
});

it('captures a missing expired state through the real Redis reader rather than reconstructing a 24-hour baseline', async () => {
  await withLocalRedis(async ({ store }) => {
    const first = await publish({ io: { writeExtraKeyWithMeta } });
    await assert.rejects(runSeed('sanctions', 'pressure', 'sanctions:pressure:v1', async () => first.data, first.options),
      error => error.exitCode === 0);
    store.delete('sanctions:pressure:state:v1');
    const next = await publish({ clock: now + 19 * 3600000, io: { verifySeedKey, writeExtraKeyWithMeta } });
    assert.equal(next.data.pressureMetadata.comparison.kind, 'baseline-unavailable');
    assert.equal(next.data.pressureMetadata.comparison.from, null);
    await assert.rejects(runSeed('sanctions', 'pressure', 'sanctions:pressure:v1', async () => next.data, next.options),
      error => error.exitCode === 0);
    const canonical = JSON.parse(store.get('sanctions:pressure:v1')).data;
    assert.equal(canonical._state.comparison.from, null);
    assert.equal(canonical._state.comparison.to, String(now + 19 * 3600000));
    assert.equal(canonical._state.cohort.computationAt, JSON.parse(store.get('sanctions:pressure:state:v1')).data.observedAt);
    assert.equal(projectCountrySanctions(canonical, 'IR', Number(canonical.fetchedAt)).sanctionsNewDesignations, null);
  });
});

it('keeps malformed and mixed-invalid IDs unknown through the real saved-state reader and canonical publisher', async () => {
  await withLocalRedis(async ({ store }) => {
    for (const entryIds of [[null], [{}], [3], ['not-a-sanctions-id'], ['SDN:1', null],
      ['SDN:1', 'sema-ca:iran:1-part-2:0']]) {
      const previousState = { observedAt: String(now - 7 * 3600000), entryIds };
      store.set('sanctions:pressure:state:v1', JSON.stringify(buildEnvelope({
        fetchedAt: now - 7 * 3600000, recordCount: entryIds.length,
        sourceVersion: SANCTIONS_SOURCE_VERSION, schemaVersion: 1, state: 'OK', data: previousState,
      })));
      assert.deepEqual(await verifySeedKey('sanctions:pressure:state:v1'), previousState);
      const semaRecords = canadian.map(record => ({ ...record, countryCodes: ['IR'], countryNames: ['Iran'] }));
      const next = await publish({ semaRecords, io: { verifySeedKey, writeExtraKeyWithMeta } });
      await assert.rejects(runSeed('sanctions', 'pressure', 'sanctions:pressure:v1', async () => next.data, next.options),
        error => error.exitCode === 0);
      const canonical = JSON.parse(store.get('sanctions:pressure:v1')).data;
      const result = projectCountrySanctions(canonical, 'IR', Number(canonical.fetchedAt));
      assert.equal(result.state, 'observed');
      assert.equal(result.sanctionsDesignations, 80);
      assert.equal(result.sanctionsNewDesignations, null, JSON.stringify(entryIds));
      assert.equal(result.websiteCounts.sanctionsNewDesignations, null);
      assert.equal(result.comparison.kind, 'baseline-unavailable');
      assert.equal(result.comparison.from, null);
      assert.equal(result.countryRow.newEntryCount, canonical.countries.find(row => row.countryCode === 'IR').newEntryCount);
    }
  });
});

it('keeps old canonical metadata and state when the canonical SET fails after source snapshots are saved', async () => {
  await withLocalRedis(async ({ store }) => {
    const first = await publish({ io: { writeExtraKeyWithMeta } });
    await assert.rejects(runSeed('sanctions', 'pressure', 'sanctions:pressure:v1', async () => first.data, first.options),
      error => error.exitCode === 0);
    const oldCanonical = store.get('sanctions:pressure:v1');
    const oldState = store.get('sanctions:pressure:state:v1');
    const next = await publish({ clock: now + 6 * 3600000, io: { verifySeedKey, writeExtraKeyWithMeta } });
    const fixtureFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const command = init.body ? JSON.parse(init.body) : null;
      if (command?.[0] === 'SET' && command[1] === 'sanctions:pressure:v1') {
        return new Response('fixture canonical write failure', { status: 400 });
      }
      return fixtureFetch(url, init);
    };
    await assert.rejects(runSeed('sanctions', 'pressure', 'sanctions:pressure:v1', async () => next.data, next.options),
      /HTTP 400/);
    assert.equal(store.get('sanctions:pressure:v1'), oldCanonical);
    assert.equal(store.get('sanctions:pressure:state:v1'), oldState);
    assert.equal(JSON.parse(oldCanonical).data._state.cohort.computationAt, String(now));
  });
});

it('publishes retained success clocks through the last millisecond and unavailable evidence at exact expiry', async () => {
  await withLocalRedis(async ({ store }) => {
    const first = await publish({ semaQuarantined: [{ id: 'private-id', reason: 'INVALID_IMO' }],
      io: { writeExtraKeyWithMeta } });
    await assert.rejects(runSeed('sanctions', 'pressure', 'sanctions:pressure:v1', async () => first.data, first.options),
      error => error.exitCode === 0);
    for (const clock of [now + RETAIN_MS - 1, now + RETAIN_MS]) {
      const next = await publish({ successes: [], clock,
        io: { verifySeedKey, readSeedSnapshot, writeExtraKeyWithMeta } });
      await assert.rejects(runSeed('sanctions', 'pressure', 'sanctions:pressure:v1', async () => next.data, next.options),
        error => error.exitCode === 0);
      const canonical = JSON.parse(store.get('sanctions:pressure:v1')).data;
      const meta = canonical._state;
      assert.equal(meta.cohort.computationAt, String(clock));
      assert.equal(meta.comparison.from, String(clock < now + RETAIN_MS ? now : clock - 1));
      const retained = clock < now + RETAIN_MS;
      assert.equal(meta.sourceHealth[SEMA_SOURCE].status, retained ? 'retained' : 'unavailable');
      assert.equal(meta.sourceHealth[SEMA_SOURCE].lastSuccessAt, retained ? now : null);
      assert.equal(meta.sourceHealth[SEMA_SOURCE].retainedUntil, retained ? now + RETAIN_MS : null);
      assert.equal(meta.sourceHealth[SEMA_SOURCE].quarantinedCount, retained ? 1 : null);
      assert.equal(meta.sourceHealth[SEMA_SOURCE].publishedAt, retained ? now - 2 * 86400000 : null);
      assert.equal(projectCountrySanctions(canonical, 'IR', Number(canonical.fetchedAt)).state, retained ? 'observed' : 'unavailable');
      assert.equal(projectCountrySanctions(canonical, 'IR', Number(canonical.fetchedAt)).partial, true);
      assert.equal(JSON.stringify(meta).includes('private-id'), false);
    }
  });
});
