import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFillEntry,
  computeTrend,
  buildCountriesPayload,
  GAS_STORAGE_KEY_PREFIX,
  GAS_STORAGE_COUNTRIES_KEY,
  GAS_STORAGE_TTL_SECONDS,
  GAS_STORAGE_ALL_KEY,
  main,
} from '../scripts/seed-gas-storage-countries.mjs';

it('publishes the country observations and coverage index in the same atomic seed transaction', async (t) => {
  const previousEnv = { ...process.env };
  process.env.UPSTASH_REDIS_REST_URL = 'https://gas-publish.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.GIE_API_KEY = 'fixture';
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  });
  let published;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(String(input));
    if (url.origin === 'https://agsi.gie.eu') {
      return Response.json({ data: [{ full: '57.92', gasInStorage: '143.4', gasDayStart: '2026-09-29' }] });
    }
    assert.equal(url.origin, 'https://gas-publish.test');
    const commands = JSON.parse(options.body);
    if (url.pathname === '/multi-exec') {
      published = commands;
      return Response.json(commands.map((_, index) => ({ result: index === 0 ? 'OK' : 1 })));
    }
    return Response.json({ result: commands[0] === 'SET' ? 'OK' : 1 });
  });
  await main();
  assert.equal(published[0][0], 'MSET');
  const values = Object.fromEntries(Array.from({ length: (published[0].length - 1) / 2 }, (_, i) =>
    [published[0][1 + i * 2], JSON.parse(published[0][2 + i * 2])],
  ));
  const observations = values[GAS_STORAGE_ALL_KEY];
  assert.ok(observations, 'the producer must publish the observations MCP reads');
  assert.deepEqual(Object.keys(observations), values[GAS_STORAGE_COUNTRIES_KEY]);
  assert.equal(observations.DE.gasTwh, 143.4);
  assert.equal(observations.DE.date, '2026-09-29');
  assert.deepEqual(observations.DE, values[`${GAS_STORAGE_KEY_PREFIX}DE`]);
  for (const key of Object.keys(values)) {
    assert.ok(published.some(command => command[0] === 'EXPIRE' && command[1] === key && command[2] === GAS_STORAGE_TTL_SECONDS));
  }
});

// GIE AGSI+ live shape (2026-10-01) for a country with no underground storage.
const NO_STORAGE = ['CY', 'EE', 'FI', 'GR', 'IE', 'LT', 'LU', 'MT', 'SI', 'GB'];
const noStorageRow = (code) => ({
  name: code, code, url: code, gasDayStart: '2026-09-30', inventory: '-', sendOut: '-', dtmi: '-', dtrs: '-', info: [], status: 'N',
});

async function runAgainstGie(t, rowFor) {
  const previousEnv = { ...process.env };
  process.env.UPSTASH_REDIS_REST_URL = 'https://gas-publish.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.GIE_API_KEY = 'fixture';
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  });
  const run = { published: null };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(String(input));
    if (url.origin === 'https://agsi.gie.eu') return Response.json({ data: [rowFor(url.searchParams.get('country'))] });
    if (url.pathname.startsWith('/get/')) return Response.json({ result: null });
    const commands = JSON.parse(options.body);
    if (url.pathname === '/multi-exec') {
      run.published = commands;
      return Response.json(commands.map(command => ({ result: command[0] === 'MSET' ? 'OK' : 1 })));
    }
    return Response.json(Array.isArray(commands[0]) ? commands.map(() => ({ result: 1 })) : { result: 'OK' });
  });
  return run;
}

it('publishes the countries with storage and retires the placeholders for countries GIE reports as having none', async (t) => {
  const run = await runAgainstGie(t, code => NO_STORAGE.includes(code)
    ? noStorageRow(code)
    : { full: '57.92', gasInStorage: '143.4', gasDayStart: '2026-09-30', status: 'C' });
  await main();
  const mset = run.published[0];
  const values = Object.fromEntries(Array.from({ length: (mset.length - 1) / 2 }, (_, i) => [mset[1 + i * 2], JSON.parse(mset[2 + i * 2])]));
  assert.equal(values[GAS_STORAGE_COUNTRIES_KEY].length, 18);
  for (const code of NO_STORAGE) {
    assert.equal(values[`${GAS_STORAGE_KEY_PREFIX}${code}`], undefined, `${code} must not be published as 0% full`);
    assert.ok(run.published.some(command => command[0] === 'DEL' && command[1] === `${GAS_STORAGE_KEY_PREFIX}${code}`),
      `${code}'s stale placeholder is removed in the same transaction`);
  }
  assert.deepEqual(values['seed-meta:energy:gas-storage-countries'].noStorageCountries, NO_STORAGE);
});

