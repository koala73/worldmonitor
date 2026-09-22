import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { computeScenario, physicalImpact, EXPOSURE_BATCH_SIZE } from '../scripts/scenario-worker.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let cache;
let batches;
const manifest = (countryIds = ['DE', 'JP'], hs2Codes = ['27', '29']) => ({
  manifestVersion: 1, status: 'ok', countryIds, hs2Codes, fetchedAt: 1789000000000,
});
const record = (iso2, hs2, score = 40, coverage = 'flow_weighted') => ({
  iso2, hs2, coverage, fetchedAt: '2026-09-09T00:00:00Z', vulnerabilityIndex: score,
  exposures: [{ chokepointId: 'hormuz_strait', exposureScore: score }],
});
const key = (iso2, hs2) => `supply-chain:exposure:${iso2}:${hs2}:v1`;

beforeEach(() => {
  cache = new Map([['seed-meta:supply_chain:chokepoint-exposure', manifest()]]);
  batches = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://fixture.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/pipeline')) {
      const commands = JSON.parse(init.body);
      batches.push(commands);
      return Response.json(commands.map(([, k]) => ({ result: cache.has(k) ? JSON.stringify(cache.get(k)) : null })));
    }
    const k = decodeURIComponent(String(url).split('/get/')[1]);
    return Response.json({ result: cache.has(k) ? JSON.stringify(cache.get(k)) : null });
  };
});
afterEach(() => { mock.restoreAll(); globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });

