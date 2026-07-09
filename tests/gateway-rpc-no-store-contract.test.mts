import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { createDomainGateway } from '../server/gateway.ts';
import { getEnergyPrices } from '../server/worldmonitor/economic/v1/get-energy-prices.ts';
import type { RouteDescriptor } from '../server/router.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const TEST_KEY = 'cache-contract-test-key';
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

function setGatewayAuthEnv() {
  process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

function request(pathAndQuery: string): Request {
  setGatewayAuthEnv();
  const separator = pathAndQuery.includes('?') ? '&' : '?';
  return new Request('https://worldmonitor.app' + pathAndQuery + separator + '_debug=1', {
    headers: {
      Origin: 'https://worldmonitor.app',
      'X-WorldMonitor-Key': TEST_KEY,
    },
  });
}

function jsonRoute(path: string, payload: unknown): RouteDescriptor {
  return {
    method: 'GET',
    path,
    handler: async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  };
}

function assertNoStore(res: Response): void {
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('X-Cache-Tier'), 'no-store');
  assert.equal(res.headers.get('CDN-Cache-Control'), null);
  assert.equal(res.headers.get('Vercel-CDN-Cache-Control'), null);
}

function assertCacheable(res: Response): void {
  assert.notEqual(res.headers.get('Cache-Control'), 'no-store');
  assert.match(res.headers.get('Cache-Control') ?? '', /max-age=/);
  assert.notEqual(res.headers.get('X-Cache-Tier'), 'no-store');
}

describe('gateway RPC no-store contract', () => {
  it('forces no-store for degraded, unavailable, nonterminal, and error-shaped 200 payloads', async () => {
    const handler = createDomainGateway([
      jsonRoute('/api/scenario/v1/get-scenario-status', { status: 'pending', error: '' }),
      jsonRoute('/api/intelligence/v1/get-risk-scores', { ciiScores: [], strategicRisks: [], degraded: true, stale: true }),
      jsonRoute('/api/forecast/v1/get-forecasts', { forecasts: [], generatedAt: 0, degraded: true, stale: false, error: 'forecast_backend_unavailable' }),
      jsonRoute('/api/market/v1/analyze-stock', { available: false, symbol: 'XYZ', error: '' }),
      jsonRoute('/api/climate/v1/list-climate-anomalies', { anomalies: [], dataAvailable: false }),
    ]);

    for (const path of [
      '/api/scenario/v1/get-scenario-status?jobId=scenario:1712345678901:abcdefgh',
      '/api/intelligence/v1/get-risk-scores',
      '/api/forecast/v1/get-forecasts',
      '/api/market/v1/analyze-stock?symbol=XYZ',
      '/api/climate/v1/list-climate-anomalies',
    ]) {
      const res = await handler(request(path));
      assert.equal(res.status, 200, path);
      assertNoStore(res);
    }
  });

  it('keeps semantically healthy empty results cacheable', async () => {
    const handler = createDomainGateway([
      jsonRoute('/api/forecast/v1/get-forecasts', {
        forecasts: [],
        generatedAt: 123,
        degraded: false,
        stale: false,
        error: '',
      }),
    ]);

    const res = await handler(request('/api/forecast/v1/get-forecasts?domain=nonexistent'));

    assert.equal(res.status, 200);
    assertCacheable(res);
  });

  it('lets a bare energy seed miss opt into no-store through the handler side channel', async () => {
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/economic/v1/get-energy-prices',
        handler: async (req) => {
          const result = await getEnergyPrices({
            request: req,
            pathParams: {},
            headers: Object.fromEntries(req.headers.entries()),
          }, { commodities: [] });
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    ]);

    const res = await handler(request('/api/economic/v1/get-energy-prices'));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(body, { prices: [] });
    assertNoStore(res);
  });
});

