import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

describe('Bootstrap cache key registry', () => {
  const cacheKeysPath = join(root, 'server', '_shared', 'cache-keys.ts');
  const cacheKeysSrc = readFileSync(cacheKeysPath, 'utf-8');

  it('exports BOOTSTRAP_CACHE_KEYS with at least 10 entries', () => {
    const matches = cacheKeysSrc.match(/^\s+\w+:\s+'[^']+'/gm);
    assert.ok(matches && matches.length >= 10, `Expected ≥10 keys, found ${matches?.length ?? 0}`);
  });

  it('every cache key matches a handler cache key pattern', () => {
    const keyRe = /:\s+'([^']+)'/g;
    let m;
    const keys = [];
    while ((m = keyRe.exec(cacheKeysSrc)) !== null) {
      keys.push(m[1]);
    }
    for (const key of keys) {
      assert.match(key, /^[a-z_]+(?::[a-z_-]+)+:v\d+$/, `Cache key "${key}" does not match expected pattern`);
    }
  });

  it('has no duplicate cache keys', () => {
    const keyRe = /:\s+'([^']+)'/g;
    let m;
    const keys = [];
    while ((m = keyRe.exec(cacheKeysSrc)) !== null) {
      keys.push(m[1]);
    }
    const unique = new Set(keys);
    assert.equal(unique.size, keys.length, `Found duplicate cache keys: ${keys.filter((k, i) => keys.indexOf(k) !== i)}`);
  });

  it('has no duplicate logical names', () => {
    const nameRe = /^\s+(\w+):/gm;
    let m;
    const names = [];
    while ((m = nameRe.exec(cacheKeysSrc)) !== null) {
      names.push(m[1]);
    }
    const unique = new Set(names);
    assert.equal(unique.size, names.length, `Found duplicate names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  it('every cache key maps to a handler file with a matching cache key string', () => {
    const keyRe = /:\s+'([^']+)'/g;
    let m;
    const keys = [];
    while ((m = keyRe.exec(cacheKeysSrc)) !== null) {
      keys.push(m[1]);
    }

    const handlerDirs = join(root, 'server', 'worldmonitor');
    const handlerFiles = [];
    function walk(dir) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts') && !entry.includes('service_server') && !entry.includes('service_client')) {
          handlerFiles.push(full);
        }
      }
    }
    walk(handlerDirs);
    const allHandlerCode = handlerFiles.map(f => readFileSync(f, 'utf-8')).join('\n');

    for (const key of keys) {
      assert.ok(
        allHandlerCode.includes(key),
        `Cache key "${key}" not found in any handler file`,
      );
    }
  });
});

describe('Bootstrap endpoint (api/bootstrap.js)', () => {
  const bootstrapPath = join(root, 'api', 'bootstrap.js');
  const src = readFileSync(bootstrapPath, 'utf-8');

  it('exports edge runtime config', () => {
    assert.ok(src.includes("runtime: 'edge'"), 'Missing edge runtime config');
  });

  it('imports BOOTSTRAP_CACHE_KEYS from cache-keys', () => {
    assert.ok(src.includes('BOOTSTRAP_CACHE_KEYS'), 'Missing BOOTSTRAP_CACHE_KEYS import');
  });

  it('imports getCachedJsonBatch from redis', () => {
    assert.ok(src.includes('getCachedJsonBatch'), 'Missing getCachedJsonBatch import');
  });

  it('supports optional ?keys= query param for subset filtering', () => {
    assert.ok(src.includes("'keys'"), 'Missing keys query param handling');
  });

  it('returns JSON with data and missing keys', () => {
    assert.ok(src.includes('data'), 'Missing data field in response');
    assert.ok(src.includes('missing'), 'Missing missing field in response');
  });

  it('sets Cache-Control header with s-maxage', () => {
    assert.ok(src.includes('s-maxage=60'), 'Missing s-maxage=60 Cache-Control');
    assert.ok(src.includes('stale-while-revalidate'), 'Missing stale-while-revalidate');
  });

  it('validates API key for desktop origins', () => {
    assert.ok(src.includes('validateApiKey'), 'Missing API key validation');
  });

  it('handles CORS preflight', () => {
    assert.ok(src.includes("'OPTIONS'"), 'Missing OPTIONS method handling');
    assert.ok(src.includes('getCorsHeaders'), 'Missing CORS headers');
  });
});

describe('Frontend hydration (src/services/bootstrap.ts)', () => {
  const bootstrapClientPath = join(root, 'src', 'services', 'bootstrap.ts');
  const src = readFileSync(bootstrapClientPath, 'utf-8');

  it('exports getHydratedData function', () => {
    assert.ok(src.includes('export function getHydratedData'), 'Missing getHydratedData export');
  });

  it('exports fetchBootstrapData function', () => {
    assert.ok(src.includes('export async function fetchBootstrapData'), 'Missing fetchBootstrapData export');
  });

  it('uses consume-once pattern (deletes after read)', () => {
    assert.ok(src.includes('.delete('), 'Missing delete in getHydratedData — consume-once pattern not implemented');
  });

  it('has a fast timeout cap to avoid regressing startup', () => {
    const timeoutMatch = src.match(/AbortSignal\.timeout\((\d+)\)/);
    assert.ok(timeoutMatch, 'Missing AbortSignal.timeout');
    const ms = parseInt(timeoutMatch[1], 10);
    assert.ok(ms <= 2000, `Timeout ${ms}ms too high — should be ≤2000ms to avoid regressing startup`);
  });

  it('fetches from /api/bootstrap', () => {
    assert.ok(src.includes('/api/bootstrap'), 'Missing /api/bootstrap fetch URL');
  });

  it('handles fetch failure silently', () => {
    assert.ok(src.includes('catch'), 'Missing error handling — panels should fall through to individual calls');
  });
});

describe('Panel hydration consumers', () => {
  const panels = [
    { name: 'ETFFlowsPanel', path: 'src/components/ETFFlowsPanel.ts', key: 'etfFlows' },
    { name: 'MacroSignalsPanel', path: 'src/components/MacroSignalsPanel.ts', key: 'macroSignals' },
    { name: 'ServiceStatusPanel (via infrastructure)', path: 'src/services/infrastructure/index.ts', key: 'serviceStatuses' },
  ];

  for (const panel of panels) {
    it(`${panel.name} checks getHydratedData('${panel.key}')`, () => {
      const src = readFileSync(join(root, panel.path), 'utf-8');
      assert.ok(src.includes('getHydratedData'), `${panel.name} missing getHydratedData import/usage`);
      assert.ok(src.includes(`'${panel.key}'`), `${panel.name} missing hydration key '${panel.key}'`);
    });
  }
});

describe('Adaptive backoff adopters', () => {
  it('ServiceStatusPanel.fetchStatus returns Promise<boolean>', () => {
    const src = readFileSync(join(root, 'src/components/ServiceStatusPanel.ts'), 'utf-8');
    assert.ok(src.includes('fetchStatus(): Promise<boolean>'), 'fetchStatus should return Promise<boolean> for adaptive backoff');
    assert.ok(src.includes('lastServicesJson'), 'Missing lastServicesJson for change detection');
  });

  it('MacroSignalsPanel.fetchData returns Promise<boolean>', () => {
    const src = readFileSync(join(root, 'src/components/MacroSignalsPanel.ts'), 'utf-8');
    assert.ok(src.includes('fetchData(): Promise<boolean>'), 'fetchData should return Promise<boolean> for adaptive backoff');
    assert.ok(src.includes('lastTimestamp'), 'Missing lastTimestamp for change detection');
  });

  it('StrategicRiskPanel.refresh returns Promise<boolean>', () => {
    const src = readFileSync(join(root, 'src/components/StrategicRiskPanel.ts'), 'utf-8');
    assert.ok(src.includes('refresh(): Promise<boolean>'), 'refresh should return Promise<boolean> for adaptive backoff');
    assert.ok(src.includes('lastRiskFingerprint'), 'Missing lastRiskFingerprint for change detection');
  });
});
