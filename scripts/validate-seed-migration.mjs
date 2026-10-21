#!/usr/bin/env node

/**
 * Post-deploy validation for seed migration.
 *
 * Usage:
 *   node scripts/validate-seed-migration.mjs [--base-url URL]
 *
 * Requires: Referer header from trusted origin OR X-WorldMonitor-Key header.
 * Uses api.worldmonitor.app by default.
 */

const BASE_URL = process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : 'https://api.worldmonitor.app';

const ORIGIN = 'https://worldmonitor.app';

// ========================================================================
// Test definitions — one per migrated handler
// ========================================================================

const TESTS = [
  // Phase 1 — Snapshot endpoints
  {
    name: 'Earthquakes',
    endpoint: '/api/seismology/v1/list-earthquakes',
    validate: (d) => Array.isArray(d.earthquakes) && d.earthquakes.length > 0,
    minRecords: 1,
    field: 'earthquakes',
  },
  {
    name: 'Fire Detections',
    endpoint: '/api/wildfire/v1/list-fire-detections',
    validate: (d) => Array.isArray(d.fireDetections),
    minRecords: 0,
    field: 'fireDetections',
  },
  {
    name: 'Internet Outages',
    endpoint: '/api/infrastructure/v1/list-internet-outages',
    validate: (d) => Array.isArray(d.outages),
    minRecords: 0,
    field: 'outages',
  },
  {
    name: 'Climate Anomalies',
    endpoint: '/api/climate/v1/list-climate-anomalies',
    validate: (d) => Array.isArray(d.anomalies) && d.anomalies.length > 0,
    minRecords: 1,
    field: 'anomalies',
  },
  {
    name: 'Climate News',
    endpoint: '/api/climate/v1/list-climate-news',
    validate: (d) => Array.isArray(d.items) && d.items.length > 0,
    minRecords: 1,
    field: 'items',
  },

  // Phase 2 — Parameterized endpoints
  {
    name: 'Unrest Events',
    endpoint: '/api/unrest/v1/list-unrest-events',
    validate: (d) => Array.isArray(d.events),
    minRecords: 0,
    field: 'events',
  },
  {
    name: 'Cyber Threats',
    endpoint: '/api/cyber/v1/list-cyber-threats',
    validate: (d) => Array.isArray(d.threats),
    minRecords: 0,
    field: 'threats',
  },
  {
    name: 'Market Quotes',
    endpoint: '/api/market/v1/list-market-quotes?symbols=AAPL,MSFT',
    validate: (d) => Array.isArray(d.quotes) && d.quotes.length > 0,
    minRecords: 1,
    field: 'quotes',
  },
  {
    name: 'Commodity Quotes',
    endpoint: '/api/market/v1/list-commodity-quotes?symbols=GC%3DF,CL%3DF',
    validate: (d) => Array.isArray(d.quotes) && d.quotes.length > 0,
    minRecords: 1,
    field: 'quotes',
  },
  {
    name: 'Crypto Quotes',
    endpoint: '/api/market/v1/list-crypto-quotes',
    validate: (d) => Array.isArray(d.quotes),
    minRecords: 0,
    field: 'quotes',
  },
  {
    name: 'ETF Flows',
    endpoint: '/api/market/v1/list-etf-flows',
    validate: (d) => Array.isArray(d.etfs),
    minRecords: 0,
    field: 'etfs',
  },
  {
    name: 'Gulf Quotes',
    endpoint: '/api/market/v1/list-gulf-quotes',
    validate: (d) => Array.isArray(d.quotes),
    minRecords: 0,
    field: 'quotes',
  },
  {
    name: 'Stablecoin Markets',
    endpoint: '/api/market/v1/list-stablecoin-markets',
    validate: (d) => Array.isArray(d.stablecoins),
    minRecords: 0,
    field: 'stablecoins',
  },

  // Phase 3 — Hybrid endpoints
  {
    name: 'Natural Events',
    endpoint: '/api/natural/v1/list-natural-events',
    validate: (d) => Array.isArray(d.events),
    minRecords: 0,
    field: 'events',
  },
  {
    name: 'Displacement Summary',
    endpoint: '/api/displacement/v1/get-displacement-summary',
    validate: (d) => d.summary && typeof d.summary.year === 'number',
    minRecords: null,
    field: null,
  },
];

// ========================================================================
// Seed Health check
// ========================================================================

const API_KEY = process.env.WORLDMONITOR_KEY || '';

const SEED_HEALTH_TEST = {
  name: 'Seed Health',
  endpoint: '/api/seed-health',
  validate: (d) => d.overall && d.seeds && typeof d.checkedAt === 'number',
};

// ========================================================================
// Runner
// ========================================================================

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

async function fetchEndpoint(endpoint) {
  const url = `${BASE_URL}${endpoint}`;
  const resp = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      'User-Agent': 'validate-seed-migration/1.0',
      ...(API_KEY ? { 'X-WorldMonitor-Key': API_KEY } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: resp.status, data: resp.ok ? await resp.json() : null };
}