it('a no-storage report never stands in for a country whose storage reading is missing', async (t) => {
  const missingReading = ['AT', 'BE', 'BG', 'HR', 'CZ'];
  await runAgainstGie(t, code => NO_STORAGE.includes(code) ? noStorageRow(code)
    : missingReading.includes(code) ? { gasDayStart: '2026-09-30', full: '-', gasInStorage: '-', status: 'C' }
    : { full: '57.92', gasInStorage: '143.4', gasDayStart: '2026-09-30', status: 'C' });
  await assert.rejects(main(), /only 13 valid countries \(10 without storage\), need >=24/);
});

it('preserves the previous coverage and observations when the transaction fails', async (t) => {
  const previousEnv = { ...process.env };
  process.env.UPSTASH_REDIS_REST_URL = 'https://gas-publish.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.GIE_API_KEY = 'fixture';
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  });
  const metaKey = 'seed-meta:energy:gas-storage-countries';
  const previous = { DE: { fillPct: 42, gasTwh: 100, date: '2026-09-28' } };
  const cache = new Map([
    [GAS_STORAGE_ALL_KEY, previous], [GAS_STORAGE_COUNTRIES_KEY, ['DE']],
    [metaKey, { fetchedAt: 123, recordCount: 1, noStorageCountries: ['EE'] }],
  ]);
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(String(input));
    if (url.origin === 'https://agsi.gie.eu') {
      return Response.json({ data: [{ full: '57.92', gasInStorage: '143.4', gasDayStart: '2026-09-29' }] });
    }
    if (url.pathname.startsWith('/get/')) {
      const value = cache.get(decodeURIComponent(url.pathname.slice(5)));
      return Response.json({ result: value ? JSON.stringify(value) : null });
    }
    const commands = JSON.parse(options.body);
    if (url.pathname === '/multi-exec') return Response.json({ error: 'transaction rejected' }, { status: 503 });
    if (url.pathname === '/pipeline') {
      for (const command of commands) if (command[0] === 'SET') cache.set(command[1], JSON.parse(command[2]));
      return Response.json(commands.map(command => ({ result: command[0] === 'SET' ? 'OK' : 1 })));
    }
    return Response.json({ result: commands[0] === 'SET' ? 'OK' : 1 });
  });
  await assert.rejects(main(), /HTTP 503/);
  assert.deepEqual(cache.get(GAS_STORAGE_COUNTRIES_KEY), ['DE']);
  assert.deepEqual(cache.get(GAS_STORAGE_ALL_KEY), previous);
  assert.equal(cache.get(metaKey).fetchedAt, 123);
  assert.equal(cache.get(metaKey).status, 'error');
  assert.deepEqual(cache.get(metaKey).noStorageCountries, ['EE'], 'a failed run keeps the preserved snapshot\'s accounting');
});

// ---------------------------------------------------------------------------
// parseFillEntry — envelope variant handling
// ---------------------------------------------------------------------------

describe('parseFillEntry', () => {
  it('extracts fillPct from "full" field', () => {
    const entry = { full: '65.4', gasInStorage: '720.1', gasDayStart: '2026-04-04' };
    const result = parseFillEntry(entry);
    assert.ok(Math.abs(result.fill - 65.4) < 0.001, `Expected fill≈65.4, got ${result.fill}`);
    assert.ok(Math.abs(result.gwh - 720.1) < 0.001, `Expected gwh≈720.1, got ${result.gwh}`);
    assert.equal(result.date, '2026-04-04');
  });

  it('falls back to "fillLevel" when "full" is absent', () => {
    const entry = { fillLevel: '42.5', gasDayStart: '2026-04-03' };
    const result = parseFillEntry(entry);
    assert.ok(Math.abs(result.fill - 42.5) < 0.001);
  });

  it('falls back to "pct" when "full" and "fillLevel" are absent', () => {
    const entry = { pct: '80.0', gasDayStart: '2026-04-02' };
    const result = parseFillEntry(entry);
    assert.ok(Math.abs(result.fill - 80.0) < 0.001);
  });

  it('extracts gasTwh from "gasTwh" field', () => {
    const entry = { full: '50', gasTwh: '600.5', gasDayStart: '2026-04-04' };
    const result = parseFillEntry(entry);
    assert.ok(Math.abs(result.gwh - 600.5) < 0.001);
  });

  it('falls back to "volume" for gwh', () => {
    const entry = { full: '50', volume: '500.0', gasDayStart: '2026-04-04' };
    const result = parseFillEntry(entry);
    assert.ok(Math.abs(result.gwh - 500.0) < 0.001);
  });

  it('uses "date" fallback when "gasDayStart" is absent', () => {
    const entry = { full: '30', date: '2026-03-15' };
    const result = parseFillEntry(entry);
    assert.equal(result.date, '2026-03-15');
  });

  it('falls through to fillLevel when full is empty string', () => {
    const entry = { full: '', fillLevel: '55.0', gasDayStart: '2026-04-04' };
    const result = parseFillEntry(entry);
    assert.ok(Math.abs(result.fill - 55.0) < 0.001, `Expected fill≈55.0, got ${result.fill}`);
  });

  it('falls through to gasTwh when gasInStorage is empty string', () => {
    const entry = { full: '50', gasInStorage: '', gasTwh: '400.0', gasDayStart: '2026-04-04' };
    const result = parseFillEntry(entry);
    assert.ok(Math.abs(result.gwh - 400.0) < 0.001, `Expected gwh≈400.0, got ${result.gwh}`);
  });

  it('handles envelope with root-level gasDayStart (single-entry envelope)', () => {
    // Simulates the `latestData?.gasDayStart` branch
    const entry = { gasDayStart: '2026-04-04', full: '71.2', gasInStorage: '800' };
    const result = parseFillEntry(entry);
    assert.ok(Math.abs(result.fill - 71.2) < 0.001);
    assert.equal(result.date, '2026-04-04');
  });
});

