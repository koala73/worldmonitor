import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

describe('Market breadth bootstrap registration', () => {
  const cacheKeysSrc = readFileSync(join(root, 'server', '_shared', 'cache-keys.ts'), 'utf-8');
  const bootstrapSrc = readFileSync(join(root, 'api', 'bootstrap.js'), 'utf-8');
  const healthSrc = readFileSync(join(root, 'api', 'health.js'), 'utf-8');
  const gatewaySrc = readFileSync(join(root, 'server', 'gateway.ts'), 'utf-8');

  it('cache-keys.ts has breadthHistory in BOOTSTRAP_CACHE_KEYS', () => {
    assert.match(cacheKeysSrc, /breadthHistory:\s+'market:breadth-history:v1'/);
  });

  it('cache-keys.ts has breadthHistory in BOOTSTRAP_TIERS', () => {
    assert.match(cacheKeysSrc, /breadthHistory:\s+'slow'/);
  });

  it('bootstrap.js has breadthHistory key', () => {
    assert.match(bootstrapSrc, /breadthHistory:\s+'market:breadth-history:v1'/);
  });

  it('bootstrap.js has breadthHistory in SLOW_KEYS', () => {
    assert.match(bootstrapSrc, /'breadthHistory'/);
  });

  it('health.js has breadthHistory data key', () => {
    assert.match(healthSrc, /breadthHistory:\s+'market:breadth-history:v1'/);
  });

  it('health.js has breadthHistory seed-meta config', () => {
    assert.match(healthSrc, /breadthHistory:\s+\{\s*key:\s+'seed-meta:market:breadth-history'/);
  });

  it('gateway.ts has market breadth history cache tier', () => {
    assert.match(gatewaySrc, /\/api\/market\/v1\/get-market-breadth-history/);
  });
});

describe('Market breadth seed script', () => {
  const seedSrc = readFileSync(join(root, 'scripts', 'seed-market-breadth.mjs'), 'utf-8');

  it('uses correct Redis key', () => {
    assert.match(seedSrc, /market:breadth-history:v1/);
  });

  it('has a 30-day TTL', () => {
    assert.match(seedSrc, /2592000/);
  });

  it('fetches all three Barchart breadth symbols', () => {
    assert.match(seedSrc, /S5TW/);
    assert.match(seedSrc, /S5FI/);
    assert.match(seedSrc, /S5TH/);
  });

  it('maintains rolling 252-day history', () => {
    assert.match(seedSrc, /HISTORY_LENGTH\s*=\s*252/);
  });

  it('calls runSeed with validation', () => {
    assert.match(seedSrc, /runSeed\(/);
    assert.match(seedSrc, /validateFn/);
  });
});

describe('Market breadth RPC handler', () => {
  const handlerSrc = readFileSync(join(root, 'server', 'worldmonitor', 'market', 'v1', 'get-market-breadth-history.ts'), 'utf-8');

  it('reads from correct cache key', () => {
    assert.match(handlerSrc, /market:breadth-history:v1/);
  });

  it('returns unavailable=true on empty data', () => {
    assert.match(handlerSrc, /unavailable:\s*true/);
  });

  it('maps history entries to BreadthSnapshot', () => {
    assert.match(handlerSrc, /BreadthSnapshot/);
  });
});

describe('Market breadth proto', () => {
  const protoSrc = readFileSync(join(root, 'proto', 'worldmonitor', 'market', 'v1', 'get_market_breadth_history.proto'), 'utf-8');
  const serviceSrc = readFileSync(join(root, 'proto', 'worldmonitor', 'market', 'v1', 'service.proto'), 'utf-8');

  it('defines GetMarketBreadthHistoryRequest and Response', () => {
    assert.match(protoSrc, /GetMarketBreadthHistoryRequest/);
    assert.match(protoSrc, /GetMarketBreadthHistoryResponse/);
  });

  it('defines BreadthSnapshot message', () => {
    assert.match(protoSrc, /message BreadthSnapshot/);
  });

  it('marks pct_above_* fields optional so null != 0 at the wire level', () => {
    assert.match(protoSrc, /optional double pct_above_20d/);
    assert.match(protoSrc, /optional double pct_above_50d/);
    assert.match(protoSrc, /optional double pct_above_200d/);
    assert.match(protoSrc, /optional double current_pct_above_20d/);
    assert.match(protoSrc, /optional double current_pct_above_50d/);
    assert.match(protoSrc, /optional double current_pct_above_200d/);
  });

  it('is imported in service.proto', () => {
    assert.match(serviceSrc, /get_market_breadth_history\.proto/);
  });

  it('has RPC registered in MarketService', () => {
    assert.match(serviceSrc, /rpc GetMarketBreadthHistory/);
  });
});

describe('Market breadth panel', () => {
  const panelSrc = readFileSync(join(root, 'src', 'components', 'MarketBreadthPanel.ts'), 'utf-8');

  it('is registered in handler.ts', () => {
    const handlerTs = readFileSync(join(root, 'server', 'worldmonitor', 'market', 'v1', 'handler.ts'), 'utf-8');
    assert.match(handlerTs, /getMarketBreadthHistory/);
  });

  it('builds SVG area chart', () => {
    assert.match(panelSrc, /<svg viewBox/);
    assert.match(panelSrc, /polyline/);
    assert.match(panelSrc, /<path/);
  });

  it('shows 3 series with correct colors', () => {
    assert.match(panelSrc, /#3b82f6/); // blue for 20d
    assert.match(panelSrc, /#f59e0b/); // orange for 50d
    assert.match(panelSrc, /#22c55e/); // green for 200d
  });

  it('fetches from bootstrap and RPC', () => {
    assert.match(panelSrc, /getHydratedData/);
    assert.match(panelSrc, /getMarketBreadthHistory/);
  });
});

describe('Market breadth null-vs-zero handling', () => {
  const panelSrc = readFileSync(join(root, 'src', 'components', 'MarketBreadthPanel.ts'), 'utf-8');
  const handlerSrc = readFileSync(join(root, 'server', 'worldmonitor', 'market', 'v1', 'get-market-breadth-history.ts'), 'utf-8');
  const seedSrc = readFileSync(join(root, 'scripts', 'seed-market-breadth.mjs'), 'utf-8');

  it('seed preserves null for failed Barchart fetches', () => {
    // readings[field] = val where val can be null; must NOT coerce to 0
    assert.match(seedSrc, /readings\[field\]\s*=\s*val/);
    assert.doesNotMatch(seedSrc, /pctAbove20d:\s*readings\.pctAbove20d\s*\|\|\s*0/);
  });

  it('handler returns nullable currents (no ?? 0 coercion)', () => {
    // Ensure the handler no longer coerces raw.current.pctAbove* ?? 0
    assert.doesNotMatch(handlerSrc, /raw\.current\.pctAbove20d\s*\?\?\s*0/);
    assert.doesNotMatch(handlerSrc, /raw\.current\.pctAbove50d\s*\?\?\s*0/);
    assert.doesNotMatch(handlerSrc, /raw\.current\.pctAbove200d\s*\?\?\s*0/);
    // Missing readings flow through nullToUndefined so proto `optional`
    // serializes as JSON undefined (field omitted), not 0.
    assert.match(handlerSrc, /nullToUndefined\(raw\.current\.pctAbove20d\)/);
    assert.match(handlerSrc, /nullToUndefined\(raw\.current\.pctAbove50d\)/);
    assert.match(handlerSrc, /nullToUndefined\(raw\.current\.pctAbove200d\)/);
  });

  it('panel type distinguishes null from number for current readings', () => {
    assert.match(panelSrc, /currentPctAbove20d:\s*number\s*\|\s*null/);
    assert.match(panelSrc, /currentPctAbove50d:\s*number\s*\|\s*null/);
    assert.match(panelSrc, /currentPctAbove200d:\s*number\s*\|\s*null/);
  });

  it('panel legend treats null as missing, 0 as a valid reading', () => {
    // hasCurrent check must accept 0 but reject null
    assert.match(panelSrc, /Number\.isFinite\(val\)\s*&&\s*val\s*>=\s*0/);
    // Uses "—" (em dash, \u2014) for missing readings, not "N/A"
    assert.match(panelSrc, /\\u2014/);
  });

  it('history chart splits polylines at null points', () => {
    assert.match(panelSrc, /splitSeriesByNulls/);
    // run-based helpers (one polyline per contiguous run, not one per series)
    assert.match(panelSrc, /runToAreaPath/);
    assert.match(panelSrc, /runToPolylinePoints/);
  });

  it('splitSeriesByNulls breaks on null/undefined/non-finite values', () => {
    assert.match(panelSrc, /v\s*===\s*null/);
    assert.match(panelSrc, /v\s*===\s*undefined/);
    assert.match(panelSrc, /!Number\.isFinite\(v\)/);
  });
});
