import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runScenario } from '../server/worldmonitor/scenario/v1/run-scenario.ts';
import { getCountryProducts } from '../server/worldmonitor/supply-chain/v1/get-country-products.ts';
import { getCountryChokepointIndex } from '../server/worldmonitor/supply-chain/v1/get-country-chokepoint-index.ts';
import { getCountryCostShock } from '../server/worldmonitor/supply-chain/v1/get-country-cost-shock.ts';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis.ts';
import { validationFailure } from './helpers/validation-failure.mts';

// Codes that pass `^[A-Z]{2}$` (after the handlers' uppercasing) but name no
// country. Each handler below did real work for them: a queued scenario job,
// a sentinel write, a 24h cache fill.
const UNASSIGNED = ['ZZ', 'zz', 'XX', 'AA', 'QQ', 'UK', 'EU', 'UN'];
const PRO_KEY = 'wm_membership_fixture';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

/** Every Redis command and upstream request a handler sends, in order. */
let sent: string[];

beforeEach(() => {
  delete process.env.LOCAL_API_MODE;
  delete process.env.VERCEL_ENV;
  process.env.WORLDMONITOR_VALID_KEYS = PRO_KEY;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  __resetKeyPrefixCacheForTests();
  sent = [];
  // A permissive backend, so a handler that skips the guard runs to
  // completion and the test reports the work it did instead of a stub error.
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.host !== 'redis.example') {
      sent.push(`upstream ${url.host}${url.pathname}`);
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const commands: unknown[][] = Array.isArray(body?.[0]) ? body : body ? [body] : [url.pathname.slice(1).split('/').map(decodeURIComponent)];
    for (const command of commands) sent.push(`redis ${command.slice(0, 2).join(' ')}`);
    const reply = (command: unknown[]) => {
      const name = String(command[0]).toUpperCase();
      if (name === 'SET') return { result: 'OK' };
      if (name === 'RPUSH' || name === 'LLEN') return { result: 0 };
      return { result: null };
    };
    return Response.json(Array.isArray(body?.[0]) ? commands.map(reply) : reply(commands[0]!));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  __resetKeyPrefixCacheForTests();
});

const ctxFor = (path: string, { pro = true, method = 'GET' } = {}) => {
  const headers: Record<string, string> = pro ? { 'X-WorldMonitor-Key': PRO_KEY } : {};
  return { request: new Request(`https://api.worldmonitor.app${path}`, { method, headers }), pathParams: {}, headers };
};

describe('run-scenario', () => {
  const run = (iso2: string) => runScenario(
    ctxFor('/api/scenario/v1/run-scenario', { method: 'POST' }),
    { scenarioId: 'suez-bab-simultaneous', iso2 },
  );

  it('rejects unassigned codes on iso2 before the queue-depth read or the enqueue', async () => {
    for (const code of UNASSIGNED) {
      await assert.rejects(run(code), validationFailure('iso2', /ISO 3166-1 alpha-2/), code);
    }
    assert.deepEqual(sent, []);
  });

  it('still enqueues for an assigned code and for an empty iso2 (all countries)', async () => {
    for (const iso2 of ['BV', '']) {
      sent = [];
      const response = await run(iso2);
      assert.equal(response.status, 'pending', iso2);
      assert.ok(sent.includes('redis RPUSH scenario-queue:pending'), iso2);
    }
  });
});

describe('get-country-products', () => {
  const read = (iso2: string) => getCountryProducts(
    ctxFor('/api/supply-chain/v1/get-country-products'),
    { iso2, hs4: '' },
  );

  it('rejects unassigned codes on iso2 before the cache read or the unsupported_reporter sentinel write', async () => {
    for (const code of UNASSIGNED) {
      await assert.rejects(read(code), validationFailure('iso2', /assigned ISO 3166-1 alpha-2/), code);
    }
    assert.deepEqual(sent, []);
  });
});

describe('get-country-chokepoint-index', () => {
  const read = (iso2: string, pro = true) => getCountryChokepointIndex(
    ctxFor('/api/supply-chain/v1/get-country-chokepoint-index', { pro }),
    { iso2, hs2: '' },
  );

  it('rejects unassigned and malformed codes on iso2 before the cache read, sentinel or 24h fill', async () => {
    for (const code of [...UNASSIGNED, 'USA', '']) {
      await assert.rejects(read(code), validationFailure('iso2', /assigned ISO 3166-1 alpha-2/), code);
    }
    assert.deepEqual(sent, []);
  });

  it('rejects an unassigned code for a free caller too, rather than an empty index', async () => {
    await assert.rejects(read('ZZ', false), validationFailure('iso2'));
  });

  it('keeps the empty index for a free caller with an assigned code', async () => {
    const response = await read('iq', false);
    assert.deepEqual(response.exposures, []);
    assert.equal(response.iso2, 'iq');
    assert.deepEqual(sent.filter(entry => entry.startsWith('redis SET')), []);
  });
});

describe('get-country-cost-shock', () => {
  const read = (iso2: string, { chokepointId = 'suez', pro = true } = {}) => getCountryCostShock(
    ctxFor('/api/supply-chain/v1/get-country-cost-shock', { pro }),
    { iso2, chokepointId, hs2: '' },
  );

  it('rejects unassigned and malformed codes on iso2 before the status read or the cost-shock cache fill', async () => {
    for (const code of [...UNASSIGNED, 'USA', '']) {
      await assert.rejects(read(code), validationFailure('iso2', /assigned ISO 3166-1 alpha-2/), code);
    }
    assert.deepEqual(sent, []);
  });

  it('rejects an unassigned code for a free caller too', async () => {
    await assert.rejects(read('ZZ', { pro: false }), validationFailure('iso2'));
  });

  it('keeps the empty response for a missing chokepoint and a malformed hs2', async () => {
    const noChokepoint = await read('IQ', { chokepointId: '' });
    assert.equal(noChokepoint.iso2, 'IQ');
    assert.equal(noChokepoint.supplyDeficitPct, 0);
    const badHs2 = await getCountryCostShock(
      ctxFor('/api/supply-chain/v1/get-country-cost-shock'),
      { iso2: 'IQ', chokepointId: 'suez', hs2: 'xx' },
    );
    assert.equal(badHs2.hasEnergyModel, false);
    assert.deepEqual(sent, []);
  });
});