async function runTest(test) {
  const t0 = Date.now();
  try {
    const { status, data } = await fetchEndpoint(test.endpoint);
    const elapsed = Date.now() - t0;

    if (status !== 200) {
      return { name: test.name, pass: false, reason: `HTTP ${status}`, elapsed };
    }

    if (!data) {
      return { name: test.name, pass: false, reason: 'Empty response body', elapsed };
    }

    if (!test.validate(data)) {
      return { name: test.name, pass: false, reason: 'Validation failed — unexpected shape', elapsed, data };
    }

    const count = test.field ? (data[test.field]?.length ?? 0) : null;
    const belowMin = test.minRecords != null && count != null && count < test.minRecords;

    return {
      name: test.name,
      pass: !belowMin,
      warn: belowMin,
      reason: belowMin ? `Only ${count} records (expected >= ${test.minRecords})` : null,
      count,
      elapsed,
    };
  } catch (err) {
    return { name: test.name, pass: false, reason: err.message, elapsed: Date.now() - t0 };
  }
}

async function runSeedHealth() {
  try {
    const { status, data } = await fetchEndpoint(SEED_HEALTH_TEST.endpoint);
    if (status !== 200 || !data) {
      return { pass: false, reason: `HTTP ${status}`, seeds: null };
    }
    return { pass: true, overall: data.overall, seeds: data.seeds };
  } catch (err) {
    return { pass: false, reason: err.message, seeds: null };
  }
}

// ========================================================================
// Main
// ========================================================================

async function main() {
  console.log(`\n${BOLD}=== Seed Migration Validation ===${RESET}`);
  console.log(`Base URL: ${BASE_URL}\n`);

  // 1. Seed Health
  console.log(`${BOLD}--- Seed Health ---${RESET}`);
  const health = await runSeedHealth();
  if (health.pass && health.seeds) {
    const icon = health.overall === 'healthy' ? PASS
      : health.overall === 'warning' ? WARN : FAIL;
    console.log(`  ${icon} Overall: ${health.overall}`);
    for (const [domain, info] of Object.entries(health.seeds)) {
      const dIcon = info.status === 'ok' ? PASS
        : info.status === 'stale' ? WARN : FAIL;
      const age = info.ageMinutes != null ? ` (${info.ageMinutes}m ago)` : '';
      const count = info.recordCount != null ? `, ${info.recordCount} records` : '';
      console.log(`    ${dIcon} ${domain}: ${info.status}${age}${count}`);
    }
  } else {
    console.log(`  ${FAIL} Seed health check failed: ${health.reason}`);
  }

  // 2. RPC Endpoints
  console.log(`\n${BOLD}--- RPC Endpoints (${TESTS.length} handlers) ---${RESET}`);
  const results = [];
  for (const test of TESTS) {
    const result = await runTest(test);
    results.push(result);
    const icon = result.pass ? PASS : result.warn ? WARN : FAIL;
    const countStr = result.count != null ? ` [${result.count} records]` : '';
    const timeStr = ` (${result.elapsed}ms)`;
    const reasonStr = result.reason ? ` — ${result.reason}` : '';
    console.log(`  ${icon} ${result.name}${countStr}${timeStr}${reasonStr}`);
  }

  // 3. Summary
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const total = results.length;

  console.log(`\n${BOLD}--- Summary ---${RESET}`);
  console.log(`  ${passed}/${total} passed, ${failed} failed`);

  if (failed > 0) {
    console.log(`\n  ${FAIL} Failed endpoints:`);
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`    - ${r.name}: ${r.reason}`);
    }
  }

  // 4. Cross-validation: compare seed health vs RPC data
  if (health.seeds) {
    console.log(`\n${BOLD}--- Cross-Validation ---${RESET}`);
    const seedDomainToTest = {
      'seismology:earthquakes': 'Earthquakes',
      'wildfire:fires': 'Fire Detections',
      'infra:outages': 'Internet Outages',
      'climate:anomalies': 'Climate Anomalies',
      'unrest:events': 'Unrest Events',
      'cyber:threats': 'Cyber Threats',
      'market:crypto': 'Crypto Quotes',
      'market:etf-flows': 'ETF Flows',
      'market:gulf-quotes': 'Gulf Quotes',
      'market:stablecoins': 'Stablecoin Markets',
      'natural:events': 'Natural Events',
      'displacement:summary': 'Displacement Summary',
    };

    for (const [domain, testName] of Object.entries(seedDomainToTest)) {
      const seedInfo = health.seeds[domain];
      const rpcResult = results.find((r) => r.name === testName);
      if (!seedInfo || !rpcResult) continue;

      if (seedInfo.status === 'ok' && rpcResult.pass) {
        console.log(`  ${PASS} ${domain}: seed fresh + RPC returns data`);
      } else if (seedInfo.status === 'ok' && !rpcResult.pass) {
        console.log(`  ${FAIL} ${domain}: seed fresh but RPC failed (${rpcResult.reason})`);
      } else if (seedInfo.status !== 'ok' && rpcResult.pass) {
        console.log(`  ${WARN} ${domain}: seed ${seedInfo.status} but RPC still returns data (fallback working)`);
      } else {
        console.log(`  ${FAIL} ${domain}: seed ${seedInfo.status} AND RPC failed`);
      }
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Validation script crashed:', err);
  process.exit(2);
});