// ---------------------------------------------------------------------------
// computeTrend
// ---------------------------------------------------------------------------

describe('computeTrend', () => {
  it('returns "injecting" when change > 0.05', () => {
    assert.equal(computeTrend(0.06), 'injecting');
    assert.equal(computeTrend(1.5), 'injecting');
  });

  it('returns "withdrawing" when change < -0.05', () => {
    assert.equal(computeTrend(-0.06), 'withdrawing');
    assert.equal(computeTrend(-2.0), 'withdrawing');
  });

  it('returns "stable" for changes in [-0.05, 0.05]', () => {
    assert.equal(computeTrend(0), 'stable');
    assert.equal(computeTrend(0.05), 'stable');
    assert.equal(computeTrend(-0.05), 'stable');
    assert.equal(computeTrend(0.04), 'stable');
    assert.equal(computeTrend(-0.04), 'stable');
  });
});

// ---------------------------------------------------------------------------
// buildCountriesPayload — filtering and shape
// ---------------------------------------------------------------------------

describe('buildCountriesPayload', () => {
  function makeRaw(iso2, full, prevFull = null) {
    const entries = [
      { gasDayStart: '2026-04-04', full: String(full), gasInStorage: '500', name: iso2 + '-country' },
    ];
    if (prevFull !== null) {
      entries.push({ gasDayStart: '2026-04-03', full: String(prevFull), gasInStorage: '490' });
    }
    return { iso2, entries };
  }

  it('rejects missing, blank, invalid, or negative stored measurements', () => {
    for (const field of ['full', 'gasInStorage']) {
      for (const value of [undefined, null, '', '   ', 'N/A', '-1']) {
        const entry = { full: '50', gasInStorage: '500', gasDayStart: '2026-04-04', [field]: value };
        assert.deepEqual(buildCountriesPayload([{ iso2: 'DE', entries: [entry] }]), [], `${field}=${value}`);
      }
    }
  });

  it('preserves measured numeric zero instead of choosing a fallback', () => {
    const entry = { full: 0, fillLevel: '50', gasInStorage: 0, gasTwh: '500', gasDayStart: '2026-04-04' };
    const [result] = buildCountriesPayload([{ iso2: 'DE', entries: [entry] }]);
    assert.equal(result.fillPct, 0);
    assert.equal(result.gasTwh, 0);
  });

  it('returns a payload entry for a valid country', () => {
    const result = buildCountriesPayload([makeRaw('DE', 65.4)]);
    assert.equal(result.length, 1);
    const [entry] = result;
    assert.equal(entry.iso2, 'DE');
    assert.ok(Math.abs(entry.fillPct - 65.4) < 0.01);
    assert.equal(typeof entry.seededAt, 'string');
    assert.ok(['injecting', 'withdrawing', 'stable'].includes(entry.trend));
  });

  it('skips entries where fillPct is NaN', () => {
    const raw = { iso2: 'XX', entries: [{ gasDayStart: '2026-04-04', full: 'not-a-number' }] };
    const result = buildCountriesPayload([raw]);
    assert.equal(result.length, 0);
  });

  it('skips entries where fillPct > 100', () => {
    const raw = { iso2: 'YY', entries: [{ gasDayStart: '2026-04-04', full: '105' }] };
    const result = buildCountriesPayload([raw]);
    assert.equal(result.length, 0);
  });

  it('skips entries where fillPct < 0', () => {
    const raw = { iso2: 'ZZ', entries: [{ gasDayStart: '2026-04-04', full: '-5' }] };
    const result = buildCountriesPayload([raw]);
    assert.equal(result.length, 0);
  });

  it('computes fillPctChange1d correctly from two entries', () => {
    const result = buildCountriesPayload([makeRaw('DE', 65.4, 66.2)]);
    assert.equal(result.length, 1);
    const change = result[0].fillPctChange1d;
    assert.ok(Math.abs(change - (-0.8)) < 0.01, `Expected ≈-0.8, got ${change}`);
    assert.equal(result[0].trend, 'withdrawing');
  });

  it('processes multiple countries and skips only invalid ones', () => {
    const input = [
      makeRaw('DE', 65.4),
      makeRaw('FR', 72.0),
      { iso2: 'BAD', entries: [{ gasDayStart: '2026-04-04', full: 'N/A' }] },
      makeRaw('IT', 55.1),
    ];
    const result = buildCountriesPayload(input);
    assert.equal(result.length, 3);
    const iso2s = result.map((r) => r.iso2);
    assert.ok(iso2s.includes('DE'));
    assert.ok(iso2s.includes('FR'));
    assert.ok(iso2s.includes('IT'));
    assert.ok(!iso2s.includes('BAD'));
  });

  it('sorts entries by date descending to pick most recent', () => {
    const raw = {
      iso2: 'NL',
      entries: [
        { gasDayStart: '2026-04-03', full: '60', gasInStorage: '400' },
        { gasDayStart: '2026-04-04', full: '62', gasInStorage: '410' },
        { gasDayStart: '2026-04-02', full: '58', gasInStorage: '390' },
      ],
    };
    const result = buildCountriesPayload([raw]);
    assert.equal(result.length, 1);
    assert.ok(Math.abs(result[0].fillPct - 62) < 0.01, `Expected fillPct≈62, got ${result[0].fillPct}`);
    assert.equal(result[0].date, '2026-04-04');
  });
});

