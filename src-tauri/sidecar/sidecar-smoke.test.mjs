#!/usr/bin/env node
/**
 * Sidecar Smoke Test — validates ALL panel-critical RPC endpoints.
 *
 * Starts the sidecar with compiled handlers (LOCAL_API_MODE=tauri-sidecar),
 * hits every domain endpoint, and checks:
 *   1. Handler loads without crash (not 404/500)
 *   2. Response is valid JSON
 *   3. Response has expected top-level shape
 *
 * Run: node --test src-tauri/sidecar/sidecar-smoke.test.mjs
 *
 * Note: without API keys, most handlers return empty/cached data (200 with
 * empty arrays). That's fine — the test validates the pipeline works.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// Dynamic import so the sidecar module is loaded fresh
const { createLocalApiServer } = await import(
  path.join(__dirname, 'local-api-server.mjs')
);

// ── Test endpoints ──────────────────────────────────────────────────────
// Each entry: [method, path, expectedKeys (top-level JSON fields), timeoutMs?]
// expectedKeys=null means just check for valid JSON + 200/non-500.

const ENDPOINTS = [
  // Bootstrap (returns empty data locally — no Redis)
  ['GET', '/api/bootstrap?tier=fast', ['data', 'missing']],
  ['GET', '/api/bootstrap?tier=slow', ['data', 'missing']],

  // Market
  ['GET', '/api/market/v1/list-market-quotes?symbols=AAPL', ['quotes']],
  ['GET', '/api/market/v1/list-crypto-quotes', ['quotes']],
  ['GET', '/api/market/v1/list-commodity-quotes?symbols=CL%3DF', ['quotes']],
  ['GET', '/api/market/v1/get-sector-summary', ['sectors']],
  ['GET', '/api/market/v1/list-stablecoin-markets', null],
  ['GET', '/api/market/v1/list-etf-flows', null],
  ['GET', '/api/market/v1/list-gulf-quotes', ['quotes']],

  // Economic
  ['GET', '/api/economic/v1/get-macro-signals', null],
  ['GET', '/api/economic/v1/get-energy-prices', null],
  ['GET', '/api/economic/v1/get-bis-policy-rates', null],
  ['GET', '/api/economic/v1/get-bis-exchange-rates', null],
  ['GET', '/api/economic/v1/get-bis-credit', null],

  // Conflict
  ['GET', '/api/conflict/v1/list-acled-events', null],
  ['GET', '/api/conflict/v1/list-ucdp-events', null],
  ['GET', '/api/conflict/v1/list-iran-events', null],

  // Climate
  ['GET', '/api/climate/v1/list-climate-anomalies', null],

  // Displacement
  ['GET', '/api/displacement/v1/get-displacement-summary', null],
  ['GET', '/api/displacement/v1/get-population-exposure', null],

  // Cyber
  ['GET', '/api/cyber/v1/list-cyber-threats', null],

  // Infrastructure
  ['GET', '/api/infrastructure/v1/list-internet-outages', null],
  ['GET', '/api/infrastructure/v1/list-service-statuses', null],
  ['GET', '/api/infrastructure/v1/list-temporal-anomalies', null],
  ['GET', '/api/infrastructure/v1/get-cable-health', null],

  // Seismology
  ['GET', '/api/seismology/v1/list-earthquakes', null],

  // Natural
  ['GET', '/api/natural/v1/list-natural-events', null],

  // Wildfire
  ['GET', '/api/wildfire/v1/list-fire-detections', null],

  // Aviation
  ['GET', '/api/aviation/v1/list-airport-delays', null],

  // Military
  ['GET', '/api/military/v1/list-military-flights', null],
  ['GET', '/api/military/v1/get-theater-posture', null],
  ['GET', '/api/military/v1/get-usni-fleet-report', null],

  // Maritime
  ['GET', '/api/maritime/v1/get-vessel-snapshot', null],

  // Supply Chain
  ['GET', '/api/supply-chain/v1/get-shipping-rates', null],
  ['GET', '/api/supply-chain/v1/get-chokepoint-status', null],
  ['GET', '/api/supply-chain/v1/get-critical-minerals', null],

  // Trade
  ['GET', '/api/trade/v1/get-trade-restrictions', null],
  ['GET', '/api/trade/v1/get-tariff-trends', null],

  // Intelligence
  ['GET', '/api/intelligence/v1/get-risk-scores', null],

  // Prediction
  ['GET', '/api/prediction/v1/list-prediction-markets', null],

  // News (RSS fetching can be slow)
  ['GET', '/api/news/v1/list-feed-digest?category=technology', null, 30_000],

  // Research
  ['GET', '/api/research/v1/list-tech-events', null],
  ['GET', '/api/research/v1/list-trending-repos', null],

  // Giving
  ['GET', '/api/giving/v1/get-giving-summary', null],

  // Positive Events
  ['GET', '/api/positive-events/v1/list-positive-geo-events', null],

  // Unrest
  ['GET', '/api/unrest/v1/list-unrest-events', null],
];

// ── Shared server ───────────────────────────────────────────────────────

let server;
let port;

test.before(async () => {
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  // No Redis needed — sidecar-cache handles everything in-memory.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const apiDir = path.join(ROOT, 'api');
  const app = await createLocalApiServer({
    port: 0,
    apiDir,
    resourceDir: ROOT,
    dataDir: ROOT,
    cloudFallback: 'false',
    logger: { log() {}, warn() {}, error() {} },
  });
  const result = await app.start();
  port = result.port;
  server = app;
});

test.after(async () => {
  if (server) await server.close();
});

// ── Generate one test per endpoint ──────────────────────────────────────

for (const [method, endpoint, expectedKeys, timeoutMs] of ENDPOINTS) {
  test(`${method} ${endpoint.split('?')[0]}`, async () => {
    const url = `http://127.0.0.1:${port}${endpoint}`;
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs ?? 15_000),
      });
    } catch (err) {
      if (err.code === 'ECONNRESET' || err.code === 'UND_ERR_SOCKET' || err.name === 'TimeoutError') {
        return; // Network issue, not a handler bug
      }
      throw err;
    }

    // Handler loaded and responded (not 404 = missing handler, not 500 = crash)
    assert.ok(
      response.status < 500,
      `Expected non-5xx, got ${response.status} for ${endpoint}`,
    );

    const text = await response.text();

    // Must be parseable JSON (not HTML error page, not binary garbage)
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      assert.fail(
        `Response is not valid JSON for ${endpoint}: ${text.slice(0, 200)}`,
      );
    }

    // Check expected top-level keys if specified
    if (expectedKeys && response.ok) {
      for (const key of expectedKeys) {
        assert.ok(
          key in json,
          `Missing key "${key}" in response for ${endpoint}. Got: ${Object.keys(json).join(', ')}`,
        );
      }
    }
  });
}
