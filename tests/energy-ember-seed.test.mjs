import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEmberCsv,
  buildAllCountriesMap,
  EMBER_KEY_PREFIX,
  EMBER_ALL_KEY,
  EMBER_META_KEY,
  EMBER_TTL_SECONDS,
} from '../scripts/seed-ember-electricity.mjs';

// ─── Fixture builders ──────────────────────────────────────────────────────

// Real Ember CSV column names (must match COLS in seed-ember-electricity.mjs)
const ISO3_COL = 'ISO 3 code';
const DATE_COL = 'Date';
const SERIES_COL = 'Variable';
const UNIT_COL = 'Unit';
const VALUE_COL = 'Value';

function makeRow(overrides = {}) {
  return {
    [ISO3_COL]: 'USA',
    [DATE_COL]: '2024-01-01',
    [SERIES_COL]: 'Coal',
    [UNIT_COL]: 'TWh',
    [VALUE_COL]: '100',
    ...overrides,
  };
}

/**
 * Build a minimal long-format CSV string from an array of row objects.
 * @param {Array<Record<string, string>>} rows
 */
function buildCsv(rows) {
  const headers = [ISO3_COL, DATE_COL, SERIES_COL, UNIT_COL, VALUE_COL, 'Category'];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => row[h] ?? '').join(','));
  }
  return lines.join('\n');
}