// ---------------------------------------------------------------------------
// Validation gate — throws when fewer than 24 valid countries
// ---------------------------------------------------------------------------

describe('validation gate', () => {
  it('throws when fewer than 24 countries have valid fillPct', () => {
    // buildCountriesPayload returns < 24 entries → main() would throw
    const invalidEntries = Array.from({ length: 10 }, (_, i) => ({
      iso2: `C${i}`,
      entries: [{ gasDayStart: '2026-04-04', full: String(50 + i), gasInStorage: '500' }],
    }));
    const result = buildCountriesPayload(invalidEntries);
    assert.equal(result.length, 10);
    // Simulate the gate check
    const MIN_VALID_COUNTRIES = 24;
    assert.throws(
      () => {
        if (result.length < MIN_VALID_COUNTRIES) {
          throw new Error(
            `gas-storage-countries: only ${result.length} valid countries, need >=${MIN_VALID_COUNTRIES}`,
          );
        }
      },
      /gas-storage-countries: only 10 valid countries/,
    );
  });

  it('does not throw when 24 or more countries are valid', () => {
    const validEntries = Array.from({ length: 24 }, (_, i) => ({
      iso2: `C${i}`,
      entries: [{ gasDayStart: '2026-04-04', full: String(50 + i), gasInStorage: '500' }],
    }));
    const result = buildCountriesPayload(validEntries);
    assert.equal(result.length, 24);
    const MIN_VALID_COUNTRIES = 24;
    assert.doesNotThrow(() => {
      if (result.length < MIN_VALID_COUNTRIES) {
        throw new Error('gate failed');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Exported key constants
// ---------------------------------------------------------------------------

describe('exported key constants', () => {
  it('GAS_STORAGE_KEY_PREFIX matches expected pattern', () => {
    assert.equal(GAS_STORAGE_KEY_PREFIX, 'energy:gas-storage:v1:');
  });

  it('GAS_STORAGE_COUNTRIES_KEY matches expected pattern', () => {
    assert.equal(GAS_STORAGE_COUNTRIES_KEY, 'energy:gas-storage:v1:_countries');
  });

  it('GAS_STORAGE_TTL_SECONDS covers 3-day minimum', () => {
    assert.ok(
      GAS_STORAGE_TTL_SECONDS >= 3 * 24 * 3600,
      `TTL ${GAS_STORAGE_TTL_SECONDS}s is less than 3 days`,
    );
  });
});