describe('scenario worker manifest and evidence', () => {
  it('caps retried reads to the remaining budget and preserves partial results on expiry', async () => {
    let now = 0;
    mock.method(Date, 'now', () => now);
    const timeout = AbortSignal.timeout;
    const timeouts = [];
    mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return timeout(ms); });
    const fetchFixture = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      if (!String(url).endsWith('/pipeline')) return fetchFixture(url, init);
      calls++;
      if (calls === 1) {
        now = 30_000;
        throw new Error('first request timed out');
      }
      now = 45_000;
      throw new Error('remaining budget timed out');
    };
    const result = await computeScenario('hormuz-tanker-blockade', null);
    assert.equal(calls, 2, 'must not make a third request after the deadline');
    assert.deepEqual(timeouts, [10_000, 30_000, 15_000]);
    assert.equal(result.coverage.status, 'partial');
    assert.ok(result.coverage.records.every(r => r.state === 'missing'));
  });

  it('scales raw score 40 to 20 at half severity and 40 at full severity with multiplier 1', () => {
    assert.equal(physicalImpact(40, 50, 1), 20);
    assert.equal(physicalImpact(40, 100, 1), 40);
  });
  it('includes Germany and Japan, preserves zero, fallback, missing and malformed records', async () => {
    cache.set(key('DE', '27'), record('DE', '27', 40));
    cache.set(key('DE', '29'), record('DE', '29', 0, 'country_route_fallback'));
    cache.set(key('JP', '27'), { ...record('JP', '27'), exposures: [] });
    const result = await computeScenario('hormuz-tanker-blockade', null, 50);
    assert.deepEqual(result.coverage.countryIds, ['DE', 'JP']);
    assert.deepEqual(result.coverage.records.map(r => r.state), ['evaluated', 'evaluated', 'malformed', 'missing']);
    assert.deepEqual(result.coverage.records.map(r => r.rawImpact), [42, 0, undefined, undefined]);
    assert.equal(result.coverage.records[1].basis, 'country_route_fallback');
    assert.equal(result.coverage.status, 'partial');
    assert.equal(result.topImpactCountries[0].iso2, 'DE');
    assert.equal(result.topImpactCountries[0].totalImpact, 42);
    cache.set(key('JP', '27'), record('JP', '27', 20));
    cache.set(key('JP', '29'), record('JP', '29', 0));
    const full = await computeScenario('hormuz-tanker-blockade', null, 100);
    assert.equal(full.coverage.status, 'complete');
    assert.deepEqual(full.topImpactCountries.map(c => [c.iso2, c.totalImpact]), [['DE', 84], ['JP', 42]]);
    assert.equal(full.topImpactCountries[0].impactPct, result.topImpactCountries[0].impactPct);
  });

  it('uses template defaults and accepts explicit zero severity', async () => {
    cache.set(key('DE', '27'), record('DE', '27'));
    cache.set(key('DE', '29'), record('DE', '29', 0));
    const defaults = await computeScenario('hormuz-tanker-blockade', 'DE');
    const zero = await computeScenario('hormuz-tanker-blockade', 'DE', 0);
    assert.equal(defaults.template.disruptionPct, 100);
    assert.equal(defaults.topImpactCountries[0].totalImpact, 84);
    assert.equal(zero.template.disruptionPct, 0);
    assert.equal(zero.topImpactCountries[0].totalImpact, 0);
    assert.equal(zero.coverage.status, 'complete');
    assert.equal(zero.scopedIso2, 'DE');
  });

  it('distinguishes raw invalid JSON from missing records and evaluated zero', async () => {
    const fetchFixture = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (!String(url).endsWith('/pipeline')) return fetchFixture(url, init);
      batches.push(JSON.parse(init.body));
      return Response.json([
        { result: '{invalid JSON' },
        { result: null },
        { result: JSON.stringify(record('JP', '27', 0)) },
        { result: JSON.stringify(record('JP', '29', 0)) },
      ]);
    };
    const result = await computeScenario('hormuz-tanker-blockade', null);
    assert.deepEqual(result.coverage.records.map(r => [r.iso2, r.hs2, r.state, r.rawImpact]), [
      ['DE', '27', 'malformed', undefined],
      ['DE', '29', 'missing', undefined],
      ['JP', '27', 'evaluated', 0],
      ['JP', '29', 'evaluated', 0],
    ]);
    assert.equal(result.coverage.status, 'partial');
    assert.deepEqual(result.topImpactCountries.map(c => [c.iso2, c.totalImpact, c.impactPct]), [['JP', 0, 0]]);
  });

  it('reports unknown coverage after manifest GET rejection without pipeline reads', async () => {
    const fetchFixture = globalThis.fetch;
    const reads = [];
    globalThis.fetch = async (url, init) => {
      reads.push(String(url));
      if (String(url).includes('/get/')) throw new Error('manifest transport unavailable');
      return fetchFixture(url, init);
    };
    const result = await computeScenario('hormuz-tanker-blockade', null);
    assert.equal(reads.length, 1);
    assert.match(decodeURIComponent(reads[0]), /\/get\/seed-meta:supply_chain:chokepoint-exposure$/);
    assert.equal(result.coverage.status, 'unknown');
    assert.deepEqual(result.coverage.records, []);
    assert.deepEqual(result.topImpactCountries, []);
    assert.equal(batches.length, 0);
  });

  it('reports unknown coverage for absent, old or invalid manifest without guessing keys', async () => {
    for (const value of [null, {}, { ...manifest(), manifestVersion: 2 }, { ...manifest(), countryIds: ['DE', 'DE'] }, { ...manifest(), hs2Codes: ['../../key'] }, { ...manifest(), countryIds: [] }, { ...manifest(), hs2Codes: [] }]) {
      cache.set('seed-meta:supply_chain:chokepoint-exposure', value);
      const result = await computeScenario('hormuz-tanker-blockade', null);
      assert.equal(result.coverage.status, 'unknown');
      assert.deepEqual(result.topImpactCountries, []);
    }
    assert.equal(batches.length, 0);
  });

  // A failed seed run invalidates per-key FRESHNESS, which the per-record 'missing' state
  // already reports. It does not invalidate the country/sector UNIVERSE, which comes from
  // static config. Gating on status:'ok' turned any single seeder failure into a total
  // feature blackout while the exposure keys it describes stayed TTL-extended and valid.
  it('still evaluates a manifest whose last seed run failed', async () => {
    cache.set('seed-meta:supply_chain:chokepoint-exposure', { ...manifest(['DE'], ['27']), status: 'error', recordCount: 0 });
    cache.set(key('DE', '27'), record('DE', '27', 40));
    const result = await computeScenario('hormuz-tanker-blockade', 'DE', 100);
    assert.notEqual(result.coverage.status, 'unknown');
    assert.equal(result.coverage.records[0].state, 'evaluated');
    assert.equal(result.topImpactCountries[0].totalImpact, 84);
  });

  // The producer's literal outputs, so a shape change in the seeder reds this file.
  it('accepts the exact metadata shapes the seeder writes on both paths', async () => {
    const universe = { manifestVersion: 1, countryIds: ['DE'], hs2Codes: ['27', '29'] };
    for (const status of ['ok', 'error']) {
      cache.set('seed-meta:supply_chain:chokepoint-exposure', { fetchedAt: 1789000000000, recordCount: status === 'ok' ? 4290 : 0, status, ...universe });
      cache.set(key('DE', '27'), record('DE', '27', 40));
      cache.set(key('DE', '29'), record('DE', '29', 10));
      const result = await computeScenario('hormuz-tanker-blockade', 'DE', 100);
      assert.equal(result.coverage.status, 'complete', `status=${status}`);
      assert.equal(result.topImpactCountries[0].totalImpact, 105, `status=${status}`);
    }
  });

  // Positive control for the all-affected-chokepoints requirement. Without this, deleting
  // the `affected.length !== template.affectedChokepointIds.length` branch keeps the suite
  // green, because every other fixture uses a single-chokepoint or tariff template.
  it('flags a record missing one of a multi-chokepoint template as incomplete_routes', async () => {
    cache.set('seed-meta:supply_chain:chokepoint-exposure', manifest(['DE'], ['27']));
    cache.set(key('DE', '27'), {
      iso2: 'DE', hs2: '27', coverage: 'flow_weighted', fetchedAt: '2026-09-09T00:00:00Z',
      vulnerabilityIndex: 10,
      // suez-bab-simultaneous disrupts suez AND bab_el_mandeb; only suez is present.
      exposures: [{ chokepointId: 'suez', exposureScore: 40 }],
    });
    const result = await computeScenario('suez-bab-simultaneous', 'DE', 100);
    assert.equal(result.coverage.records[0].state, 'incomplete_routes');
    assert.equal(result.coverage.records[0].rawImpact, undefined);
    assert.deepEqual(result.topImpactCountries, []);
    // Distinct from 'malformed': the cache entry itself is well-formed.
    assert.notEqual(result.coverage.records[0].state, 'malformed');

    cache.set(key('DE', '27'), {
      iso2: 'DE', hs2: '27', coverage: 'flow_weighted', fetchedAt: '2026-09-09T00:00:00Z',
      vulnerabilityIndex: 10,
      exposures: [{ chokepointId: 'suez', exposureScore: 40 }, { chokepointId: 'bab_el_mandeb', exposureScore: 20 }],
    });
    const complete = await computeScenario('suez-bab-simultaneous', 'DE', 100);
    assert.equal(complete.coverage.records[0].state, 'evaluated');
  });

  it('marks a country aggregated from partial evidence as a lower bound', async () => {
    cache.set('seed-meta:supply_chain:chokepoint-exposure', manifest(['DE'], ['27', '29']));
    cache.set(key('DE', '27'), record('DE', '27', 0));  // genuine evaluated zero
    // DE/29 absent -> 'missing'. The country total is therefore built from 1 of 2 records.
    const result = await computeScenario('hormuz-tanker-blockade', 'DE', 100);
    const de = result.topImpactCountries[0];
    assert.equal(de.totalImpact, 0);
    assert.equal(de.evaluatedRecords, 1);
    assert.equal(de.requestedRecords, 2);
    assert.equal(de.partialEvidence, true, 'a zero built from partial evidence must not read as a genuine zero');

    cache.set(key('DE', '29'), record('DE', '29', 0));
    const full = await computeScenario('hormuz-tanker-blockade', 'DE', 100);
    assert.equal(full.topImpactCountries[0].partialEvidence, false);
    assert.equal(full.topImpactCountries[0].evaluatedRecords, 2);
  });

  it('distinguishes a country or sector outside the manifest from a missing seeded key', async () => {
    cache.set('seed-meta:supply_chain:chokepoint-exposure', manifest(['DE'], ['27']));
    const result = await computeScenario('hormuz-tanker-blockade', 'DE');
    assert.deepEqual(result.coverage.records.map(r => r.state), ['missing', 'not_seeded']);
    const outside = await computeScenario('hormuz-tanker-blockade', 'JP');
    assert.deepEqual(outside.coverage.records.map(r => r.state), ['not_seeded', 'not_seeded']);
  });

  it('keeps tariff vulnerability math and rejects physical overrides on tariffs', async () => {
    cache.set('seed-meta:supply_chain:chokepoint-exposure', manifest(['DE'], ['85']));
    cache.set(key('DE', '85'), record('DE', '85', 40));
    const result = await computeScenario('us-tariff-escalation-electronics', 'DE');
    assert.equal(result.topImpactCountries[0].totalImpact, 60);
    assert.equal(result.template.disruptionPct, 0);
    await assert.rejects(computeScenario('us-tariff-escalation-electronics', 'DE', 0), /Invalid disruption/);
    for (const severity of [-1, 101, 0.5, NaN, Infinity, null, '50']) {
      await assert.rejects(computeScenario('hormuz-tanker-blockade', 'DE', severity), /Invalid disruption/);
    }
  });

  it('bounds reads to EXPOSURE_BATCH_SIZE keys per batch', async () => {
    // Derived from the constant, not a hardcoded literal: raising the batch size to cut
    // round-trips must not require editing a magic number in two places.
    const total = EXPOSURE_BATCH_SIZE + 32;
    const sectors = Array.from({ length: 8 }, (_, i) => String(i + 1).padStart(2, '0'));
    const countries = Array.from({ length: Math.ceil(total / sectors.length) }, (_, i) =>
      `${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);
    cache.set('seed-meta:supply_chain:chokepoint-exposure', manifest(countries, sectors));
    const result = await computeScenario('panama-drought-50pct', null);
    const expected = countries.length * sectors.length;
    assert.equal(result.coverage.records.length, expected);
    assert.equal(batches.length, Math.ceil(expected / EXPOSURE_BATCH_SIZE));
    assert.ok(batches.every(b => b.length <= EXPOSURE_BATCH_SIZE), 'no batch may exceed the constant');
    assert.equal(batches.reduce((n, b) => n + b.length, 0), expected);
  });

  it('fails on Redis transport errors instead of declaring missing evidence', async () => {
    globalThis.fetch = async url => String(url).endsWith('/pipeline')
      ? new Response('unavailable', { status: 503 }) : Response.json({ result: JSON.stringify(manifest()) });
    await assert.rejects(computeScenario('hormuz-tanker-blockade', null), /HTTP 503/);
  });

  // The 503 case above throws at the earlier !resp.ok check, so neither arm of the
  // pipeline-integrity guard was reachable from the suite before these two.
  it('rejects a pipeline response with fewer entries than keys requested', async () => {
    const fetchFixture = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (!String(url).endsWith('/pipeline')) return fetchFixture(url, init);
      const commands = JSON.parse(init.body);
      return Response.json(commands.slice(1).map(() => ({ result: null })));
    };
    await assert.rejects(computeScenario('hormuz-tanker-blockade', null), /Incomplete Redis exposure pipeline/);
  });

  it('rejects a pipeline response carrying a per-entry error', async () => {
    const fetchFixture = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (!String(url).endsWith('/pipeline')) return fetchFixture(url, init);
      const commands = JSON.parse(init.body);
      return Response.json(commands.map((_, i) =>
        i === 0 ? { error: 'ERR unknown command' } : { result: null }));
    };
    await assert.rejects(computeScenario('hormuz-tanker-blockade', null), /Incomplete Redis exposure pipeline/);
  });

  it('retries a transient pipeline failure rather than failing the whole job', async () => {
    const fetchFixture = globalThis.fetch;
    let pipelineCalls = 0;
    cache.set('seed-meta:supply_chain:chokepoint-exposure', manifest(['DE'], ['27']));
    cache.set(key('DE', '27'), record('DE', '27', 40));
    globalThis.fetch = async (url, init) => {
      if (!String(url).endsWith('/pipeline')) return fetchFixture(url, init);
      pipelineCalls++;
      if (pipelineCalls === 1) return new Response('flap', { status: 503 });
      return fetchFixture(url, init);
    };
    const result = await computeScenario('hormuz-tanker-blockade', 'DE', 100);
    assert.ok(pipelineCalls > 1, 'expected a retry after the transient failure');
    assert.equal(result.coverage.records[0].state, 'evaluated');
    assert.equal(result.topImpactCountries[0].totalImpact, 84);
  });
});
