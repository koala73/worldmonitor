/**
 * Regression tests for Tech Readiness Index "No data available" bug.
 *
 * Root cause: a single shared `wbBreaker` was used for all 4 World Bank
 * indicator RPC calls (IT.NET.USER.ZS, IT.CEL.SETS.P2, IT.NET.BBND.P2,
 * GB.XPD.RSDV.GD.ZS). This caused:
 *   1. Cache poisoning  — last parallel call's result overwrote cache;
 *      subsequent refreshes returned wrong indicator data for all 4 calls.
 *   2. Cascading failures — 2 failures in any one indicator tripped the
 *      breaker and silenced all 4, returning emptyWbFallback ({ data: [] }).
 *   3. Persistent empty data — server returning { data: [] } during a
 *      transient WB API hiccup caused recordSuccess({ data: [] }), which
 *      persisted to IndexedDB as "breaker:World Bank". On next page load
 *      hydratePersistentCache restored { data: [] }, and all 4 calls
 *      returned empty → allCountries was empty → scores = [] → panel showed
 *      "No data available".
 *
 * Fix: replace single wbBreaker with getWbBreaker(indicatorCode) map,
 * identical to the existing getFredBreaker(seriesId) pattern.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as ts from 'typescript'; // TypeScript compiler API — available via the typescript devDep used by tsc

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const economicPath = resolve(root, 'src/services/economic/index.ts');
const techReadinessPanelPath = resolve(root, 'src/components/TechReadinessPanel.ts');

function loadEconomicSourceFile() {
  return ts.createSourceFile(
    economicPath,
    readFileSync(economicPath, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function loadTechReadinessPanelSource() {
  return readFileSync(techReadinessPanelPath, 'utf-8');
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function findVariableDeclaration(sourceFile, name) {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) {
        return decl;
      }
    }
  }
  return undefined;
}

function findFunctionDeclaration(sourceFile, name) {
  return sourceFile.statements.find(
    (stmt) => ts.isFunctionDeclaration(stmt) && stmt.name?.text === name,
  );
}

function collectCallExpressions(node) {
  const calls = [];
  walk(node, (current) => {
    if (ts.isCallExpression(current)) calls.push(current);
  });
  return calls;
}

function isIdentifierNamed(node, name) {
  return ts.isIdentifier(node) && node.text === name;
}

function isStringLiteralValue(node, value) {
  return (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === value;
}

function getTechIndicatorKeys(sourceFile) {
  const decl = findVariableDeclaration(sourceFile, 'TECH_INDICATORS');
  assert.ok(decl?.initializer && ts.isObjectLiteralExpression(decl.initializer), 'TECH_INDICATORS object must exist');

  const keys = new Set();
  for (const prop of decl.initializer.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (ts.isStringLiteral(prop.name) || ts.isIdentifier(prop.name)) {
      keys.add(prop.name.text);
    }
  }
  return keys;
}

// ============================================================
// 1. Behavioral: the pool hands out one breaker per indicator
// ============================================================

// The structural assertions this section replaced pinned the shape of
// getWbBreaker (a Map exists, a factory exists, the name is a template
// string) without ever calling it. Keying the pool on a constant instead
// of `indicatorCode` — the exact bug in this file's header — left every
// one of them green, because the mutation preserves the shape they read.
// These drive the real factory instead.
describe('economic/index.ts — per-indicator World Bank circuit breakers', () => {
  let getWbBreaker;
  let wbBreakerPoolSize;

  before(async () => {
    const result = await build({
      stdin: {
        contents: "export { __testing__ } from './src/services/economic/index.ts';",
        loader: 'ts',
        resolveDir: root,
        sourcefile: 'wb-breaker-test-entry.ts',
      },
      bundle: true,
      // `import.meta.env` and `import.meta.glob` are Vite-only. The economic
      // service reaches i18n's locale glob transitively, so both need a value
      // before the bundle will evaluate under node.
      define: { 'import.meta.env': '{"DEV":false}', 'import.meta.glob': '__wmNoGlob' },
      inject: [resolve(__dirname, 'helpers/vite-glob-stub.mjs')],
      format: 'esm',
      logLevel: 'silent',
      platform: 'node',
      target: 'node20',
      write: false,
    });
    const source = result.outputFiles[0]?.text;
    assert.ok(source, 'esbuild must emit the economic service harness');
    const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    ({ getWbBreaker, wbBreakerPoolSize } = mod.__testing__);
  });

  // Declared first so it reads a clean pool. A shared breaker would answer
  // the second indicator from the first one's warm cache without calling
  // through at all, which is failure mode 1 in this file's header.
  it('never serves one indicator’s cached rows to another', async () => {
    const fallback = { data: [], pagination: undefined };
    const rowsA = {
      data: [{ countryCode: 'USA', indicatorCode: 'WB.CACHE.A', year: 2023, value: 120 }],
      pagination: undefined,
    };
    const rowsB = {
      data: [{ countryCode: 'FRA', indicatorCode: 'WB.CACHE.B', year: 2023, value: 42 }],
      pagination: undefined,
    };

    const servedA = await getWbBreaker('WB.CACHE.A').execute(async () => rowsA, fallback);
    const servedB = await getWbBreaker('WB.CACHE.B').execute(async () => rowsB, fallback);

    assert.deepEqual(servedA, rowsA);
    assert.deepEqual(servedB, rowsB, 'the second indicator must call through, not read the first one’s cache');
  });

  it('hands out a distinct breaker per indicator code', () => {
    assert.notEqual(
      getWbBreaker('IT.NET.USER.ZS'),
      getWbBreaker('IT.CEL.SETS.P2'),
      'two indicators must not share one breaker instance',
    );
  });

  it('hands out the same breaker for a repeated indicator code', () => {
    assert.equal(getWbBreaker('IT.NET.BBND.P2'), getWbBreaker('IT.NET.BBND.P2'));
  });

  it('grows the pool once per distinct indicator', () => {
    const startSize = wbBreakerPoolSize();
    getWbBreaker('GB.XPD.RSDV.GD.ZS');
    getWbBreaker('GB.XPD.RSDV.GD.ZS');
    assert.equal(wbBreakerPoolSize(), startSize + 1);
  });

  it('names each breaker for its own indicator', () => {
    assert.equal(getWbBreaker('WB.NAME.CHECK').name, 'WB:WB.NAME.CHECK');
  });

  it('confines a tripped indicator to itself', async () => {
    const tripped = getWbBreaker('WB.TRIP.A');
    const healthy = getWbBreaker('WB.TRIP.B');
    const fallback = { data: [], pagination: undefined };
    const alwaysFail = () => { throw new Error('World Bank unavailable'); };

    await tripped.execute(alwaysFail, fallback);
    await tripped.execute(alwaysFail, fallback);

    assert.equal(tripped.isOnCooldown(), true, 'two failures must trip the indicator that failed');
    assert.equal(healthy.isOnCooldown(), false, 'a second indicator must stay closed');
  });

});

// ============================================================
// 2. Static analysis: the call site the pool tests cannot reach
// ============================================================

describe('economic/index.ts — getIndicatorData wiring', () => {
  const sourceFile = loadEconomicSourceFile();

  it('getIndicatorData calls getWbBreaker(indicator).execute, not a shared breaker', () => {
    const fn = findFunctionDeclaration(sourceFile, 'getIndicatorData');
    assert.ok(fn?.body, 'getIndicatorData must exist');

    const executeCall = collectCallExpressions(fn.body).find((call) => {
      if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'execute') return false;
      const receiver = call.expression.expression;
      return ts.isCallExpression(receiver)
        && isIdentifierNamed(receiver.expression, 'getWbBreaker')
        && isIdentifierNamed(receiver.arguments[0], 'indicator');
    });

    assert.ok(
      executeCall,
      'getIndicatorData must use getWbBreaker(indicator).execute, not a shared wbBreaker',
    );
  });
});

// ============================================================
// 2. Behavioral: circuit breaker isolation
// ============================================================

describe('CircuitBreaker isolation — independent per-indicator instances', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('two breakers with different names are independent (failure in one does not trip the other)', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    const breakerA = createCircuitBreaker({ name: 'WB:IT.NET.USER.ZS', cacheTtlMs: 30 * 60 * 1000 });
    const breakerB = createCircuitBreaker({ name: 'WB:IT.CEL.SETS.P2', cacheTtlMs: 30 * 60 * 1000 });

    const fallback = { data: [], pagination: undefined };
    let callCount = 0;

    // Force breakerA into cooldown (2 failures = maxFailures)
    const alwaysFail = () => { callCount++; throw new Error('World Bank unavailable'); };
    await breakerA.execute(alwaysFail, fallback); // failure 1
    await breakerA.execute(alwaysFail, fallback); // failure 2 → cooldown
    assert.equal(breakerA.isOnCooldown(), true, 'breakerA should be on cooldown after 2 failures');

    // breakerB must NOT be affected
    assert.equal(breakerB.isOnCooldown(), false, 'breakerB must not be on cooldown when breakerA fails');

    // breakerB should still call through successfully
    const goodData = { data: [{ countryCode: 'USA', countryName: 'United States', indicatorCode: 'IT.CEL.SETS.P2', indicatorName: 'Mobile', year: 2023, value: 120 }], pagination: undefined };
    const result = await breakerB.execute(async () => goodData, fallback);
    assert.deepEqual(result, goodData, 'breakerB should return live data unaffected by breakerA cooldown');

    clearAllCircuitBreakers();
  });

  it('two breakers with different names cache independently (no cross-indicator cache poisoning)', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    const breakerA = createCircuitBreaker({ name: 'WB:IT.NET.USER.ZS', cacheTtlMs: 30 * 60 * 1000 });
    const breakerB = createCircuitBreaker({ name: 'WB:IT.CEL.SETS.P2', cacheTtlMs: 30 * 60 * 1000 });

    const fallback = { data: [], pagination: undefined };
    const internetData = { data: [{ countryCode: 'USA', indicatorCode: 'IT.NET.USER.ZS', year: 2023, value: 90 }], pagination: undefined };
    const mobileData = { data: [{ countryCode: 'USA', indicatorCode: 'IT.CEL.SETS.P2', year: 2023, value: 120 }], pagination: undefined };

    // Populate both caches with different data
    await breakerA.execute(async () => internetData, fallback);
    await breakerB.execute(async () => mobileData, fallback);

    // Each must return its own cached value, not the other's
    const cachedA = await breakerA.execute(async () => fallback, fallback);
    const cachedB = await breakerB.execute(async () => fallback, fallback);

    assert.equal(cachedA.data[0]?.indicatorCode, 'IT.NET.USER.ZS',
      'breakerA cache must return internet data, not mobile data');
    assert.equal(cachedB.data[0]?.indicatorCode, 'IT.CEL.SETS.P2',
      'breakerB cache must return mobile data, not internet data');
    assert.notEqual(cachedA.data[0]?.value, cachedB.data[0]?.value,
      'Cached values must be independent per indicator');

    clearAllCircuitBreakers();
  });

  it('empty server response does not poison the cache for other indicators', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    const breakerA = createCircuitBreaker({ name: 'WB:IT.NET.USER.ZS', cacheTtlMs: 30 * 60 * 1000 });
    const breakerB = createCircuitBreaker({ name: 'WB:IT.CEL.SETS.P2', cacheTtlMs: 30 * 60 * 1000 });

    const fallback = { data: [], pagination: undefined };
    const emptyResponse = { data: [], pagination: undefined }; // what server returns on WB API hiccup
    const goodData = { data: [{ countryCode: 'DEU', indicatorCode: 'IT.CEL.SETS.P2', year: 2023, value: 130 }], pagination: undefined };

    // breakerA caches empty data (the bug scenario: server had a hiccup)
    await breakerA.execute(async () => emptyResponse, fallback);
    const cachedA = breakerA.getCached();
    assert.deepEqual(cachedA?.data, [], 'breakerA caches empty array from server hiccup');

    // breakerB must not be affected — should fetch fresh data
    const resultB = await breakerB.execute(async () => goodData, fallback);
    assert.equal(resultB.data.length, 1, 'breakerB returns real data unaffected by breakerA empty cache');
    assert.equal(resultB.data[0]?.indicatorCode, 'IT.CEL.SETS.P2');

    clearAllCircuitBreakers();
  });
});

// ============================================================
// 3. getTechReadinessRankings: reads from bootstrap/seed, never calls WB API
// ============================================================

describe('getTechReadinessRankings — bootstrap-only data flow', () => {
  const sourceFile = loadEconomicSourceFile();
  const fn = findFunctionDeclaration(sourceFile, 'getTechReadinessRankings');

  it('reads from bootstrap hydration or endpoint, never calls WB API directly', () => {
    assert.ok(fn?.body, 'getTechReadinessRankings must exist');
    const calls = collectCallExpressions(fn.body);

    const hydratedCall = calls.find((call) =>
      isIdentifierNamed(call.expression, 'getHydratedData')
      && isStringLiteralValue(call.arguments[0], 'techReadiness'),
    );
    assert.ok(hydratedCall, 'Must try bootstrap hydration cache first');

    const bootstrapFetch = calls.find((call) => {
      if (!isIdentifierNamed(call.expression, 'fetch')) return false;
      const firstArg = call.arguments[0];
      return ts.isCallExpression(firstArg)
        && isIdentifierNamed(firstArg.expression, 'toApiUrl')
        && isStringLiteralValue(firstArg.arguments[0], '/api/bootstrap?keys=techReadiness');
    });
    assert.ok(bootstrapFetch, 'Must fallback to bootstrap endpoint');

    const wbCalls = calls.filter((call) => isIdentifierNamed(call.expression, 'getIndicatorData'));
    assert.equal(wbCalls.length, 0, 'Must NOT call getIndicatorData (WB API) from frontend');
  });

  it('indicator codes exist in TECH_INDICATORS for seed script parity', () => {
    const keys = getTechIndicatorKeys(sourceFile);
    assert.ok(keys.has('IT.NET.USER.ZS'), 'Internet Users indicator must be present');
    assert.ok(keys.has('IT.CEL.SETS.P2'), 'Mobile Subscriptions indicator must be present');
    assert.ok(keys.has('IT.NET.BBND.P2'), 'Fixed Broadband indicator must be present');
    assert.ok(keys.has('GB.XPD.RSDV.GD.ZS'), 'R&D Expenditure indicator must be present');
  });
});

// ============================================================
// 4. TechReadinessPanel: soft-refresh retry UX regressions
// ============================================================

describe('TechReadinessPanel — empty/error retry UX', () => {
  const panelSrc = loadTechReadinessPanelSource();

  it('does not set the count badge to 0 before the empty-result soft state', () => {
    assert.doesNotMatch(
      panelSrc,
      /this\.setCount\(result\.length\)/,
      'empty result must not write count badge 0 before showSoftRefreshing()',
    );
    assert.match(panelSrc, /this\.hideCountBadge\(\);[\s\S]*?this\.setSafeContent\(unsafeRawHtml\(`\s*<div class="panel-soft-empty"/);
    assert.match(panelSrc, /this\.showCountBadge\(this\.rankings\.length\);/);
  });

  it('resets retry budget only on external refreshes, not scheduled retries', () => {
    assert.match(panelSrc, /public async refresh\(isRetry = false\): Promise<void>/);
    assert.match(panelSrc, /if \(!isRetry\) this\.localRetryAttempt = 0;/);
    assert.match(panelSrc, /void this\.refresh\(true\);/);
    assert.doesNotMatch(panelSrc, /void this\.refresh\(\);\s*\}, delay\);/);
  });
});