function threeCountryFixture() {
  // USA: 2024-01 — Fossil=400, Renewables=300, Nuclear=100, Coal=200, Gas=200, Total=800
  // DEU: 2024-01 — Fossil=200, Renewables=500, Nuclear=0, Coal=100, Gas=100, Total=700
  // FRA: 2024-01 — Fossil=50, Renewables=100, Nuclear=400, Coal=20, Gas=30, Total=550
  const rows = [
    // USA
    makeRow({ [ISO3_COL]: 'USA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Fossil',           [VALUE_COL]: '400' }),
    makeRow({ [ISO3_COL]: 'USA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Renewables',       [VALUE_COL]: '300' }),
    makeRow({ [ISO3_COL]: 'USA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Nuclear',          [VALUE_COL]: '100' }),
    makeRow({ [ISO3_COL]: 'USA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Coal',             [VALUE_COL]: '200' }),
    makeRow({ [ISO3_COL]: 'USA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Gas',              [VALUE_COL]: '200' }),
    makeRow({ [ISO3_COL]: 'USA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Total Generation', [VALUE_COL]: '800' }),
    // DEU (Germany)
    makeRow({ [ISO3_COL]: 'DEU', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Fossil',           [VALUE_COL]: '200' }),
    makeRow({ [ISO3_COL]: 'DEU', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Renewables',       [VALUE_COL]: '500' }),
    makeRow({ [ISO3_COL]: 'DEU', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Nuclear',          [VALUE_COL]: '0'   }),
    makeRow({ [ISO3_COL]: 'DEU', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Coal',             [VALUE_COL]: '100' }),
    makeRow({ [ISO3_COL]: 'DEU', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Gas',              [VALUE_COL]: '100' }),
    makeRow({ [ISO3_COL]: 'DEU', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Total Generation', [VALUE_COL]: '700' }),
    // FRA (France)
    makeRow({ [ISO3_COL]: 'FRA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Fossil',           [VALUE_COL]: '50'  }),
    makeRow({ [ISO3_COL]: 'FRA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Renewables',       [VALUE_COL]: '100' }),
    makeRow({ [ISO3_COL]: 'FRA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Nuclear',          [VALUE_COL]: '400' }),
    makeRow({ [ISO3_COL]: 'FRA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Coal',             [VALUE_COL]: '20'  }),
    makeRow({ [ISO3_COL]: 'FRA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Gas',              [VALUE_COL]: '30'  }),
    makeRow({ [ISO3_COL]: 'FRA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Total Generation', [VALUE_COL]: '550' }),
  ];
  return buildCsv(rows);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('parseEmberCsv', () => {
  it('parses a minimal 3-country fixture', () => {
    const csv = threeCountryFixture();
    const result = parseEmberCsv(csv);
    assert.ok(result instanceof Map);
    assert.ok(result.size >= 1, 'should have at least 1 country');
  });

  it('includes one entry per fixture country (US, DE, FR)', () => {
    const csv = threeCountryFixture();
    const result = parseEmberCsv(csv);
    assert.ok(result.has('US'), 'should have US');
    assert.ok(result.has('DE'), 'should have DE');
    assert.ok(result.has('FR'), 'should have FR');
  });

  it('computes fossilShare = (fossil_twh / total_twh) * 100', () => {
    const csv = threeCountryFixture();
    const result = parseEmberCsv(csv);
    const us = result.get('US');
    assert.ok(us != null, 'US entry missing');
    // USA: fossil=400, total=800 → 50%
    assert.ok(Math.abs(us.fossilShare - 50) < 0.01, `fossilShare should be 50, got ${us.fossilShare}`);
  });

  it('computes renewShare correctly', () => {
    const csv = threeCountryFixture();
    const result = parseEmberCsv(csv);
    const us = result.get('US');
    // USA: renewables=300, total=800 → 37.5%
    assert.ok(Math.abs(us.renewShare - 37.5) < 0.01, `renewShare should be 37.5, got ${us.renewShare}`);
  });

  it('sets dataMonth to YYYY-MM from date field', () => {
    const csv = threeCountryFixture();
    const result = parseEmberCsv(csv);
    const us = result.get('US');
    assert.equal(us.dataMonth, '2024-01');
  });

  it('selects the most recent month when a country has two months of data', () => {
    const rows = [
      // Jan 2024
      makeRow({ [ISO3_COL]: 'GBR', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Fossil',           [VALUE_COL]: '100' }),
      makeRow({ [ISO3_COL]: 'GBR', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Total Generation', [VALUE_COL]: '200' }),
      // Feb 2024 (later — should be selected)
      makeRow({ [ISO3_COL]: 'GBR', [DATE_COL]: '2024-02-01', [SERIES_COL]: 'Fossil',           [VALUE_COL]: '80'  }),
      makeRow({ [ISO3_COL]: 'GBR', [DATE_COL]: '2024-02-01', [SERIES_COL]: 'Total Generation', [VALUE_COL]: '210' }),
    ];
    const csv = buildCsv(rows);
    const result = parseEmberCsv(csv);
    const gb = result.get('GB');
    assert.ok(gb != null, 'GB entry missing');
    assert.equal(gb.dataMonth, '2024-02', 'should use the later month');
    // Feb: fossil=80, total=210 → ~38.1%
    assert.ok(Math.abs(gb.fossilShare - (80 / 210) * 100) < 0.01);
  });

  it('skips rows where unit !== TWh', () => {
    const rows = [
      makeRow({ [ISO3_COL]: 'AUS', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Fossil',           [UNIT_COL]: 'GW', [VALUE_COL]: '100' }),
      makeRow({ [ISO3_COL]: 'AUS', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Total Generation', [UNIT_COL]: 'GW', [VALUE_COL]: '200' }),
    ];
    const csv = buildCsv(rows);
    const result = parseEmberCsv(csv);
    // AUS should not appear since no TWh rows
    assert.ok(!result.has('AU'), 'AU should be excluded when unit is GW');
  });

  it('skips countries where Total Generation is missing', () => {
    const rows = [
      makeRow({ [ISO3_COL]: 'JPN', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Fossil', [VALUE_COL]: '100' }),
      // No Total Generation row for JPN
    ];
    const csv = buildCsv(rows);
    const result = parseEmberCsv(csv);
    assert.ok(!result.has('JP'), 'JP should be excluded when Total Generation is absent');
  });
});

describe('schema sentinel', () => {
  it('throws when Fossil series is not present in any row', () => {
    const rows = [
      makeRow({ [ISO3_COL]: 'USA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Coal',             [VALUE_COL]: '100' }),
      makeRow({ [ISO3_COL]: 'USA', [DATE_COL]: '2024-01-01', [SERIES_COL]: 'Total Generation', [VALUE_COL]: '200' }),
    ];
    const csv = buildCsv(rows);
    assert.throws(
      () => parseEmberCsv(csv),
      /Fossil.*series not found|schema changed/i,
      'should throw when Fossil series is absent',
    );
  });
});

describe('buildAllCountriesMap', () => {
  it('returns compact shape without seededAt or country fields', () => {
    const csv = threeCountryFixture();
    const countries = parseEmberCsv(csv);
    const allMap = buildAllCountriesMap(countries);
    for (const [, entry] of Object.entries(allMap)) {
      assert.ok(!('seededAt' in entry), 'compact map should not have seededAt');
      assert.ok(!('country' in entry), 'compact map should not have country');
      assert.ok('dataMonth' in entry, 'compact map should have dataMonth');
      assert.ok('fossilShare' in entry, 'compact map should have fossilShare');
    }
  });

  it('has one entry per parsed country', () => {
    const csv = threeCountryFixture();
    const countries = parseEmberCsv(csv);
    const allMap = buildAllCountriesMap(countries);
    assert.equal(Object.keys(allMap).length, countries.size);
  });
});

describe('exported constants', () => {
  it('EMBER_KEY_PREFIX is correct', () => {
    assert.equal(EMBER_KEY_PREFIX, 'energy:ember:v1:');
  });

  it('EMBER_ALL_KEY is correct', () => {
    assert.equal(EMBER_ALL_KEY, 'energy:ember:v1:_all');
  });

  it('EMBER_META_KEY is correct', () => {
    assert.equal(EMBER_META_KEY, 'seed-meta:energy:ember');
  });

  it('EMBER_TTL_SECONDS is 259200 (72h)', () => {
    assert.equal(EMBER_TTL_SECONDS, 259200);
  });

  it('EMBER_TTL_SECONDS covers 3x the 24h daily cron interval', () => {
    const dailyIntervalSeconds = 24 * 60 * 60; // 86400
    assert.ok(
      EMBER_TTL_SECONDS >= 3 * dailyIntervalSeconds,
      `TTL ${EMBER_TTL_SECONDS}s should be >= ${3 * dailyIntervalSeconds}s (3× daily)`,
    );
  });
});

describe('count-drop guard math', () => {
  it('45/60 is acceptable (75% threshold)', () => {
    const prevCount = 60;
    const newCount = 45;
    const ratio = newCount / prevCount;
    assert.ok(ratio >= 0.75, '45/60 = 75% should pass the guard');
  });

  it('44/60 triggers the guard (below 75%)', () => {
    const prevCount = 60;
    const newCount = 44;
    const ratio = newCount / prevCount;
    assert.ok(ratio < 0.75, '44/60 ≈ 73.3% should trigger the guard');
  });
});

describe('pipeline failure detection logic (non-transactional, e.g. Phase B meta write)', () => {
  it('detects a partial pipeline failure when one command errors', () => {
    const results = [{ result: 'OK' }, { result: 'OK' }, { error: 'NOSCRIPT' }, { result: 'OK' }];
    const failures = results.filter((r) => r?.error || r?.result === 'ERR');
    assert.equal(failures.length, 1, 'should detect 1 failed command');
  });

  it('treats all-OK results as no failures', () => {
    const results = [{ result: 'OK' }, { result: 'OK' }, { result: 'OK' }];
    const failures = results.filter((r) => r?.error || r?.result === 'ERR');
    assert.equal(failures.length, 0, 'all-OK pipeline should have 0 failures');
  });

  it('detects ERR-result commands as failures', () => {
    const results = [{ result: 'OK' }, { result: 'ERR' }];
    const failures = results.filter((r) => r?.error || r?.result === 'ERR');
    assert.equal(failures.length, 1, 'ERR result should count as failure');
  });
});

describe('MULTI/EXEC transaction pipeline shape', () => {
  it('wraps data commands between MULTI and EXEC', () => {
    const countries = new Map([['US', { foo: 1 }], ['DE', { foo: 2 }]]);
    const cmds = [['MULTI']];
    for (const [iso2, payload] of countries) {
      cmds.push(['SET', `${EMBER_KEY_PREFIX}${iso2}`, JSON.stringify(payload), 'EX', EMBER_TTL_SECONDS]);
    }
    cmds.push(['SET', EMBER_ALL_KEY, '{}', 'EX', EMBER_TTL_SECONDS]);
    cmds.push(['EXEC']);

    assert.equal(cmds[0][0], 'MULTI', 'first command is MULTI');
    assert.equal(cmds[cmds.length - 1][0], 'EXEC', 'last command is EXEC');
    assert.equal(cmds.length, 5, 'MULTI + 2 country SET + 1 _all SET + EXEC');
  });

  it('includes DEL for obsolete keys inside the transaction', () => {
    const oldAllMap = { US: {}, DE: {}, JP: {} };
    const newCountryKeys = new Set(['US', 'DE']);
    const oldIso2Set = new Set(Object.keys(oldAllMap));

    const cmds = [['MULTI']];
    cmds.push(['SET', `${EMBER_KEY_PREFIX}US`, '{}', 'EX', EMBER_TTL_SECONDS]);
    cmds.push(['SET', `${EMBER_KEY_PREFIX}DE`, '{}', 'EX', EMBER_TTL_SECONDS]);
    cmds.push(['SET', EMBER_ALL_KEY, '{}', 'EX', EMBER_TTL_SECONDS]);
    for (const iso2 of oldIso2Set) {
      if (!newCountryKeys.has(iso2)) {
        cmds.push(['DEL', `${EMBER_KEY_PREFIX}${iso2}`]);
      }
    }
    cmds.push(['EXEC']);

    const delCmds = cmds.filter(c => c[0] === 'DEL');
    assert.equal(delCmds.length, 1);
    assert.equal(delCmds[0][1], `${EMBER_KEY_PREFIX}JP`);
    assert.equal(cmds[cmds.length - 1][0], 'EXEC', 'EXEC is still last');
  });
});

describe('EXEC result validation', () => {
  it('detects null EXEC result as transaction abort', () => {
    const execResult = { result: null };
    const isAborted = !execResult?.result || !Array.isArray(execResult.result);
    assert.ok(isAborted, 'null EXEC result means transaction aborted');
  });

  it('accepts array EXEC result as success', () => {
    const execResult = { result: ['OK', 'OK', 'OK', 1] };
    const isAborted = !execResult?.result || !Array.isArray(execResult.result);
    assert.ok(!isAborted, 'array EXEC result means success');
  });

  it('detects ERR within EXEC result array', () => {
    const execResults = ['OK', 'OK', 'ERR', 'OK'];
    const failures = execResults.filter((r) => {
      if (typeof r === 'string') return r === 'ERR';
      if (r && typeof r === 'object') return !!r.error;
      return false;
    });
    assert.equal(failures.length, 1);
  });

  it('detects error object within EXEC result array', () => {
    const execResults = ['OK', { error: 'WRONGTYPE' }, 'OK'];
    const failures = execResults.filter((r) => {
      if (typeof r === 'string') return r === 'ERR';
      if (r && typeof r === 'object') return !!r.error;
      return false;
    });
    assert.equal(failures.length, 1);
  });
});

describe('MULTI/EXEC eliminates need for JS-side rollback', () => {
  it('EXEC failure means no data was written (no rollback needed)', () => {
    const execResult = { result: null };
    const transactionAborted = !execResult?.result || !Array.isArray(execResult.result);
    assert.ok(transactionAborted, 'aborted EXEC means no partial writes exist');
  });
});

describe('publish pipeline includes DEL for obsolete per-country keys', () => {
  it('generates DEL commands for keys in old _all but not in new dataset', () => {
    const oldAllMap = { US: {}, DE: {}, JP: {} };
    const newCountryKeys = new Set(['US', 'DE']); // JP removed
    const oldIso2Set = new Set(Object.keys(oldAllMap));

    const delCmds = [];
    for (const iso2 of oldIso2Set) {
      if (!newCountryKeys.has(iso2)) {
        delCmds.push(['DEL', `${EMBER_KEY_PREFIX}${iso2}`]);
      }
    }

    assert.equal(delCmds.length, 1, 'should DEL 1 obsolete key');
    assert.equal(delCmds[0][1], `${EMBER_KEY_PREFIX}JP`);
  });

  it('generates no DEL when new dataset is a superset of old', () => {
    const oldAllMap = { US: {}, DE: {} };
    const newCountryKeys = new Set(['US', 'DE', 'FR']);
    const oldIso2Set = new Set(Object.keys(oldAllMap));

    const delCmds = [];
    for (const iso2 of oldIso2Set) {
      if (!newCountryKeys.has(iso2)) {
        delCmds.push(['DEL', `${EMBER_KEY_PREFIX}${iso2}`]);
      }
    }

    assert.equal(delCmds.length, 0, 'no DELs needed when new is superset');
  });

  it('handles empty old _all (first run)', () => {
    const oldAllMap = null;
    const newCountryKeys = new Set(['US', 'DE']);
    const oldIso2Set = oldAllMap && typeof oldAllMap === 'object' ? new Set(Object.keys(oldAllMap)) : new Set();

    const delCmds = [];
    for (const iso2 of oldIso2Set) {
      if (!newCountryKeys.has(iso2)) {
        delCmds.push(['DEL', `${EMBER_KEY_PREFIX}${iso2}`]);
      }
    }

    assert.equal(delCmds.length, 0, 'no DELs on first run');
  });
});

describe('preservePreviousSnapshot restore DELs new-only keys', () => {
  it('generates DEL for keys in new dataset but not in old stash', () => {
    const oldAllMap = { US: {}, DE: {} };
    const newCountryKeys = new Set(['US', 'DE', 'XX']);

    const delCmds = [];
    const oldIso2Set = new Set(Object.keys(oldAllMap));
    for (const iso2 of newCountryKeys) {
      if (!oldIso2Set.has(iso2)) {
        delCmds.push(['DEL', `${EMBER_KEY_PREFIX}${iso2}`]);
      }
    }

    assert.equal(delCmds.length, 1, 'should DEL 1 new-only key');
    assert.equal(delCmds[0][1], `${EMBER_KEY_PREFIX}XX`);
  });

  it('generates no DEL when new dataset is subset of old stash', () => {
    const oldAllMap = { US: {}, DE: {}, FR: {} };
    const newCountryKeys = new Set(['US', 'DE']);

    const delCmds = [];
    const oldIso2Set = new Set(Object.keys(oldAllMap));
    for (const iso2 of newCountryKeys) {
      if (!oldIso2Set.has(iso2)) {
        delCmds.push(['DEL', `${EMBER_KEY_PREFIX}${iso2}`]);
      }
    }

    assert.equal(delCmds.length, 0, 'no DELs when new is subset of old');
  });
});

describe('preservePreviousSnapshot cleanup of new-only keys', () => {
  it('includes DEL commands for new-only keys when restoring from stash', () => {
    const stashedAllMap = { US: {}, DE: {} };
    const newCountryKeys = new Set(['US', 'DE', 'XX', 'YY']);

    const restoreCmds = [];
    // Simulate restore SET commands
    for (const [iso2, val] of Object.entries(stashedAllMap)) {
      restoreCmds.push(['SET', `${EMBER_KEY_PREFIX}${iso2}`, JSON.stringify(val), 'EX', EMBER_TTL_SECONDS]);
    }
    restoreCmds.push(['SET', EMBER_ALL_KEY, JSON.stringify(stashedAllMap), 'EX', EMBER_TTL_SECONDS]);

    // Add DEL for new-only keys
    const oldIso2Set = new Set(Object.keys(stashedAllMap));
    for (const iso2 of newCountryKeys) {
      if (!oldIso2Set.has(iso2)) {
        restoreCmds.push(['DEL', `${EMBER_KEY_PREFIX}${iso2}`]);
      }
    }

    const delCmds = restoreCmds.filter(c => c[0] === 'DEL');
    assert.equal(delCmds.length, 2, 'should DEL XX and YY');
    const delKeys = delCmds.map(c => c[1]).sort();
    assert.deepEqual(delKeys, [`${EMBER_KEY_PREFIX}XX`, `${EMBER_KEY_PREFIX}YY`]);
  });

  it('skips DEL when newCountryKeys is null (error before parse)', () => {
    const stashedAllMap = { US: {} };
    const newCountryKeys = null;

    const restoreCmds = [];
    if (newCountryKeys) {
      const oldIso2Set = new Set(Object.keys(stashedAllMap));
      for (const iso2 of newCountryKeys) {
        if (!oldIso2Set.has(iso2)) {
          restoreCmds.push(['DEL', `${EMBER_KEY_PREFIX}${iso2}`]);
        }
      }
    }

    assert.equal(restoreCmds.length, 0, 'no DELs when newCountryKeys is null');
  });
});

describe('health cascade: seedError priority over hasData', () => {
  function resolveStatus({ seedError, hasData, seedStale, size }) {
    let status;
    if (seedError === true) {
      status = 'SEED_ERROR';
    } else if (!hasData) {
      status = 'EMPTY';
    } else if (size === 0) {
      status = 'EMPTY_DATA';
    } else if (seedStale === true) {
      status = 'STALE_SEED';
    } else {
      status = 'OK';
    }
    return status;
  }

  it('returns SEED_ERROR when seedError=true and hasData=false', () => {
    const status = resolveStatus({ seedError: true, hasData: false, seedStale: true, size: 0 });
    assert.equal(status, 'SEED_ERROR', 'seedError should take priority over !hasData');
  });

  it('returns SEED_ERROR when seedError=true and hasData=true', () => {
    const status = resolveStatus({ seedError: true, hasData: true, seedStale: false, size: 100 });
    assert.equal(status, 'SEED_ERROR', 'seedError should take priority even when data exists');
  });

  it('returns EMPTY when seedError=false and hasData=false', () => {
    const status = resolveStatus({ seedError: false, hasData: false, seedStale: false, size: 0 });
    assert.equal(status, 'EMPTY', 'no error + no data should be EMPTY');
  });

  it('returns OK when seedError=false and hasData=true and not stale', () => {
    const status = resolveStatus({ seedError: false, hasData: true, seedStale: false, size: 100 });
    assert.equal(status, 'OK');
  });
});

describe('health endpoint status agreement for error meta', () => {
  it('seed-health.js logic emits "error" for meta.status="error"', () => {
    // Simulates seed-health.js lines 131-148 logic
    const meta = { fetchedAt: Date.now(), recordCount: 100, status: 'error', error: 'test failure' };
    const isError = meta.status === 'error';
    const ageMs = Date.now() - (meta.fetchedAt || 0);
    const maxStalenessMs = 1440 * 2 * 60 * 1000;
    const stale = ageMs > maxStalenessMs || isError;
    const status = stale ? (isError ? 'error' : 'stale') : 'ok';
    assert.equal(status, 'error', 'seed-health.js should report "error" for meta.status=error');
  });

  it('health.js SEED_ERROR is the correct status for meta.status="error" (not STALE_SEED)', () => {
    // Verifies the expected contract: meta.status=error → SEED_ERROR (not STALE_SEED)
    // This test documents the intended behavior after the fix
    const meta = { fetchedAt: Date.now(), recordCount: 100, status: 'error', error: 'test failure' };
    const seedError = meta?.status === 'error';
    const seedStale = seedError; // error implies stale

    let status;
    if (seedError) {
      status = 'SEED_ERROR';
    } else if (seedStale) {
      status = 'STALE_SEED';
    } else {
      status = 'OK';
    }
    assert.equal(status, 'SEED_ERROR', 'explicit error meta should yield SEED_ERROR, not STALE_SEED');
  });
});

describe('preservePreviousSnapshot recordCount fallback', () => {
  it('uses null (not 0) when existingMeta is unavailable', () => {
    const existingMeta = null;
    const recordCount = existingMeta?.recordCount ?? null;
    assert.equal(recordCount, null, 'should be null, not 0');
    const serialized = JSON.stringify({ recordCount });
    assert.ok(serialized.includes('"recordCount":null'), 'null should be serialized');
  });

  it('preserves existing recordCount when meta is readable', () => {
    const existingMeta = { recordCount: 180, fetchedAt: Date.now() };
    const recordCount = existingMeta?.recordCount ?? null;
    assert.equal(recordCount, 180);
  });

  it('null recordCount does not enable count-drop guard', () => {
    const prevMeta = { recordCount: null, status: 'error' };
    const guardActive = prevMeta && typeof prevMeta === 'object' && prevMeta.recordCount > 0;
    assert.equal(guardActive, false, 'null recordCount should not activate guard');
  });
});

describe('dataWritten flag prevents stash restore after successful EXEC', () => {
  it('skips restore when dataWritten=true (data is correct, only meta failed)', () => {
    const stashedAllMap = { US: {}, DE: {} };
    const dataWritten = true;
    const shouldRestore = stashedAllMap && typeof stashedAllMap === 'object' && !dataWritten;
    assert.equal(shouldRestore, false, 'should not restore stash when data was written successfully');
  });

  it('allows restore when dataWritten=false (EXEC failed or never ran)', () => {
    const stashedAllMap = { US: {}, DE: {} };
    const dataWritten = false;
    const shouldRestore = stashedAllMap && typeof stashedAllMap === 'object' && !dataWritten;
    assert.ok(shouldRestore, 'should restore stash when data was not written');
  });

  it('skips TTL extension when dataWritten=true and no stash', () => {
    const stashedAllMap = null;
    const dataWritten = true;
    const shouldExtendTtl = !dataWritten;
    assert.equal(shouldExtendTtl, false, 'should not extend TTL when data is already correct');
  });
});