const PROTECTED_HIGH_TIER_EMPTY_HANDLERS = [
  'server/worldmonitor/economic/v1/get-energy-prices.ts',
  'server/worldmonitor/economic/v1/get-energy-capacity.ts',
  'server/worldmonitor/economic/v1/get-crude-inventories.ts',
  'server/worldmonitor/economic/v1/get-nat-gas-storage.ts',
  'server/worldmonitor/economic/v1/list-fuel-prices.ts',
  'server/worldmonitor/economic/v1/list-bigmac-prices.ts',
  'server/worldmonitor/economic/v1/get-fao-food-price-index.ts',
  'server/worldmonitor/economic/v1/get-bis-policy-rates.ts',
  'server/worldmonitor/economic/v1/get-bis-exchange-rates.ts',
  'server/worldmonitor/economic/v1/get-bis-credit.ts',
  'server/worldmonitor/climate/v1/get-co2-monitoring.ts',
  'server/worldmonitor/climate/v1/get-ocean-ice-data.ts',
  'server/worldmonitor/climate/v1/list-climate-anomalies.ts',
  'server/worldmonitor/climate/v1/list-climate-disasters.ts',
  'server/worldmonitor/conflict/v1/list-ucdp-events.ts',
  'server/worldmonitor/cyber/v1/list-cyber-threats.ts',
  'server/worldmonitor/forecast/v1/get-forecasts.ts',
  'server/worldmonitor/forecast/v1/get-forecast-scorecard.ts',
  'server/worldmonitor/market/v1/list-defi-tokens.ts',
  'server/worldmonitor/market/v1/list-ai-tokens.ts',
  'server/worldmonitor/market/v1/list-other-tokens.ts',
  'server/worldmonitor/research/v1/list-arxiv-papers.ts',
  'server/worldmonitor/research/v1/list-hackernews-items.ts',
  'server/worldmonitor/research/v1/list-trending-repos.ts',
  'server/worldmonitor/military/v1/get-theater-posture.ts',
  'server/worldmonitor/military/v1/list-defense-patents.ts',
] as const;

const HEALTHY_EMPTY_ALLOWLIST = new Set([
  "server/worldmonitor/forecast/v1/get-forecasts.ts::{ forecasts: [], generatedAt: data.generatedAt || 0, degraded: false, stale: false, error: '' }",
  "server/worldmonitor/forecast/v1/get-forecast-scorecard.ts::{ schemaVersion: 1, generatedAt: 0, rollingWindowDays: 180, methodology: '', totals: { entries: 0, resolved: 0, pending: 0, pendingJudge: 0, scored: 0, void: 0, voidRate: 0, publicationCoverage: 0, }, byDomain: [], byGenerationOrigin: [], calibration: [], degraded: false, stale: false, error: '', ...overrides, }",
  "server/worldmonitor/climate/v1/list-climate-disasters.ts::{ disasters: [], pagination: { nextCursor: '', totalCount: allDisasters.length }, }",
]);

function propName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function boolLiteral(node: ts.Expression): boolean | null {
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function objectHasEmptyArrayPayload(node: ts.ObjectLiteralExpression): boolean {
  return node.properties.some((prop) => {
    if (!ts.isPropertyAssignment(prop)) return false;
    return ts.isArrayLiteralExpression(prop.initializer) && prop.initializer.elements.length === 0;
  });
}

function objectHasNoStoreMarker(node: ts.ObjectLiteralExpression): boolean {
  return node.properties.some((prop) => {
    if (!ts.isPropertyAssignment(prop)) return false;
    const name = propName(prop.name);
    if (name === 'upstreamUnavailable' || name === 'unavailable' || name === 'degraded') {
      return boolLiteral(prop.initializer) === true;
    }
    if (name === 'dataAvailable' || name === 'available') {
      return boolLiteral(prop.initializer) === false;
    }
    return false;
  });
}

function unwrapNoStoreCall(expr: ts.Expression): boolean {
  return ts.isCallExpression(expr)
    && ts.isIdentifier(expr.expression)
    && expr.expression.text === 'markNoStoreFallbackResponse';
}

describe('high-tier bare-empty source guard', () => {
  it('requires protected high-tier empty seed-miss returns to carry no-store metadata', () => {
    const failures: string[] = [];

    for (const relative of PROTECTED_HIGH_TIER_EMPTY_HANDLERS) {
      const absolute = resolve(root, relative);
      const source = readFileSync(absolute, 'utf8');
      const sourceFile = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      function visit(node: ts.Node): void {
        if (ts.isReturnStatement(node) && node.expression) {
          const expr = node.expression;
          if (unwrapNoStoreCall(expr)) return;
          if (ts.isObjectLiteralExpression(expr) && objectHasEmptyArrayPayload(expr) && !objectHasNoStoreMarker(expr)) {
            const snippet = expr.getText(sourceFile).replace(/\s+/g, ' ').trim();
            const key = relative + '::' + snippet;
            if (!HEALTHY_EMPTY_ALLOWLIST.has(key)) failures.push(key);
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    assert.deepEqual(failures, []);
  });
});
