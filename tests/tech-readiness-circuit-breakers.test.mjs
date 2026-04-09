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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ts from 'typescript'; // TypeScript compiler API — available via the typescript devDep used by tsc

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const economicPath = resolve(root, 'src/services/economic/index.ts');

function loadEconomicSourceFile() {
  return ts.createSourceFile(
    economicPath,
    readFileSync(economicPath, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
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

function findPropertyAssignment(node, name) {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  return node.properties.find(
    (prop) => ts.isPropertyAssignment(prop)
      && ((ts.isIdentifier(prop.name) && prop.name.text === name)
        || (ts.isStringLiteral(prop.name) && prop.name.text === name)),
  );
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

function getCreateCircuitBreakerNameInitializer(fn) {
  const createCall = collectCallExpressions(fn).find((call) => isIdentifierNamed(call.expression, 'createCircuitBreaker'));
  assert.ok(createCall, 'getWbBreaker must call createCircuitBreaker');

  const optionsArg = createCall.arguments[0];
  assert.ok(optionsArg && ts.isObjectLiteralExpression(optionsArg), 'createCircuitBreaker must receive an options object');

  const nameProp = findPropertyAssignment(optionsArg, 'name');
  assert.ok(nameProp, 'createCircuitBreaker options must include a name');
  return nameProp.initializer;
}

// ============================================================
// 1. Static analysis: source structure guarantees
// ============================================================

describe('economic/index.ts — per-indicator World Bank circuit breakers', () => {
  const sourceFile = loadEconomicSourceFile();

  it('does NOT have a single shared wbBreaker', () => {
    assert.equal(
      findVariableDeclaration(sourceFile, 'wbBreaker'),
      undefined,
      'Single shared wbBreaker must not exist — use getWbBreaker(indicatorCode) instead',
    );
  });

  it('has a wbBreakers Map for per-indicator instances', () => {
    const decl = findVariableDeclaration(sourceFile, 'wbBreakers');
    assert.ok(decl?.initializer && ts.isNewExpression(decl.initializer), 'wbBreakers declaration must exist');
    assert.ok(isIdentifierNamed(decl.initializer.expression, 'Map'), 'wbBreakers must be initialized with new Map(...)');
  });

  it('has a getWbBreaker(indicatorCode) factory function', () => {
    const fn = findFunctionDeclaration(sourceFile, 'getWbBreaker');
    assert.ok(fn, 'getWbBreaker function must exist');
    assert.equal(fn.parameters[0]?.name.getText(sourceFile), 'indicatorCode');
    assert.ok(
      collectCallExpressions(fn).some((call) => isIdentifierNamed(call.expression, 'createCircuitBreaker')),
      'getWbBreaker must create circuit breakers lazily',
    );
  });

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

  it('per-indicator breaker names include the indicator code', () => {
    const fn = findFunctionDeclaration(sourceFile, 'getWbBreaker');
    assert.ok(fn, 'getWbBreaker function must exist');

    const nameInitializer = getCreateCircuitBreakerNameInitializer(fn);
    assert.ok(
      ts.isTemplateExpression(nameInitializer),
      'Breaker name should be a template string scoped to the indicator code',
    );
    assert.equal(nameInitializer.head.text, 'WB:');
    assert.equal(nameInitializer.templateSpans.length, 1);
    assert.ok(isIdentifierNamed(nameInitializer.templateSpans[0]?.expression, 'indicatorCode'));
  });

  it('mirrors fredBatchBreaker pattern (consistency check)', () => {
    const fredDecl = findVariableDeclaration(sourceFile, 'fredBatchBreaker');
    assert.ok(fredDecl?.initializer && ts.isCallExpression(fredDecl.initializer), 'fredBatchBreaker must exist');
    assert.ok(isIdentifierNamed(fredDecl.initializer.expression, 'createCircuitBreaker'));
    assert.ok(findFunctionDeclaration(sourceFile, 'getWbBreaker'), 'getWbBreaker implementation should be present');
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
